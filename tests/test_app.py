"""Serveur (vue3d/app.py) : paramètres, codes d'erreur, en-têtes."""
import gzip
import json
import math
import types

import numpy as np
import pytest

from vue3d import app as module_app
from vue3d.nuage import NUAGE_PROCHE_COTE_M
from vue3d.scene import SceneIncomplete


@pytest.fixture
def client(tmp_path):
    scene = {"version": 1, "bbox": [0, 0, 1, 1], "houppiers": []}

    def construire(lat, lon, avancer=None, zone=None):
        if lat == 45.0:
            raise SceneIncomplete("orthophoto illisible : Read timed out")
        return gzip.compress(json.dumps({**scene, "zone": zone}).encode()), b"\xff\xd8jpeg"

    def lire_monuments(west, south, east, north):
        # Au sud de 46° : Overpass en panne.
        if south < 46:
            raise ConnectionError("Overpass injoignable : 504")
        return {"elements": []}

    def lire_ouvrages(west, south, east, north):
        # Au sud de 46° : l'IGN en panne sur ces couches.
        if south < 46:
            raise ConnectionError("HTTP 504 sur construction_lineaire")
        return {"lineaires": {"features": []}, "surfaciques": {"features": []},
                "voies": {"features": []}, "terrains": {"features": []}}

    def lire_emprises(west, south, east, north):
        # Au sud de 46° : l'IGN en panne sur ces couches.
        if south < 46:
            raise ConnectionError("HTTP 504 sur cimetiere")
        return {"cimetieres": {"features": []}, "aerodromes": {"features": []},
                "pistes": {"features": []}, "postes": {"features": []},
                "haies": {"features": []}}

    lectures_nuage = []

    def lire_nuage(west, south, east, north, proche_m=None, cote_max_m=None):
        # Au sud de 46° : une dalle LiDAR HD illisible ; ailleurs, hors couverture.
        lectures_nuage.append(proche_m or cote_max_m and ("central", cote_max_m))
        if south < 46:
            raise ConnectionError("plage refusée")
        return None

    appli = module_app.creer_app(str(tmp_path), construire=construire,
                                 lire_monuments=lire_monuments, lire_ouvrages=lire_ouvrages,
                                 lire_emprises=lire_emprises,
                                 lire_nuage=lire_nuage)
    client = appli.test_client()
    client.lectures_nuage = lectures_nuage
    return client


@pytest.fixture
def client_vehicules(tmp_path):
    """Un service lancé avec un détecteur : la lecture rend une boîte au
    centre d'une orthophoto à 0,2 m, sauf au sud de 46° où elle échoue ; un
    navire un peu au sud, et la mer partout."""
    scene = {"version": 1, "bbox": [0, 0, 1, 1], "batiments": {"features": []}, "eau": None}

    def construire(lat, lon, avancer=None):
        return gzip.compress(json.dumps(scene).encode()), b"\xff\xd8jpeg"

    def orthophoto(west, south, east, north):
        """Une image noire à 0,2 m, comme ortho.fetch_ortho_rgb."""
        if south < 46:
            raise ConnectionError("Read timed out")
        kx = 111320 * math.cos(math.radians((south + north) / 2))
        return np.zeros((int((north - south) * 111320 / 0.2), int((east - west) * kx / 0.2), 3),
                        dtype=np.uint8)

    def lire_piscines(west, south, east, north, rgb=None):
        if rgb is None:
            rgb = orthophoto(west, south, east, north)
        return {"largeur": rgb.shape[1], "hauteur": rgb.shape[0],
                "piscines": [[300, 400, 50, 25, 0.0, 0.3, 0x5AC8D2, "rtmdet"]]}

    def lire_navires(west, south, east, north, rgb=None):
        if rgb is None:
            rgb = orthophoto(west, south, east, north)
        largeur, hauteur = rgb.shape[1], rgb.shape[0]
        return {"largeur": largeur, "hauteur": hauteur,
                "navires": [[largeur / 2, hauteur / 2 + 100, 60, 20, 0.0, 0.8, 0xF0F0F0, 230, "rtmdet"]]}

    def lire_mer(west, south, east, north):
        return {"communes": [], "altitudes": {"bbox": (west, south, east, north), "taille": 1,
                                              "valeurs": [[-99999.0]]}}

    def lire_vehicules(detecteur):
        def lire(west, south, east, north, rgb=None):
            if rgb is None:
                rgb = orthophoto(west, south, east, north)
            largeur, hauteur = rgb.shape[1], rgb.shape[0]
            return {"largeur": largeur, "hauteur": hauteur,
                    "boites": [[largeur / 2, hauteur / 2, 22, 10, 0.0, 0.6, 0, 0xC81E28, detecteur]]}
        return lire

    lecteur = types.SimpleNamespace(mode="rtmdet", detecteurs=("rtmdet",), orthophoto=orthophoto,
                                    piscines=lire_piscines, navires=lire_navires,
                                    vehicules=lire_vehicules)
    # Les ouvrages aussi sont doublés : sans cela, /api/scene lançait le vrai
    # fetch_ouvrages, et la suite appelait la Géoplateforme (six connexions
    # par passage, relevées le 2 octobre 2026).
    appli = module_app.creer_app(str(tmp_path), construire=construire,
                                 lire_monuments=lambda *b: {"elements": []},
                                 lire_ouvrages=lambda *b: {}, lire_emprises=lambda *b: {},
                                 lire_vehicules=lecteur,
                                 lire_mer=lire_mer)
    return appli.test_client()


