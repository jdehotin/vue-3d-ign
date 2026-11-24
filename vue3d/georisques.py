"""Risques de Géorisques : inondations, feux de forêt, cavités souterraines.

Quatre couches à part, que la page demande une fois la scène affichée (les
trois premières) ou au clic (la fiche de la commune). Aucune n'est lue
d'avance par le serveur : éteinte dans la fenêtre « Données » de la page, une
source ne doit coûter aucune requête, et le serveur ne sait pas ce que
l'utilisateur a éteint.

**Ce qui existe en géométrie, et ce qui n'existe qu'en fiche.** Mesuré le
24 novembre 2026 sur les services publics, sans clé :

- Surfaces inondables des TRI (directive inondation, rapportage 2020) : WFS de
  Géorisques, `ALEA_SYNT_<type>_<scénario>_FXX` — trois types (débordement de
  cours d'eau, ruissellement, submersion marine) et jusqu'à quatre scénarios
  (fréquent, moyen, moyen avec changement climatique, rare). Onze couches,
  une requête chacune : le service refuse plusieurs `typeNames` (400).
- Zonage des obligations légales de débroussaillement (OLD) : WFS de la
  Géoplateforme, `DEBROUSSAILLEMENT:debroussaillement` (IGN pour le MASA).
  `zonage` vaut 1 pour un massif, 2 pour sa bande de 200 m (descriptif de
  contenu, mars 2026) ; le Géoportail n'affiche que les bandes
  (`diffusion = Oui`).
- Cavités souterraines (BDCavité, BRGM) : WFS de Géorisques,
  `CAVITE_LOCALISEE`, des points.
- AZI, TRI, PAPI, arrêtés CatNat : l'API v1 de Géorisques ne les donne que
  par commune, sans géométrie — d'où la fiche. Les atlas des zones inondables
  ne sont servis en géométrie par aucun service national ; la base des
  inondations historiques non plus : la fiche porte à leur place les arrêtés
  de catastrophe naturelle liés aux inondations, l'historique officiel des
  événements reconnus. L'API v2 demande une inscription (401) : le projet
  n'a pas de clé.

**Un WFS de Géorisques qui ne trouve rien répond 200 avec un corps vide**,
ce qui ne se distingue pas d'une réponse perdue. Chaque couche est donc
d'abord comptée (`resultType=hits`) : 0, et l'absence est un fait ; sinon la
lecture doit rendre exactement ce nombre d'objets, ou c'est un incident et
rien n'est écrit.

**Une surface déborde largement de l'emprise** : la surface inondable du
Rhône à Avignon court sur 8 km, la bande OLD d'un massif du Luberon pèse 1 Mo
de GeoJSON. Elles sont découpées sur l'emprise avant d'être transmises.
"""

import concurrent.futures
import datetime
import logging
import re
import time

import requests
import shapely
from shapely.geometry import Point, box, mapping, shape

from .couches import lire_couche

journal = logging.getLogger(__name__)

# Format des couches. L'incrémenter ne refait que ces couches, pas les scènes.
GEORISQUES_VERSION = 1

WFS_URL = "https://www.georisques.gouv.fr/services"
API_URL = "https://www.georisques.gouv.fr/api/v1"
COUCHE_OLD = "DEBROUSSAILLEMENT:debroussaillement"
COUCHE_CAVITES = "CAVITE_LOCALISEE"

