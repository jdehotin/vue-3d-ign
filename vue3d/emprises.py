"""Emprises de la BD TOPO au sol : cimetières, aérodromes et leurs pistes,
postes de transformation, et les haies qui s'y dressent.

Une couche à part de la scène, comme les ouvrages (vue3d/ouvrages.py) : la vue
la demande une fois la scène affichée, elle a sa propre version
(EMPRISES_VERSION) et son propre fichier de cache, et rien d'ici n'entre dans un
calcul de la scène — ni toit, ni houppier. La liste des couches lues est donc
indépendante de celle des ouvrages, et l'une peut changer sans refaire l'autre.

Cinq couches, lues sur l'emprise de la scène et découpées sur elle :

- `cimetiere`, `aerodrome`, `piste_d_aerodrome`, `poste_de_transformation` :
  des emprises, en aplats drapés sur le relief ;
- `haie` : des lignes, dressées en volume.

**Un aplat n'a pas d'altitude.** La vue drape une emprise sur le relief de la
scène, comme elle le fait des terrains de sport ; l'altitude des sommets de la
BD TOPO — une piste d'aérodrome en porte une, mesurée à 143,6 m à Strasbourg —
est ignorée : c'est le relief qui commande, et une emprise posée à l'altitude de
la BD TOPO décollerait de lui là où les deux diffèrent.

**Une haie n'a ni hauteur ni largeur.** Sur 785 haies relevées — 45 sur les
33 km² d'une emprise strasbourgeoise de 6 × 5,5 km, 740 sur 30 km² du vignoble
alsacien — la BD TOPO laisse `hauteur` et `largeur` vides sur toutes, et sa
géométrie est en deux dimensions : rien n'y dit qu'une haie se dresse, ni de
combien. Les deux conventions ci-dessous sont donc celles de la vue, comme la
largeur d'une voie ferrée (ouvrages.LARGEUR_PAR_VOIE_M) : une haie de 2 m de
haut, épaisse de 1,5 m. C'est l'ordre de grandeur d'une haie taillée de jardin ou
de bord de champ.

**Rien de tout cela au centre-ville.** Sur la même emprise d'un kilomètre carré
autour de la place Broglie, à Strasbourg, la couche ne trouve qu'un cimetière,
aucun aérodrome et aucune haie : elle se voit donc surtout en périphérie et à la
campagne, et une scène qui n'en porte pas ne montre aucun de ses boutons.

**Un cimetière militaire ou civil.** La BD TOPO distingue les deux (`nature`) ;
la vue les teinte différemment, comme un monument militaire se lit sur une
carte. L'emprise, elle, reste un aplat de terrain clos.

Ce que la couche ne dessine pas : les emprises « en projet » et « en
construction », et les objets `fictif` — la même règle que les ouvrages.
"""

import logging

import shapely
from shapely.geometry import box, mapping, shape

from .couches import lire_couche

journal = logging.getLogger(__name__)

# Format de la couche. L'incrémenter ne refait que la couche, pas les scènes :
# le numéro est dans le nom du fichier de cache (scene.NOM_EMPRISES).
EMPRISES_VERSION = 1

COUCHES = {
    "cimetieres": "BDTOPO_V3:cimetiere",
    "aerodromes": "BDTOPO_V3:aerodrome",
    "pistes": "BDTOPO_V3:piste_d_aerodrome",
    "postes": "BDTOPO_V3:poste_de_transformation",
    "haies": "BDTOPO_V3:haie",
}

# Hauteur et épaisseur d'une haie sans mesure : deux conventions, mesurées en
# tête de module (la BD TOPO ne les donne nulle part).
HAIE_HAUTEUR_M = 2.0
HAIE_LARGEUR_M = 1.5
# Objets écartés, comme les ouvrages : rien n'est dessiné qui n'existe pas.
ETATS_ECARTES = ("En projet", "En construction")
# Arrondi des coordonnées : 7 décimales, un centimètre.
DECIMALES = 7


def fetch_emprises(west, south, east, north):
    """GeoJSON bruts des cinq couches sur l'emprise.

    Raises:
        requests.RequestException si l'une d'elles n'a pas pu être lue : la
        couche est complète ou n'existe pas, comme la scène.
    """
    return {cle: lire_couche(couche, west, south, east, north)
            for cle, couche in COUCHES.items()}


def _arrondir_2d(geom):
    """GeoJSON 2D arrondi au centimètre."""
    def coords(c):
        if isinstance(c[0], (int, float)):
            return [round(c[0], DECIMALES), round(c[1], DECIMALES)]
        return [coords(x) for x in c]
    g = mapping(geom)
    return {"type": g["type"], "coordinates": coords(g["coordinates"])}


