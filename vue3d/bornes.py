"""Bornes de recharge pour véhicules électriques (IRVE) autour du point.

Une couche à part, comme les DPE (vue3d/dpe.py) : **jamais lue d'office**, la
page ne la demande qu'au clic sur son bouton.

**La source.** La Base nationale des IRVE de data.gouv.fr, consolidée chaque
jour, sous Licence Ouverte 2.0 : un point de charge par ligne, avec sa
station, son opérateur, sa puissance, ses prises, son accès. Le fichier entier
pèse 101 Mo ; l'API tabulaire de data.gouv.fr, sans clé, le filtre par emprise
sur ses coordonnées consolidées : 0,35 s pour les 22 points de charge autour
de l'Auchan d'Aubagne (mesuré le 2026-10-15).

**La ressource.** Le fichier du jour est désigné par le jeu de données : celui
dont le titre commence par RESSOURCE_TITRE. Son identifiant n'est pas tenu
pour stable ; il est relu à chaque lecture.

**Daté.** Comme les DPE, la couche porte la date de sa lecture (`lu_le`), que
la page affiche ; « Reconstruire la scène » la relit. Elle est écrite entière
ou pas du tout : une page de l'API en échec, ou des pages qui ne comptent pas
autant de points que l'API en annonce, lèvent, et rien n'est écrit.
"""

import datetime
import logging
import time

import requests

journal = logging.getLogger(__name__)

# Format de la couche ; l'incrémenter ne refait qu'elle.
BORNES_VERSION = 1

JEU_URL = "https://www.data.gouv.fr/api/1/datasets/5448d3e0c751df01f85d0572/"
RESSOURCE_TITRE = "Consolidation de la dernière version"
DONNEES_URL = "https://tabular-api.data.gouv.fr/api/resources/{ressource}/data/"
# La plus grande page que l'API accepte (au-delà : « Page size exceeds allowed
# maximum: 200 ») ; 445 points de charge autour de l'Opéra, à Paris, sur 1,7 km.
PAGE = 200
ESSAIS = 3
ATTENTE_S = 3
TIMEOUT_S = 60

# Les prises d'un point de charge, colonne par colonne, et leur nom affiché.
PRISES = (("prise_type_2", "Type 2"), ("prise_type_combo_ccs", "Combo CCS"),
          ("prise_type_chademo", "CHAdeMO"), ("prise_type_ef", "domestique"),
          ("prise_type_autre", "autre"))


def _lire(url):
    """Une réponse JSON de data.gouv.fr, réessayée."""
    dernier = None
    for essai in range(ESSAIS):
        try:
            reponse = requests.get(url, headers={"User-Agent": "vue-3d-ign"}, timeout=TIMEOUT_S)
            if not reponse.ok:
                raise requests.RequestException(f"HTTP {reponse.status_code} sur {url[:120]}")
            return reponse.json()
        except (requests.RequestException, ValueError) as exc:
            dernier = exc
            if essai + 1 < ESSAIS:
                time.sleep(ATTENTE_S)
    raise requests.RequestException(f"data.gouv.fr injoignable : {dernier}")


def _ressource():
    """Identifiant du fichier consolidé du jour, lu dans le jeu de données."""
    for r in _lire(JEU_URL).get("resources", []):
        if (r.get("title") or "").startswith(RESSOURCE_TITRE) and (r.get("format") or "").lower() == "csv":
            return r["id"]
    raise requests.RequestException(f"aucune ressource « {RESSOURCE_TITRE} » dans le jeu des IRVE")


def fetch_bornes(west, south, east, north):
    """Les points de charge de la Base nationale des IRVE dans l'emprise.

    Returns:
        {"lignes": [ligne brute de l'API], "lu_le": date ISO, "ressource": id}.

    Raises:
        requests.RequestException si une page n'a pas pu être lue, ou si les
        pages lues ne comptent pas autant de points que l'API en annonce.
    """
    lu_le = datetime.date.today().isoformat()
    ressource = _ressource()
    url = (DONNEES_URL.format(ressource=ressource)
           + f"?page_size={PAGE}"
           f"&consolidated_longitude__greater={west}&consolidated_longitude__less={east}"
           f"&consolidated_latitude__greater={south}&consolidated_latitude__less={north}")
    lignes, total = [], None
    while url:
        page = _lire(url)
        if total is None:
            total = (page.get("meta") or {}).get("total")
        donnees = page.get("data") or []
        lignes += donnees
        url = (page.get("links") or {}).get("next") if donnees else None
    if total is not None and len(lignes) != total:
        raise requests.RequestException(f"{len(lignes)} points de charge lus sur {total} annoncés")
    return {"lignes": lignes, "lu_le": lu_le, "ressource": ressource}


