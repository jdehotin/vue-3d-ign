"""Carte des classes du LiDAR HD (vue3d/classes.py) : couleurs, tuiles, URL.
Ni réseau ni image de l'IGN : des PNG fabriqués aux couleurs de la légende."""
import io

import numpy as np
from PIL import Image

from vue3d import classes
from vue3d.classes import COULEUR_VEGETATION, fetch_vegetation_lidar, vegetation_depuis_image

SOL, BASSE, BATI, VIDE = (207, 150, 70, 255), (90, 110, 40, 255), (180, 20, 20, 255), (0, 0, 0, 0)
VERT = (*COULEUR_VEGETATION, 255)


def _png(pixels):
    tampon = io.BytesIO()
    Image.fromarray(np.asarray(pixels, dtype=np.uint8), "RGBA").save(tampon, "PNG")
    return tampon.getvalue()


def test_seule_la_vegetation_moyenne_et_haute_couvre_un_toit():
    masque, classe = vegetation_depuis_image(_png([[VERT, BASSE], [BATI, VIDE]]))
    assert masque.tolist() == [[1, 0], [0, 0]]
    assert classe == 0.75                       # trois pixels sur quatre ont un point


def test_hors_couverture_la_carte_ne_dit_rien(monkeypatch):
    monkeypatch.setattr(classes, "_image_classes", lambda *a: _png([[VIDE] * 3] * 2))
    assert fetch_vegetation_lidar(2.0, 48.0, 2.001, 48.001, 3, 2) is None
    monkeypatch.setattr(classes, "_image_classes", lambda *a: _png([[SOL, VERT, VIDE]] * 2))
    assert fetch_vegetation_lidar(2.0, 48.0, 2.001, 48.001, 3, 2).tolist() == [[0, 1, 0]] * 2


def test_une_grande_grille_se_lit_en_tuiles_alignees(monkeypatch):
    """Au-delà de WMS_PIXELS_MAX, des tuiles comme la grille MNH ; chacune à
    sa place. Une tuile servie plus petite est ré-échantillonnée."""
    monkeypatch.setattr(classes, "WMS_PIXELS_MAX", 4)
    vus = []

    def image(west, south, east, north, largeur, hauteur):
        vus.append((largeur, hauteur))
        couleur = VERT if west < 2.0005 else SOL     # la tuile de l'ouest en végétation
        return _png([[couleur] * max(largeur // 2, 1)] * max(hauteur // 2, 1))
    monkeypatch.setattr(classes, "_image_classes", image)
    masque = fetch_vegetation_lidar(2.0, 48.0, 2.001, 48.001, 6, 5)
    # Des tuiles de 4 pixels au plus : 4 + 2 colonnes, 4 + 1 lignes.
    assert masque.shape == (5, 6) and sorted(vus) == [(2, 1), (2, 4), (4, 1), (4, 4)]
    assert masque[:, :4].all() and not masque[:, 4:].any()


def test_la_requete_suit_la_regle_du_wms_en_epsg_4326(monkeypatch):
    urls = []

    class Reponse:
        headers = {"Content-Type": "image/png"}
        content = _png([[VERT]])

        def raise_for_status(self):
            pass
    monkeypatch.setattr(classes, "get_avec_reprise", lambda url, **k: urls.append(url) or Reponse())
    fetch_vegetation_lidar(2.0, 48.0, 2.001, 48.002, 1, 1)
    (url,) = urls
    assert "LAYERS=IGNF_LIDAR-HD_CLASS" in url and "FORMAT=image/png" in url
    assert "BBOX=48.0,2.0,48.002,2.001" in url          # lat,lon en WMS 1.3.0
