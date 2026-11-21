"""Postes de transformation HTA/BT du réseau Enedis.

Une couche à part, chargée après la scène, depuis l'API Data Fair
d'Enedis (opendata.enedis.fr). Le jeu « Postes électriques (postes
HTA/BT) » contient ~976 000 points, mis à jour semestriellement, sous
Licence Ouverte 2.0.

**L'API** :
  GET https://opendata.enedis.fr/data-fair/api/v1/datasets/poste-electrique/lines
      ?size=500&bbox=west_lon,south_lat,east_lon,north_lat
Renvoie les postes dans la bounding box. La pagination se fait via le
curseur « after » contenu dans le lien `next` de la réponse. Les champs
sont géographiques uniquement (position, commune, IRIS, département,
région) ; aucun attribut électrique n'est exposé dans ce jeu public.
"""

import json
import logging
import re
import time

import requests

journal = logging.getLogger(__name__)

# Format de la couche. L'incrémenter ne refait que la couche, pas les scènes.
POSTES_ENEDIS_VERSION = 1

API_URL = ("https://opendata.enedis.fr/data-fair/api/v1/datasets/"
           "poste-electrique/lines")
PAGE = 500
# Plafond par emprise : au-delà, les pages suivantes sont ignorées.
# 2 000 postes couvrent une zone très dense (centre de Paris ~170 sur 1 km²).
MAX_POSTES = 2000
TIMEOUT_S = 30
ESSAIS = 3
ATTENTE_S = 2
DECIMALES = 7


def _lire(url, params=None):
    """Une page de l'API Enedis, réessayée."""
    dernier = None
    for essai in range(ESSAIS):
        try:
            r = requests.get(url, params=params,
                             headers={"User-Agent": "vue-3d-ign"},
                             timeout=TIMEOUT_S)
            if not r.ok:
                raise requests.RequestException(
                    f"HTTP {r.status_code} sur {url[:100]}")
            return r.json()
        except (requests.RequestException, ValueError) as exc:
            dernier = exc
            if essai + 1 < ESSAIS:
                time.sleep(ATTENTE_S)
    raise requests.RequestException(
        f"API Enedis injoignable : {dernier}")


def fetch_postes_enedis(west, south, east, north):
    """Postes HTA/BT de l'emprise depuis l'API Data Fair d'Enedis.

    Returns:
        liste des enregistrements bruts (peut être vide).

    Raises:
        requests.RequestException si une page n'a pas pu être lue.
    """
    params = {
        "size": PAGE,
        "bbox": f"{west},{south},{east},{north}",
    }
    postes = []
    for _ in range(MAX_POSTES // PAGE + 1):
        data = _lire(API_URL, params=params)
        postes.extend(data.get("results", []))
        total = data.get("total", 0)
        if len(postes) >= total or len(postes) >= MAX_POSTES:
            break
        next_url = data.get("next")
        if not next_url:
            break
        # Curseur dans le lien next : after=val1%2Cval2 (URL-encodé).
        m = re.search(r'[?&]after=([^&]+)', next_url)
        if not m:
            break
        params = {
            "size": PAGE,
            "after": requests.utils.unquote(m.group(1)),
        }
    return postes


def postes_enedis_pour_emprise(west, south, east, north, brut):
    """Postes HTA/BT formatés pour la vue.

    Args:
        brut: liste de `fetch_postes_enedis`.

    Returns:
        dict(version, postes) ; None si l'emprise n'a aucun poste.
        - postes : [{lon, lat, commune, iris, departement}].
    """
    postes = []
    for p in (brut or []):
        try:
            geom = json.loads(p.get("geometry") or "{}")
            coords = geom.get("coordinates")
            if not coords or len(coords) < 2:
                continue
            lon = round(float(coords[0]), DECIMALES)
            lat = round(float(coords[1]), DECIMALES)
        except Exception:
            continue
        postes.append({
            "lon": lon,
            "lat": lat,
            "commune": p.get("nom_commune") or None,
            "iris": p.get("nom_iris") or None,
            "departement": p.get("code_departement") or None,
        })
    if not postes:
        return None
    journal.info("Postes Enedis : %d poste(s)", len(postes))
    return {"version": POSTES_ENEDIS_VERSION, "postes": postes}
