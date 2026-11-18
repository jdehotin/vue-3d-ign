"""Massifs forestiers de la BD Forêt v2 de l'IGN.

Une couche à part de la scène, comme les emprises (vue3d/emprises.py) : la vue
la demande une fois la scène affichée, elle a sa propre version (FORET_VERSION)
et son propre fichier de cache, et rien d'ici n'entre dans un calcul de la
scène — ni toit, ni houppier.

La couche LANDCOVER.FORESTINVENTORY.V2:formation_vegetale est déjà lue lors
de la construction de la scène, pour orienter la segmentation des houppiers
(vue3d/couches.py : COUCHE_FORET). Ici elle est lue comme couche à part, pour
l'affichage et l'export : chaque massif comme aplat drapé sur le relief, avec
son essence dominante et son type de peuplement.

**Un aplat forestier n'a pas d'altitude propre.** Comme les cimetières et les
aérodromes, la vue drape l'emprise sur le relief de la scène ; la géométrie
3D de la BD Forêt n'est pas lue.

**La couche couvre les massifs boisés inventoriés.** Elle ne couvre pas les
haies, les arbres isolés, ni le bocage : ceux-ci ressortent de la BD TOPO
(BDTOPO_V3:zone_de_vegetation) et des houppiers de la scène. Les zones non
couvertes (< 0,5 ha, forêts de moins de 5 m de haut) sont absentes.
"""

import logging

import shapely
from shapely.geometry import box, mapping, shape

from .couches import COUCHE_FORET, lire_couche

journal = logging.getLogger(__name__)

# Format de la couche. L'incrémenter ne refait que la couche, pas les scènes.
FORET_VERSION = 1

# Arrondi des coordonnées : 7 décimales, un centimètre.
DECIMALES = 7


def fetch_foret(west, south, east, north):
    """GeoJSON brut de la couche BD Forêt v2 sur l'emprise.

    Raises:
        requests.RequestException si la couche n'a pas pu être lue.
    """
    return lire_couche(COUCHE_FORET, west, south, east, north)


def _arrondir_2d(geom):
    """GeoJSON 2D arrondi au centimètre."""
    def coords(c):
        if isinstance(c[0], (int, float)):
            return [round(c[0], DECIMALES), round(c[1], DECIMALES)]
        return [coords(x) for x in c]
    g = mapping(geom)
    return {"type": g["type"], "coordinates": coords(g["coordinates"])}


def foret_pour_emprise(west, south, east, north, brut):
    """Massifs forestiers de l'emprise, prêts pour la vue.

    Args:
        brut: GeoJSON de `fetch_foret`.

    Returns:
        dict(version, massifs) ; None si l'emprise n'a aucun massif forestier.
        - massifs : [{essence, libelle, type_peuplement, annee, geometrie}] ;
          `geometrie` est un MultiPolygon GeoJSON 2D arrondi au centimètre.
    """
    cadre = box(west, south, east, north)
    massifs = []
    for f in (brut or {}).get("features", []):
        if not f.get("geometry"):
            continue
        p = f.get("properties") or {}
        try:
            geom = shapely.force_2d(shape(f["geometry"])).buffer(0).intersection(cadre)
        except Exception:
            continue
        morceaux = [g for g in getattr(geom, "geoms", [geom])
                    if g.geom_type == "Polygon" and g.area > 0]
        if not morceaux:
            continue
        massifs.append({
            "essence": p.get("code_essfor"),
            "libelle": p.get("lib_essfor"),
            "type_peuplement": p.get("type_pel"),
            "annee": p.get("anneerefer"),
            "geometrie": _arrondir_2d(shapely.MultiPolygon(morceaux)),
        })

    if not massifs:
        return None
    journal.info("BD Forêt : %d massif(s)", len(massifs))
    return {"version": FORET_VERSION, "massifs": massifs}
