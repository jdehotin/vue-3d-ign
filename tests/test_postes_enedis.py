"""Postes HTA/BT d'Enedis (vue3d/postes_enedis.py) : pagination de l'API Data
Fair, reprise, postes gardés dans l'emprise et le contour — sans réseau."""
import json

import pytest
import requests

from vue3d import postes_enedis
from vue3d.polygone import Polygone
from vue3d.postes_enedis import (POSTES_ENEDIS_VERSION, fetch_postes_enedis,
                                 postes_enedis_pour_emprise)

# ~100 m de côté vers 45° N.
EMPRISE = (2.0, 45.0, 2.00127, 45.0009)


def _poste(lon, lat, **champs):
    """Un enregistrement de l'API : la géométrie y est une chaîne GeoJSON."""
    return {"geometry": json.dumps({"type": "Point", "coordinates": [lon, lat]}),
            "nom_commune": "Gordes", "nom_iris": "Centre", "code_departement": "84", **champs}


def _pt(fx, fy):
    o, s, e, n = EMPRISE
    return o + (e - o) * fx, s + (n - s) * fy


class _Reponse:
    def __init__(self, corps, statut=200):
        self._corps, self.status_code = corps, statut

    @property
    def ok(self):
        return self.status_code < 400

    def json(self):
        return self._corps


@pytest.fixture
def api(monkeypatch):
    """Doublure de l'API : rend les pages données dans l'ordre, note les appels."""
    appels, pages = [], []

    def get(url, params=None, headers=None, timeout=None):
        appels.append(dict(params or {}))
        page = pages.pop(0)
        if isinstance(page, Exception):
            raise page
        return page

    monkeypatch.setattr(postes_enedis.requests, "get", get)
    monkeypatch.setattr(postes_enedis.time, "sleep", lambda s: None)
    return appels, pages


# --- Mise en forme -----------------------------------------------------------

def test_un_poste_garde_sa_position_et_sa_commune():
    couche = postes_enedis_pour_emprise(*EMPRISE, [_poste(*_pt(.5, .5))])
    assert couche["version"] == POSTES_ENEDIS_VERSION
    (p,) = couche["postes"]
    assert (p["lon"], p["lat"]) == tuple(round(v, 7) for v in _pt(.5, .5))
    assert (p["commune"], p["iris"], p["departement"]) == ("Gordes", "Centre", "84")


def test_un_poste_hors_de_l_emprise_est_ecarte():
    couche = postes_enedis_pour_emprise(*EMPRISE, [_poste(*_pt(.5, .5)), _poste(*_pt(1.5, .5))])
    assert len(couche["postes"]) == 1


def test_un_poste_hors_du_contour_est_ecarte():
    # Triangle sud-ouest de l'emprise : (0,0), (1,0), (0,1). Sommets en (lat, lon).
    triangle = Polygone([(_pt(0, 0)[1], _pt(0, 0)[0]), (_pt(1, 0)[1], _pt(1, 0)[0]),
                         (_pt(0, 1)[1], _pt(0, 1)[0])])
    dedans, dehors = _poste(*_pt(.2, .2)), _poste(*_pt(.8, .8))
    couche = postes_enedis_pour_emprise(*EMPRISE, [dedans, dehors], polygone=triangle)
    assert [(p["lon"], p["lat"]) for p in couche["postes"]] == [tuple(round(v, 7) for v in _pt(.2, .2))]
    # Sans contour, les deux sont gardés.
    assert len(postes_enedis_pour_emprise(*EMPRISE, [dedans, dehors])["postes"]) == 2


def test_les_champs_vides_deviennent_none():
    (p,) = postes_enedis_pour_emprise(*EMPRISE, [_poste(*_pt(.5, .5), nom_commune="", nom_iris=None)])["postes"]
    assert p["commune"] is None and p["iris"] is None


def test_une_geometrie_absente_ou_illisible_est_ecartee():
    bons = [_poste(*_pt(.5, .5))]
    mauvais = [{"geometry": None}, {"geometry": "pas du json"},
               {"geometry": json.dumps({"type": "Point", "coordinates": [2.0]})}]
    assert len(postes_enedis_pour_emprise(*EMPRISE, mauvais + bons)["postes"]) == 1


def test_aucun_poste_rend_none():
    assert postes_enedis_pour_emprise(*EMPRISE, []) is None
    assert postes_enedis_pour_emprise(*EMPRISE, None) is None


# --- Lecture de l'API ----------------------------------------------------------

def test_la_premiere_page_demande_la_boite_ouest_sud_est_nord(api):
    appels, pages = api
    pages.append(_Reponse({"results": [_poste(*_pt(.5, .5))], "total": 1}))
    assert len(fetch_postes_enedis(*EMPRISE)) == 1
    assert appels == [{"size": postes_enedis.PAGE, "bbox": "2.0,45.0,2.00127,45.0009"}]


def test_les_pages_suivent_le_curseur_after_du_lien_next(api):
    appels, pages = api
    pages += [_Reponse({"results": [{}] * 2, "total": 3,
                        "next": "https://x/lines?size=500&after=12%2C34&bbox=…"}),
              _Reponse({"results": [{}], "total": 3})]
    assert len(fetch_postes_enedis(*EMPRISE)) == 3
    assert appels[1] == {"size": postes_enedis.PAGE, "after": "12,34"}


def test_la_lecture_s_arrete_au_plafond(api, monkeypatch):
    appels, pages = api
    monkeypatch.setattr(postes_enedis, "MAX_POSTES", 4)
    monkeypatch.setattr(postes_enedis, "PAGE", 2)
    suite = {"next": "https://x/lines?after=1"}
    pages += [_Reponse({"results": [{}] * 2, "total": 100, **suite}) for _ in range(5)]
    assert len(fetch_postes_enedis(*EMPRISE)) == 4
    assert len(appels) == 2


def test_un_lien_next_sans_curseur_arrete_la_lecture(api):
    appels, pages = api
    pages.append(_Reponse({"results": [{}], "total": 10, "next": "https://x/lines?size=500"}))
    assert len(fetch_postes_enedis(*EMPRISE)) == 1 and len(appels) == 1


def test_un_echec_passager_est_reessaye(api):
    appels, pages = api
    pages += [requests.ConnectionError("coupure"), _Reponse({}, statut=502),
              _Reponse({"results": [{}], "total": 1})]
    assert len(fetch_postes_enedis(*EMPRISE)) == 1
    assert len(appels) == 3


def test_trois_echecs_levent_une_erreur_de_lecture(api):
    # Une panne doit lever : la couche n'écrit rien, la demande suivante réessaie.
    _, pages = api
    pages += [_Reponse({}, statut=503)] * postes_enedis.ESSAIS
    with pytest.raises(requests.RequestException, match="Enedis injoignable"):
        fetch_postes_enedis(*EMPRISE)


def test_une_reponse_qui_n_est_pas_du_json_est_un_echec(api):
    _, pages = api

    class _PasJson(_Reponse):
        def json(self):
            raise ValueError("pas du JSON")

    pages += [_PasJson({})] * postes_enedis.ESSAIS
    with pytest.raises(requests.RequestException):
        fetch_postes_enedis(*EMPRISE)
