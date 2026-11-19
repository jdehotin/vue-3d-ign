"""Voies piétonnes et cyclables de la BD TOPO : chemins, sentiers, pistes
cyclables, voies vertes et escaliers.

Une couche à part de la scène, comme les emprises (vue3d/emprises.py) : la vue
la demande une fois la scène affichée, elle a sa propre version
(CHEMINS_VERSION) et son propre fichier de cache, et rien d'ici n'entre dans
un calcul de la scène — ni toit, ni houppier.

La couche `BDTOPO_V3:troncon_de_route` est déjà lue pour la scène principale,
qui rend tous les tronçons. Cette couche à part relit la même source, mais ne
garde que les natures piétonnes et cyclables, et stocke des attributs absents
de la scène principale : aménagement cyclable, largeur réelle.

**La vue drape chaque segment sur le relief.** Pas d'altitude propre : comme
les routes de la scène principale, le segment est posé sur le terrain de la
scène, légèrement au-dessus pour éviter le z-fighting.

**La largeur est celle de la donnée quand elle la donne.** Sinon une
convention par nature, mesurée en tête de module (la BD TOPO la tait souvent
sur les chemins ruraux et les pistes cyclables).
"""

import logging

import shapely
from shapely.geometry import box, shape

from .couches import COUCHE_ROUTES, lire_couche

journal = logging.getLogger(__name__)

# Format de la couche. L'incrémenter ne refait que la couche, pas les scènes.
CHEMINS_VERSION = 1

# Natures conservées dans cette couche (piéton et vélo uniquement).
NATURES_CHEMINS = frozenset(['Chemin', 'Sentier', 'Piste cyclable',
                              'Voie verte', 'Escalier'])

# Largeur par nature quand la BD TOPO la tait : ordre de grandeur d'une piste
# cyclable à double sens (2 m), d'une voie verte partagée (2,5 m), d'un chemin
# rural (1,5 m), d'un sentier pédestre (1 m), d'un escalier de rue (2 m).
LARGEUR_PAR_NATURE = {
    'Piste cyclable': 2.0,
    'Voie verte': 2.5,
    'Chemin': 1.5,
    'Sentier': 1.0,
    'Escalier': 2.0,
}

# Arrondi des coordonnées : 7 décimales, un centimètre.
DECIMALES = 7


def fetch_chemins(west, south, east, north):
    """GeoJSON brut des tronçons de route sur l'emprise.

    Raises:
        requests.RequestException si la couche n'a pas pu être lue.
    """
    return lire_couche(COUCHE_ROUTES, west, south, east, north)


def chemins_pour_emprise(west, south, east, north, brut):
    """Voies piétonnes et cyclables de l'emprise, prêtes pour la vue.

    Args:
        brut: GeoJSON de `fetch_chemins`.

    Returns:
        dict(version, chemins) ; None si l'emprise n'a aucune voie.
        - chemins : [{nature, amenagement_cyclable, largeur_m, ligne}] ;
          `ligne` est une liste de [lon, lat] arrondie au centimètre ;
          `amenagement_cyclable` est la valeur côté droit ou gauche, ou None.
    """
    cadre = box(west, south, east, north)
    chemins = []
    for f in (brut or {}).get("features", []):
        p = f.get("properties") or {}
        if p.get("nature") not in NATURES_CHEMINS:
            continue
        # Tunnels et ponts : le ruban posé sur le relief serait dans la colline
        # ou dans les airs, comme pour les routes de la scène principale.
        if p.get("fictif") or str(p.get("position_par_rapport_au_sol") or "0") != "0":
            continue
        if not f.get("geometry"):
            continue
        try:
            geom = shapely.force_2d(shape(f["geometry"])).intersection(cadre)
        except Exception:
            continue
        for morceau in getattr(geom, "geoms", [geom]):
            if morceau.geom_type != "LineString" or not morceau.length:
                continue
            nature = p.get("nature")
            amenagement = p.get("amenagement_cyclable_droit") or p.get("amenagement_cyclable_gauche")
            largeur = p.get("largeur_de_chaussee") or 0
            if largeur <= 0:
                largeur = LARGEUR_PAR_NATURE.get(nature, 1.5)
            chemins.append({
                "nature": nature,
                "amenagement_cyclable": amenagement,
                "largeur_m": float(largeur),
                "ligne": [[round(x, DECIMALES), round(y, DECIMALES)]
                          for x, y in morceau.coords],
            })

    if not chemins:
        return None
    journal.info("Chemins et pistes : %d segment(s)", len(chemins))
    return {"version": CHEMINS_VERSION, "chemins": chemins}
