"""Parcelles agricoles du Registre Parcellaire Graphique (RPG), IGN.

Une couche à part de la scène, comme les emprises (vue3d/emprises.py) : la vue
la demande une fois la scène affichée, elle a sa propre version (RPG_VERSION)
et son propre fichier de cache, et rien d'ici n'entre dans un calcul de la
scène — ni toit, ni houppier.

Le RPG (Registre Parcellaire Graphique) est le référentiel géographique des
surfaces déclarées à la PAC (Politique Agricole Commune). Il est produit par
l'ASP (Agence de Services et de Paiement) et mis à disposition par l'IGN sur
la Géoplateforme. Il couvre les îlots de culture déclarés en France
métropolitaine et outre-mer.

Chaque parcelle porte son groupe de cultures (céréales, oléagineux, prairies…)
et le code de la culture dominante. La couche est annuelle : la version
RPG.LATEST pointe sur la campagne la plus récente publiée.

**Un aplat RPG n'a pas d'altitude propre.** Comme les cimetières, la vue drape
la parcelle sur le relief de la scène.

**Le RPG couvre les déclarations PAC.** Il ne couvre pas les parcelles non
déclarées (forêts, friches, jardins, etc.) ni les terrains non agricoles.
"""

import logging

import shapely
from shapely.geometry import box, mapping, shape

from .couches import lire_couche

journal = logging.getLogger(__name__)

# Format de la couche. L'incrémenter ne refait que la couche, pas les scènes.
RPG_VERSION = 1

# Couche WFS du RPG sur la Géoplateforme (millésime le plus récent).
COUCHE_RPG = "RPG.LATEST:parcelles_graphiques"

# Arrondi des coordonnées : 7 décimales, un centimètre.
DECIMALES = 7


def fetch_rpg(west, south, east, north):
    """GeoJSON brut de la couche RPG sur l'emprise.

    Raises:
        requests.RequestException si la couche n'a pas pu être lue.
    """
    return lire_couche(COUCHE_RPG, west, south, east, north)


def _arrondir_2d(geom):
    """GeoJSON 2D arrondi au centimètre."""
    def coords(c):
        if isinstance(c[0], (int, float)):
            return [round(c[0], DECIMALES), round(c[1], DECIMALES)]
        return [coords(x) for x in c]
    g = mapping(geom)
    return {"type": g["type"], "coordinates": coords(g["coordinates"])}


def rpg_pour_emprise(west, south, east, north, brut):
    """Parcelles agricoles de l'emprise, prêtes pour la vue.

    Args:
        brut: GeoJSON de `fetch_rpg`.

    Returns:
        dict(version, parcelles) ; None si l'emprise n'a aucune parcelle RPG.
        - parcelles : [{code_culture, libelle, groupe, surface_ha, geometrie}] ;
          `geometrie` est un MultiPolygon GeoJSON 2D arrondi au centimètre.
    """
    cadre = box(west, south, east, north)
    parcelles = []
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
        parcelles.append({
            "code_culture": p.get("code_cultu"),
            "libelle": p.get("libelle_cu"),
            "groupe": p.get("code_group"),
            "surface_ha": p.get("surf_parc"),
            "geometrie": _arrondir_2d(shapely.MultiPolygon(morceaux)),
        })

    if not parcelles:
        return None
    journal.info("RPG : %d parcelle(s)", len(parcelles))
    return {"version": RPG_VERSION, "parcelles": parcelles}
