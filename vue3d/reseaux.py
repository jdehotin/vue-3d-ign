"""Canalisations de la BD TOPO (réseaux souterrains, aériens et en tranchées).

Une couche à part de la scène, comme les emprises (vue3d/emprises.py) : la vue
la demande une fois la scène affichée, elle a sa propre version
(RESEAUX_VERSION) et son propre fichier de cache.

La couche `BDTOPO_V3:canalisation` n'est pas lue par la scène principale :
elle recense uniquement les canalisations linéaires (eau, gaz, électricité…),
indépendantes des bâtiments et du terrain.

**La vue drape chaque segment sur le relief.** Pas d'altitude propre pour les
conduites souterraines : le segment est posé sur le terrain de la scène,
légèrement en dessous pour les souterraines, au niveau pour les aériennes.
Chaque nature reçoit une couleur conventionnelle (eau = bleu, gaz = ambre…).

**La position est conservée telle quelle** (`position_par_rapport_au_sol`) :
-1 = souterrain, 0 = au sol, 1 = aérien. La vue les affiche tous pour que
l'utilisateur comprenne le réseau dans son ensemble.
"""

import logging

import shapely
from shapely.geometry import box, shape

from .couches import lire_couche

journal = logging.getLogger(__name__)

# Format de la couche. L'incrémenter ne refait que la couche, pas les scènes.
RESEAUX_VERSION = 1

COUCHE_CANALISATION = "BDTOPO_V3:canalisation"

# Arrondi des coordonnées : 7 décimales, un centimètre.
DECIMALES = 7


def fetch_reseaux(west, south, east, north):
    """GeoJSON brut des canalisations sur l'emprise.

    Raises:
        requests.RequestException si la couche n'a pas pu être lue.
    """
    return lire_couche(COUCHE_CANALISATION, west, south, east, north)


def reseaux_pour_emprise(west, south, east, north, brut):
    """Canalisations de l'emprise, prêtes pour la vue.

    Args:
        brut: GeoJSON de `fetch_reseaux`.

    Returns:
        dict(version, reseaux) ; None si l'emprise n'a aucune canalisation.
        - reseaux : [{nature, position, ligne}] ;
          `nature` : Eau potable, Gaz, Électricité, Hydrocarbure… ;
          `position` : valeur de position_par_rapport_au_sol (-1, 0, 1) ;
          `ligne` est une liste de [lon, lat] arrondie au centimètre.
    """
    cadre = box(west, south, east, north)
    reseaux = []
    for f in (brut or {}).get("features", []):
        if not f.get("geometry"):
            continue
        try:
            geom = shapely.force_2d(shape(f["geometry"])).intersection(cadre)
        except Exception:
            continue
        p = f.get("properties") or {}
        for morceau in getattr(geom, "geoms", [geom]):
            if morceau.geom_type != "LineString" or not morceau.length:
                continue
            reseaux.append({
                "nature": p.get("nature"),
                "position": p.get("position_par_rapport_au_sol"),
                "ligne": [[round(x, DECIMALES), round(y, DECIMALES)]
                          for x, y in morceau.coords],
            })

    if not reseaux:
        return None
    journal.info("Réseaux : %d segment(s)", len(reseaux))
    return {"version": RESEAUX_VERSION, "reseaux": reseaux}