# (type d'inondation, scénario) -> couche WFS. Les types et scénarios absents
# n'existent pas au rapportage 2020 en métropole (pas de ruissellement
# « moyen avec changement climatique »).
SURFACES_INONDABLES = {
    ("debordement", "frequent"): "ALEA_SYNT_01_01FOR_FXX",
    ("debordement", "moyen"): "ALEA_SYNT_01_02MOY_FXX",
    ("debordement", "moyen_cc"): "ALEA_SYNT_01_03MCC_FXX",
    ("debordement", "rare"): "ALEA_SYNT_01_04FAI_FXX",
    ("ruissellement", "frequent"): "ALEA_SYNT_02_01FOR_FXX",
    ("ruissellement", "moyen"): "ALEA_SYNT_02_02MOY_FXX",
    ("ruissellement", "rare"): "ALEA_SYNT_02_04FAI_FXX",
    ("submersion", "frequent"): "ALEA_SYNT_03_01FOR_FXX",
    ("submersion", "moyen"): "ALEA_SYNT_03_02MOY_FXX",
    ("submersion", "moyen_cc"): "ALEA_SYNT_03_03MCC_FXX",
    ("submersion", "rare"): "ALEA_SYNT_03_04FAI_FXX",
}
# Lectures simultanées vers Géorisques pour une scène : onze couches, dont la
# plupart comptent 0 en 0,3 s ; la plus lourde mesurée (débordement fréquent
# du Rhône, 340 Ko) a pris 6,3 s.
LECTURES_SIMULTANEES = 4
# Plafond d'objets par couche et par emprise : au-delà, la couche est jugée
# incomplète plutôt que tronquée. 82 cavités sur 1,5 km² d'Arras, la ville
# des boves ; une surface inondable est un seul polygone par scénario et TRI.
OBJETS_MAX = 5000
TIMEOUT_S = 60
ESSAIS = 3
ATTENTE_S = 2
DECIMALES = 7
# Les arrêtés CatNat retenus pour l'historique des inondations : leur libellé
# au Journal officiel (« Inondations et/ou Coulées de Boue », « Chocs
# Mécaniques liés à l'action des Vagues », « Inondations par remontées de
# nappe phréatique », « Lave torrentielle »…).
CATNAT_INONDATION = re.compile(r"inond|boue|submersion|crue|vague|lave torrentielle|nappe", re.I)
# Pages de l'API v1 lues au plus pour les arrêtés d'une commune : 24 à
# Avignon, une page de 100 suffit presque partout.
CATNAT_PAGES_MAX = 10


class GeorisquesIllisible(requests.RequestException):
    """Géorisques a répondu, mais pas ce qu'on attendait."""


def _get(url, params):
    """Un GET vers Géorisques, réessayé. La réponse, quel que soit son code :
    c'est à l'appelant de dire ce qu'un 404 signifie."""
    dernier = None
    for essai in range(ESSAIS):
        try:
            reponse = requests.get(url, params=params, timeout=TIMEOUT_S,
                                   headers={"User-Agent": "vue-3d-ign"})
            if reponse.status_code < 500 and reponse.status_code != 429:
                return reponse
            dernier = requests.RequestException(f"HTTP {reponse.status_code} sur {url}")
        except requests.RequestException as exc:
            dernier = exc
        if essai + 1 < ESSAIS:
            time.sleep(ATTENTE_S)
    raise requests.RequestException(f"Géorisques injoignable : {dernier}")


def _bbox(west, south, east, north):
    # WFS 2.0 en EPSG:4326 par son URN : l'ordre des axes est lat, lon.
    return f"{south},{west},{north},{east},urn:ogc:def:crs:EPSG::4326"


def lire_wfs_georisques(couche, west, south, east, north):
    """GeoJSON d'une couche du WFS de Géorisques sur l'emprise, sans objet
    manquant.

    Raises:
        requests.RequestException si le service ne répond pas, ou rend un
        autre nombre d'objets que celui qu'il a compté.
    """
    params = {"service": "WFS", "version": "2.0.0", "request": "GetFeature",
              "typeNames": f"ms:{couche}", "bbox": _bbox(west, south, east, north)}
    reponse = _get(WFS_URL, {**params, "resultType": "hits"})
    trouve = re.search(r'numberMatched="(\d+)"', reponse.text)
    if reponse.status_code != 200 or not trouve:
        raise GeorisquesIllisible(f"{couche} : comptage illisible (HTTP {reponse.status_code})")
    attendus = int(trouve.group(1))
    if attendus == 0:
        return {"type": "FeatureCollection", "features": []}
    if attendus > OBJETS_MAX:
        raise GeorisquesIllisible(f"{couche} : {attendus} objets, plus que {OBJETS_MAX}")
    # count = N + 1 : en GeoJSON, MapServer rend un objet de moins que
    # `count` quand il vaut exactement le nombre compté (3 sur 4 pour le
    # débordement moyen du Rhône à Avignon, les 4 en GML ou avec count=10).
    reponse = _get(WFS_URL, {**params, "outputFormat": "geojson", "count": attendus + 1})
    try:
        geojson = reponse.json()
    except ValueError as exc:
        raise GeorisquesIllisible(f"{couche} : réponse illisible ({len(reponse.content)} octets)") from exc
    rendus = len(geojson.get("features") or [])
    if reponse.status_code != 200 or rendus != attendus:
        raise GeorisquesIllisible(f"{couche} : {rendus} objets rendus sur {attendus}")
    return geojson


