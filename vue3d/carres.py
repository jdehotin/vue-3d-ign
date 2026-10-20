"""Carrés de la vue en voiture : bâtiments et routes BD TOPO, par 500 m.

La page de la voiture (static/voiture.html) avance sur un monde qui défile :
elle ne peut pas attendre une scène, qui demande 10 à 30 s par kilomètre
carré et que la prod limite à 20 par heure et par visiteur, quand une voiture
à 90 km/h traverse une zone de 1 000 m en 40 s. Elle lit donc des carrés de
la grille Lambert-93, faits des seules couches BD TOPO qui se lisent d'une
requête : 0,14 à 0,20 s par couche sur un carré de 500 m, mesuré le
2026-10-20 à Paris (Opéra), à Gordes et le long de l'A7 à Montélimar, de 46
à 49 Ko compressés pour les bâtiments, de 16 à 29 Ko pour les routes. Ni
LiDAR, ni MNH, ni végétation : la page y gagne de quoi charger plusieurs
kilomètres devant elle.

Un carré est la règle des scènes en petit : complet ou absent, jamais
périmé, écrit d'un bloc. Une couche en échec lève CarreIndisponible et rien
n'est écrit.

Format, JSON gzippé, coordonnées en décimètres depuis le coin sud-ouest du
carré (`origine`, en mètres Lambert-93) :

- `batiments` : ceux dont le premier sommet tombe dans le carré — le WFS rend
  tout ce qui touche l'emprise, et un bâtiment à cheval sur deux carrés
  sortirait deux fois. Chacun : `id` (cleabs), `usage`, `sol`, `gouttiere`,
  `faitage` (altitudes BD TOPO, m), `hauteur`, `etages`, `polygones` (anneaux
  [x0, y0, x1, y1, …], le premier extérieur) ;
- `routes` : tous les tronçons carrossables qui touchent le carré, entiers,
  pour que le graphe de la page se raccorde d'un carré à l'autre (elle les
  dédoublonne par `id`). Chacun : `id`, `nom` (BAN), `numero` (« D56 »),
  `importance` (1 à 6), `nature`, `sol` (-1 tunnel, 0, 1 pont…), `sens`
  (« 2 » double, « + » sens direct, « - » inverse, « » sans objet), `voies`,
  `largeur`, `acces` (null s'il est libre, sinon la valeur BD TOPO : « A
  péage », « Restreint aux ayants droit »…), `ligne` [x0, y0, z0, x1, y1, z1,
  …] (z en décimètres d'altitude).
"""

import gzip
import json
import os
import tempfile
import threading
from datetime import date

import requests

from .couches import COUCHE_BATIMENTS, COUCHE_ROUTES, SRS_LAMBERT93, lire_couche
from .geopf import LectureAbandonnee, en_parallele

