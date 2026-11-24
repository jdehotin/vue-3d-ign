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


def test_le_zonage_old_distingue_massif_et_bande_et_pose_les_massifs_dessus():
    brut = {"features": [
        {"properties": {"zonage": 1, "source": "Zonage local", "dat_ap_old": "22/10/25",
                        "url": "https://www.vaucluse.gouv.fr/"}, "geometry": carre(4.805, 43.949, 0.0005)},
        {"properties": {"zonage": 2, "source": "Zonage local"}, "geometry": carre(4.805, 43.949, 0.01)}]}
    zones = g.old_pour_emprise(*EMPRISE, brut)["zones"]
    assert [z["zonage"] for z in zones] == ["bande", "massif"]
    assert zones[1]["arrete"] == "22/10/25" and zones[1]["url"].startswith("https://")
    assert g.old_pour_emprise(*EMPRISE, {"features": []}) is None


def test_les_cavites_hors_emprise_sont_ecartees():
    brut = {"features": [
        {"properties": {"type_cavite": "carrière", "nom_cavite": "Cathédrale",
                        "identifiant": "NPCCS00003486", "reperage_geographique": "centre cavité"},
         "geometry": {"type": "Point", "coordinates": [4.805, 43.949]}},
        {"properties": {"type_cavite": "cave"},
         "geometry": {"type": "Point", "coordinates": [4.9, 43.949]}}]}
    [cavite] = g.cavites_pour_emprise(*EMPRISE, brut)["cavites"]
    assert cavite == {"lon": 4.805, "lat": 43.949, "type": "carrière", "nom": "Cathédrale",
                      "identifiant": "NPCCS00003486", "reperage": "centre cavité"}
    assert g.cavites_pour_emprise(*EMPRISE, {"features": brut["features"][1:]}) is None


def test_la_fiche_garde_les_arretes_lies_aux_inondations_du_plus_recent_au_plus_ancien():
    brut = {
        "azi": [{"code_national_azi": "13DREAL20050005", "libelle_azi": "AZI - PSS du Rhône",
                 "libelle_bassin_risques": "BV du Rhône", "date_publication_web": "01/06/2005",
                 "liste_libelle_risque": [{"libelle_risque_long": "Inondation"}],
                 "code_insee": "84007", "libelle_commune": "Avignon"}],
        "tri": [], "papi": [],
        "catnat": [
            {"date_debut_evt": "08/09/2002", "date_fin_evt": "09/09/2002",
             "date_publication_arrete": "19/09/2002", "libelle_risque_jo": "Inondations et/ou Coulées de Boue",
             "code_insee": "84007", "libelle_commune": "Avignon"},
            {"date_debut_evt": "01/07/2019", "libelle_risque_jo": "Sécheresse"},
            {"date_debut_evt": "01/12/2003", "libelle_risque_jo": "Inondations par remontées de nappe phréatique"}],
        "old": [],
    }
    fiche = g.risques_commune_pour_emprise(*EMPRISE, brut)
    assert fiche["commune"] == {"code": "84007", "nom": "Avignon"}
    assert [c["debut"] for c in fiche["inondations"]] == ["01/12/2003", "08/09/2002"]
    assert fiche["catnat_total"] == 3 and fiche["old"] is None
    assert fiche["azi"][0]["risques"] == ["Inondation"]


def test_la_fiche_lit_la_commune_du_point_et_un_404_vide_est_un_fait(monkeypatch):
    """`rayon=1` : seule la commune du point ; « Pas de résultat » en 404,
    hors OLD, n'est pas une panne."""
    demandes = []

    def get(url, params=None, timeout=None, headers=None):
        demandes.append((url.rsplit("/v1/", 1)[1], dict(params)))
        if url.endswith("/old"):
            return Reponse(404, "", {"results": 0, "data": None, "message": "Pas de résultat trouvé"})
        return Reponse(200, "", {"results": 0, "total_pages": 0, "data": []})

    monkeypatch.setattr(g.requests, "get", get)
    brut = g.fetch_risques_commune(*EMPRISE)
    assert brut == {"azi": [], "tri": [], "papi": [], "catnat": [], "old": []}
    assert all(p["latlon"] == "4.805500,43.949300" for _, p in demandes)
    assert all(p.get("rayon") == 1 for c, p in demandes if c != "old")


def test_une_erreur_de_l_api_n_est_pas_prise_pour_une_absence(monkeypatch):
    monkeypatch.setattr(g.requests, "get", lambda *a, **k: Reponse(
        403, "", {"message": "Interdit"}))
    with pytest.raises(requests.RequestException, match="HTTP 403"):
        g.fetch_risques_commune(*EMPRISE)


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

    lectures = {
        "inondations": panne_au_sud(lambda *b: {}),
        "old": panne_au_sud(lambda *b: {"features": []}),
        "cavites": panne_au_sud(lambda w, s, e, n: {"features": [
            {"properties": {"type_cavite": "carrière"},
             "geometry": {"type": "Point", "coordinates": [(w + e) / 2, (s + n) / 2]}}]}),
        "commune": panne_au_sud(lambda *b: {"azi": [], "tri": [], "papi": [], "catnat": [], "old": []}),
    }
    appli = module_app.creer_app(str(tmp_path), construire=construire,
                                 lire_monuments=lambda *b: {"elements": []},
                                 lire_ouvrages=lambda *b: {}, lire_emprises=lambda *b: {},
                                 lire_reseaux=lambda *b: None, lire_postes_enedis=lambda *b: None,
                                 lire_georisques=lectures)
    return appli.test_client()


def lire(r):
    assert r.status_code == 200 and r.headers["Content-Encoding"] == "gzip"
    return json.loads(gzip.decompress(r.data))


def test_les_couches_de_georisques_sont_servies_a_part(client):
    assert lire(client.get("/api/georisques/inondations?lat=48.8049&lon=2.1204")) is None
    assert lire(client.get("/api/georisques/old?lat=48.8049&lon=2.1204")) is None
    [cavite] = lire(client.get("/api/georisques/cavites?lat=48.8049&lon=2.1204"))["cavites"]
    assert cavite["type"] == "carrière"
    fiche = lire(client.get("/api/georisques/commune?lat=48.8049&lon=2.1204"))
    assert fiche["commune"] is None and fiche["inondations"] == []


def test_une_panne_de_georisques_rend_503_et_n_ecrit_rien(client):
    for couche in ("inondations", "old", "cavites", "commune"):
        r = client.get(f"/api/georisques/{couche}?lat=45.5&lon=2")
        assert r.status_code == 503 and "Rien n'a été mis en cache" in r.get_json()["erreur"]
    assert client.get("/api/scene?lat=45.5&lon=2").status_code == 200


def test_une_couche_inconnue_est_refusee(client):
    r = client.get("/api/georisques/seisme?lat=48.8049&lon=2.1204")
    assert r.status_code == 404 and "inondations" in r.get_json()["erreur"]


def test_le_catalogue_porte_les_sources_de_georisques(client):
    sources = {s["id"]: s for s in client.get("/api/sources").get_json()["sources"]}
    assert {sources[i]["mode"] for i in ("inondations", "old", "cavites")} == {"apres-scene"}
    assert sources["risques_commune"]["mode"] == "au-clic"
    assert all(sources[i]["theme"] == "Risques" for i in ("inondations", "old", "cavites",
                                                          "risques_commune"))
