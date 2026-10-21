"""Relief RGE ALTI (vue3d/relief.py) : quantification et trous, sans réseau."""
import base64

import numpy as np
import pytest
import requests

from vue3d import geopf, relief
from vue3d.relief import RELIEF_NODATA, RELIEF_SENTINELLE


def _decoder(r):
    q = np.frombuffer(base64.b64decode(r["altitudes"]), dtype="<i2").reshape(r["height"], r["width"])
    return q


@pytest.fixture
def bil(monkeypatch):
    """Remplace le WMS par une grille donnée."""
    def poser(grille):
        monkeypatch.setattr(relief, "_bil", lambda *a: np.asarray(grille, dtype="<f4"))
    return poser


def test_le_relief_est_quantifie_au_decimetre_au_dessus_du_minimum(bil):
    bil(np.array([[100.04, 100.26], [101.0, 102.5]]))
    r = relief.fetch_relief(2, 48, 2.1, 48.1, taille=2)
    assert r["zero_m"] == 100.0
    assert _decoder(r).tolist() == [[0, 3], [10, 25]]


def test_la_scene_hors_couverture_n_a_pas_de_relief(bil):
    g = np.full((10, 10), 50.0)
    g[0, :3] = RELIEF_NODATA          # 3 % de trous : bord de couverture
    bil(g)
    assert relief.fetch_relief(2, 48, 2.1, 48.1, taille=10) is None


def test_les_trous_meles_aux_voisins_ne_font_pas_le_zero_de_la_scene(bil):
    """Monaco : quelques trous de mer dans un coin (0,3 %), et autour d'eux des
    altitudes où le service a mêlé son −99 999 aux voisins (−99 955 m, puis
    −13 m un peu plus loin). Comptées comme du relief, la première faisait le
    zéro de la grille et tout le reste saturait les 16 bits."""
    taille = 100
    sud, nord = 43.7327, 43.7327 + 2.0 * (taille - 1) / relief.M_PAR_DEGRE_LAT   # 2 m de maille
    g = np.full((taille, taille), 30.0)
    g[-3:, -3:] = RELIEF_NODATA
    g[-4, -4:] = g[-4:, -4] = -99955.0
    g[-5, -5:] = g[-5:, -5] = -13.0
    bil(g)
    r = relief.fetch_relief(7.42, sud, 7.4225, nord, taille=taille)
    assert r is not None
    q = _decoder(r)
    trous = q == RELIEF_SENTINELLE
    assert trous[-5:, -5:].all() and not trous[:80, :80].any()
    assert r["zero_m"] == 30.0 and r["pas_m"] == 0.1
    assert (q[~trous] == 0).all()


def test_un_relief_de_plus_de_3276_m_garde_ses_sommets(bil):
    """Le pas grandit plutôt que de plafonner les entiers 16 bits."""
    bil(np.array([[0.0, 4000.0], [1000.0, 2000.0]]))
    r = relief.fetch_relief(2, 48, 2.1, 48.1, taille=2)
    assert r["pas_m"] == 0.2
    alt = relief.echantillonneur(r)
    assert alt(2.1, 48.1) == pytest.approx(4000.0, abs=0.1)
    assert alt(2.0, 48.0) == pytest.approx(1000.0, abs=0.1)


# --- Anneau, lu dans les tuiles natives -----------------------------------------
# Une emprise de 44 m de maille (l'anneau d'une zone de 1 000 m) à cheval sur
# deux lignes et deux colonnes de tuiles du niveau 11, près de la
# Sainte-Victoire.
ANNEAU = (5.59, 43.48, 5.66, 43.53)
P11 = relief._pixel_deg(11)


@pytest.fixture
def natives(monkeypatch):
    """Remplace les tuiles WMTS par une fonction des pixels natifs (colonne X,
    ligne Y, comptées depuis −180°, 90°) ; rend la liste des tuiles lues."""
    lues = []

    def poser(altitude):
        def tuile(niveau, ligne, colonne):
            lues.append((niveau, ligne, colonne))
            y, x = np.mgrid[0:256, 0:256]
            return altitude(colonne * 256 + x, ligne * 256 + y).astype(np.float64)
        monkeypatch.setattr(relief, "_tuile_native", tuile)
        return lues
    return poser


def _noeuds(emprise, taille):
    """Coordonnées des nœuds de l'anneau en pixels natifs du niveau 11."""
    o, s, e, n = emprise
    x = (o + (e - o) * np.arange(taille) / (taille - 1) + 180) / P11 - 0.5
    y = (90 - (n - (n - s) * np.arange(taille) / (taille - 1))) / P11 - 0.5
    return x, y