def _arrondir(geom):
    """GeoJSON 2D arrondi au centimètre."""
    def coords(c):
        if isinstance(c[0], (int, float)):
            return [round(c[0], DECIMALES), round(c[1], DECIMALES)]
        return [coords(x) for x in c]
    g = mapping(geom)
    return {"type": g["type"], "coordinates": coords(g["coordinates"])}


def _decouper(feature, cadre):
    """La géométrie surfacique d'un objet, ramenée à l'emprise ; None s'il
    n'en reste rien."""
    if not feature.get("geometry"):
        return None
    try:
        geom = shapely.force_2d(shape(feature["geometry"])).buffer(0).intersection(cadre)
    except Exception:
        return None
    morceaux = [g for g in getattr(geom, "geoms", [geom])
                if g.geom_type == "Polygon" and g.area > 0]
    return _arrondir(shapely.MultiPolygon(morceaux)) if morceaux else None


def _aujourdhui():
    return datetime.date.today().isoformat()


# --- Inondations ---------------------------------------------------------------

def fetch_inondations(west, south, east, north):
    """Les onze couches de surfaces inondables sur l'emprise.

    Returns:
        {"<type>/<scénario>": GeoJSON}.

    Raises:
        requests.RequestException à la première couche illisible.
    """
    with concurrent.futures.ThreadPoolExecutor(LECTURES_SIMULTANEES,
                                               thread_name_prefix="georisques") as bassin:
        lectures = {f"{t}/{s}": bassin.submit(lire_wfs_georisques, couche, west, south, east, north)
                    for (t, s), couche in SURFACES_INONDABLES.items()}
        return {cle: lecture.result() for cle, lecture in lectures.items()}


def inondations_pour_emprise(west, south, east, north, brut):
    """Surfaces inondables de l'emprise, prêtes à être drapées.

    Returns:
        dict(version, lu_le, surfaces) ; None si l'emprise n'est dans aucune.
        - surfaces : [{type, scenario, cours_deau, tri, geometrie}], dans
          l'ordre de SURFACES_INONDABLES ; `type` : debordement,
          ruissellement, submersion ; `scenario` : frequent, moyen,
          moyen_cc, rare.
    """
    cadre = box(west, south, east, north)
    surfaces = []
    for (type_, scenario) in SURFACES_INONDABLES:
        for f in ((brut or {}).get(f"{type_}/{scenario}") or {}).get("features", []):
            geometrie = _decouper(f, cadre)
            if not geometrie:
                continue
            p = f.get("properties") or {}
            surfaces.append({"type": type_, "scenario": scenario,
                             "cours_deau": p.get("cours_deau") or None,
                             "tri": p.get("id_tri") or None, "geometrie": geometrie})
    if not surfaces:
        return None
    journal.info("Inondations : %d surface(s)", len(surfaces))
    return {"version": GEORISQUES_VERSION, "lu_le": _aujourdhui(), "surfaces": surfaces}


# --- Obligations légales de débroussaillement ------------------------------------

