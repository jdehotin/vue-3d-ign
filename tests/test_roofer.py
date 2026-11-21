"""Toits de roofer (vue3d/roofer.py) : triangulation, sortie CityJSONSeq,
assemblage de la couche, lancement, route. Ni réseau, ni Docker, ni roofer."""
import gzip
import json
import math
import subprocess

import numpy as np
import pytest

from vue3d import app as module_app
from vue3d import roofer
from vue3d.nuage import vers_lambert93
from vue3d.roofer import (ROOFER_ZONE_MAX_M, Roofer, RooferIndisponible, lecteur, lire_cityjsonseq,
                          roofer_pour_emprise, trianguler)
from vue3d.scene import emprise

LAT, LON = 48.8049, 2.1204


def _aire(sommets, tris):
    return sum(np.linalg.norm(np.cross(sommets[b] - sommets[a], sommets[c] - sommets[a])) / 2
               for a, b, c in tris)


def test_une_face_trouee_est_couverte_exactement_et_garde_son_sens():
    # Un carré de 10 m percé d'un carré de 2 m, à plat, sens trigonométrique
    # vu du dessus : normale vers le haut.
    s = np.array([[0, 0, 5], [10, 0, 5], [10, 10, 5], [0, 10, 5],
                  [4, 4, 5], [4, 6, 5], [6, 6, 5], [6, 4, 5]], dtype=float)
    tris = trianguler((s, [[0, 1, 2, 3], [4, 5, 6, 7]]))
    assert _aire(s, tris) == pytest.approx(100 - 4)
    for a, b, c in tris:
        assert np.cross(s[b] - s[a], s[c] - s[a])[2] > 0
    # Le même anneau à l'envers : normale vers le bas, triangles retournés.
    tris = trianguler((s, [[3, 2, 1, 0]]))
    assert _aire(s, tris) == pytest.approx(100)
    assert all(np.cross(s[b] - s[a], s[c] - s[a])[2] < 0 for a, b, c in tris)


def test_un_mur_vertical_se_triangule_et_une_face_degeneree_non():
    s = np.array([[0, 0, 0], [8, 0, 0], [8, 0, 6], [4, 0, 9], [0, 0, 6]], dtype=float)
    tris = trianguler((s, [[0, 1, 2, 3, 4]]))
    assert len(tris) == 3 and _aire(s, tris) == pytest.approx(8 * 6 + 8 * 3 / 2)
    assert trianguler((s, [[0, 1, 0]])) == []


def _maison_l93(west, south, east, north, sol=100.0):
    """Une maison de 10 × 8 m au centre de l'emprise, toit à deux pans (murs
    de 6 m, faîtage à 9 m), en CityJSONSeq comme roofer l'écrit ; et son
    emprise en lon/lat."""
    lon0, lat0 = (west + east) / 2, (south + north) / 2
    dlon, dlat = 5 / (111320 * math.cos(math.radians(lat0))), 4 / 111320
    anneau = [[lon0 - dlon, lat0 - dlat], [lon0 + dlon, lat0 - dlat], [lon0 + dlon, lat0 + dlat],
              [lon0 - dlon, lat0 + dlat], [lon0 - dlon, lat0 - dlat]]
    x, y = vers_lambert93([a[0] for a in anneau[:4]], [a[1] for a in anneau[:4]])
    ym = (y[0] + y[3]) / 2
    pts = ([(x[k], y[k], sol) for k in range(4)] + [(x[k], y[k], sol + 6) for k in range(4)]
           + [(x[0], ym, sol + 9), (x[1], ym, sol + 9)])
    translation = [float(x[0]), float(y[0]), 0.0]
    entiers = [[round((p[i] - translation[i]) / 0.001) for i in range(3)] for p in pts]
    faces = [
        [[0, 3, 2, 1]],              # plancher
        [[4, 5, 9, 8]],              # pan sud
        [[7, 8, 9, 6]],              # pan nord
        [[0, 1, 5, 4]], [[2, 3, 7, 6]],                     # murs longs
        [[1, 2, 6, 9, 5]], [[3, 0, 4, 8, 7]],               # pignons
    ]
    sem = {"surfaces": [{"type": "GroundSurface"}, {"type": "RoofSurface"}, {"type": "WallSurface"}],
           "values": [[0, 1, 1, 2, 2, 2, 2]]}
    entete = {"type": "CityJSON", "version": "2.0", "CityObjects": {}, "vertices": [],
              "transform": {"scale": [0.001, 0.001, 0.001], "translate": translation}}
    objet = {"type": "CityJSONFeature", "id": "M", "vertices": entiers, "CityObjects": {
        "M": {"type": "Building", "attributes": {
            "id": "BATIMENT1", "rf_h_ground": sol, "rf_roof_type": "slanted", "rf_roof_planes": 2,
            "rf_rmse_lod22": 0.123, "rf_val3dity_lod22": "[]"}, "children": ["M-0"]},
        "M-0": {"type": "BuildingPart", "parents": ["M"], "geometry": [
            {"type": "Solid", "lod": "2.2", "boundaries": [faces], "semantics": sem},
            {"type": "Solid", "lod": "1.2", "boundaries": [faces[:1]]}]}}}
    return json.dumps(entete) + "\n" + json.dumps(objet) + "\n", anneau