def test_la_page_est_servie(client):
    r = client.get("/")
    assert r.status_code == 200 and b"Vue 3D IGN" in r.data


def test_la_page_demande_sa_scene_avant_three_js(client):
    """Un script ordinaire, avant la carte d'import et le module : il part
    pendant que three.js arrive du CDN."""
    page = client.get("/").get_data(as_text=True)
    assert page.index("window.DEMANDE_SCENE") < page.index('type="importmap"') < page.index('type="module"')


def test_la_scene_est_servie_gzippee(client):
    r = client.get("/api/scene?lat=48.8049&lon=2.1204")
    assert r.status_code == 200
    assert r.headers["Content-Encoding"] == "gzip"
    assert json.loads(gzip.decompress(r.data))["version"] == 1


def test_l_orthophoto_est_servie(client):
    r = client.get("/api/ortho?lat=48.8049&lon=2.1204")
    assert r.status_code == 200 and r.mimetype == "image/jpeg"


def test_sans_parametres_400(client):
    assert client.get("/api/scene").status_code == 400
    assert client.get("/api/scene?lat=abc&lon=2").status_code == 400


def test_la_zone_est_transmise_a_la_scene_et_a_ses_couches(client):
    r = client.get("/api/scene?lat=48.8049&lon=2.1204&zone=690")
    assert json.loads(gzip.decompress(r.data))["zone"] == 700
    r = client.get("/api/scene?lat=48.8049&lon=2.1204")
    assert json.loads(gzip.decompress(r.data))["zone"] is None
    assert client.get("/api/ouvrages?lat=48.8049&lon=2.1204&zone=700").status_code == 200
    assert client.get("/api/avancement?lat=48.8049&lon=2.1204&zone=700").get_json() == {"etat": "prete"}
    assert client.get("/api/avancement?lat=48.8049&lon=2.1204&zone=500").get_json() == {"etat": "attente"}


def test_une_zone_illisible_400(client):
    assert client.get("/api/scene?lat=48.8&lon=2.1&zone=grand").status_code == 400


def test_hors_emprise_422(client):
    r = client.get("/api/scene?lat=40&lon=2")
    assert r.status_code == 422 and "France" in r.get_json()["erreur"]


def test_une_panne_ign_rend_503_et_ne_cache_rien(client):
    r = client.get("/api/scene?lat=45.0&lon=2")
    assert r.status_code == 503
    assert "réessayez" in r.get_json()["erreur"]


def test_l_avancement_dit_si_la_scene_est_prete(client):
    assert client.get("/api/avancement?lat=48.8049&lon=2.1204").get_json() == {"etat": "attente"}
    client.get("/api/scene?lat=48.8049&lon=2.1204")
    r = client.get("/api/avancement?lat=48.8049&lon=2.1204")
    assert r.get_json() == {"etat": "prete"}
    # Il change d'une seconde à l'autre : jamais mis en cache.
    assert r.headers["Cache-Control"] == "no-store"
    assert client.get("/api/avancement").status_code == 400
    assert client.get("/api/avancement?lat=40&lon=2").status_code == 422


def test_la_couche_osm_est_servie_a_part(client):
    """Aucune partie sur l'emprise : la couche vaut null, et se met en cache."""
    r = client.get("/api/monuments?lat=48.8049&lon=2.1204")
    assert r.status_code == 200 and r.headers["Content-Encoding"] == "gzip"
    assert json.loads(gzip.decompress(r.data)) is None


def test_une_panne_osm_rend_503_sans_toucher_la_scene(client):
    """La scène reste servie ; seule la couche OSM attend un nouvel essai."""
    assert client.get("/api/scene?lat=45.5&lon=2").status_code == 200
    r = client.get("/api/monuments?lat=45.5&lon=2")
    assert r.status_code == 503 and "OpenStreetMap" in r.get_json()["erreur"]


def test_la_couche_des_ouvrages_est_servie_a_part(client):
    """Aucun ouvrage sur l'emprise : la couche vaut null, et se met en cache."""
    r = client.get("/api/ouvrages?lat=48.8049&lon=2.1204")
    assert r.status_code == 200 and r.headers["Content-Encoding"] == "gzip"
    assert json.loads(gzip.decompress(r.data)) is None


def test_une_panne_des_ouvrages_rend_503_sans_toucher_la_scene(client):
    """La scène reste servie ; seule la couche attend un nouvel essai."""
    assert client.get("/api/scene?lat=45.5&lon=2").status_code == 200
    r = client.get("/api/ouvrages?lat=45.5&lon=2")
    assert r.status_code == 503 and "IGN" in r.get_json()["erreur"]
    assert client.get("/api/scene?lat=45.5&lon=2").status_code == 200


def test_la_couche_des_emprises_est_servie_a_part(client):
    """Aucune emprise sur l'emprise : la couche vaut null, et se met en cache."""
    r = client.get("/api/emprises?lat=48.8049&lon=2.1204")
    assert r.status_code == 200 and r.headers["Content-Encoding"] == "gzip"
    assert json.loads(gzip.decompress(r.data)) is None


def test_une_panne_des_emprises_rend_503_sans_toucher_la_scene(client):
    """La scène reste servie ; seule la couche attend un nouvel essai."""
    assert client.get("/api/scene?lat=45.5&lon=2").status_code == 200
    r = client.get("/api/emprises?lat=45.5&lon=2")
    assert r.status_code == 503 and "IGN" in r.get_json()["erreur"]
    assert client.get("/api/scene?lat=45.5&lon=2").status_code == 200


