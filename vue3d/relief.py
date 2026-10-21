"""Relief RGE ALTI, embarqué dans la scène plutôt que téléchargé par la vue.

La vue demandait elle-même au WMS de l'IGN une grille BIL float32 de 256 points
de côté, soit 263 Ko à chaque ouverture, sur le même hôte que les seize tuiles
d'orthophoto — un navigateur n'ouvrant que six connexions par hôte, tout cela
se met en file.

La même grille, quantifiée en décimètres sur des entiers 16 bits et rapportée à
son minimum, tient dans une dizaine de kilo-octets une fois la scène
compressé : le relief est lisse, donc ses différences le sont aussi. Mesuré sur
un site de plaine, 2,4 m de dénivelé sur 356 m.

La résolution est celle que la vue employait déjà, et l'erreur d'interpolation
en découle. Mesurée contre une référence à 512 points de côté sur la même
emprise :

    grille      maille     erreur médiane   p95      compressé
     96          3,7 m        0,03 m       0,27 m       2 Ko
    128          2,8 m        0,02 m       0,19 m       4 Ko
    178          2,0 m        0,01 m       0,10 m       7 Ko
    256          1,4 m        0,00 m       0,07 m      10 Ko

Le maillage du terrain place un sommet tous les 2 m : 256 le nourrit largement,
et c'est le même coût qu'une grille plus grossière une fois compressée.

Hors couverture (étranger, outre-mer) le service rend −99999 partout. Au-delà
de quelques pour cent de trous on est en bord de couverture : mieux vaut
laisser la vue basculer sur son repli mondial que rapiécer.
"""

import base64
import io
import logging
import math
import struct

import numpy as np
import requests
from PIL import Image

from .geopf import get_avec_reprise, place

journal = logging.getLogger(__name__)

RELIEF_LAYER = "ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES"
# Le MNT LiDAR HD, même emprise et même WMS que le RGE ALTI. Il sert de
# remplacement là où le RGE ALTI vient d'une source moins précise.
LIDAR_LAYER = "IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G"
# Le masque de source du RGE ALTI : la couche qui dit d'où vient chaque dalle et
# quelle est son erreur maximale. `ELEVATION.ELEVATIONGRIDCOVERAGE.THRESHOLD`,
# souvent confondue avec elle, est la carte des seuils de pente pour
# l'agriculture et ne dit rien de la précision du MNT.
QUALITE_LAYER = "ELEVATIONGRIDCOVERAGE.HIGHRES.QUALITY"
# Couleurs de la légende du masque (IGN). Le WMS les rend à un ou deux points
# près, avec un canal alpha : la classe est la plus proche, à moins de 30.
QUALITE_COULEURS = (
    ((194, 214, 155), "laser30"),
    ((234, 241, 221), "laser50"),
    ((118, 146, 60), "laser80"),
    ((198, 217, 241), "images70"),
    ((0, 176, 240), "images5"),
    ((79, 129, 189), "images10"),
    ((227, 108, 10), "radar"),
    ((148, 54, 52), "bdalti"),
    ((0, 0, 0), "autre"),
    ((183, 183, 183), "limite"),
)
QUALITE_LASER = frozenset(("laser30", "laser50", "laser80"))
QUALITE_TOLERANCE = 30
# Altitudes LiDAR aberrantes : la mer et les dalles non couvertes. Le RGE ALTI
# borne déjà ses trous à -20 m ; le LiDAR descend plus bas sur les côtes.
LIDAR_SOUS_M = -20
LIDAR_SUR_M = 9000