def fetch_old(west, south, east, north):
    """Le zonage OLD de l'emprise, sur la Géoplateforme (reprise et places de
    vue3d/couches.py)."""
    return lire_couche(COUCHE_OLD, west, south, east, north)


def old_pour_emprise(west, south, east, north, brut):
    """Massifs et bandes de 200 m soumis aux OLD sur l'emprise.

    Returns:
        dict(version, lu_le, zones) ; None si l'emprise n'en a aucun.
        - zones : [{zonage, source, arrete, url, geometrie}] ; `zonage` :
          "massif" ou "bande" ; `arrete` : date de l'arrêté préfectoral,
          telle que l'IGN l'écrit (JJ/MM/AA).
    """
    cadre = box(west, south, east, north)
    zones = []
    for f in (brut or {}).get("features", []):
        geometrie = _decouper(f, cadre)
        if not geometrie:
            continue
        p = f.get("properties") or {}
        zones.append({"zonage": "massif" if p.get("zonage") == 1 else "bande",
                      "source": p.get("source") or None,
                      "arrete": p.get("dat_ap_old") or None,
                      "url": p.get("url") or None, "geometrie": geometrie})
    if not zones:
        return None
    # Les bandes d'abord : la vue pose les massifs par-dessus.
    zones.sort(key=lambda z: z["zonage"] == "massif")
    journal.info("OLD : %d zone(s)", len(zones))
    return {"version": GEORISQUES_VERSION, "lu_le": _aujourdhui(), "zones": zones}


# --- Cavités souterraines ----------------------------------------------------------

def fetch_cavites(west, south, east, north):
    """Les cavités de BDCavité sur l'emprise."""
    return lire_wfs_georisques(COUCHE_CAVITES, west, south, east, north)


def cavites_pour_emprise(west, south, east, north, brut):
    """Cavités de l'emprise, en points.

    Returns:
        dict(version, lu_le, cavites) ; None si l'emprise n'en a aucune.
        - cavites : [{lon, lat, type, nom, identifiant, reperage}] ; `type` :
          carrière, cave, naturelle, ouvrage civil, ouvrage militaire,
          puits, indéterminé… ; `reperage` dit ce que le point désigne
          (« centre cavité », « entrée »…).
    """
    cadre = box(west, south, east, north)
    cavites = []
    for f in (brut or {}).get("features", []):
        g = f.get("geometry") or {}
        if g.get("type") != "Point":
            continue
        lon, lat = g["coordinates"][:2]
        if not cadre.covers(Point(lon, lat)):
            continue
        p = f.get("properties") or {}
        cavites.append({"lon": round(lon, DECIMALES), "lat": round(lat, DECIMALES),
                        "type": p.get("type_cavite") or None,
                        "nom": p.get("nom_cavite") or None,
                        "identifiant": p.get("identifiant") or None,
                        "reperage": p.get("reperage_geographique") or None})
    if not cavites:
        return None
    journal.info("Cavités : %d", len(cavites))
    return {"version": GEORISQUES_VERSION, "lu_le": _aujourdhui(), "cavites": cavites}


# --- La fiche de la commune, au clic --------------------------------------------------

def _api(chemin, params):
    """Une réponse de l'API v1. Un 404 « Pas de résultat » est un fait : la
    liste vide ; tout autre écart est un incident."""
    reponse = _get(f"{API_URL}/{chemin}", params)
    try:
        corps = reponse.json()
    except ValueError as exc:
        raise GeorisquesIllisible(f"{chemin} : réponse illisible (HTTP {reponse.status_code})") from exc
    if reponse.status_code == 404 and isinstance(corps, dict) and corps.get("results") == 0:
        return None
    if reponse.status_code != 200:
        raise GeorisquesIllisible(f"{chemin} : HTTP {reponse.status_code}")
    return corps