def test_la_couche_du_nuage_est_servie_a_part(client):
    """Hors couverture LiDAR HD : la couche vaut null, et se met en cache."""
    r = client.get("/api/nuage?lat=48.8049&lon=2.1204")
    assert r.status_code == 200 and r.headers["Content-Encoding"] == "gzip"
    assert json.loads(gzip.decompress(r.data)) is None


def test_le_nuage_se_lit_d_abord_autour_du_point(client):
    """Zone de 1 000 m : le carré proche d'abord, puis la zone entière ; celle-ci
    écrite, la demande du carré la sert. Sur l'emprise par défaut, une seule
    lecture."""
    url = "/api/nuage?lat=48.8049&lon=2.1204&zone=1000"
    assert client.get(url + "&proche=1").status_code == 200
    assert client.lectures_nuage == [NUAGE_PROCHE_COTE_M]
    entiere = client.get(url)
    assert entiere.status_code == 200 and client.lectures_nuage == [NUAGE_PROCHE_COTE_M, None]
    r = client.get(url + "&proche=1")
    assert r.headers["ETag"] == entiere.headers["ETag"] and len(client.lectures_nuage) == 2
    assert client.get("/api/nuage?lat=48.8049&lon=2.1204&proche=1").status_code == 200
    assert client.lectures_nuage[-1] is None


def test_une_zone_de_2000_m_ne_lit_que_le_kilometre_central_du_nuage(client):
    """Le carré proche d'abord, puis le carré central de 1 000 m au lieu
    de la zone entière : la Géoplateforme refuse la lecture (429), et sa
    mémoire en demanderait une dizaine de Go. Jusqu'à 1 000 m, rien ne change."""
    url = "/api/nuage?lat=48.8049&lon=2.1204&zone=2000"
    assert client.get(url + "&proche=1").status_code == 200
    assert client.get(url).status_code == 200
    assert client.lectures_nuage == [NUAGE_PROCHE_COTE_M, ("central", 1000)]
    assert client.get("/api/nuage?lat=48.8049&lon=2.1204&zone=1000").status_code == 200
    assert client.lectures_nuage[-1] is None


def test_une_panne_du_nuage_rend_503_sans_toucher_la_scene(client):
    assert client.get("/api/scene?lat=45.5&lon=2").status_code == 200
    r = client.get("/api/nuage?lat=45.5&lon=2")
    assert r.status_code == 503 and "IGN" in r.get_json()["erreur"]
    assert client.get("/api/scene?lat=45.5&lon=2").status_code == 200


def test_sans_detecteur_les_couches_de_l_orthophoto_le_disent(client):
    """Ni erreur ni fichier : la page lit le mode et ne montre pas la couche."""
    assert client.get("/api/sante").get_json()["vehicules"] == {"mode": "aucun", "detecteurs": []}
    r = client.get("/api/vehicules?lat=48.8049&lon=2.1204")
    assert r.status_code == 200
    assert r.get_json() == {"mode": "aucun", "detecteur": None, "vehicules": []}
    # Le service peut être relancé avec un détecteur : jamais gardée.
    assert r.headers["Cache-Control"] == "no-store"
    r = client.get("/api/piscines?lat=48.8049&lon=2.1204")
    assert r.get_json() == {"mode": "aucun", "piscines": []} and r.headers["Cache-Control"] == "no-store"
    r = client.get("/api/navires?lat=48.8049&lon=2.1204")
    assert r.get_json() == {"mode": "aucun", "navires": []} and r.headers["Cache-Control"] == "no-store"


def test_les_couches_de_l_orthophoto_sont_servies_a_part_detecteur_par_detecteur(client_vehicules):
    """La page apprend les détecteurs par /api/sante, demande les piscines,
    les navires, puis les véhicules de chaque détecteur : chaque couche a sa
    route."""
    sante = client_vehicules.get("/api/sante")
    assert sante.get_json()["vehicules"] == {"mode": "rtmdet", "detecteurs": ["rtmdet"]}
    assert sante.headers["Cache-Control"] == "no-store"
    r = client_vehicules.get("/api/piscines?lat=48.8049&lon=2.1204")
    assert r.status_code == 200 and r.headers["Content-Encoding"] == "gzip"
    couche = json.loads(gzip.decompress(r.data))
    assert couche["mode"] == "rtmdet" and [p[2:] for p in couche["piscines"]] == [[10.0, 5.0, 90.0, 0x5AC8D2]]
    r = client_vehicules.get("/api/navires?lat=48.8049&lon=2.1204")
    assert r.status_code == 200 and r.headers["Content-Encoding"] == "gzip"
    couche = json.loads(gzip.decompress(r.data))
    assert couche["mode"] == "rtmdet" and [n[2:] for n in couche["navires"]] == [[12.0, 4.0, 90.0, 0xF0F0F0]]
    r = client_vehicules.get("/api/vehicules?lat=48.8049&lon=2.1204&detecteur=rtmdet")
    assert r.status_code == 200 and r.headers["Content-Encoding"] == "gzip"
    couche = json.loads(gzip.decompress(r.data))
    assert couche["detecteur"] == "rtmdet" and "piscines" not in couche
    (lon, lat, longueur, largeur, cap, couleur), = couche["vehicules"]
    assert (round(lat, 4), round(lon, 4)) == (48.8049, 2.1204) and couleur == 0xC81E28
    # Sans détecteur, ou avec un détecteur que ce service n'a pas : 400, avec la liste.
    r = client_vehicules.get("/api/vehicules?lat=48.8049&lon=2.1204")
    assert r.status_code == 400 and "rtmdet" in r.get_json()["erreur"]
    r = client_vehicules.get("/api/vehicules?lat=48.8049&lon=2.1204&detecteur=yolo")
    assert r.status_code == 400 and "yolo" in r.get_json()["erreur"] and "rtmdet" in r.get_json()["erreur"]
    assert client_vehicules.get("/api/vehicules?detecteur=rtmdet").status_code == 400
    assert client_vehicules.get("/api/vehicules?lat=40&lon=2&detecteur=rtmdet").status_code == 422
    assert client_vehicules.get("/api/piscines?lat=40&lon=2").status_code == 422
    assert client_vehicules.get("/api/navires?lat=40&lon=2").status_code == 422