# Version du format et de son contenu : le cache ne périme jamais, un carré
# change de dossier avec elle.
CARRES_VERSION = 1
# 500 m : la moitié d'une zone de la page, de quoi charger finement le long
# de la route sans lire tout un kilomètre de part et d'autre. Une réponse de
# 255 à 382 bâtiments aux trois lieux mesurés, loin des 5 000 du plafond WFS.
CARRE_M = 500
# La France métropolitaine en Lambert-93, Corse comprise, en carrés : de
# Brest (x ≈ 145 km) à Menton et la Corse (x ≈ 1 240 km), de Bonifacio
# (y ≈ 6 040 km) à Dunkerque (y ≈ 7 110 km), avec une marge.
CARRES_I = (0, 1_300_000 // CARRE_M)
CARRES_J = (6_000_000 // CARRE_M, 7_200_000 // CARRE_M)
# Carrés neufs par heure et par adresse IP, quand le service a un quota de
# scènes (VUE3D_QUOTA). La page en demande le long de la route prévue devant
# elle, sur une bande d'un carré de part et d'autre : de l'ordre de six par
# kilomètre, soit ~800 à 130 km/h. Un carré déjà lu ne compte pas.
CARRES_PAR_HEURE = 1500
# Ce qu'une voiture ne prend pas : le graphe de la page n'y passerait pas.
# Les galeries marchandes sont des « Route à 1 chaussée » dont l'accès est
# « Physiquement impossible » (Galerie de la Madeleine, Galerie des Champs) :
# la voiture simulée y entrait, sous les immeubles.
NATURES_ECARTEES = ("Sentier", "Escalier", "Piste cyclable")
ACCES_ECARTE = "Physiquement impossible"
ETATS_ECARTES = ("En projet", "En construction")
SENS = {"Double sens": "2", "Sens direct": "+", "Sens inverse": "-"}


class CarreIndisponible(Exception):
    """Une couche du carré n'a pas pu être lue : rien n'a été écrit."""


class CarreHorsEmprise(ValueError):
    """Le carré n'est pas en France métropolitaine."""


def verifier_carre(i, j):
    """
    Raises:
        CarreHorsEmprise si le carré (i, j) n'est pas servi.
    """
    if not (CARRES_I[0] <= i < CARRES_I[1] and CARRES_J[0] <= j < CARRES_J[1]):
        raise CarreHorsEmprise(f"Le carré {i}, {j} est hors de France métropolitaine, seule servie.")


def emprise_carre(i, j):
    """(ouest, sud, est, nord) du carré, en mètres Lambert-93."""
    return i * CARRE_M, j * CARRE_M, (i + 1) * CARRE_M, (j + 1) * CARRE_M


def _dm(v, origine):
    return round((v - origine) * 10)


def _nombre(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _anneaux(geometrie):
    """Polygones d'un (Multi)Polygon GeoJSON, chacun liste d'anneaux de sommets."""
    if not geometrie:
        return []
    if geometrie.get("type") == "Polygon":
        return [geometrie["coordinates"]]
    if geometrie.get("type") == "MultiPolygon":
        return geometrie["coordinates"]
    return []


def batiments_du_carre(geojson, i, j):
    """Les bâtiments du carré, au format compact (voir le module)."""
    x0, y0, x1, y1 = emprise_carre(i, j)
    sortie = []
    for f in geojson.get("features", []):
        p = f.get("properties") or {}
        if p.get("etat_de_l_objet") in ETATS_ECARTES:
            continue
        polygones = [[a for a in poly if len(a) >= 4] for poly in _anneaux(f.get("geometry"))]
        polygones = [poly for poly in polygones if poly]
        if not polygones:
            continue
        premier = polygones[0][0][0]
        if not (x0 <= premier[0] < x1 and y0 <= premier[1] < y1):
            continue
        sortie.append({
            "id": p.get("cleabs"),
            "usage": p.get("usage_1"),
            "sol": _nombre(p.get("altitude_minimale_sol")),
            "gouttiere": _nombre(p.get("altitude_minimale_toit")),
            "faitage": _nombre(p.get("altitude_maximale_toit")),
            "hauteur": _nombre(p.get("hauteur")),
            "etages": _nombre(p.get("nombre_d_etages")),
            "polygones": [[[c for s in anneau for c in (_dm(s[0], x0), _dm(s[1], y0))]
                           for anneau in poly] for poly in polygones],
        })
    return sortie


def routes_du_carre(geojson, i, j):
    """Les tronçons carrossables qui touchent le carré, au format compact."""
    x0, y0, _, _ = emprise_carre(i, j)
    sortie = []
    for f in geojson.get("features", []):
        p = f.get("properties") or {}
        g = f.get("geometry") or {}
        if (p.get("etat_de_l_objet") in ETATS_ECARTES or p.get("nature") in NATURES_ECARTEES
                or p.get("acces_vehicule_leger") == ACCES_ECARTE or g.get("type") != "LineString" or len(g.get("coordinates") or []) < 2):
            continue
        ligne = []
        for s in g["coordinates"]:
            z = s[2] if len(s) > 2 and _nombre(s[2]) is not None and s[2] > -1000 else None
            ligne += [_dm(s[0], x0), _dm(s[1], y0), None if z is None else round(z * 10)]
        importance = p.get("importance")
        sortie.append({
            "id": p.get("cleabs"),
            "nom": p.get("nom_voie_ban_gauche") or p.get("nom_voie_ban_droite")
                   or p.get("nom_collaboratif_gauche") or p.get("nom_collaboratif_droite"),
            "numero": p.get("cpx_numero"),
            "importance": int(importance) if str(importance).isdigit() else 6,
            "nature": p.get("nature"),
            "sol": int(p["position_par_rapport_au_sol"])
                   if str(p.get("position_par_rapport_au_sol")).lstrip("-").isdigit() else 0,
            "sens": SENS.get(p.get("sens_de_circulation"), ""),
            "voies": _nombre(p.get("nombre_de_voies")),
            "largeur": _nombre(p.get("largeur_de_chaussee")),
            "acces": None if p.get("acces_vehicule_leger") in (None, "Libre") else p["acces_vehicule_leger"],
            "ligne": ligne,
        })
    return sortie


def fetch_carre(i, j):
    """Le carré (i, j), lu à la Géoplateforme : bâtiments et routes ensemble.

    Raises:
        CarreIndisponible si l'une des deux couches n'a pas pu être lue.
    """
    emprise = emprise_carre(i, j)
    try:
        batiments, routes = en_parallele(
            lambda: lire_couche(COUCHE_BATIMENTS, *emprise, srs=SRS_LAMBERT93),
            lambda: lire_couche(COUCHE_ROUTES, *emprise, srs=SRS_LAMBERT93))
    except (requests.RequestException, LectureAbandonnee) as exc:
        raise CarreIndisponible(str(exc)) from exc
    return {
        "version": CARRES_VERSION, "carre": [i, j], "taille": CARRE_M,
        "origine": [emprise[0], emprise[1]], "lu": date.today().isoformat(),
        "batiments": batiments_du_carre(batiments, i, j),
        "routes": routes_du_carre(routes, i, j),
    }


class Carres:
    """Les carrés lus, sur disque : `dossier`/carres/v<version>/<i>/<j>.json.gz.

    Hors du dossier des versions de scène : un carré ne dépend pas de
    SCENE_VERSION. `lire` : (i, j) -> dict, injectable pour les tests.
    """

    def __init__(self, dossier, lire=fetch_carre):
        self.dossier = os.path.join(dossier, "carres", f"v{CARRES_VERSION}")
        self.lire = lire
        self._verrous = {}
        self._verrou_global = threading.Lock()

    def chemin(self, i, j):
        return os.path.join(self.dossier, str(i), f"{j}.json.gz")

    def present(self, i, j):
        return os.path.exists(self.chemin(i, j))

    def _verrou(self, cle):
        with self._verrou_global:
            return self._verrous.setdefault(cle, threading.Lock())

    def obtenir(self, i, j):
        """Le chemin du carré, lu au besoin ; deux demandes du même carré
        n'en font qu'une lecture.

        Raises:
            CarreHorsEmprise, CarreIndisponible.
        """
        verifier_carre(i, j)
        chemin = self.chemin(i, j)
        if os.path.exists(chemin):
            return chemin
        with self._verrou((i, j)):
            if os.path.exists(chemin):
                return chemin
            carre = self.lire(i, j)
            octets = gzip.compress(json.dumps(carre, ensure_ascii=False,
                                              separators=(",", ":")).encode())
            os.makedirs(os.path.dirname(chemin), exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=os.path.dirname(chemin))
            with os.fdopen(fd, "wb") as f:
                f.write(octets)
            os.replace(tmp, chemin)
        return chemin