def _nuage(anneau=None, n=50):
    """Un nuage de sol (100 m) et de bâti (109 m), le long d'une emprise ou n'importe où."""
    x0, y0 = vers_lambert93(anneau[0][0], anneau[0][1]) if anneau else (600000.0, 6860000.0)
    x = float(x0) + np.linspace(-3, 13, n)
    c = np.where(np.arange(n) % 2, 6, 2).astype(np.uint8)
    return {"x": x, "y": x * 0 + float(y0) + 2, "z": np.where(c == 6, 109.0, 100.0), "c": c}


def test_la_couche_garde_toits_et_murs_en_metres_locaux_depuis_le_sol_de_roofer():
    bbox = emprise(LAT, LON)
    texte, anneau = _maison_l93(*bbox)
    scene = {"batiments": {"features": [{"type": "Feature", "properties": {
        "cleabs": "BATIMENT1", "altitude_minimale_sol": 100, "altitude_maximale_toit": 109},
        "geometry": {"type": "MultiPolygon", "coordinates": [[anneau]]}}]}}
    vus = {}

    def lancer(dossier):
        # roofer reçoit le nuage et les emprises en Lambert-93, l'id de chacune.
        geo = json.load(open(f"{dossier}/batiments.geojson"))
        vus["ids"] = [f["properties"]["id"] for f in geo["features"]]
        vus["x"] = geo["features"][0]["geometry"]["coordinates"][0][0][0]
        return texte

    couche = roofer_pour_emprise(*bbox, _nuage(), scene, lancer)
    assert vus["ids"] == ["BATIMENT1"] and vus["x"] > 100000       # Lambert-93, pas des degrés
    (b,) = couche["batiments"]
    assert couche["sans_lod22"] == 0 and couche["centre"] == [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]
    v = np.asarray(b["v"]).reshape(-1, 3)
    # Les dix sommets, sans doublon ; centrés, à 5 et 4 m du centre ; hauteurs 0, 6, 9.
    assert len(v) == 10
    assert np.abs(v[:, 0]).max() == pytest.approx(5, abs=0.05)
    assert np.abs(v[:, 1]).max() == pytest.approx(4, abs=0.05)
    assert sorted(set(v[:, 2])) == [0, 6, 9]
    # Deux pans de deux triangles ; quatre murs (deux quadrilatères, deux
    # pentagones) ; le plancher n'est pas transmis.
    assert len(b["toit"]) == 4 * 3 and len(b["murs"]) == (2 * 2 + 2 * 3) * 3
    assert all(v[i, 2] >= 6 for i in b["toit"])
    assert b["type"] == "slanted" and b["plans"] == 2 and b["rmse"] == 0.12 and b["valide"] is True
    assert b["cleabs"] == "BATIMENT1" and b["anneau"][0] == [round(c, 7) for c in anneau[0]]