def _nombre(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _texte(v):
    return v.strip() if isinstance(v, str) and v.strip() else None


def _station(points):
    """Une station, à partir de ses points de charge."""
    p0 = points[0]
    puissances = [x for x in (_nombre(p.get("puissance_nominale")) for p in points) if x and x > 0]
    prises = [nom for col, nom in PRISES if any(p.get(col) is True for p in points)]
    declares = [int(n) for n in (_nombre(p.get("nbre_pdc")) for p in points) if n]
    dates = sorted(d for d in (_texte(p.get("date_maj")) for p in points) if d)
    lon = sum(p["_lon"] for p in points) / len(points)
    lat = sum(p["_lat"] for p in points) / len(points)
    return {
        "lon": round(lon, 7), "lat": round(lat, 7),
        "nom": _texte(p0.get("nom_station")) or "Station de recharge",
        "operateur": _texte(p0.get("nom_operateur")), "enseigne": _texte(p0.get("nom_enseigne")),
        "adresse": _texte(p0.get("adresse_station")),
        "implantation": _texte(p0.get("implantation_station")),
        # Les points de la station lus dans l'emprise, et ceux qu'elle déclare.
        "points": len(points), "declares": max(declares) if declares else None,
        "puissance_max": max(puissances) if puissances else None,
        "puissance_min": min(puissances) if puissances else None,
        "prises": prises,
        "gratuit": True if any(p.get("gratuit") is True for p in points) else None,
        "paiement_cb": any(p.get("paiement_cb") is True for p in points),
        "acces": _texte(p0.get("condition_acces")), "horaires": _texte(p0.get("horaires")),
        "pmr": _texte(p0.get("accessibilite_pmr")),
        "deux_roues": any(p.get("station_deux_roues") is True for p in points),
        "maj": dates[-1] if dates else None,
    }


def bornes_pour_emprise(west, south, east, north, brut, polygone=None):
    """La couche des bornes de l'emprise, réunies par station.

    Un point de charge par ligne de la base : ceux d'une même station
    (`id_station_itinerance`, sinon son nom à la même position) en font une
    seule, avec le nombre de ses points, ses puissances et ses prises.

    Args:
        polygone: contour de la zone (vue3d/polygone.py), s'il y en a un : une
            station hors du contour n'est pas gardée.

    Returns:
        dict(version, lu_le, nombre_points, stations) ; `stations` :
        [{lon, lat, nom, operateur, enseigne, adresse, implantation, points,
        declares, puissance_max, puissance_min, prises, gratuit, paiement_cb,
        acces, horaires, pmr, deux_roues, maj}], de la plus puissante à la
        moins puissante.
    """
    brut = brut or {"lignes": []}
    stations, vus = {}, set()
    for ligne in brut.get("lignes", []):
        lon, lat = _nombre(ligne.get("consolidated_longitude")), _nombre(ligne.get("consolidated_latitude"))
        if lon is None or lat is None or not (west <= lon <= east and south <= lat <= north):
            continue
        # Un point de charge déclaré deux fois n'en compte qu'un.
        pdc = _texte(ligne.get("id_pdc_itinerance")) or _texte(ligne.get("id_pdc_local"))
        if pdc:
            if pdc in vus:
                continue
            vus.add(pdc)
        cle = (_texte(ligne.get("id_station_itinerance"))
               or (_texte(ligne.get("nom_station")), round(lon, 5), round(lat, 5)))
        stations.setdefault(cle, []).append({**ligne, "_lon": lon, "_lat": lat})
    liste = [_station(points) for points in stations.values()]
    if polygone is not None:
        liste = [s for s in liste if polygone.masque(s["lon"], s["lat"])]
    liste.sort(key=lambda s: (-(s["puissance_max"] or 0), s["nom"]))
    nombre = sum(s["points"] for s in liste)
    journal.info("Bornes de recharge : %d station(s), %d point(s) de charge sur %d ligne(s) lue(s)",
                 len(liste), nombre, len(brut.get("lignes", [])))
    return {"version": BORNES_VERSION, "lu_le": brut.get("lu_le"), "nombre_points": nombre,
            "stations": liste}