RELIEF_TAILLE = 256
RELIEF_NODATA = -99999
# Au-delà, l'emprise est en bord de couverture : on ne renvoie rien.
RELIEF_PART_TROUS_MAX = 0.02
# Pas de quantification : le décimètre, très en deçà de l'erreur propre du RGE
# ALTI (0,54 à 0,72 m de médiane selon les sites).
RELIEF_PAS_M = 0.1
RELIEF_SENTINELLE = -32768
# Le service rééchantillonne SANS masquer ses −99 999 : il les mélange à leurs
# voisins, et sort des altitudes de −99 955 m, −8 700 m ou −13 m à quelques
# pixels du trou. Sous ce seuil, une altitude est un trou ; le plus bas mesuré
# hors trou est −5 m, sur l'estran de Saint-Malo.
RELIEF_TROU_SOUS_M = -20
# Le mélange déborde du contour à −20 m sur une bande de largeur à peu près
# constante en mètres, quelle que soit la maille. Plus basse altitude restante
# après élargissement de k pixels, mesurée le 2026-10-15 :
#
#                                maille    k=2     k=3     k=5
#   Monaco, 1 000 m, 512 points   2 m     −13,4    0,5     0,5
#   Menton port, 500 m, 256       2 m     −14,0   −0,5    −0,5
#   Monaco, 1 000 m, 1 000        1 m     −13,4   −13,4    0,5
#   Nice port, 1 000 m, 1 000     1 m     −18,5   −18,5   −0,1
#
# À Monaco, 372 de ces altitudes mêlées (−99 955 à −82 158 m) passaient pour
# du relief à côté de 827 trous (0,3 %, relief accepté) : le minimum devenait
# le zéro de la grille, tout le reste saturait les 16 bits, et la vue posait
# l'anneau et l'horizon à 96 km au-dessus de la scène.
RELIEF_TROU_ELARGISSEMENT_M = 6
M_PAR_DEGRE_LAT = 111320


def _bil_layer(layer, west, south, east, north, largeur, hauteur):
    """GetMap BIL32 d'une couche d'altitude, décodé en grille de flottants.

    Trois pièges, tous vérifiés contre le service : en WMS 1.3.0 avec EPSG:4326
    la BBOX s'écrit lat,lon ; le corps est du float32 petit-boutiste brut,
    première ligne au nord ; une erreur arrive en XML avec un code 200, c'est
    donc le type de contenu qui tranche.
    """
    url = (
        "https://data.geopf.fr/wms-r/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap"
        f"&LAYERS={layer}&STYLES=&CRS=EPSG:4326"
        "&FORMAT=image/x-bil;bits=32"
        f"&WIDTH={largeur}&HEIGHT={hauteur}"
        f"&BBOX={south},{west},{north},{east}"
    )
    with place():
        reponse = get_avec_reprise(url)
    reponse.raise_for_status()
    if "bil" not in reponse.headers.get("Content-Type", ""):
        raise requests.RequestException(
            f"Réponse relief inattendue ({reponse.headers.get('Content-Type')}): "
            f"{reponse.text[:200]}")
    attendu = largeur * hauteur * 4
    if len(reponse.content) < attendu:
        raise requests.RequestException("BIL relief tronqué")
    return np.frombuffer(reponse.content[:attendu], dtype="<f4").reshape(hauteur, largeur)


def _bil(west, south, east, north, largeur, hauteur):
    """RGE ALTI, la source de référence de la scène."""
    return _bil_layer(RELIEF_LAYER, west, south, east, north, largeur, hauteur)


def _bil_lidar(west, south, east, north, largeur, hauteur):
    """MNT LiDAR HD, la source de remplacement quand elle couvre l'emprise."""
    return _bil_layer(LIDAR_LAYER, west, south, east, north, largeur, hauteur)


def _qualite(west, south, east, north, largeur, hauteur):
    """PNG du masque de source du RGE ALTI, en 4 canaux (RGBA)."""
    url = (
        "https://data.geopf.fr/wms-r/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap"
        f"&LAYERS={QUALITE_LAYER}&STYLES=&CRS=EPSG:4326"
        "&FORMAT=image/png"
        f"&WIDTH={largeur}&HEIGHT={hauteur}"
        f"&BBOX={south},{west},{north},{east}"
    )
    with place():
        reponse = get_avec_reprise(url)
    reponse.raise_for_status()
    if "png" not in reponse.headers.get("Content-Type", ""):
        raise requests.RequestException(
            f"Masque de source inattendu ({reponse.headers.get('Content-Type')}): "
            f"{reponse.text[:200]}")
    return reponse.content