def test_une_emprise_en_plusieurs_morceaux_a_un_id_par_morceau():
    bbox = emprise(LAT, LON)
    texte, anneau = _maison_l93(*bbox)
    loin = [[a[0] + 0.0005, a[1]] for a in anneau]
    scene = {"batiments": {"features": [{"properties": {"cleabs": "B", "altitude_minimale_sol": 99,
                                                        "altitude_maximale_toit": 110},
                                         "geometry": {"type": "MultiPolygon", "coordinates": [[anneau], [loin]]}}]}}
    vus = {}

    def lancer(dossier):
        geo = json.load(open(f"{dossier}/batiments.geojson"))
        vus["ids"] = [f["properties"]["id"] for f in geo["features"]]
        vus["sol"] = {f["properties"]["altitude_minimale_sol"] for f in geo["features"]}
        return texte.replace('"BATIMENT1"', '"B~0"')

    couche = roofer_pour_emprise(*bbox, _nuage(anneau), scene, lancer)
    assert vus["ids"] == ["B~0", "B~1"] and vus["sol"] == {99}
    # Le morceau sans reconstruction est compté, pas inventé.
    assert [b["cleabs"] for b in couche["batiments"]] == ["B"] and couche["sans_lod22"] == 1
    # Sans altitudes BD TOPO, celles du nuage alentour : son sol, son bâti le
    # plus haut ; le morceau loin de tout point n'est pas envoyé.
    del scene["batiments"]["features"][0]["properties"]["altitude_minimale_sol"]
    roofer_pour_emprise(*bbox, _nuage(anneau), scene, lancer)
    assert vus["ids"] == ["B~0"] and vus["sol"] == {100.0}


def test_hors_couverture_ou_zone_trop_grande_roofer_ne_tourne_pas():
    def lancer(dossier):
        raise AssertionError("roofer n'avait pas à tourner")
    assert roofer_pour_emprise(*emprise(LAT, LON), None, {}, lancer) is None
    couche = roofer_pour_emprise(*emprise(LAT, LON), {"trop_grande": True}, {}, lancer)
    assert couche["trop_grande"] and couche["zone_max_m"] == ROOFER_ZONE_MAX_M
    assert Roofer("docker").nuage(*emprise(LAT, LON, 2000)) == {"trop_grande": True}


def test_une_sortie_illisible_ne_donne_pas_de_couche():
    bbox = emprise(LAT, LON)
    _, anneau = _maison_l93(*bbox)
    scene = {"batiments": {"features": [{"properties": {"cleabs": "B", "altitude_minimale_sol": 1,
                                                        "altitude_maximale_toit": 2},
                                         "geometry": {"type": "Polygon", "coordinates": [anneau]}}]}}
    with pytest.raises(RooferIndisponible):
        roofer_pour_emprise(*bbox, _nuage(), scene, lambda dossier: "pas du json\n")


def test_le_nuage_ne_garde_que_le_sol_et_le_bati_67_compris(monkeypatch):
    monkeypatch.setattr(roofer, "lire_couche", lambda *a: {"features": [
        {"properties": {"url_npl": "https://exemple/a.copc.laz"}},
        {"properties": {"url_npl": "https://exemple/b.copc.laz"}}]})

    def lire_points(url, x0, y0, x1, y1, **k):
        c = np.array([1, 2, 3, 6, 67, 9], dtype=np.uint8)
        return (np.arange(6.0), np.arange(6.0), np.arange(6.0), c), None
    monkeypatch.setattr(roofer, "lire_points", lire_points)
    n = Roofer("docker").nuage(*emprise(LAT, LON))
    assert list(n["c"]) == [2, 6, 6] * 2 and list(n["z"]) == [1, 3, 4] * 2
    monkeypatch.setattr(roofer, "lire_couche", lambda *a: {"features": []})
    assert Roofer("docker").nuage(*emprise(LAT, LON)) is None


