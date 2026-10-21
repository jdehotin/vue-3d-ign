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
import functools
import math
import struct

import numpy as np
import requests

from .geopf import en_parallele, get_avec_reprise, place

RELIEF_LAYER = "ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES"
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


def _bil(west, south, east, north, largeur, hauteur):
    """GetMap BIL32 sur la couche d'altitude, décodé en grille de flottants.

    Trois pièges, tous vérifiés contre le service : en WMS 1.3.0 avec EPSG:4326
    la BBOX s'écrit lat,lon ; le corps est du float32 petit-boutiste brut,
    première ligne au nord ; une erreur arrive en XML avec un code 200, c'est
    donc le type de contenu qui tranche.
    """
    url = (
        "https://data.geopf.fr/wms-r/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap"
        f"&LAYERS={RELIEF_LAYER}&STYLES=&CRS=EPSG:4326"
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


def fetch_relief(west, south, east, north, taille=RELIEF_TAILLE):
    """Relief de l'emprise, prêt à embarquer dans la scène.

    Returns:
        dict(width, height, bbox, zero_m, pas_m, altitudes) où `altitudes` est
        un tableau d'entiers 16 bits encodé en base64, en pas de 0,1 m au-dessus
        de `zero_m`, ligne 0 au nord. Les trous valent RELIEF_SENTINELLE.
        None si l'emprise n'est pas couverte.
    """
    west, south, east, north = map(float, (west, south, east, north))
    grille = _bil(west, south, east, north, taille, taille).astype(np.float64)
    maille = (north - south) * M_PAR_DEGRE_LAT / max(taille - 1, 1)
    trous = _elargir(grille < RELIEF_TROU_SOUS_M, math.ceil(RELIEF_TROU_ELARGISSEMENT_M / maille))
    if trous.mean() > RELIEF_PART_TROUS_MAX:
        return None
    if trous.all():
        return None
    return _quantifier(grille, trous, west, south, east, north)


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
# Il est lu dans les tuiles WMTS natives de la pyramide, et non au WMS. Le
# WMS rééchantillonne au plus proche, et à la maille de 44 m de l'anneau
# d'une zone de 1 000 m il glisse en plus, toutes les 8 lignes environ, une
# ligne prise 3,3 pixels natifs (130 m) plus au nord : recalée, elle colle au
# RGE ALTI à 2 m près, en place elle s'en écarte de 11 à 37 m (RMS de la
# ligne) au Regagnas, jusqu'à 190 m sous la Sainte-Victoire. La vue y
# dessinait des arêtes est-ouest d'un bout à l'autre de l'anneau. Mesuré le
# 2026-10-21 : 20 à 40 lignes aberrantes sur 128 dans les scènes vallonnées
# du cache, presque aucune colonne. Les tuiles natives n'ont ni ligne
# répétée ni ligne déplacée, du niveau 9 au niveau 14 ; l'horizon de la vue
# les lit déjà, pour la même raison (static/index.html, « Horizon »).
ALTI_WMTS = ("https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0"
             f"&LAYER={RELIEF_LAYER}&STYLE=normal&FORMAT=image/x-bil;bits=32"
             "&TILEMATRIXSET=WGS84G_6_14&TILEMATRIX={niveau}&TILEROW={ligne}&TILECOL={colonne}")
ALTI_NIVEAU_MIN, ALTI_NIVEAU_MAX = 6, 14
ALTI_TUILE_PX = 256
# La pyramide mêle elle aussi ses −99 999 aux voisins près de la mer, à tous
# les niveaux. Plus basse altitude restante sous le seuil RELIEF_TROU_SOUS_M,
# élargi de k pixels natifs (niveaux 11, 12, 13), mesurée le 2026-10-21 :
#
#                   k=0                    k=1
#   Saint-Malo   −16,1  −19,2  −17,5    −5,0  −5,0  −5,0   (l'estran)
#   Menton       −17,7   −1,5  −18,2     0,1   0,0  −0,4
#   Nice         −15,4   −7,1  −16,4    −0,1  −0,1  −0,2
#
# Un pixel suffit, deux ne changent rien.
ANNEAU_ELARGISSEMENT = 1


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


def _pixel_deg(niveau):
    """Côté d'un pixel natif du niveau, en degrés (WGS84G : 2 tuiles sur 360°
    au niveau 0)."""
    return 180 / 2 ** niveau / ALTI_TUILE_PX


def _niveau_natif(south, north, taille):
    """Le plus grossier dont le pixel ne dépasse pas la maille nord-sud de la
    grille : 11 (38 m) pour les 44 m de l'anneau d'une zone de 1 000 m."""
    maille = (north - south) / max(taille - 1, 1)
    for niveau in range(ALTI_NIVEAU_MIN, ALTI_NIVEAU_MAX + 1):
        if _pixel_deg(niveau) <= maille:
            return niveau
    return ALTI_NIVEAU_MAX


def _tuile_native(niveau, ligne, colonne):
    """Une tuile de 256 × 256 altitudes, ligne 0 au nord.

    Hors des limites de la pyramide (le large, l'étranger), le service répond
    404 à chaque reprise : un fait, rendu en trous. Tout autre échec lève.
    """
    url = ALTI_WMTS.format(niveau=niveau, ligne=ligne, colonne=colonne)
    try:
        with place():
            reponse = get_avec_reprise(url)
    except requests.RequestException as exc:
        if getattr(exc, "response", None) is not None and exc.response.status_code == 404:
            return np.full((ALTI_TUILE_PX, ALTI_TUILE_PX), float(RELIEF_NODATA))
        raise
    if "bil" not in reponse.headers.get("Content-Type", ""):
        raise requests.RequestException(
            f"Tuile d'altitudes inattendue ({reponse.headers.get('Content-Type')}): "
            f"{reponse.text[:200]}")
    attendu = ALTI_TUILE_PX * ALTI_TUILE_PX * 4
    if len(reponse.content) < attendu:
        raise requests.RequestException("Tuile d'altitudes tronquée")
    return np.frombuffer(reponse.content[:attendu], dtype="<f4").reshape(
        ALTI_TUILE_PX, ALTI_TUILE_PX).astype(np.float64)


def _altitudes_natives(west, south, east, north, taille):
    """Grille de `taille` points de côté, nœuds aux bords de l'emprise, ligne
    0 au nord, interpolée bilinéairement entre les centres des pixels natifs
    — la même lecture que l'horizon de la vue. NaN là où un pixel voisin est
    un trou, élargi de ANNEAU_ELARGISSEMENT."""
    niveau = _niveau_natif(south, north, taille)
    p = _pixel_deg(niveau)
    # Pixels natifs entourant l'emprise ; leurs centres sont aux demi-entiers.
    x0 = math.floor((west + 180) / p - 0.5)
    x1 = math.floor((east + 180) / p - 0.5) + 1
    y0 = math.floor((90 - north) / p - 0.5)
    y1 = math.floor((90 - south) / p - 0.5) + 1
    n = ALTI_TUILE_PX
    tuiles = [(ligne, colonne) for ligne in range(y0 // n, y1 // n + 1)
              for colonne in range(x0 // n, x1 // n + 1)]
    lues = en_parallele(*(functools.partial(_tuile_native, niveau, ligne, colonne)
                          for ligne, colonne in tuiles))
    pixels = np.empty((y1 - y0 + 1, x1 - x0 + 1))
    for (ligne, colonne), valeurs in zip(tuiles, lues):
        ya, yb = max(y0, ligne * n), min(y1, ligne * n + n - 1)
        xa, xb = max(x0, colonne * n), min(x1, colonne * n + n - 1)
        pixels[ya - y0:yb - y0 + 1, xa - x0:xb - x0 + 1] = \
            valeurs[ya - ligne * n:yb - ligne * n + 1, xa - colonne * n:xb - colonne * n + 1]
    pixels[_elargir(pixels < RELIEF_TROU_SOUS_M, ANNEAU_ELARGISSEMENT)] = np.nan

    lons = west + (east - west) * np.arange(taille) / (taille - 1)
    lats = north - (north - south) * np.arange(taille) / (taille - 1)
    fx = np.clip((lons + 180) / p - 0.5 - x0, 0, x1 - x0)
    fy = np.clip((90 - lats) / p - 0.5 - y0, 0, y1 - y0)
    i = np.minimum(np.floor(fx).astype(int), x1 - x0 - 1)
    j = np.minimum(np.floor(fy).astype(int), y1 - y0 - 1)
    ax, ay = (fx - i)[None, :], (fy - j)[:, None]
    jj, ii = j[:, None], i[None, :]
    # Un trou voisin rend NaN : 0 × NaN reste NaN.
    return ((pixels[jj, ii] * (1 - ax) + pixels[jj, ii + 1] * ax) * (1 - ay)
            + (pixels[jj + 1, ii] * (1 - ax) + pixels[jj + 1, ii + 1] * ax) * ay)


def fetch_relief_anneau(west, south, east, north, taille=ANNEAU_TAILLE):
    """Relief grossier autour de la scène, trous compris, lu dans les tuiles
    natives du RGE ALTI.

    Même format que `fetch_relief`. None seulement si rien n'est couvert.

    Raises:
        requests.RequestException si une tuile n'a pas pu être lue.
    """
    west, south, east, north = map(float, (west, south, east, north))
    grille = _altitudes_natives(west, south, east, north, taille)
    trous = np.isnan(grille)
    if trous.all():
        return None
    grille[trous] = 0.0
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