def _classes_qualite(png, largeur, hauteur):
    """Classe de chaque pixel du masque, -1 quand la couleur n'est pas connue.

    Le PNG du WMS est translucide et anticrénelé : les pixels de bord ne
    tombent pas exactement sur une couleur de la légende. On les laisse
    inconnus, donc au RGE ALTI, plutôt que de deviner.
    """
    with Image.open(io.BytesIO(png)) as image:
        image = image.convert("RGBA")
        if image.size != (largeur, hauteur):
            image = image.resize((largeur, hauteur), Image.NEAREST)
        pixels = np.asarray(image)
    rgb = pixels[..., :3].astype(np.int32)
    couleurs = np.asarray([couleur for couleur, _ in QUALITE_COULEURS], dtype=np.int32)
    distances = ((rgb[:, :, None, :] - couleurs[None, None, :, :]) ** 2).sum(axis=-1)
    index = distances.argmin(axis=-1)
    connus = ((distances.min(axis=-1) <= QUALITE_TOLERANCE ** 2)
              & (pixels[..., 3] >= 32))
    classes = np.full((hauteur, largeur), -1, dtype=np.int8)
    classes[connus] = index[connus]
    return classes


def _flou(masque, rayon=2):
    """Moyenne 5 points répétée : une transition de quelques pixels entre les
    deux sources, plutôt qu'une marche à la frontière de deux dalles."""
    doux = masque.astype(np.float64)
    for _ in range(rayon):
        p = np.pad(doux, 1, mode="edge")
        doux = (p[1:-1, 1:-1] + p[:-2, 1:-1] + p[2:, 1:-1]
                + p[1:-1, :-2] + p[1:-1, 2:]) / 5.0
    return doux


def fetch_altitudes(west, south, east, north, taille):
    """Grille brute du RGE ALTI, `taille` points de côté, ligne 0 au nord, trous
    compris (RELIEF_NODATA, ou ce que le service en mêle à leurs voisins :
    voir RELIEF_TROU_SOUS_M). Pour dire où est la mer (vehicules.fetch_mer),
    jamais pour la scène.

    Raises:
        requests.RequestException si le service n'a pas répondu.
    """
    return _bil(*map(float, (west, south, east, north)), taille, taille).astype(np.float64)


def _quantifier(grille, trous, west, south, east, north):
    """Grille d'altitudes en décimètres au-dessus de son minimum, en base64.

    Au-delà de 3 276,7 m d'étendue, le pas grandit d'autant de décimètres
    qu'il faut : un plafond silencieux aplatirait tout ce qui dépasse.
    """
    hauteur, largeur = grille.shape
    zero = float(np.floor(grille[~trous].min()))
    pas = RELIEF_PAS_M
    etendue = float(grille[~trous].max()) - zero
    if np.rint(etendue / pas) > 32767:
        pas = round(RELIEF_PAS_M * math.ceil(etendue / (RELIEF_PAS_M * 32767)), 1)
    quant = np.rint((grille - zero) / pas)
    quant = np.clip(quant, RELIEF_SENTINELLE + 1, 32767)
    quant[trous] = RELIEF_SENTINELLE
    return {
        "width": largeur, "height": hauteur,
        "bbox": [west, south, east, north],
        "zero_m": round(zero, 1),
        "pas_m": pas,
        "source": "RGE ALTI (IGN)",
        "precision": "1 m, modèle de terrain",
        "altitudes": base64.b64encode(quant.astype("<i2").tobytes()).decode("ascii"),
    }