def test_roofer_tourne_sans_reseau_et_son_echec_est_un_incident(tmp_path):
    lances = []

    def executer(cmd, **k):
        lances.append(cmd)
        return subprocess.CompletedProcess(cmd, 1, "", "GDAL: cannot open")
    r = Roofer("docker", executer=executer)
    with pytest.raises(RooferIndisponible, match="cannot open"):
        r.lancer(str(tmp_path))
    cmd = lances[0]
    assert cmd[1:3] == ["run", "--rm"] and "--network" in cmd and cmd[cmd.index("--network") + 1] == "none"
    assert cmd[-3:] == ["/data/lidar.laz", "/data/batiments.geojson", "/data/sortie"]
    # Un exécutable local : les fichiers du dossier, tels quels.
    assert Roofer("/opt/roofer").commande("/d")[0] == "/opt/roofer"
    # Lancé sans rien écrire : un incident aussi.
    r = Roofer("docker", executer=lambda cmd, **k: subprocess.CompletedProcess(cmd, 0, "", ""))
    with pytest.raises(RooferIndisponible, match="rien écrit"):
        r.lancer(str(tmp_path))


def test_le_lecteur_vient_de_vue3d_roofer(monkeypatch):
    monkeypatch.delenv("VUE3D_ROOFER", raising=False)
    assert lecteur() is None and lecteur("aucun") is None
    assert lecteur("docker").mode == "docker"


def test_lire_cityjsonseq_ignore_les_lod_inferieurs():
    texte, _ = _maison_l93(*emprise(LAT, LON))
    b = lire_cityjsonseq(texte)["BATIMENT1"]
    assert len(b["faces"]) == 7 and b["sommets"].shape == (10, 3)


class _Roofer:
    """Doublure : le nuage (au sud de 46°, illisible) et un roofer qui rend la maison."""
    def __init__(self):
        self.lances = 0

    def __call__(self, west, south, east, north):
        if south < 46:
            raise OSError("dalle COPC illisible")
        return _nuage()

    def lancer(self, dossier):
        self.lances += 1
        texte, _ = _maison_l93(*emprise(LAT, LON))
        return texte


@pytest.fixture
def client_roofer(tmp_path):
    bbox = emprise(LAT, LON, 1000)
    _, anneau = _maison_l93(*bbox)
    scene = {"version": 1, "bbox": list(bbox), "batiments": {"features": [
        {"properties": {"cleabs": "BATIMENT1", "altitude_minimale_sol": 100, "altitude_maximale_toit": 109},
         "geometry": {"type": "MultiPolygon", "coordinates": [[anneau]]}}]}}

    def construire(lat, lon, avancer=None, zone=None):
        return gzip.compress(json.dumps(scene).encode()), b"\xff\xd8jpeg"
    doublure = _Roofer()
    appli = module_app.creer_app(str(tmp_path), construire=construire,
                                 lire_monuments=lambda *b: {"elements": []},
                                 lire_eoliennes=lambda *b: {"elements": []},
                                 lire_ouvrages=lambda *b: {}, lire_roofer=doublure)
    return appli.test_client(), doublure


def test_sans_roofer_la_couche_le_dit(tmp_path):
    client = module_app.creer_app(str(tmp_path), construire=lambda *a, **k: None).test_client()
    r = client.get(f"/api/roofer?lat={LAT}&lon={LON}")
    assert r.status_code == 200 and r.get_json() == {"actif": False}
    assert r.headers["Cache-Control"] == "no-store"


def test_la_couche_roofer_est_servie_a_part_et_gardee(client_roofer):
    from vue3d.scene import NOM_ROOFER
    client, doublure = client_roofer
    r = client.get(f"/api/roofer?lat={LAT}&lon={LON}&zone=1000")
    assert r.status_code == 200 and r.headers["ETag"].startswith(f'"{NOM_ROOFER}-')
    (b,) = json.loads(gzip.decompress(r.data))["batiments"]
    assert b["cleabs"] == "BATIMENT1" and len(b["toit"]) == 12
    # Gardée : la seconde demande ne relance pas roofer.
    assert client.get(f"/api/roofer?lat={LAT}&lon={LON}&zone=1000").status_code == 200
    assert doublure.lances == 1
    # Le nuage illisible : 503, rien en cache, la scène reste servie.
    r = client.get("/api/roofer?lat=45.5&lon=2")
    assert r.status_code == 503 and "roofer" in r.get_json()["erreur"]
    assert client.get("/api/scene?lat=45.5&lon=2").status_code == 200
