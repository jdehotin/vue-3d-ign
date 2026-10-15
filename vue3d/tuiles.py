"""Tuiles WMTS de la Géoplateforme refusées aux visiteurs, gardées sur le serveur.

La page lit l'orthophoto et le Plan IGN en tuiles WMTS de 256 pixels : le fond
de la scène quand l'orthophoto publiée manque, l'anneau, et surtout l'horizon,
jusqu'à 60 km. La Géoplateforme en refuse par épisodes (400, parfois 404) une
tuile qui existe : 253 refus en une visite le 15 octobre 2026 vers 17 h 15,
aucun ensuite, ni en rafale ni au pas — 576 tuiles lues 12 à la fois, 576 une
à une toutes les 100 ms, aux zooms 12, 13 et 17, depuis l'adresse du
serveur. Ce n'est donc pas le débit : la page n'y gagnerait rien à espacer ses
demandes. Elle réessayait une fois après 1,5 s ; au second refus, un trou ou
une tuile floue restait.

D'où ce stock. La page demande chaque tuile au serveur (`/api/tuile/…`) :
présente sur disque, il la sert ; sinon, il redirige vers l'IGN, et le
navigateur la lit là-bas comme avant — seules les tuiles en stock passent par
le serveur, et par la connexion qui le relie. Refusée au navigateur, la page la
redemande avec `?relire=1` : le serveur la lit lui-même, avec les reprises de
`geopf.get_avec_reprise`, la garde et la rend. Le stock ne contient donc que
des tuiles refusées au moins une fois à un visiteur, lues par le serveur à
l'IGN — jamais une image venue d'un navigateur, qu'on ne saurait vérifier :
l'IGN ne donne ni ETag ni date de modification.

Une tuile gardée se périme (TUILES_AGE_MAX_S) : l'IGN renouvelle
l'orthophoto, et sans ETag on ne peut pas lui demander si la sienne a changé.
"""

import logging
import math
import os
import tempfile
import threading
import time

import requests

from .geopf import get_avec_reprise, place
from .scene import EMPRISE_SERVIE

journal = logging.getLogger(__name__)

# Couches servies : (nom WMTS, type, extension, signature du fichier). Les
# mêmes que FONDS dans index.html.
COUCHES = {
    "ortho": ("ORTHOIMAGERY.ORTHOPHOTOS", "image/jpeg", "jpg", b"\xff\xd8"),
    "plan": ("GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2", "image/png", "png", b"\x89PNG"),
}
URL_WMTS = ("https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0"
            "&LAYER={couche}&STYLE=normal&FORMAT={type}"
            "&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}")
# Zooms que la page demande : HORIZON_ZOOM_MIN (9) à TUILE_ZOOM (18) dans
# index.html. Au-delà, une demande ne vient pas de la page.
TUILES_ZOOM = (9, 18)
# Marge autour de l'emprise servie (scene.EMPRISE_SERVIE), en degrés :
# l'horizon s'étend à HORIZON_RAYON = 60 km du point, 0,54° en latitude et
# 0,8° en longitude à 48°.
TUILES_MARGE_DEG = 1.0
# Durée de vie d'une tuile gardée. L'IGN dit aux navigateurs de garder une
# tuile 21 jours (Cache-Control: max-age=1814400) et renouvelle l'orthophoto
# d'un département tous les trois ans environ : 90 jours, choisis le 15
# octobre 2026, rattrapent une nouvelle prise de vue en moins d'un trimestre.
TUILES_AGE_MAX_S = 90 * 86400
# Intervalle entre deux purges du stock.
TUILES_PURGE_S = 86400
# Reprises d'une relecture : un visiteur l'attend. Trois essais comme
# geopf.GEOPF_ESSAIS, mais à 1,5 s d'écart et non 3 : le délai après lequel
# la page redemandait une tuile refusée, qui suffisait à Gordes (un 404 au
# zoom 16, puis 200 cinq fois de suite).
TUILES_ESSAIS = 3
TUILES_ATTENTE_S = 1.5
# Relectures à la fois, pour tout le processus. Chacune tient une des 8
# places de la Géoplateforme (geopf.GEOPF_SIMULTANEES) pendant ses reprises,
# 3 s au moins pour une tuile vraiment absente ; une scène ne gagne rien
# au-delà de 4 places (mesure du 1er octobre 2026, vue3d/geopf.py). Au-delà
# de 2, une relecture est refusée tout de suite (503) plutôt que d'attendre :
# elle bloquerait un des 8 fils de gunicorn.
TUILES_RELECTURES_SIMULTANEES = 2
# Une tuile vraiment absente — la mer au large dès le zoom 16, l'étranger dès
# le 13 — répond 404 à chaque reprise. Retenue ici, elle n'est plus
# redemandée à l'IGN pendant ce temps : la page la remplace par celle d'un
# ancêtre. Une absence à tort (trois refus en 3 s) floute la tuile au plus
# ce temps-là, d'où une journée et non la durée du stock.
TUILES_ABSENTE_S = 86400
# Relectures par heure et par adresse IP, quand le service a un quota de
# scènes (VUE3D_QUOTA) : 253 refus en une visite pendant l'épisode du 15
# octobre 2026 ; 1 000 en laissent passer quatre, et bornent ce qu'une seule
# adresse fait lire à l'IGN et écrire sur le disque (~15 Mo).
TUILES_RELECTURES_PAR_HEURE = 1000


