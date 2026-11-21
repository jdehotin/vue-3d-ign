"""La végétation vue par le nuage LiDAR HD classé, en carte 2D.

L'IGN publie une « simplification 2D de la classification du nuage de points
LiDAR HD » (WMS IGNF_LIDAR-HD_CLASS) : chaque pixel a la couleur de la classe
de ce que le nuage voit d'en haut — sol, végétation, bâti, eau. Elle dit si un
toit est sous les arbres mieux que l'orthophoto, que les toitures lisaient
jusqu'ici (indice de verdure ExG, vue3d/ortho.py) : le seuil ExG ≥ 4 voit
« vert » le parvis de la cathédrale de Strasbourg, la place du Château, des
toits gris et les routes de Gordes.

Mesuré le 21 novembre 2026, zones de 1 000 m, vérité prise au nuage complet
(point le plus haut de chaque maille de 0,5 m dans l'emprise, végétation
3, 4 ou 5 sur plus d'un tiers des mailles) :

                      sous les arbres     ExG ≥ 4 en rejette à tort
    Gordes            75 bât. (4 % aire)  313 (43 % de l'aire des toits)
    Strasbourg        10 bât. (0 %)       369 (39 %)

Aucun seuil ExG ne les sépare : à 12, Gordes garde 57 toits rejetés à tort et
manque 30 des 75 vrais. Les classes du nuage le font sans seuil ; lues dans
les dalles COPC, elles coûtaient 46 à 63 Mo et 8 à 14 s par zone de 1 000 m
même à 1 m de résolution, et cette carte tient en une requête, comme
l'orthophoto.

Une image PNG, aux couleurs exactes de la légende (LIDARHD-CLASS-legend.png),
relevées sur les images servies : une couleur inconnue n'est pas de la
végétation. Un pixel transparent n'a pas de point ; hors couverture LiDAR HD,
toute l'image l'est.
"""

import io

import numpy as np
import requests

from .geopf import en_parallele, get_avec_reprise, place
from .mnh import WMS_PIXELS_MAX, bbox_tuile, tuiles_wms

CLASSES_LAYER = "IGNF_LIDAR-HD_CLASS"
# Végétation moyenne (0,5 à 1,5 m) et haute (au-delà) : la même couleur dans
# les images servies. La végétation basse (90, 110, 40), sous 0,5 m, ne cache
# pas un toit.
COULEUR_VEGETATION = (70, 150, 60)


def vegetation_depuis_image(contenu):
    """Masque (uint8, 1 : végétation moyenne ou haute) d'une image de la carte
    des classes, et la part de ses pixels classés (non transparents)."""
    from PIL import Image
    img = np.asarray(Image.open(io.BytesIO(contenu)).convert("RGBA"))
    vegetation = ((img[:, :, 0] == COULEUR_VEGETATION[0]) & (img[:, :, 1] == COULEUR_VEGETATION[1])
                  & (img[:, :, 2] == COULEUR_VEGETATION[2]) & (img[:, :, 3] == 255))
    return vegetation.astype(np.uint8), float((img[:, :, 3] > 0).mean())


def _image_classes(west, south, east, north, largeur, hauteur):
    # WMS 1.3.0 + EPSG:4326 => BBOX en lat,lon, comme pour le MNH ; en PNG,
    # sans quoi la compression changerait les couleurs.
    url = (
        "https://data.geopf.fr/wms-r/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap"
        f"&LAYERS={CLASSES_LAYER}&STYLES=&CRS=EPSG:4326"
        f"&BBOX={south},{west},{north},{east}"
        f"&WIDTH={largeur}&HEIGHT={hauteur}&FORMAT=image/png&TRANSPARENT=TRUE"
    )
    with place():
        reponse = get_avec_reprise(url)
    reponse.raise_for_status()
    if "image" not in reponse.headers.get("Content-Type", ""):
        raise requests.RequestException(
            f"Réponse de la carte des classes inattendue ({reponse.headers.get('Content-Type')}): "
            f"{reponse.text[:200]}")
    return reponse.content


def _vegetation_wms(west, south, east, north, largeur, hauteur):
    """Masque de végétation et part classée d'une seule image du WMS."""
    masque, classe = vegetation_depuis_image(_image_classes(west, south, east, north, largeur, hauteur))
    if masque.shape != (hauteur, largeur):
        # Une image d'une autre taille (service bridé) : ré-échantillonnée au
        # plus proche, comme l'orthophoto, pour garder l'alignement.
        from PIL import Image
        masque = np.asarray(Image.fromarray(masque).resize((largeur, hauteur), Image.NEAREST))
    return masque, classe


def fetch_vegetation_lidar(west, south, east, north, largeur, hauteur):
    """Végétation du LiDAR HD (uint8, hauteur × largeur, 1 : végétation moyenne
    ou haute), alignée sur la grille MNH comme la grille ExG ; None si la
    carte n'a aucun pixel classé — hors couverture LiDAR HD, un fait.

    Raises:
        requests.RequestException si une image n'a pu être lue.
    """
    west, south, east, north = map(float, (west, south, east, north))
    if largeur <= WMS_PIXELS_MAX and hauteur <= WMS_PIXELS_MAX:
        masque, classe = _vegetation_wms(west, south, east, north, largeur, hauteur)
        return masque if classe > 0 else None
    tuiles = tuiles_wms(largeur, hauteur, WMS_PIXELS_MAX)
    morceaux = en_parallele(*(
        lambda t=t: _vegetation_wms(*bbox_tuile(west, south, east, north, largeur, hauteur, t), t[2], t[3])
        for t in tuiles))
    masque = np.zeros((hauteur, largeur), dtype=np.uint8)
    for (x0, y0, l, h), (morceau, _) in zip(tuiles, morceaux):
        masque[y0:y0 + h, x0:x0 + l] = morceau
    return masque if any(classe > 0 for _, classe in morceaux) else None