def _aplats(couche, cadre, attributs):
    """Emprises d'une couche surfacique, découpées sur l'emprise.

    Args:
        couche: GeoJSON d'une des couches de `fetch_emprises`.
        attributs: (properties) -> attributs à transmettre à la vue.

    Returns:
        liste de {…attributs, geometrie} ; `geometrie` en GeoJSON 2D arrondi.
    """
    out = []
    for f in (couche or {}).get("features", []):
        p = f.get("properties") or {}
        if p.get("etat_de_l_objet") in ETATS_ECARTES or p.get("fictif"):
            continue
        if not f.get("geometry"):
            continue
        try:
            # force_2d : l'altitude des sommets ne sert pas, la vue drape
            # l'aplat sur le relief de la scène.
            geom = shapely.force_2d(shape(f["geometry"])).buffer(0).intersection(cadre)
        except Exception:
            continue
        morceaux = [g for g in getattr(geom, "geoms", [geom])
                    if g.geom_type == "Polygon" and g.area > 0]
        if morceaux:
            out.append({**attributs(p),
                        "geometrie": _arrondir_2d(shapely.MultiPolygon(morceaux))})
    return out


def _haies(couche, cadre):
    """Haies de l'emprise, découpées à son bord, prêtes à être dressées."""
    out = []
    for f in (couche or {}).get("features", []):
        if not f.get("geometry"):
            continue
        try:
            ligne = shapely.force_2d(shape(f["geometry"])).intersection(cadre)
        except Exception:
            continue
        p = f.get("properties") or {}
        hauteur, largeur = p.get("hauteur"), p.get("largeur")
        for morceau in getattr(ligne, "geoms", [ligne]):
            if morceau.geom_type != "LineString" or not morceau.length:
                continue
            out.append({"h": hauteur or HAIE_HAUTEUR_M, "h_mesuree": hauteur is not None,
                        "largeur_m": largeur or HAIE_LARGEUR_M,
                        "largeur_mesuree": largeur is not None,
                        "ligne": [[round(x, DECIMALES), round(y, DECIMALES)]
                                  for x, y in morceau.coords]})
    return out


def emprises_pour_emprise(west, south, east, north, brut):
    """Emprises de l'emprise, prêtes pour la vue.

    Args:
        brut: GeoJSON des cinq couches, de `fetch_emprises`.

    Returns:
        dict(version, cimetieres, aerodromes, pistes, postes, haies) ; None si
        l'emprise n'a aucune emprise à dessiner.
        - cimetieres : [{nom, nature, geometrie}] ; nature : Civil, Militaire ;
        - aerodromes : [{nom, nature, categorie, usage, oaci, iata, geometrie}] ;
        - pistes : [{nature, fonction, geometrie}] ;
        - postes : [{nom, importance, geometrie}] ;
        - haies : [{h, h_mesuree, largeur_m, largeur_mesuree, ligne}] — h et
          largeur_m sont des conventions quand la BD TOPO les tait, ce que dit
          `h_mesuree` ; `ligne` en [lon, lat].
    """
    brut = brut or {}
    cadre = box(west, south, east, north)

    cimetieres = _aplats(brut.get("cimetieres"), cadre, lambda p: {
        "nom": p.get("toponyme"), "nature": p.get("nature")})
    aerodromes = _aplats(brut.get("aerodromes"), cadre, lambda p: {
        "nom": p.get("toponyme"), "nature": p.get("nature"),
        "categorie": p.get("categorie"), "usage": p.get("usage"),
        "oaci": p.get("code_icao"), "iata": p.get("code_iata")})
    pistes = _aplats(brut.get("pistes"), cadre, lambda p: {
        "nature": p.get("nature"), "fonction": p.get("fonction")})
    postes = _aplats(brut.get("postes"), cadre, lambda p: {
        "nom": p.get("toponyme"), "importance": p.get("importance")})
    haies = _haies(brut.get("haies"), cadre)

    if not (cimetieres or aerodromes or pistes or postes or haies):
        return None
    journal.info("Emprises : %d cimetière(s), %d aérodrome(s), %d piste(s), "
                 "%d poste(s), %d haie(s)",
                 len(cimetieres), len(aerodromes), len(pistes), len(postes), len(haies))
    return {"version": EMPRISES_VERSION, "cimetieres": cimetieres,
            "aerodromes": aerodromes, "pistes": pistes, "postes": postes,
            "haies": haies}
