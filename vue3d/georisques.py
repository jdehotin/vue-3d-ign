"""Surfaces inondables des TRI, lues sur le WFS de Géorisques.

Une couche à part, que la page demande une fois la scène affichée. Elle n'est
pas lue d'avance par le serveur : éteinte dans la fenêtre « Données » de la
page, une source ne doit coûter aucune requête, et le serveur ne sait pas ce
que l'utilisateur a éteint.

Les surfaces inondables des territoires à risque important d'inondation
(directive inondation, rapportage 2020) : `ALEA_SYNT_<type>_<scénario>_FXX` —
trois types (débordement de cours d'eau, ruissellement, submersion marine) et
jusqu'à quatre scénarios (fréquent, moyen, moyen avec changement climatique,
rare). Onze couches, une requête chacune : le service refuse plusieurs
`typeNames` (400). Mesuré le 24 novembre 2026, sans clé. Hors TRI, rien :
les atlas des zones inondables ne sont servis en géométrie par aucun service
national.

**Un WFS de Géorisques qui ne trouve rien répond 200 avec un corps vide**,
ce qui ne se distingue pas d'une réponse perdue. Chaque couche est donc
d'abord comptée (`resultType=hits`) : 0, et l'absence est un fait ; sinon la
lecture doit rendre exactement ce nombre d'objets, ou c'est un incident et
rien n'est écrit.

**Une surface déborde largement de l'emprise** : celle du Rhône à Avignon
court sur 8 km. Elle est découpée sur l'emprise avant d'être transmise.
"""

import concurrent.futures
import datetime
import logging
import re
import time

import requests
import shapely
from shapely.geometry import box, mapping, shape

journal = logging.getLogger(__name__)

# Format des couches. L'incrémenter ne refait que ces couches, pas les scènes.
GEORISQUES_VERSION = 1

WFS_URL = "https://www.georisques.gouv.fr/services"

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
# incomplète plutôt que tronquée : une surface inondable est un seul
# polygone par scénario et par TRI.
OBJETS_MAX = 5000
TIMEOUT_S = 60
ESSAIS = 3
ATTENTE_S = 2
DECIMALES = 7


class GeorisquesIllisible(requests.RequestException):
    """Géorisques a répondu, mais pas ce qu'on attendait."""


def _get(url, params):
    """Un GET vers Géorisques, réessayé sur 5xx, 429 et coupure. La réponse,
    quel que soit son code : c'est à l'appelant d'en juger."""
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