def test_la_couche_des_vehicules_est_revalidee_a_chaque_demande(client_vehicules):
    """Le navigateur ne la garde pas : à la même adresse, elle change avec le
    détecteur, la version, et quand la scène est reconstruite. Le fichier,
    son nom et l'instant de son écriture, sert de validateur."""
    from vue3d.scene import nom_piscines, nom_vehicules
    url = "/api/vehicules?lat=48.8049&lon=2.1204&detecteur=rtmdet"
    r = client_vehicules.get(url)
    assert r.headers["Cache-Control"] == "no-cache"
    assert r.headers["ETag"].startswith(f'"{nom_vehicules("rtmdet")}-')
    # Même fichier : 304, sans corps.
    r2 = client_vehicules.get(url, headers={"If-None-Match": r.headers["ETag"]})
    assert r2.status_code == 304 and r2.data == b"" and r2.headers["ETag"] == r.headers["ETag"]
    # Le validateur d'un autre détecteur, ou d'une autre version : la couche entière.
    r3 = client_vehicules.get(url, headers={"If-None-Match": f'"{nom_vehicules("yolo")}"'})
    assert r3.status_code == 200 and json.loads(gzip.decompress(r3.data))["detecteur"] == "rtmdet"
    # Les piscines, de même.
    r4 = client_vehicules.get("/api/piscines?lat=48.8049&lon=2.1204")
    assert r4.headers["Cache-Control"] == "no-cache"
    assert r4.headers["ETag"].startswith(f'"{nom_piscines("rtmdet")}-')


def test_une_panne_des_vehicules_rend_503_sans_toucher_la_scene(client_vehicules):
    assert client_vehicules.get("/api/scene?lat=45.5&lon=2").status_code == 200
    r = client_vehicules.get("/api/vehicules?lat=45.5&lon=2&detecteur=rtmdet")
    assert r.status_code == 503 and "véhicules" in r.get_json()["erreur"]
    r = client_vehicules.get("/api/piscines?lat=45.5&lon=2")
    assert r.status_code == 503 and "piscines" in r.get_json()["erreur"]
    r = client_vehicules.get("/api/navires?lat=45.5&lon=2")
    assert r.status_code == 503 and "navires" in r.get_json()["erreur"]
    assert client_vehicules.get("/api/scene?lat=45.5&lon=2").status_code == 200


def test_sante(client):
    assert client.get("/api/sante").get_json() == {
        "ok": True, "vehicules": {"mode": "aucun", "detecteurs": []},
        "panneaux": {"actif": False, "source": None}}


def test_sans_registre_la_couche_des_panneaux_le_dit(client):
    r = client.get("/api/panneaux?lat=48.8049&lon=2.1204")
    assert r.status_code == 200 and r.get_json() == {"actif": False, "panneaux": []}
    assert r.headers["Cache-Control"] == "no-store"


@pytest.fixture
def client_panneaux(tmp_path):
    """Un service lancé avec un registre : une installation carrée de 10 m au
    point demandé, sauf au sud de 46° où la base est illisible."""
    scene = {"version": 1, "bbox": [0, 0, 1, 1]}

    def construire(lat, lon, avancer=None):
        return gzip.compress(json.dumps(scene).encode()), b"\xff\xd8jpeg"

    def lire_panneaux(west, south, east, north):
        if south < 46:
            raise OSError("disk I/O error")
        lon, lat = (west + east) / 2, (south + north) / 2
        d = 5 / 111320
        return [{"contour": [[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d],
                             [lon - d, lat - d]], "surface": 100, "kwp": 12, "annee": 2023}]

    appli = module_app.creer_app(str(tmp_path), construire=construire,
                                 lire_monuments=lambda *b: {"elements": []},
                                 lire_ouvrages=lambda *b: {}, lire_emprises=lambda *b: {},
                                 lire_panneaux=lire_panneaux)
    return appli.test_client()


