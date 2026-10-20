"""Carrés de la vue en voiture (vue3d/carres.py) et leur route /api/carre."""
import gzip
import json
import os

import pytest
import requests

from vue3d import app as module_app
from vue3d import carres
from vue3d.couches import SRS_LAMBERT93

# Le carré de Gordes : x de 876 000 à 876 500, y de 6 316 000 à 6 316 500.
I, J = 1752, 12632
X0, Y0 = I * carres.CARRE_M, J * carres.CARRE_M


def _batiment(cleabs, sommets, **props):
    return {"type": "Feature", "geometry": {"type": "MultiPolygon", "coordinates": [[sommets]]},
            "properties": {"cleabs": cleabs, "etat_de_l_objet": "En service", "usage_1": "Résidentiel",
                           "altitude_minimale_sol": 438.6, "altitude_minimale_toit": 445.5,
                           "altitude_maximale_toit": 448.7, "hauteur": 6.9, "nombre_d_etages": 2, **props}}


def _route(cleabs, sommets, **props):
    return {"type": "Feature", "geometry": {"type": "LineString", "coordinates": sommets},
            "properties": {"cleabs": cleabs, "etat_de_l_objet": "En service", "nature": "Route à 1 chaussée",
                           "nom_voie_ban_gauche": "Route de Murs", "cpx_numero": "D15", "importance": "4",
                           "position_par_rapport_au_sol": "0", "sens_de_circulation": "Double sens",
                           "nombre_de_voies": 2, "largeur_de_chaussee": 5.5,
                           "acces_vehicule_leger": "Libre", **props}}


def _carre(x, y):
    """L'emprise d'un bâtiment carré de 10 m, son premier sommet en (x, y)."""
    return [[x, y, 440], [x + 10, y, 440], [x + 10, y + 10, 440], [x, y + 10, 440], [x, y, 440]]


def test_un_batiment_appartient_au_carre_de_son_premier_sommet():
    """Le WFS rend tout ce qui touche l'emprise : un bâtiment à cheval sur
    deux carrés n'est gardé que par celui de son premier sommet."""
    geojson = {"features": [
        _batiment("DEDANS", _carre(X0 + 100.04, Y0 + 200)),
        _batiment("A_CHEVAL_DEBUT_ICI", _carre(X0 + 495, Y0 + 10)),
        _batiment("A_CHEVAL_DEBUT_VOISIN", _carre(X0 - 5, Y0 + 10)),
        _batiment("EN_PROJET", _carre(X0 + 50, Y0 + 50), etat_de_l_objet="En projet"),
    ]}
    sortie = carres.batiments_du_carre(geojson, I, J)
    assert [b["id"] for b in sortie] == ["DEDANS", "A_CHEVAL_DEBUT_ICI"]
    b = sortie[0]
    # Décimètres depuis le coin sud-ouest, sommet de fermeture compris.
    assert b["polygones"] == [[[1000, 2000, 1100, 2000, 1100, 2100, 1000, 2100, 1000, 2000]]]
    assert (b["usage"], b["sol"], b["gouttiere"], b["faitage"], b["hauteur"], b["etages"]) == \
        ("Résidentiel", 438.6, 445.5, 448.7, 6.9, 2)


def test_les_altitudes_absentes_restent_nulles():
    geojson = {"features": [_batiment("SANS", _carre(X0 + 1, Y0 + 1), altitude_minimale_sol=None,
                                      hauteur=None, nombre_d_etages=None)]}
    b = carres.batiments_du_carre(geojson, I, J)[0]
    assert b["sol"] is None and b["hauteur"] is None and b["etages"] is None


def test_les_routes_gardees_sont_entieres_et_carrossables():
    """Une route qui sort du carré est gardée entière : la page raccorde son
    graphe d'un carré à l'autre. Sentiers, escaliers, pistes cyclables et
    galeries (accès « Physiquement impossible ») n'en sont pas."""
    ligne = [[X0 - 100, Y0 + 10, 430.25], [X0 + 250, Y0 + 260, 441.0]]
    geojson = {"features": [
        _route("D15", ligne),
        _route("SENTIER", ligne, nature="Sentier"),
        _route("GALERIE", ligne, acces_vehicule_leger="Physiquement impossible"),
        _route("PRIVEE", ligne, acces_vehicule_leger="Restreint aux ayants droit",
               sens_de_circulation="Sens inverse", position_par_rapport_au_sol="-1"),
        _route("POINT", ligne[:1]),
    ]}
    sortie = carres.routes_du_carre(geojson, I, J)
    assert [r["id"] for r in sortie] == ["D15", "PRIVEE"]
    d15, privee = sortie
    assert d15["ligne"] == [-1000, 100, 4302, 2500, 2600, 4410]
    assert (d15["nom"], d15["numero"], d15["importance"], d15["sens"], d15["sol"], d15["acces"]) == \
        ("Route de Murs", "D15", 4, "2", 0, None)
    assert (privee["sens"], privee["sol"], privee["acces"]) == ("-", -1, "Restreint aux ayants droit")


