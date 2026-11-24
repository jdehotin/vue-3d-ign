"""Risques de Géorisques (vue3d/georisques.py) : lectures et assemblages,
sans réseau."""
import gzip
import json
import types

import pytest
import requests

from vue3d import app as module_app
from vue3d import georisques as g

# Une emprise de 200 m autour d'un point d'Avignon.
EMPRISE = (4.8042, 43.9484, 4.8068, 43.9502)


def carre(lon, lat, d):
    return {"type": "Polygon", "coordinates": [[[lon - d, lat - d], [lon + d, lat - d],
                                                [lon + d, lat + d], [lon - d, lat + d],
                                                [lon - d, lat - d]]]}


class Reponse:
    def __init__(self, code=200, texte="", corps=None):
        self.status_code, self.text = code, texte
        self.content = texte.encode()
        self._corps = corps

    def json(self):
        if self._corps is None:
            raise ValueError("pas de JSON")
        return self._corps


@pytest.fixture
def service(monkeypatch):
    """Un WFS de Géorisques simulé : le comptage, puis les objets."""
    appels = []
    etat = types.SimpleNamespace(compte=2, objets=None, code=200)

    def get(url, params=None, timeout=None, headers=None):
        appels.append(dict(params))
        if params.get("resultType") == "hits":
            return Reponse(etat.code, f'<wfs:FeatureCollection numberMatched="{etat.compte}" '
                                      'numberReturned="0"/>')
        objets = etat.objets if etat.objets is not None else etat.compte
        return Reponse(200, "{}", {"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {"id": i},
             "geometry": {"type": "Point", "coordinates": [4.805, 43.949]}}
            for i in range(objets)]})

    monkeypatch.setattr(g.requests, "get", get)
    monkeypatch.setattr(g, "ATTENTE_S", 0)
    etat.appels = appels
    return etat


def test_une_couche_comptee_vide_est_un_fait_sans_seconde_requete(service):
    """Le WFS répond un corps vide quand il ne trouve rien : c'est le
    comptage qui dit l'absence, et la lecture n'est pas faite."""
    service.compte = 0
    assert g.lire_wfs_georisques("CAVITE_LOCALISEE", *EMPRISE) == {
        "type": "FeatureCollection", "features": []}
    assert len(service.appels) == 1


def test_la_lecture_demande_un_objet_de_plus_que_le_compte(service):
    """MapServer rend count − 1 objets en GeoJSON quand count vaut le compte."""
    assert len(g.lire_wfs_georisques("CAVITE_LOCALISEE", *EMPRISE)["features"]) == 2
    lecture = service.appels[-1]
    assert lecture["count"] == 3 and lecture["outputFormat"] == "geojson"
    # WFS 2.0 en EPSG:4326 par son URN : lat, lon.
    assert lecture["bbox"].startswith("43.9484,4.8042,43.9502,4.8068")


def test_une_lecture_incomplete_est_un_incident(service):
    service.objets = 1
    with pytest.raises(requests.RequestException, match="1 objets rendus sur 2"):
        g.lire_wfs_georisques("CAVITE_LOCALISEE", *EMPRISE)


def test_un_comptage_illisible_est_un_incident(service):
    service.code = 400
    with pytest.raises(requests.RequestException, match="comptage illisible"):
        g.lire_wfs_georisques("CAVITE_LOCALISEE", *EMPRISE)