class TuileAbsente(Exception):
    """L'IGN répond 404 à chaque reprise : pas d'image à ce zoom ici."""


class TuileIllisible(Exception):
    """La réponse de l'IGN n'est pas une image de la couche."""


class TuilesOccupees(Exception):
    """TUILES_RELECTURES_SIMULTANEES relectures sont déjà en cours."""


def valide(couche, z, x, y):
    """La tuile est-elle de celles que la page demande : couche servie, zoom
    de la page, dans la grille, et près de l'emprise servie ?"""
    if couche not in COUCHES or not TUILES_ZOOM[0] <= z <= TUILES_ZOOM[1]:
        return False
    n = 2 ** z
    if not (0 <= x < n and 0 <= y < n):
        return False
    ouest, est = x / n * 360 - 180, (x + 1) / n * 360 - 180
    nord = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    sud = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    (lat0, lat1), (lon0, lon1) = EMPRISE_SERVIE["lat"], EMPRISE_SERVIE["lon"]
    return (sud <= lat1 + TUILES_MARGE_DEG and nord >= lat0 - TUILES_MARGE_DEG
            and ouest <= lon1 + TUILES_MARGE_DEG and est >= lon0 - TUILES_MARGE_DEG)


def url_ign(couche, z, x, y):
    nom, type_, _, _ = COUCHES[couche]
    return URL_WMTS.format(couche=nom, type=type_, z=z, x=x, y=y)


def fetch_tuile(couche, z, x, y):
    """Octets de la tuile, lus à l'IGN avec reprises.

    Raises:
        TuileAbsente si l'IGN répond 404 jusqu'au bout ;
        TuileIllisible si la réponse n'est pas une image de la couche ;
        requests.RequestException pour tout autre échec.
    """
    _, type_, _, signature = COUCHES[couche]
    try:
        with place():
            reponse = get_avec_reprise(url_ign(couche, z, x, y), essais=TUILES_ESSAIS,
                                       attente=TUILES_ATTENTE_S)
    except requests.RequestException as exc:
        if getattr(exc, "response", None) is not None and exc.response.status_code == 404:
            raise TuileAbsente(f"{couche} {z}/{x}/{y}") from exc
        raise
    if (not reponse.headers.get("content-type", "").startswith(type_)
            or not reponse.content.startswith(signature)):
        raise TuileIllisible(f"{couche} {z}/{x}/{y} : {reponse.headers.get('content-type')}")
    return reponse.content