def test_la_couche_des_panneaux_est_servie_a_part(client_panneaux):
    from vue3d.scene import NOM_PANNEAUX
    assert client_panneaux.get("/api/sante").get_json()["panneaux"] == {
        "actif": True, "source": "OpenPVMapper (G. Kasmi), CC-BY 4.0"}
    r = client_panneaux.get("/api/panneaux?lat=48.8049&lon=2.1204")
    assert r.status_code == 200 and r.headers["Content-Encoding"] == "gzip"
    assert r.headers["Cache-Control"] == "no-cache" and r.headers["ETag"].startswith(f'"{NOM_PANNEAUX}-')
    (p,) = json.loads(gzip.decompress(r.data))["panneaux"]
    assert p["surface"] == 100 and p["kwp"] == 12 and p["annee"] == 2023 and len(p["contour"]) == 4
    assert client_panneaux.get("/api/panneaux").status_code == 400
    assert client_panneaux.get("/api/panneaux?lat=40&lon=2").status_code == 422
    # La base illisible : 503, rien en cache, la scène reste servie.
    assert client_panneaux.get("/api/scene?lat=45.5&lon=2").status_code == 200
    r = client_panneaux.get("/api/panneaux?lat=45.5&lon=2")
    assert r.status_code == 503 and "panneaux" in r.get_json()["erreur"]


def test_la_scene_et_l_orthophoto_sont_revalidees(client):
    """Une scène peut être reconstruite sous la même adresse : le navigateur
    revalide, et reçoit un 304 sans corps tant qu'elle n'a pas été réécrite."""
    for route in ("/api/scene", "/api/ortho"):
        url = f"{route}?lat=48.8049&lon=2.1204"
        r = client.get(url)
        assert r.status_code == 200 and r.headers["Cache-Control"] == "no-cache"
        r2 = client.get(url, headers={"If-None-Match": r.headers["ETag"]})
        assert r2.status_code == 304 and r2.data == b""


def test_le_bouton_reconstruit_la_scene(client, tmp_path):
    """POST /api/reconstruire met la scène de côté : la demande suivante la
    reconstruit, avec un autre validateur. Trop tôt après, refusé (429)."""
    import os
    import time
    url = "/api/scene?lat=48.8049&lon=2.1204"
    avant = client.get(url).headers["ETag"]
    r = client.post("/api/reconstruire?lat=48.8049&lon=2.1204")
    assert r.status_code == 429 and "Reconstruction refusée" in r.get_json()["erreur"]
    (chemin,) = [os.path.join(d, f) for d, _, fs in os.walk(tmp_path) for f in fs
                 if f == "scene.json.gz"]
    t = time.time() - 3600
    os.utime(chemin, (t, t))
    r = client.post("/api/reconstruire?lat=48.8049&lon=2.1204")
    assert r.status_code == 202 and r.headers["Cache-Control"] == "no-store"
    assert client.get("/api/avancement?lat=48.8049&lon=2.1204").get_json() == {"etat": "attente"}
    r = client.get(url, headers={"If-None-Match": avant})
    assert r.status_code == 200 and r.headers["ETag"] != avant
    assert client.post("/api/reconstruire?lat=48.8049&lon=2.1204").status_code == 429
    assert client.post("/api/reconstruire?lat=abc&lon=2").status_code == 400
    assert client.get("/api/reconstruire?lat=48.8049&lon=2.1204").status_code == 405


@pytest.fixture
def client_dpe_dvf(tmp_path):
    """DPE, DVF et bornes de recharge doublés : chaque lecture est notée ; au
    sud de 46°, les trois sources sont en panne."""
    lectures = []
    scene = {"version": 1, "bbox": [0, 0, 1, 1], "batiments": {"features": []}}

    def construire(lat, lon, avancer=None):
        return gzip.compress(json.dumps(scene).encode()), b"\xff\xd8jpeg"

    def lire_dpe(west, south, east, north):
        lectures.append("dpe")
        if south < 46:
            raise ConnectionError("API de l'ADEME injoignable")
        return {"lu_le": "2026-10-09", "lignes": [{
            "numero_dpe": "1", "etiquette_dpe": "C", "etiquette_ges": "B", "type_batiment": "maison",
            "_geopoint": f"{(south + north) / 2},{(west + east) / 2}"}]}

    def lire_dvf(west, south, east, north):
        lectures.append("dvf")
        if south < 46:
            raise ConnectionError("fichiers DVF injoignables")
        return {"lu_le": "2026-10-09", "parcelles": {"features": []}, "lignes": [],
                "millesimes": [2025], "absent": ["Bas-Rhin"]}

    def lire_bornes(west, south, east, north):
        lectures.append("bornes")
        if south < 46:
            raise ConnectionError("data.gouv.fr injoignable")
        return {"lu_le": "2026-10-09", "lignes": [{
            "id_station_itinerance": "S1", "id_pdc_itinerance": "P1", "nom_station": "Mairie",
            "puissance_nominale": 22, "consolidated_longitude": (west + east) / 2,
            "consolidated_latitude": (south + north) / 2}]}

    appli = module_app.creer_app(str(tmp_path), construire=construire,
                                 lire_monuments=lambda *b: {"elements": []},
                                 lire_ouvrages=lambda *b: {}, lire_emprises=lambda *b: {},
                                 lire_nuage=lambda *b: None,
                                 lire_dpe=lire_dpe, lire_dvf=lire_dvf, lire_bornes=lire_bornes)
    return appli.test_client(), lectures