def test_le_nom_collaboratif_supplee_la_ban():
    geojson = {"features": [_route("R", [[X0, Y0, 1], [X0 + 5, Y0, 1]], nom_voie_ban_gauche=None,
                                   nom_collaboratif_gauche="R DE LA CHAUSSEE D'ANTIN")]}
    assert carres.routes_du_carre(geojson, I, J)[0]["nom"] == "R DE LA CHAUSSEE D'ANTIN"


def test_un_carre_se_lit_en_lambert_93(monkeypatch):
    lus = []

    def lire_couche(couche, ouest, sud, est, nord, srs=None):
        lus.append((couche, ouest, sud, est, nord, srs))
        return {"features": []}

    monkeypatch.setattr(carres, "lire_couche", lire_couche)
    carre = carres.fetch_carre(I, J)
    assert sorted(lus) == sorted([(c, X0, Y0, X0 + 500, Y0 + 500, SRS_LAMBERT93)
                                  for c in (carres.COUCHE_BATIMENTS, carres.COUCHE_ROUTES)])
    assert (carre["carre"], carre["origine"], carre["taille"]) == ([I, J], [X0, Y0], 500)


def test_une_couche_en_echec_rend_le_carre_indisponible(monkeypatch):
    def lire_couche(couche, *emprise, srs=None):
        if couche == carres.COUCHE_ROUTES:
            raise requests.ConnectionError("HTTP 504")
        return {"features": []}

    monkeypatch.setattr(carres, "lire_couche", lire_couche)
    with pytest.raises(carres.CarreIndisponible):
        carres.fetch_carre(I, J)


def test_hors_de_france_le_carre_n_est_pas_servi():
    for i, j in [(-1, J), (I, 100), (3000, J), (I, 15000)]:
        with pytest.raises(carres.CarreHorsEmprise):
            carres.verifier_carre(i, j)
    carres.verifier_carre(I, J)


def test_un_carre_lu_une_fois_ou_pas_du_tout(tmp_path):
    lectures = []

    def lire(i, j):
        lectures.append((i, j))
        if i == I + 1:
            raise carres.CarreIndisponible("WFS en panne")
        return {"carre": [i, j], "batiments": [], "routes": []}

    stock = carres.Carres(str(tmp_path), lire=lire)
    chemin = stock.obtenir(I, J)
    assert stock.obtenir(I, J) == chemin and lectures == [(I, J)]
    with gzip.open(chemin) as f:
        assert json.load(f)["carre"] == [I, J]
    assert chemin == os.path.join(str(tmp_path), "carres", f"v{carres.CARRES_VERSION}", str(I), f"{J}.json.gz")
    with pytest.raises(carres.CarreIndisponible):
        stock.obtenir(I + 1, J)
    # Rien d'écrit, pas même un fichier temporaire.
    assert not stock.present(I + 1, J)
    assert not os.path.exists(os.path.join(stock.dossier, str(I + 1)))


@pytest.fixture
def service(tmp_path):
    def fabrique(lire_carre, **options):
        appli = module_app.creer_app(str(tmp_path), lire_carre=lire_carre, **options)
        return appli.test_client()
    return fabrique


def test_la_route_sert_le_carre_gzippe_et_garde_une_semaine(service):
    client = service(lambda i, j: {"carre": [i, j], "batiments": [], "routes": []})
    r = client.get(f"/api/carre?i={I}&j={J}")
    assert r.status_code == 200
    assert r.headers["Content-Encoding"] == "gzip"
    assert r.headers["Cache-Control"] == "public, max-age=604800"
    assert json.loads(gzip.decompress(r.data))["carre"] == [I, J]


def test_la_route_dit_ses_erreurs(service):
    def lire(i, j):
        raise carres.CarreIndisponible("HTTP 504 sur troncon_de_route")

    client = service(lire)
    assert client.get("/api/carre?i=1").status_code == 400
    assert client.get("/api/carre?i=a&j=2").status_code == 400
    assert client.get("/api/carre?i=-5&j=2").status_code == 422
    r = client.get(f"/api/carre?i={I}&j={J}")
    assert r.status_code == 503 and r.headers["Retry-After"] == "10"


def test_le_quota_des_carres_ne_compte_que_les_neufs(service):
    client = service(lambda i, j: {"carre": [i, j], "batiments": [], "routes": []}, quota_carres=2)
    assert client.get(f"/api/carre?i={I}&j={J}").status_code == 200
    assert client.get(f"/api/carre?i={I + 1}&j={J}").status_code == 200
    # Déjà lus : toujours servis.
    assert client.get(f"/api/carre?i={I}&j={J}").status_code == 200
    r = client.get(f"/api/carre?i={I + 2}&j={J}")
    assert r.status_code == 429 and int(r.headers["Retry-After"]) > 0


def test_le_quota_des_carres_suit_celui_des_scenes(service):
    client = service(lambda i, j: {"carre": [i, j]}, quota=1)
    for k in range(5):
        assert client.get(f"/api/carre?i={I + k}&j={J}").status_code == 200


def test_la_page_de_la_voiture_est_servie(service):
    r = service(lambda i, j: {}).get("/voiture")
    assert r.status_code == 200
    assert r.headers["Cache-Control"] == "no-cache"
    assert b"api/carre" in r.data
