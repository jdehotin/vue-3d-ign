"""Grille MNH (vue3d/mnh.py) : décodage, taille, repli MNS − MNT."""
import struct
import threading

import numpy as np
import pytest
import requests

from vue3d import mnh


def _ancien_decodage(contenu, largeur, hauteur):
    """Le décodage d'avant numpy, cellule à cellule : la référence."""
    brut = struct.unpack(f"<{largeur * hauteur}f", contenu[:largeur * hauteur * 4])
    return [0.0 if (v < 0 or v > 200 or v != v) else round(v, 1) for v in brut]


def test_le_decodage_rend_les_memes_hauteurs_qu_avant():
    """À l'octet près, signe de zéro compris : les ex aequo (0,25, 0,35 en
    float32), les bornes, le nodata, NaN et l'infini, puis du bruit."""
    speciaux = [0.0, -0.0, 0.25, 0.35, 0.05, 0.15, 2.675, 199.95, 200.0, 200.04, 200.1,
                -0.04, -99999.0, -9999.0, float("nan"), float("inf"), -float("inf"),
                1e-30, 12.349999, 12.35, 12.45, 87.65]
    alea = np.random.default_rng(3).uniform(-5, 210, 20000).astype(np.float32).tolist()
    valeurs = speciaux + alea
    contenu = struct.pack(f"<{len(valeurs)}f", *valeurs)
    attendu = _ancien_decodage(contenu, len(valeurs), 1)
    obtenu = mnh._grille_depuis_bil(contenu, len(valeurs), 1)
    assert type(obtenu) is list and all(type(v) is float for v in obtenu)
    assert [repr(v) for v in obtenu] == [repr(v) for v in attendu]


def test_un_bil_tronque_est_refuse():
    with pytest.raises(ValueError):
        mnh._grille_depuis_bil(b"\0" * 12, 2, 2)


def test_la_taille_de_la_grille_ne_depend_que_de_l_emprise(monkeypatch):
    """La scène demande l'orthophoto et le terrain à cette taille avant
    d'avoir la grille : fetch_mnh_grid doit prendre la même."""
    demandes = []

    def grille_wms(layer, w, s, e, n, largeur, hauteur, brut=False):
        demandes.append((largeur, hauteur))
        return [1.0] * (largeur * hauteur)

    monkeypatch.setattr(mnh, "_grille_wms", grille_wms)
    for bbox in ((5.19, 43.90, 5.21, 43.92), (7.745, 48.5773, 7.7554, 48.5863),
                 (2.1188, 48.8033, 2.1220, 48.8065)):
        grille = mnh.fetch_mnh_grid(*bbox, resolution_m=0.5, max_pixels=2048)
        attendu = mnh.dimensions_grille(*bbox, 0.5, 2048)
        assert (grille["width"], grille["height"]) == attendu == demandes[-1]


def test_le_repli_lit_mns_et_mnt_ensemble(monkeypatch):
    """Hors LiDAR HD, les deux grilles du repli sont lues en même temps."""
    barriere = threading.Barrier(2, timeout=5)

    def grille_wms(layer, w, s, e, n, largeur, hauteur, brut=False):
        if layer == mnh.MNH_LAYER:
            return [0.0] * (largeur * hauteur)
        barriere.wait()
        return [110.0 if layer == mnh.MNS_LAYER else 100.0] * (largeur * hauteur)

    monkeypatch.setattr(mnh, "_grille_wms", grille_wms)
    grille = mnh.fetch_mnh_grid(5.19, 43.90, 5.1902, 43.9002)
    assert grille["source"] == "mns_mnt" and grille["couvert"]
    assert set(grille["values"]) == {10.0}


def test_un_repli_en_echec_garde_la_reponse_lidar(monkeypatch):
    def grille_wms(layer, w, s, e, n, largeur, hauteur, brut=False):
        if layer == mnh.MNT_LAYER:
            raise requests.RequestException("HTTP 502")
        return [0.0 if layer == mnh.MNH_LAYER else 110.0] * (largeur * hauteur)

    monkeypatch.setattr(mnh, "_grille_wms", grille_wms)
    grille = mnh.fetch_mnh_grid(5.19, 43.90, 5.1902, 43.9002)
    assert not grille["couvert"] and grille["source"] is None