def test_dpe_et_dvf_ne_sont_lus_qu_a_la_demande(client_dpe_dvf):
    """Choix de l'utilisateur : la scène ne les lit jamais d'office ; leur
    route les lit une fois, puis les sert du cache, datés."""
    client, lectures = client_dpe_dvf
    assert client.get("/api/scene?lat=48.8049&lon=2.1204").status_code == 200
    assert lectures == []
    for route in ("dpe", "dvf", "bornes"):
        r = client.get(f"/api/{route}?lat=48.8049&lon=2.1204")
        assert r.status_code == 200 and r.headers["Content-Encoding"] == "gzip"
        assert r.headers["Cache-Control"] == "no-cache"
        couche = json.loads(gzip.decompress(r.data))
        assert couche["lu_le"] == "2026-10-09"
        client.get(f"/api/{route}?lat=48.8049&lon=2.1204")
    assert lectures == ["dpe", "dvf", "bornes"]
    (station,) = couche["stations"]
    assert station["nom"] == "Mairie" and station["puissance_max"] == 22
    r = client.get("/api/dvf?lat=48.8049&lon=2.1204")
    assert json.loads(gzip.decompress(r.data))["absent"] == ["Bas-Rhin"]
    r = client.get("/api/dpe?lat=48.8049&lon=2.1204")
    (adresse,) = json.loads(gzip.decompress(r.data))["adresses"]
    assert adresse["resume"]["mediane"] == "C" and adresse["dpe"][0]["numero"] == "1"


def test_une_panne_de_l_ademe_ou_de_dvf_rend_503_sans_rien_ecrire(client_dpe_dvf):
    client, lectures = client_dpe_dvf
    r = client.get("/api/dpe?lat=45.5&lon=2")
    assert r.status_code == 503 and "ADEME" in r.get_json()["erreur"]
    r = client.get("/api/dvf?lat=45.5&lon=2")
    assert r.status_code == 503 and "DVF" in r.get_json()["erreur"]
    r = client.get("/api/bornes?lat=45.5&lon=2")
    assert r.status_code == 503 and "bornes de recharge" in r.get_json()["erreur"]
    client.get("/api/dpe?lat=45.5&lon=2")
    assert lectures == ["dpe", "dvf", "bornes", "dpe"]
    assert client.get("/api/dpe?lat=40&lon=2").status_code == 422


@pytest.fixture
def client_quota(tmp_path):
    """Fabrique de services publics, à quota et proxy choisis, sur un même
    cache : une scène construite par l'un est en cache pour l'autre."""
    scene = {"version": 1, "bbox": [0, 0, 1, 1], "batiments": {"features": []}}

    def construire(lat, lon, avancer=None):
        return gzip.compress(json.dumps(scene).encode()), b"\xff\xd8jpeg"

    def creer(**options):
        return module_app.creer_app(str(tmp_path), construire=construire,
                                    lire_monuments=lambda *b: {"elements": []},
                                    lire_ouvrages=lambda *b: {}, lire_emprises=lambda *b: {},
                                 lire_nuage=lambda *b: None,
                                    **options).test_client()
    return creer


VISITEUR_A = {"REMOTE_ADDR": "203.0.113.5"}
VISITEUR_B = {"REMOTE_ADDR": "203.0.113.6"}


def test_le_quota_compte_les_scenes_neuves_de_chaque_visiteur(client_quota):
    """Deux scènes neuves par heure : la troisième est refusée (429, avec
    Retry-After), de même qu'une couche d'un point neuf, qui construirait sa
    scène. Les requêtes d'une page sur un même lieu neuf ne comptent qu'une
    scène ; une scène en cache reste ouverte ; chaque visiteur a son quota."""
    client = client_quota(quota=2)
    for url in ("/api/scene?lat=48.801&lon=2.12", "/api/ortho?lat=48.801&lon=2.12",
                "/api/monuments?lat=48.801&lon=2.12", "/api/scene?lat=48.802&lon=2.12"):
        assert client.get(url, environ_base=VISITEUR_A).status_code == 200, url
    r = client.get("/api/scene?lat=48.803&lon=2.12", environ_base=VISITEUR_A)
    assert r.status_code == 429 and 0 < int(r.headers["Retry-After"]) <= 3600
    assert "au plus 2 scènes nouvelles par heure" in r.get_json()["erreur"]
    assert client.get("/api/ouvrages?lat=48.804&lon=2.12", environ_base=VISITEUR_A).status_code == 429
    assert client.get("/api/scene?lat=48.801&lon=2.12", environ_base=VISITEUR_A).status_code == 200
    assert client.get("/api/scene?lat=48.803&lon=2.12", environ_base=VISITEUR_B).status_code == 200
    assert client.get("/api/scene?lat=48.803&lon=2.12", environ_base=VISITEUR_A).status_code == 200
    assert client.get("/api/scene?lat=40&lon=2.12", environ_base=VISITEUR_A).status_code == 422


def test_sans_quota_par_defaut(client_quota, monkeypatch):
    monkeypatch.delenv("VUE3D_QUOTA", raising=False)
    client = client_quota()
    for i in range(5):
        assert client.get(f"/api/scene?lat=48.81{i}&lon=2.12",
                          environ_base=VISITEUR_A).status_code == 200
    monkeypatch.setenv("VUE3D_QUOTA", "1")
    client = client_quota()
    assert client.get("/api/scene?lat=48.821&lon=2.12", environ_base=VISITEUR_A).status_code == 200
    assert client.get("/api/scene?lat=48.822&lon=2.12", environ_base=VISITEUR_A).status_code == 429
    monkeypatch.setenv("VUE3D_QUOTA", "vingt")
    with pytest.raises(ValueError, match="VUE3D_QUOTA"):
        client_quota()


