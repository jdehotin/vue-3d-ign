"""Relief RGE ALTI (vue3d/relief.py) : quantification, trous et LiDAR, sans réseau."""
import base64
import io

import numpy as np
import pytest
import requests
from PIL import Image

from vue3d import relief
from vue3d.relief import RELIEF_NODATA, RELIEF_SENTINELLE


def _decoder(r):
    q = np.frombuffer(base64.b64decode(r["altitudes"]), dtype="<i2").reshape(r["height"], r["width"])
    return q


@pytest.fixture
def bil(monkeypatch):
    """Remplace le WMS par une grille donnée, sans masque de source."""
    def poser(grille):
        monkeypatch.setattr(relief, "_bil", lambda *a: np.asarray(grille, dtype="<f4"))
        def pas_de_masque(*a):
            raise requests.RequestException("masque non simulé")
        monkeypatch.setattr(relief, "_qualite", pas_de_masque)
    return poser


def _png_qualite(classes):
    """Un PNG RGBA du masque, une couleur de la légende par classe."""
    couleurs = {
        "laser30": (194, 214, 155),
        "images70": (198, 217, 241),
        "radar": (227, 108, 10),
    }
    hauteur, largeur = classes.shape
    image = Image.new("RGBA", (largeur, hauteur))
    for y in range(hauteur):
        for x in range(largeur):
            image.putpixel((x, y), (*couleurs[classes[y, x]], 255))
    tampon = io.BytesIO()
    image.save(tampon, format="PNG")
    return tampon.getvalue()


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


def test_l_anneau_garde_ses_trous_et_les_elargit(bil):
    """Mer ou frontière : l'anneau est servi, ses trous restent vides. Le
    service mélange ses −99 999 aux voisins : les altitudes aberrantes autour
    d'un trou (ici −61 m) partent avec lui, élargies de deux pixels."""
    g = np.full((12, 12), 30.0)
    g[:, :3] = RELIEF_NODATA
    g[:, 3] = -61.0
    bil(g)
    r = relief.fetch_relief_anneau(2, 48, 2.1, 48.1, taille=12)
    q = _decoder(r)
    trous = q == RELIEF_SENTINELLE
    assert trous[:, :6].all() and not trous[:, 6:].any()
    assert r["zero_m"] == 30.0


def test_l_anneau_entierement_hors_couverture_est_absent(bil):
    bil(np.full((8, 8), RELIEF_NODATA))
    assert relief.fetch_relief_anneau(2, 48, 2.1, 48.1, taille=8) is None


def test_l_echantillonneur_relit_le_relief_comme_la_vue(bil):
    """Nœuds aux bords de l'emprise, ligne 0 au nord, bilinéaire entre eux."""
    bil(np.array([[100.0, 102.0], [110.0, 112.0]]))
    alt = relief.echantillonneur(relief.fetch_relief(2, 48, 2.1, 48.1, taille=2))
    assert alt(2, 48.1) == pytest.approx(100.0) and alt(2.1, 48) == pytest.approx(112.0)
    assert alt(2.05, 48.05) == pytest.approx(106.0)
    assert alt(2.2, 48.05) is None
    assert relief.echantillonneur(None) is None


def test_le_lidar_remplace_le_rge_ou_le_masque_n_est_pas_laser(monkeypatch):
    """Une moitié « images » passe au MNT LiDAR, l'autre, déjà laser, reste
    au RGE ALTI. La transition est fondue sur quelques pixels."""
    taille = 8
    classes = np.full((taille, taille), "laser30", dtype=object)
    classes[:, :taille // 2] = "images70"
    monkeypatch.setattr(relief, "_bil", lambda *a: np.full((taille, taille), 100.0, dtype="<f4"))
    monkeypatch.setattr(relief, "_bil_lidar", lambda *a: np.full((taille, taille), 110.0, dtype="<f4"))
    monkeypatch.setattr(relief, "_qualite", lambda *a: _png_qualite(classes))

    r = relief.fetch_relief(2, 48, 2.1, 48.1, taille=taille)
    alt = relief.echantillonneur(r)
    assert r["source"] == "LiDAR HD + RGE ALTI"
    assert 0 < r["lidar_part"] < 1
    assert r["qualite"]
    assert alt(2.01, 48.05) == pytest.approx(110.0, abs=0.1)
    assert alt(2.09, 48.05) == pytest.approx(100.0, abs=0.1)


def test_le_lidar_n_est_pas_lu_quand_le_rge_est_deja_laser(monkeypatch):
    """Le masque dit que le RGE ALTI vient du LiDAR : inutile de le relire."""
    taille = 8
    classes = np.full((taille, taille), "laser30", dtype=object)
    monkeypatch.setattr(relief, "_bil", lambda *a: np.full((taille, taille), 100.0, dtype="<f4"))
    monkeypatch.setattr(relief, "_qualite", lambda *a: _png_qualite(classes))
    monkeypatch.setattr(relief, "_bil_lidar",
                        lambda *a: (_ for _ in ()).throw(AssertionError("LiDAR lu à tort")))

    r = relief.fetch_relief(2, 48, 2.1, 48.1, taille=taille)
    assert r["source"] == "RGE ALTI (IGN)"
    assert r["lidar_part"] == 0.0
    assert r["qualite"]