def test_les_surfaces_inondables_sont_decoupees_sur_l_emprise():
    """Une surface de 8 km ne garde que sa part de l'emprise ; un scénario
    sans surface n'apparaît pas."""
    brut = {"debordement/moyen": {"features": [
        {"properties": {"cours_deau": "Rhône", "id_tri": "FRD_TRI_AVIGNON"},
         "geometry": carre(4.80, 43.95, 0.05)}]},
        "debordement/rare": {"features": []}}
    couche = g.inondations_pour_emprise(*EMPRISE, brut)
    [surface] = couche["surfaces"]
    assert (surface["type"], surface["scenario"], surface["cours_deau"], surface["tri"]) == (
        "debordement", "moyen", "Rhône", "FRD_TRI_AVIGNON")
    lons = [x for x, _ in surface["geometrie"]["coordinates"][0][0]]
    assert min(lons) == pytest.approx(EMPRISE[0]) and max(lons) == pytest.approx(EMPRISE[2])
    assert couche["version"] == g.GEORISQUES_VERSION and couche["lu_le"]


def test_hors_de_toute_surface_la_couche_vaut_null():
    brut = {"debordement/moyen": {"features": [
        {"properties": {}, "geometry": carre(5.5, 44.5, 0.01)}]}}
    assert g.inondations_pour_emprise(*EMPRISE, brut) is None
    assert g.inondations_pour_emprise(*EMPRISE, {}) is None


# --- Le service -------------------------------------------------------------------

@pytest.fixture
def client(tmp_path):
    scene = {"version": 1, "bbox": [0, 0, 1, 1]}

    def construire(lat, lon, avancer=None, zone=None):
        return gzip.compress(json.dumps(scene).encode()), b"\xff\xd8jpeg"

    def panne_au_sud(lire):
        def lecture(west, south, east, north):
            if south < 46:
                raise requests.RequestException("HTTP 502 sur Géorisques")
            return lire(west, south, east, north)
        return lecture

    def une_surface_au_centre(w, s, e, n):
        # Une surface du débordement moyen au centre de l'emprise (celle de
        # la scène factice, [0, 0, 1, 1]).
        return {"debordement/moyen": {"features": [
            {"properties": {"cours_deau": "Seine", "id_tri": "FRF_TRI_PARI"},
             "geometry": carre((w + e) / 2, (s + n) / 2, 0.001)}]}}

    lectures = {"inondations": panne_au_sud(une_surface_au_centre)}
    appli = module_app.creer_app(str(tmp_path), construire=construire,
                                 lire_monuments=lambda *b: {"elements": []},
                                 lire_ouvrages=lambda *b: {}, lire_emprises=lambda *b: {},
                                 lire_reseaux=lambda *b: None, lire_postes_enedis=lambda *b: None,
                                 lire_georisques=lectures)
    return appli.test_client()


def lire(r):
    assert r.status_code == 200 and r.headers["Content-Encoding"] == "gzip"
    return json.loads(gzip.decompress(r.data))


def test_les_surfaces_inondables_sont_servies_a_part(client):
    [surface] = lire(client.get("/api/georisques/inondations?lat=48.8049&lon=2.1204"))["surfaces"]
    assert (surface["type"], surface["scenario"], surface["cours_deau"]) == ("debordement", "moyen", "Seine")


def test_une_panne_de_georisques_rend_503_et_n_ecrit_rien(client):
    r = client.get("/api/georisques/inondations?lat=45.5&lon=2")
    assert r.status_code == 503 and "Rien n'a été mis en cache" in r.get_json()["erreur"]
    assert client.get("/api/scene?lat=45.5&lon=2").status_code == 200


def test_une_couche_inconnue_est_refusee(client):
    """Le débroussaillement, les cavités et la fiche de la commune ont été
    retirés : seules les surfaces inondables restent."""
    for couche in ("seisme", "old", "cavites", "commune"):
        r = client.get(f"/api/georisques/{couche}?lat=48.8049&lon=2.1204")
        assert r.status_code == 404 and "inondations" in r.get_json()["erreur"]


def test_le_catalogue_porte_les_sources_de_georisques(client):
    sources = {s["id"]: s for s in client.get("/api/sources").get_json()["sources"]}
    assert sources["inondations"]["mode"] == "apres-scene"
    assert sources["inondations"]["theme"] == "Risques"
    assert not {"old", "cavites", "risques_commune"} & set(sources)