def fetch_risques_commune(west, south, east, north):
    """Les fiches de la commune du centre de l'emprise : AZI, TRI, PAPI,
    arrêtés CatNat et OLD au point. `rayon=1` (mètre) : l'API ne rend alors
    que la commune du point (mesuré à Avignon et à Gordes)."""
    lon, lat = (west + east) / 2, (south + north) / 2
    point = {"latlon": f"{lon:.6f},{lat:.6f}", "rayon": 1}
    brut = {}
    for cle in ("azi", "tri", "papi"):
        corps = _api(f"gaspar/{cle}", {**point, "page_size": 100})
        brut[cle] = (corps or {}).get("data") or []
    catnat = []
    for page in range(1, CATNAT_PAGES_MAX + 1):
        corps = _api("gaspar/catnat", {**point, "page_size": 100, "page": page})
        catnat += (corps or {}).get("data") or []
        if not corps or page >= (corps.get("total_pages") or 0):
            break
    else:
        raise GeorisquesIllisible(f"catnat : plus de {CATNAT_PAGES_MAX} pages")
    brut["catnat"] = catnat
    brut["old"] = _api("old", {"latlon": point["latlon"]}) or []
    return brut


def _commune(brut):
    for cle in ("catnat", "azi", "tri", "papi"):
        for x in brut.get(cle) or []:
            if x.get("code_insee"):
                return {"code": x["code_insee"], "nom": x.get("libelle_commune")}
    for x in brut.get("old") or []:
        c = x.get("commune") or {}
        if c.get("code"):
            return {"code": c["code"], "nom": c.get("nom")}
    return None


def risques_commune_pour_emprise(west, south, east, north, brut):
    """La fiche des risques de la commune, prête pour la page. Toujours un
    dict : une commune sans atlas ni arrêté est un fait que la page dit.

    Returns:
        dict(version, lu_le, commune, azi, tri, papi, inondations,
        catnat_total, old).
        - inondations : arrêtés CatNat liés aux inondations, du plus récent au
          plus ancien : [{debut, fin, arrete, libelle}] (dates JJ/MM/AAAA) ;
        - old : {zone_urbaine, approbation, url} au point, None hors OLD.
    """
    brut = brut or {}
    risques = lambda x: [r.get("libelle_risque_long") for r in x.get("liste_libelle_risque") or []]
    date = lambda d: datetime.datetime.strptime(d, "%d/%m/%Y") if d else datetime.datetime.min
    inondations = [{"debut": c.get("date_debut_evt"), "fin": c.get("date_fin_evt"),
                    "arrete": c.get("date_publication_arrete"),
                    "libelle": c.get("libelle_risque_jo")}
                   for c in brut.get("catnat") or []
                   if CATNAT_INONDATION.search(c.get("libelle_risque_jo") or "")]
    inondations.sort(key=lambda c: date(c["debut"]), reverse=True)
    old = None
    for x in brut.get("old") or []:
        r = x.get("risque") or {}
        old = {"zone_urbaine": x.get("zoneUrbaine"),
               "approbation": r.get("Date approbation"), "url": r.get("url")}
    return {
        "version": GEORISQUES_VERSION, "lu_le": _aujourdhui(), "commune": _commune(brut),
        "azi": [{"code": a.get("code_national_azi"), "libelle": a.get("libelle_azi"),
                 "bassin": a.get("libelle_bassin_risques") or None,
                 "publication": a.get("date_publication_web") or a.get("date_diffusion"),
                 "risques": risques(a)} for a in brut.get("azi") or []],
        "tri": [{"code": t.get("code_national_tri"), "libelle": t.get("libelle_tri"),
                 "arrete_carte": t.get("date_arrete_carte"),
                 "arrete_national": t.get("date_arrete_national"),
                 "risques": risques(t)} for t in brut.get("tri") or []],
        "papi": [{"code": p.get("code_national_papi"), "libelle": p.get("libelle_papi"),
                  "bassin": p.get("libelle_bassin_risques") or None,
                  "labellisation": p.get("date_labellisation"),
                  "fin": p.get("date_fin_realisation"),
                  "risques": risques(p)} for p in brut.get("papi") or []],
        "inondations": inondations,
        "catnat_total": len(brut.get("catnat") or []),
        "old": old,
    }