def test_derriere_un_proxy_le_visiteur_est_celui_de_x_forwarded_for(client_quota):
    """Derrière Caddy, tous les visiteurs arrivent de 127.0.0.1 : avec
    proxy=1, chacun est reconnu à X-Forwarded-For. Sans proxy déclaré,
    l'en-tête est ignoré : un visiteur ne s'invente pas une adresse par
    requête."""
    derriere = client_quota(quota=1, proxy=1)

    def statut(client, lat, adresse):
        return client.get(f"/api/scene?lat={lat}&lon=2.12",
                          headers={"X-Forwarded-For": adresse}).status_code
    assert statut(derriere, 48.831, "198.51.100.1") == 200
    assert statut(derriere, 48.832, "198.51.100.2") == 200
    assert statut(derriere, 48.833, "198.51.100.1") == 429
    direct = client_quota(quota=1)
    assert statut(direct, 48.841, "198.51.100.3") == 200
    assert statut(direct, 48.842, "198.51.100.4") == 429


def test_une_reconstruction_refusee_par_le_quota_laisse_la_scene(client_quota, tmp_path):
    """Le quota se vérifie avant de mettre la scène de côté : refusée, elle
    reste en place. Acceptée, la reconstruction compte une scène, une seule
    fois avec la construction qui suit."""
    import os
    import time
    client = client_quota(quota=1)
    assert client.get("/api/scene?lat=48.851&lon=2.12", environ_base=VISITEUR_B).status_code == 200
    assert client.get("/api/scene?lat=48.852&lon=2.12", environ_base=VISITEUR_A).status_code == 200
    t = time.time() - 3600
    for d, _, fs in os.walk(tmp_path):
        if "scene.json.gz" in fs:
            os.utime(os.path.join(d, "scene.json.gz"), (t, t))
    r = client.post("/api/reconstruire?lat=48.851&lon=2.12", environ_base=VISITEUR_A)
    assert r.status_code == 429 and "Retry-After" in r.headers
    assert client.get("/api/avancement?lat=48.851&lon=2.12").get_json() == {"etat": "prete"}
    assert client.post("/api/reconstruire?lat=48.851&lon=2.12",
                       environ_base=VISITEUR_B).status_code == 202
    assert client.get("/api/scene?lat=48.851&lon=2.12", environ_base=VISITEUR_B).status_code == 200
    assert client.get("/api/scene?lat=48.853&lon=2.12", environ_base=VISITEUR_B).status_code == 429


def test_le_quota_glisse_sur_une_heure():
    t = [0.0]
    quota = module_app.Quota(2, horloge=lambda: t[0])
    assert quota.attente("a", 1) == 0
    t[0] = 600
    assert quota.attente("a", 2) == 0
    assert quota.attente("a", 1) == 0                  # déjà comptée
    t[0] = 1200
    assert quota.attente("a", 3, compter=False) == 2400
    assert quota.attente("a", 3) == 2400               # la scène 1 sort à 3 600 s
    t[0] = 3600
    assert quota.attente("a", 3) == 0
    assert quota.attente("a", 4) == 600                # la scène 2 sort à 4 200 s
    # Une adresse muette depuis une heure est oubliée.
    t[0] = 8000
    quota.attente("b", 1)
    assert "a" not in quota._scenes

# --- Dépôt dans un projet Trimble Connect (vue3d/app.py) ---------------------

class _Reponse:
    """Une réponse de Connect, sans réseau."""

    def __init__(self, code, corps=None):
        self.status_code = code
        self.content = b"{}" if corps is not None else b""
        self._corps = corps if corps is not None else {}

    def json(self):
        return self._corps

    def raise_for_status(self):
        raise AssertionError("aucune erreur réseau attendue ici")


class _Session:
    """Les trois temps du dépôt Connect : initiate, écriture, commit."""

    def __init__(self, origine="https://app21.connect.trimble.com"):
        self.origine = origine
        self.appels = []
        self.ecrit = None
        self.amorces = []

    def get(self, url, headers=None, timeout=None):
        self.appels.append(("GET", url))
        if url.startswith(self.origine + "/tc/api/2.0/projects/"):
            return _Reponse(200, {"id": "projet", "rootId": "racine"})
        return _Reponse(404)

    def post(self, url, headers=None, json=None, timeout=None):
        self.appels.append(("POST", url, json))
        if url.endswith("/files/fs/initiate"):
            self.amorces.append(json)
            return _Reponse(200, {"uploadURL": "https://depot.example/1", "uploadId": "u1"})
        if url.endswith("/files/fs/commit"):
            return _Reponse(200, {"data": {"id": "f1", "name": "vue3d.ifc"}})
        return _Reponse(404)

    def put(self, url, data=None, timeout=None):
        self.appels.append(("PUT", url))
        self.ecrit = data
        return _Reponse(200)


def test_le_depot_connect_suit_les_trois_temps_de_l_api():
    session = _Session()
    depose = module_app.deposer_dans_projet("Bearer jeton", "vK4pJn9BUh4", "vue3d.ifc",
                                            b"ISO-10303-21;", session=session)
    assert depose["ok"] and depose["fichier"]["id"] == "f1"
    # Le projet d'Europe est le premier essayé : une seule origine le connaît.
    assert session.appels[0] == ("GET", "https://app21.connect.trimble.com/tc/api/2.0/projects/vK4pJn9BUh4")
    assert session.amorces == [{"parentId": "racine", "parentType": "FOLDER", "name": "vue3d.ifc"}]
    assert session.ecrit == b"ISO-10303-21;"
    assert session.appels[-1][1].endswith("/files/fs/commit")