def test_un_repli_en_echec_n_abandonne_pas_la_scene(monkeypatch):
    """Dans une scène, le MNS en échec abandonne le MNT, son voisin du
    repli, pas les autres lectures de la scène : la grille LiDAR, même vide,
    est rendue comme avant, et c'est la scène qui la juge."""
    import concurrent.futures

    from vue3d import geopf

    class Reponse:
        ok = True
        status_code = 200
        headers = {"Content-Type": "image/x-bil;bits=32"}

        def __init__(self, contenu):
            self.content = contenu

        def raise_for_status(self):
            pass

    def get(url, timeout=None):
        if f"LAYERS={mnh.MNS_LAYER}&" in url:
            raise requests.ConnectionError("panne")
        valeur = 110.0 if f"LAYERS={mnh.MNT_LAYER}&" in url else 0.0
        return Reponse(struct.pack("<4f", *[valeur] * 4))

    monkeypatch.setattr(geopf, "_places", geopf._Places(geopf.GEOPF_SIMULTANEES))
    monkeypatch.setattr(geopf.requests, "get", get)
    monkeypatch.setattr(geopf.time, "sleep", lambda s: None)
    monkeypatch.setattr(mnh, "dimensions_grille", lambda *a, **k: (2, 2))
    groupe = geopf.Groupe()
    with concurrent.futures.ThreadPoolExecutor(1) as bassin:
        grille = groupe.soumettre(bassin, mnh.fetch_mnh_grid, 5.19, 43.90, 5.1902,
                                  43.9002).result(timeout=5)
    assert not grille["couvert"] and grille["source"] is None
    assert not groupe.abandonne()


def _service_bil(demandes, emprise, largeur, hauteur):
    """Doublure du WMS : chaque cellule vaut une fonction de sa place dans la
    grille entière, retrouvée de son centre — quelle que soit la requête qui
    la couvre. Du nodata, du bruit négatif et NaN en quelques places, pour
    que le nettoyage soit éprouvé à travers les tuiles."""
    o0, s0, e0, n0 = emprise

    def bil_wms(layer, o, s, e, n, l, h):
        demandes.append((o, s, e, n, l, h))
        x = o + (np.arange(l) + 0.5) * (e - o) / l
        y = n - (np.arange(h) + 0.5) * (n - s) / h
        i = np.floor((x - o0) / (e0 - o0) * largeur).astype(int)
        j = np.floor((n0 - y) / (n0 - s0) * hauteur).astype(int)
        jj, ii = np.meshgrid(j, i, indexing="ij")
        v = ((ii * 7 + jj * 13) % 2003 / 10.0 - 0.04).astype("<f4")
        v[(ii + jj) % 17 == 0] = -99999.0
        v[(ii * jj) % 23 == 5] = np.nan
        return v.tobytes()
    return bil_wms


@pytest.mark.parametrize("brut", [False, True])
def test_une_grille_trop_grande_est_lue_en_tuiles_a_l_identique(monkeypatch, brut):
    """Au-delà du plafond du WMS (une zone de plus de 1 024 m à 0,5 m), la
    grille se lit en tuiles qui pavent l'emprise sans trou ni recouvrement,
    et chaque cellule y a la valeur qu'une requête unique lui donnerait."""
    emprise, largeur, hauteur = (5.19, 43.90, 5.2147, 43.918), 40, 37
    seule, tuiles = [], []
    monkeypatch.setattr(mnh, "_bil_wms", _service_bil(seule, emprise, largeur, hauteur))
    attendue = mnh._grille_wms(mnh.MNH_LAYER, *emprise, largeur, hauteur, brut=brut)
    assert len(seule) == 1
    monkeypatch.setattr(mnh, "WMS_PIXELS_MAX", 16)
    monkeypatch.setattr(mnh, "_bil_wms", _service_bil(tuiles, emprise, largeur, hauteur))
    obtenue = mnh._grille_wms(mnh.MNH_LAYER, *emprise, largeur, hauteur, brut=brut)
    assert len(tuiles) == 3 * 3 and max(max(t[4], t[5]) for t in tuiles) <= 16
    assert sum(t[4] * t[5] for t in tuiles) == largeur * hauteur
    assert type(obtenue) is list and all(type(v) is float for v in obtenue)
    assert [repr(v) for v in obtenue] == [repr(v) for v in attendue]
    # Le nodata et NaN ont traversé les tuiles : gardés bruts, nettoyés sinon.
    assert (-99999.0 in obtenue and any(v != v for v in obtenue)) if brut else 0.0 in obtenue


def test_une_tuile_illisible_fait_echouer_toute_la_grille(monkeypatch):
    """Une tuile perdue ne laisse pas de trou à zéro dans la grille : la
    lecture lève, et la scène est incomplète."""
    emprise, largeur, hauteur = (5.19, 43.90, 5.2147, 43.918), 40, 37
    service = _service_bil([], emprise, largeur, hauteur)

    def en_panne(layer, o, s, e, n, l, h):
        if h < 16:                          # la rangée du sud
            raise requests.RequestException("HTTP 400")
        return service(layer, o, s, e, n, l, h)

    monkeypatch.setattr(mnh, "WMS_PIXELS_MAX", 16)
    monkeypatch.setattr(mnh, "_bil_wms", en_panne)
    with pytest.raises(requests.RequestException):
        mnh._grille_wms(mnh.MNH_LAYER, *emprise, largeur, hauteur)