def fetch_relief(west, south, east, north, taille=RELIEF_TAILLE, lidar=True):
    """Relief de l'emprise, prêt à embarquer dans la scène.

    Le RGE ALTI reste la source de référence. Là où son masque de source dit
    qu'il vient d'images, de radar ou de BD ALTI — donc d'une source moins
    précise que le LiDAR —, le MNT LiDAR HD le remplace cellule pour cellule
    quand il couvre l'emprise. Ailleurs, le RGE ALTI est déjà issu du LiDAR ou
    le LiDAR manque : il est conservé tel quel.

    `qualite` porte le PNG du masque de source, pour la vue qui l'affiche ;
    `lidar_part` dit quelle part de la grille a effectivement changé de source.

    Returns:
        dict(width, height, bbox, zero_m, pas_m, altitudes) où `altitudes` est
        un tableau d'entiers 16 bits encodé en base64, en pas de 0,1 m au-dessus
        de `zero_m`, ligne 0 au nord. Les trous valent RELIEF_SENTINELLE.
        `lidar_part` dit la part de la grille venue du LiDAR, `source` et
        `precision` le disent en clair quand elle n'est pas nulle, et `qualite`
        porte le PNG du masque en base64 quand il a été lu.
        None si l'emprise n'est pas couverte.
    """
    west, south, east, north = map(float, (west, south, east, north))
    grille = _bil(west, south, east, north, taille, taille).astype(np.float64)

    qualite_png = None
    classes = None
    if lidar:
        # Le masque est un confort : s'il manque, le RGE ALTI suffit et la
        # scène ne doit pas échouer pour lui.
        try:
            qualite_png = _qualite(west, south, east, north, taille, taille)
            classes = _classes_qualite(qualite_png, taille, taille)
        except Exception as exc:  # noqa: BLE001 - service public, panne banale
            journal.warning("Masque de source du RGE ALTI indisponible : %s", exc)

    poids = None
    if classes is not None:
        indices_non_laser = [i for i, (_, nom) in enumerate(QUALITE_COULEURS)
                             if nom not in QUALITE_LASER]
        a_remplacer = np.isin(classes, indices_non_laser)
        if a_remplacer.any():
            try:
                lidar_grid = _bil_lidar(west, south, east, north, taille, taille).astype(np.float64)
            except Exception as exc:  # noqa: BLE001 - le RGE ALTI reste valable
                journal.warning("MNT LiDAR HD indisponible : %s", exc)
            else:
                valide = (lidar_grid > LIDAR_SOUS_M) & (lidar_grid < LIDAR_SUR_M)
                poids = _flou((a_remplacer & valide).astype(np.float64), 2)
                if poids.max() > 0:
                    grille = grille * (1.0 - poids) + lidar_grid * poids
                else:
                    poids = None

    maille = (north - south) * M_PAR_DEGRE_LAT / max(taille - 1, 1)
    trous = _elargir(grille < RELIEF_TROU_SOUS_M, math.ceil(RELIEF_TROU_ELARGISSEMENT_M / maille))
    if trous.mean() > RELIEF_PART_TROUS_MAX:
        return None
    if trous.all():
        return None
    relief = _quantifier(grille, trous, west, south, east, north)
    part = round(float(poids.mean()), 3) if poids is not None else 0.0
    relief["lidar_part"] = part
    if part > 0:
        relief["source"] = "LiDAR HD + RGE ALTI"
        relief["precision"] = ("1 m, LiDAR HD là où le RGE ALTI vient d'images, "
                               "de radar ou de BD ALTI")
    if qualite_png:
        relief["qualite"] = base64.b64encode(qualite_png).decode("ascii")
    return relief