class Stock:
    """Les tuiles gardées, une par fichier : `dossier/couche/z/x/y.ext`.

    Args:
        lire: (couche, z, x, y) -> octets de la tuile ; `fetch_tuile`, ou une
            doublure pour les tests.
        horloge: secondes, pour l'âge des fichiers (leur instant d'écriture).
        chrono: secondes monotones, pour les absences et la purge.
    """

    def __init__(self, dossier, lire=fetch_tuile, horloge=time.time, chrono=time.monotonic):
        self.dossier = dossier
        self.lire = lire
        self.horloge = horloge
        self.chrono = chrono
        self._relectures = threading.BoundedSemaphore(TUILES_RELECTURES_SIMULTANEES)
        self._absentes = {}         # (couche, z, x, y) -> instant où elle a été dite absente
        self._verrou = threading.Lock()
        self._derniere_purge = None

    def chemin(self, couche, z, x, y):
        return os.path.join(self.dossier, couche, str(z), str(x), f"{y}.{COUCHES[couche][2]}")

    def present(self, couche, z, x, y):
        """Chemin de la tuile gardée, ou None. Une tuile périmée est effacée."""
        chemin = self.chemin(couche, z, x, y)
        try:
            age = self.horloge() - os.path.getmtime(chemin)
        except OSError:
            return None
        if age <= TUILES_AGE_MAX_S:
            return chemin
        self._effacer(chemin)
        return None

    def absente(self, couche, z, x, y):
        """L'IGN a-t-il dit cette tuile absente depuis moins de TUILES_ABSENTE_S ?"""
        with self._verrou:
            instant = self._absentes.get((couche, z, x, y))
            if instant is None:
                return False
            if self.chrono() - instant < TUILES_ABSENTE_S:
                return True
            del self._absentes[(couche, z, x, y)]
            return False

    def relire(self, couche, z, x, y):
        """Lit la tuile à l'IGN, la garde, et rend son chemin.

        Raises:
            TuilesOccupees si TUILES_RELECTURES_SIMULTANEES sont en cours ;
            TuileAbsente (retenue TUILES_ABSENTE_S), TuileIllisible, ou
            l'exception de la lecture ; rien n'est alors écrit.
        """
        if not self._relectures.acquire(blocking=False):
            raise TuilesOccupees()
        try:
            octets = self.lire(couche, z, x, y)
        except TuileAbsente:
            with self._verrou:
                self._absentes[(couche, z, x, y)] = self.chrono()
            raise
        finally:
            self._relectures.release()
        chemin = self.chemin(couche, z, x, y)
        os.makedirs(os.path.dirname(chemin), exist_ok=True)
        # D'un bloc : un fichier temporaire, renommé une fois complet. Une
        # tuile à moitié écrite serait servie telle quelle pendant 90 jours.
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(chemin))
        with os.fdopen(fd, "wb") as f:
            f.write(octets)
        os.replace(tmp, chemin)
        return chemin

    def purger(self):
        """Efface les tuiles plus vieilles que TUILES_AGE_MAX_S et les
        dossiers vides qu'elles laissent ; rend le nombre de tuiles effacées."""
        limite = self.horloge() - TUILES_AGE_MAX_S
        effacees = 0
        for racine, dossiers, fichiers in os.walk(self.dossier, topdown=False):
            for nom in fichiers:
                chemin = os.path.join(racine, nom)
                try:
                    vieille = os.path.getmtime(chemin) < limite
                except OSError:
                    continue
                if vieille and self._effacer(chemin):
                    effacees += 1
            if racine != self.dossier:
                try:
                    os.rmdir(racine)            # seulement s'il est vide
                except OSError:
                    pass
        with self._verrou:
            limite = self.chrono() - TUILES_ABSENTE_S
            for cle in [c for c, t in self._absentes.items() if t <= limite]:
                del self._absentes[cle]
        if effacees:
            journal.info("Tuiles : %d tuile(s) de plus de %d jours effacée(s)",
                         effacees, TUILES_AGE_MAX_S // 86400)
        return effacees

    def purger_si_du(self):
        """Lance une purge en tâche de fond si la dernière date de plus de
        TUILES_PURGE_S — la première fois, dès la première tuile demandée.
        Rend le fil lancé, ou None."""
        with self._verrou:
            maintenant = self.chrono()
            if (self._derniere_purge is not None
                    and maintenant - self._derniere_purge < TUILES_PURGE_S):
                return None
            self._derniere_purge = maintenant
        fil = threading.Thread(target=self.purger, name="purge-tuiles", daemon=True)
        fil.start()
        return fil

    @staticmethod
    def _effacer(chemin):
        try:
            os.remove(chemin)
            return True
        except OSError:
            return False
