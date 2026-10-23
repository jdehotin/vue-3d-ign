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
import gzip
import json
import logging
import os
import tempfile
import threading
import time

import requests

from .carres import CARRE_M, CARRES_I, CARRES_J, lambert93, wgs84

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


def bornes_pour_emprise(west, south, east, north, brut):
    """La couche des bornes de l'emprise, réunies par station.

    Un point de charge par ligne de la base : ceux d'une même station
    (`id_station_itinerance`, sinon son nom à la même position) en font une
    seule, avec le nombre de ses points, ses puissances et ses prises.

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
    liste.sort(key=lambda s: (-(s["puissance_max"] or 0), s["nom"]))
    nombre = sum(s["points"] for s in liste)
    journal.info("Bornes de recharge : %d station(s), %d point(s) de charge sur %d ligne(s) lue(s)",
                 len(liste), nombre, len(brut.get("lignes", [])))
    return {"version": BORNES_VERSION, "lu_le": brut.get("lu_le"), "nombre_points": nombre,
            "stations": liste}


# --- Pour la vue en voiture : par bloc de la grille Lambert-93 -----------------------------------
# La voiture n'a pas de scène : elle lit les bornes par bloc de BLOC_M de
# côté, autour d'elle et le long de la route prévue. Mesuré le 2026-10-23 à
# l'API tabulaire : un bloc de 4 km compte 11 à 22 points de charge à
# Rousset, à la Barque (Fuveau) ou sur l'A7 à Montélimar, lus en 0,5 s ; 1 915
# points (191 stations) autour de l'Opéra, en 8,3 s et dix pages, 6,6 Ko
# gzippés. Un bloc de 2 km n'y coûte pas moins (10,7 s pour 936 points, le
# temps de l'API varie plus que la taille) et en demande quatre fois plus.
BLOC_M = 4000
BLOC_CARRES = BLOC_M // CARRE_M
BLOC_VERSION = 1
# La base est consolidée chaque jour ; une station ouverte la veille n'a pas
# à paraître le jour même. Au-delà, le bloc est relu, et gardé tel quel si la
# relecture échoue : il porte sa date de lecture.
BLOC_JOURS = 7
# Blocs neufs par heure et par adresse IP, quand le service a un quota : à
# 130 km/h, la voiture en traverse un toutes les deux minutes, avec ses
# voisins à 3 km de part et d'autre, une centaine par heure au plus.
BLOCS_PAR_HEURE = 200


class BlocHorsEmprise(ValueError):
    """Le bloc n'a aucun carré en France métropolitaine."""


def verifier_bloc(bi, bj):
    """
    Raises:
        BlocHorsEmprise si aucun carré du bloc (bi, bj) n'est servi.
    """
    i0, j0 = bi * BLOC_CARRES, bj * BLOC_CARRES
    if not (i0 + BLOC_CARRES > CARRES_I[0] and i0 < CARRES_I[1]
            and j0 + BLOC_CARRES > CARRES_J[0] and j0 < CARRES_J[1]):
        raise BlocHorsEmprise(f"Le bloc {bi}, {bj} est hors de France métropolitaine, seule servie.")


def bornes_du_bloc(bi, bj, lire=fetch_bornes):
    """Les stations dont la position tombe dans le bloc (bi, bj) de BLOC_M,
    Lambert-93 : l'emprise lue en degrés le déborde (les méridiens
    convergent), une station n'appartient qu'à un bloc.

    Raises:
        requests.RequestException si la base n'a pas pu être lue en entier.
    """
    x0, y0 = bi * BLOC_M, bj * BLOC_M
    coins = [wgs84(x, y) for x in (x0, x0 + BLOC_M) for y in (y0, y0 + BLOC_M)]
    w, s = min(c[0] for c in coins), min(c[1] for c in coins)
    e, n = max(c[0] for c in coins), max(c[1] for c in coins)
    brut = lire(w, s, e, n)
    couche = bornes_pour_emprise(w, s, e, n, brut)
    dedans = []
    for station in couche["stations"]:
        x, y = lambert93(station["lon"], station["lat"])
        if x0 <= x < x0 + BLOC_M and y0 <= y < y0 + BLOC_M:
            dedans.append(station)
    return {"version": BLOC_VERSION, "bloc": [bi, bj], "taille": BLOC_M, "lu_le": couche["lu_le"],
            "nombre_points": sum(st["points"] for st in dedans), "stations": dedans}


class BlocsBornes:
    """Les blocs de bornes lus, sur disque : `dossier`/carres/bornes-v<n>/<bi>/<bj>.json.gz,
    écrits d'un coup, relus après BLOC_JOURS. `lire` : (ouest, sud, est,
    nord) -> réponse brute (fetch_bornes), injectable pour les tests ;
    `aujourdhui` : la date du jour, de même."""

    def __init__(self, dossier, lire=fetch_bornes, aujourdhui=datetime.date.today):
        self.dossier = os.path.join(dossier, "carres", f"bornes-v{BLOC_VERSION}")
        self.lire = lire
        self.aujourdhui = aujourdhui
        self._verrous = {}
        self._verrou = threading.Lock()

    def chemin(self, bi, bj):
        return os.path.join(self.dossier, str(bi), f"{bj}.json.gz")

    def _lu_le(self, chemin):
        """La date de lecture du bloc gardé ; None s'il n'y en a pas."""
        if not os.path.exists(chemin):
            return None
        with gzip.open(chemin, "rt", encoding="utf-8") as f:
            return datetime.date.fromisoformat(json.load(f)["lu_le"])

    def a_jour(self, bi, bj):
        """Vrai si le bloc est gardé et de moins de BLOC_JOURS : le servir ne lit rien."""
        lu_le = self._lu_le(self.chemin(bi, bj))
        return lu_le is not None and (self.aujourdhui() - lu_le).days < BLOC_JOURS

    def obtenir(self, bi, bj):
        """Le chemin du bloc, lu ou relu au besoin ; deux demandes du même
        bloc n'en font qu'une lecture.

        Raises:
            BlocHorsEmprise.
            requests.RequestException si la base n'a pas répondu et qu'aucun
            bloc n'est gardé : rien n'est écrit.
        """
        verifier_bloc(bi, bj)
        chemin = self.chemin(bi, bj)
        with self._verrou:
            verrou = self._verrous.setdefault((bi, bj), threading.Lock())
        with verrou:
            if self.a_jour(bi, bj):
                return chemin
            try:
                bloc = bornes_du_bloc(bi, bj, self.lire)
            except requests.RequestException as exc:
                if os.path.exists(chemin):
                    journal.warning("Bornes du bloc %d, %d non relues (%s) : celles du %s restent",
                                    bi, bj, exc, self._lu_le(chemin))
                    return chemin
                raise
            octets = gzip.compress(json.dumps(bloc, ensure_ascii=False, separators=(",", ":")).encode())
            os.makedirs(os.path.dirname(chemin), exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=os.path.dirname(chemin))
            with os.fdopen(fd, "wb") as f:
                f.write(octets)
            os.replace(tmp, chemin)
        return chemin