# --- Anneau de contexte ---------------------------------------------------
# Autour de la scène, un relief grossier évite l'effet de maquette posée dans
# le vide. Il se fond dans le brouillard de la vue : sa précision compte peu,
# son poids beaucoup moins encore. Mesuré sur 2 km de côté contre une
# référence à 512 points, pour la même emprise :
#
#                      grille 64   96     128    192
#   maille               32 m     21 m   16 m   10 m
#   Versailles  méd.     0,38     0,24   0,18   0,12 m    (34 m de dénivelé)
#               p95      2,2      1,5    1,2    0,7 m
#   Gordes      méd.     2,3      1,4    1,1    0,7 m     (242 m)
#               p95     10,5      6,9    5,2    3,5 m
#   Chamonix    p95     27,9     18,9   15,0    9,1 m     (671 m)
#   compressé           3 Ko     7 Ko  12 Ko   26 Ko
#
# 128 : un mètre d'erreur médiane même en pente, pour 12 Ko au plus.
ANNEAU_TAILLE = 128
# L'anneau touche la mer ou la frontière bien plus souvent que la scène : un
# quart de trous à Saint-Malo comme à Menton. Il n'est donc pas refusé pour
# autant, ses trous restent simplement vides.
#
# Ses trous mêlés aux voisins (RELIEF_TROU_SOUS_M) : mesuré à Saint-Malo et
# Menton, un élargissement de deux pixels (31 m) est le premier qui ne laisse
# que des altitudes plausibles (−5 m au plus bas, sur l'estran).
ANNEAU_ELARGISSEMENT = 2


def _elargir(masque, pas):
    """Dilatation en croix de `pas` pixels, sans dépendance à scipy."""
    for _ in range(pas):
        m = masque.copy()
        m[1:] |= masque[:-1]
        m[:-1] |= masque[1:]
        m[:, 1:] |= masque[:, :-1]
        m[:, :-1] |= masque[:, 1:]
        masque = m
    return masque


def fetch_relief_anneau(west, south, east, north, taille=ANNEAU_TAILLE):
    """Relief grossier autour de la scène, trous compris.

    Même format que `fetch_relief`. None seulement si rien n'est couvert.
    """
    west, south, east, north = map(float, (west, south, east, north))
    grille = _bil(west, south, east, north, taille, taille).astype(np.float64)
    trous = _elargir(grille < RELIEF_TROU_SOUS_M, ANNEAU_ELARGISSEMENT)
    if trous.all():
        return None
    return _quantifier(grille, trous, west, south, east, north)


def echantillonneur(relief):
    """Altitude du relief embarqué en un point, telle que la vue la lit.

    Même interpolation bilinéaire que la page (nœuds de la grille aux bords de
    l'emprise, ligne 0 au nord) : une hauteur comptée ici au-dessus du relief
    est celle que la vue dessinera.

    Returns:
        fonction (lon, lat) -> altitude en mètres, ou None hors de la grille
        et près d'un trou ; None si la scène n'a pas de relief.
    """
    if not relief or not relief.get("altitudes"):
        return None
    largeur, hauteur = relief["width"], relief["height"]
    quant = np.frombuffer(base64.b64decode(relief["altitudes"]), dtype="<i2")
    if quant.size != largeur * hauteur:
        return None
    alt = relief["zero_m"] + quant.reshape(hauteur, largeur).astype(np.float64) * relief["pas_m"]
    alt[quant.reshape(hauteur, largeur) == RELIEF_SENTINELLE] = np.nan
    west, south, east, north = relief["bbox"]

    def altitude(lon, lat):
        fx = (lon - west) / (east - west) * (largeur - 1)
        fy = (north - lat) / (north - south) * (hauteur - 1)
        if not (0 <= fx <= largeur - 1 and 0 <= fy <= hauteur - 1):
            return None
        x0, y0 = int(fx), int(fy)
        x1, y1 = min(x0 + 1, largeur - 1), min(y0 + 1, hauteur - 1)
        ax, ay = fx - x0, fy - y0
        a = ((alt[y0, x0] * (1 - ax) + alt[y0, x1] * ax) * (1 - ay)
             + (alt[y1, x0] * (1 - ax) + alt[y1, x1] * ax) * ay)
        return None if np.isnan(a) else float(a)

    return altitude