def test_le_depot_connect_refuse_un_projet_inconnu():
    class Aucun(_Session):
        def get(self, url, headers=None, timeout=None):
            return _Reponse(404)

    with pytest.raises(module_app.DepotRefuse) as refus:
        module_app.deposer_dans_projet("Bearer jeton", "inconnu", "vue3d.ifc", b"x",
                                       session=Aucun())
    assert refus.value.code == 404


def test_le_depot_exige_le_jeton_et_un_format_connu(client):
    assert client.post("/api/connect/fichier?projet=vK4pJn9BUh4&nom=a.ifc",
                       data=b"x").status_code == 401
    assert client.post("/api/connect/fichier?projet=vK4pJn9BUh4&nom=a.exe",
                       data=b"x", headers={"Authorization": "Bearer " + "j" * 40}).status_code == 400


def test_le_depot_dun_fichier_passe_par_le_serveur(client, monkeypatch):
    vus = {}

    def deposer(jeton, projet, nom, donnees):
        vus.update(jeton=jeton, projet=projet, nom=nom, donnees=donnees)
        return {"ok": True, "projet": projet, "nom": nom, "fichier": {"id": "f1"}}

    monkeypatch.setattr(module_app, "deposer_dans_projet", deposer)
    r = client.post("/api/connect/fichier?projet=vK4pJn9BUh4&nom=vue3d-43.9-5.2-z500.ifc",
                    data=b"ISO-10303-21;",
                    headers={"Authorization": "Bearer " + "j" * 40})
    assert r.status_code == 200 and r.get_json()["fichier"]["id"] == "f1"
    assert vus["projet"] == "vK4pJn9BUh4" and vus["donnees"] == b"ISO-10303-21;"
    assert vus["nom"] == "vue3d-43.9-5.2-z500.ifc" and vus["jeton"].startswith("Bearer ")


# --- L'emprise d'un projet, lue dans sa fiche ---------------------------------

class _Projet(_Session):
    """La fiche du projet, avec l'adresse que Connect y range."""

    def __init__(self, adresse):
        super().__init__()
        self.adresse = adresse

    def get(self, url, headers=None, timeout=None):
        self.appels.append(("GET", url))
        if url.startswith(self.origine + "/tc/api/2.0/projects/"):
            fiche = {"id": "projet", "rootId": "racine"}
            if self.adresse is not None:
                fiche["address"] = self.adresse
            return _Reponse(200, fiche)
        return _Reponse(404)


def test_lemprise_se_lit_dans_le_contour_de_ladresse():
    # La forme documentée par l'API Core : un tableau de sommets [lat, lon].
    session = _Projet({"text": "Aix",
                       "geometry": "[[43.5, 5.4], [43.5, 5.5], [43.6, 5.5]]"})
    assert module_app.obtenir_emprise_projet(session, {}, "vK4pJn9BUh4") == \
        {"minLat": 43.5, "maxLat": 43.6, "minLon": 5.4, "maxLon": 5.5}


def test_lemprise_lit_aussi_un_polygone_geojson():
    # L'autre forme, en longitude puis latitude : le même carré.
    session = _Projet({"geometry": '{"type": "Polygon", "coordinates": '
                                   '[[[5.4, 43.5], [5.5, 43.5], [5.5, 43.6]]]}'})
    assert module_app.obtenir_emprise_projet(session, {}, "vK4pJn9BUh4") == \
        {"minLat": 43.5, "maxLat": 43.6, "minLon": 5.4, "maxLon": 5.5}


@pytest.mark.parametrize("adresse", [
    None,                                            # pas d'adresse du tout
    {"text": "Aix"},                                 # une adresse sans contour
    {"geometry": "[[43.5, 5.4]]"},                   # un seul point d'ancrage
    {"geometry": "[[43.5, 5.4], [43.6, 5.5]]"},      # deux sommets : pas une zone
])
def test_sans_contour_lemprise_demande_a_etre_definie(adresse):
    with pytest.raises(module_app.DepotRefuse) as refus:
        module_app.obtenir_emprise_projet(_Projet(adresse), {}, "vK4pJn9BUh4")
    assert refus.value.code == 404
    assert "L'emprise du projet n'est pas définie dans Trimble Connect" in str(refus.value)
    assert "paramètres du projet" in str(refus.value)


# --- Le panneau de l'extension lit l'emprise par le serveur -------------------

def test_lemprise_souvre_au_panneau_de_lextension(client):
    origine = "https://vue3d-trimble-connect.netlify.app"
    # Sans jeton, le refus reste lisible par le panneau : il doit le lire.
    r = client.get("/api/connect/emprise?projet=vK4pJn9BUh4",
                   headers={"Origin": origine})
    assert r.status_code == 401
    assert r.headers["Access-Control-Allow-Origin"] == origine
    assert "Authorization" in r.headers["Access-Control-Allow-Headers"]
    # Le contrôle préalable du navigateur, pour l'en-tête Authorization.
    avant = client.options("/api/connect/emprise?projet=vK4pJn9BUh4", headers={
        "Origin": origine,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
    })
    assert avant.status_code in (200, 204)
    assert avant.headers["Access-Control-Allow-Origin"] == origine


def test_lemprise_ne_souvre_pas_a_une_autre_origine(client):
    r = client.get("/api/connect/emprise?projet=vK4pJn9BUh4",
                   headers={"Origin": "https://exemple.test"})
    assert "Access-Control-Allow-Origin" not in r.headers