def test_l_anneau_interpole_les_pixels_natifs_a_travers_les_tuiles(natives):
    """Centres des pixels aux demi-entiers, tuiles raboutées sans décalage :
    un plan incliné ressort exact à chaque nœud (au décimètre près), même à
    travers les coutures des quatre tuiles."""
    lues = natives(lambda x, y: 200 + 0.5 * (x - 540_500) + 0.25 * (y - 135_200))
    r = relief.fetch_relief_anneau(*ANNEAU, taille=128)
    assert sorted(lues) == [(11, 528, 2111), (11, 528, 2112), (11, 529, 2111), (11, 529, 2112)]
    x, y = _noeuds(ANNEAU, 128)
    attendu = 200 + 0.5 * (x[None, :] - 540_500) + 0.25 * (y[:, None] - 135_200)
    obtenu = r["zero_m"] + _decoder(r) * r["pas_m"]
    assert np.abs(obtenu - attendu).max() <= 0.05 + 1e-9


def test_le_niveau_natif_est_le_plus_grossier_sous_la_maille():
    assert relief._niveau_natif(43.48, 43.53, 128) == 11        # 44 m : 38 m
    assert relief._niveau_natif(43.0, 43.018, 128) == 13        # 16 m : 9,6 m
    assert relief._niveau_natif(43.0, 43.001, 128) == 14        # sous le natif


def test_l_anneau_garde_ses_trous_et_les_elargit_d_un_pixel(natives):
    """Mer ou frontière : l'anneau est servi, ses trous restent vides. La
    pyramide mêle ses −99 999 aux voisins : l'altitude aberrante au bord d'un
    trou (ici −61 m) part avec lui, puis un pixel de plus ; un nœud dont un
    pixel voisin est un trou en est un."""
    x_trou = 540_600
    natives(lambda x, y: np.where(x < x_trou, RELIEF_NODATA, np.where(x == x_trou, -61.0, 30.0)))
    r = relief.fetch_relief_anneau(*ANNEAU, taille=128)
    trous = _decoder(r) == RELIEF_SENTINELLE
    x, _ = _noeuds(ANNEAU, 128)
    attendus = np.floor(x) <= x_trou + 1
    assert attendus.any() and not attendus.all()
    assert (trous == attendus[None, :]).all()
    assert r["zero_m"] == 30.0 and (_decoder(r)[~trous] == 0).all()


def test_l_anneau_entierement_hors_couverture_est_absent(natives):
    natives(lambda x, y: np.full(x.shape, float(RELIEF_NODATA)))
    assert relief.fetch_relief_anneau(*ANNEAU, taille=8) is None


class _Reponse:
    def __init__(self, code, contenu=b"", type_="image/x-bil;bits=32"):
        self.status_code = code
        self.ok = code < 400
        self.content = contenu
        self.text = contenu.decode("latin-1")
        self.headers = {"Content-Type": type_}


@pytest.fixture
def service(monkeypatch):
    """Le service WMTS, réponse par réponse, sans attente entre les reprises."""
    monkeypatch.setattr(geopf, "_places", geopf._Places(geopf.GEOPF_SIMULTANEES))
    monkeypatch.setattr(geopf.time, "sleep", lambda s: None)
    reponses = []
    monkeypatch.setattr(geopf.requests, "get", lambda url, timeout: reponses.pop(0))
    return reponses


def test_une_tuile_hors_de_la_pyramide_est_un_trou_un_refus_un_echec(service):
    """Un 404 jusqu'au bout est le large ou l'étranger : des trous. Un refus
    passager est réessayé ; persistant, ou une page d'erreur rendue en 200,
    la lecture échoue — la scène aussi, plutôt que d'être écrite trouée."""
    plat = np.full((256, 256), 12.5, dtype="<f4").tobytes()
    service[:] = [_Reponse(404)] * geopf.GEOPF_ESSAIS
    assert (relief._tuile_native(11, 528, 2111) == RELIEF_NODATA).all()
    service[:] = [_Reponse(400), _Reponse(200, plat)]
    assert (relief._tuile_native(11, 528, 2111) == 12.5).all()
    service[:] = [_Reponse(502)] * geopf.GEOPF_ESSAIS
    with pytest.raises(requests.RequestException):
        relief._tuile_native(11, 528, 2111)
    service[:] = [_Reponse(200, b"<ExceptionReport/>", "application/xml")]
    with pytest.raises(requests.RequestException):
        relief._tuile_native(11, 528, 2111)
    service[:] = [_Reponse(200, plat[:1000])]
    with pytest.raises(requests.RequestException, match="tronquée"):
        relief._tuile_native(11, 528, 2111)


def test_l_echantillonneur_relit_le_relief_comme_la_vue(bil):
    """Nœuds aux bords de l'emprise, ligne 0 au nord, bilinéaire entre eux."""
    bil(np.array([[100.0, 102.0], [110.0, 112.0]]))
    alt = relief.echantillonneur(relief.fetch_relief(2, 48, 2.1, 48.1, taille=2))
    assert alt(2, 48.1) == pytest.approx(100.0) and alt(2.1, 48) == pytest.approx(112.0)
    assert alt(2.05, 48.05) == pytest.approx(106.0)
    assert alt(2.2, 48.05) is None
    assert relief.echantillonneur(None) is None
