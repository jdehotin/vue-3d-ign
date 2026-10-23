"""Bornes de recharge (vue3d/bornes.py) : stations, lecture paginée, sans réseau."""
import pytest
import requests

from vue3d import bornes

BBOX = (5.59, 43.29, 5.61, 43.31)


def _point(station, pdc, lon=5.6, lat=43.3, **champs):
    return {"id_station_itinerance": station, "id_pdc_itinerance": pdc, "nom_station": f"Station {station}",
            "nom_operateur": "Opérateur", "consolidated_longitude": lon, "consolidated_latitude": lat,
            "puissance_nominale": 22, "nbre_pdc": 2, "prise_type_2": True, "condition_acces": "Accès libre",
            "date_maj": "2026-01-01", **champs}


def test_les_points_d_une_station_n_en_font_qu_une():
    brut = {"lu_le": "2026-10-15", "lignes": [
        _point("S1", "P1", puissance_nominale=22),
        _point("S1", "P2", puissance_nominale=50, prise_type_2=False, prise_type_combo_ccs=True,
               date_maj="2026-03-01"),
        _point("S1", "P2"),                                   # déclaré deux fois
        _point("S2", "P3", lon=5.595, lat=43.295, puissance_nominale=7.4, gratuit=True),
    ]}
    c = bornes.bornes_pour_emprise(*BBOX, brut)
    assert c["lu_le"] == "2026-10-15" and c["nombre_points"] == 3
    s1, s2 = c["stations"]                                    # la plus puissante d'abord
    assert (s1["nom"], s1["points"], s1["declares"]) == ("Station S1", 2, 2)
    assert (s1["puissance_max"], s1["puissance_min"]) == (50, 22)
    assert s1["prises"] == ["Type 2", "Combo CCS"] and s1["maj"] == "2026-03-01"
    assert s1["gratuit"] is None and s2["gratuit"] is True
    assert (s2["lon"], s2["lat"]) == (5.595, 43.295)


def test_sans_identifiant_la_station_est_son_nom_a_sa_position():
    brut = {"lignes": [_point(None, None, nom_station="Parking"), _point(None, None, nom_station="Parking"),
                       _point(None, None, nom_station="Parking", lon=5.605)]}
    assert [s["points"] for s in bornes.bornes_pour_emprise(*BBOX, brut)["stations"]] == [2, 1]


def test_hors_emprise_ou_sans_position_un_point_n_est_pas_garde():
    brut = {"lignes": [_point("S1", "P1", lon=5.7), _point("S2", "P2", lat=None),
                       _point("S3", "P3", lon="?"), _point("S4", "P4")]}
    assert [s["nom"] for s in bornes.bornes_pour_emprise(*BBOX, brut)["stations"]] == ["Station S4"]
    assert bornes.bornes_pour_emprise(*BBOX, None)["stations"] == []


class _Reponse:
    def __init__(self, json, status=200):
        self._json, self.status_code, self.ok = json, status, status < 400

    def json(self):
        return self._json


JEU = {"resources": [{"id": "geo", "format": "geojson", "title": "Export au format geojson"},
                     {"id": "R1", "format": "csv", "title": "Consolidation de la dernière version à date"}]}


def test_la_lecture_trouve_la_ressource_du_jour_et_suit_les_pages(monkeypatch):
    pages = [{"meta": {"total": 3}, "data": [{"n": 1}, {"n": 2}], "links": {"next": "SUITE"}},
             {"meta": {"total": 3}, "data": [{"n": 3}], "links": {"next": None}}]
    demandes = []

    def get(url, **_):
        demandes.append(url)
        return _Reponse(JEU if url == bornes.JEU_URL else pages.pop(0))

    monkeypatch.setattr(requests, "get", get)
    brut = bornes.fetch_bornes(*BBOX)
    assert [ligne["n"] for ligne in brut["lignes"]] == [1, 2, 3] and brut["ressource"] == "R1"
    assert "/resources/R1/data/" in demandes[1] and "page_size=200" in demandes[1]
    assert f"consolidated_longitude__greater={BBOX[0]}" in demandes[1]
    assert f"consolidated_latitude__less={BBOX[3]}" in demandes[1]
    assert demandes[2] == "SUITE" and len(brut["lu_le"]) == 10


def test_une_lecture_incomplete_ou_en_echec_leve(monkeypatch):
    """Complète ou absente : rien n'est rendu à moitié."""
    monkeypatch.setattr(bornes.time, "sleep", lambda s: None)
    monkeypatch.setattr(requests, "get", lambda url, **_: _Reponse(
        JEU if url == bornes.JEU_URL else {"meta": {"total": 5}, "data": [{}], "links": {}}))
    with pytest.raises(requests.RequestException, match="1 points de charge lus sur 5"):
        bornes.fetch_bornes(*BBOX)
    monkeypatch.setattr(requests, "get", lambda url, **_: _Reponse({"resources": []}))
    with pytest.raises(requests.RequestException, match="aucune ressource"):
        bornes.fetch_bornes(*BBOX)
    essais = []
    monkeypatch.setattr(requests, "get", lambda url, **_: essais.append(url) or _Reponse({}, 502))
    with pytest.raises(requests.RequestException, match="data.gouv.fr injoignable"):
        bornes.fetch_bornes(*BBOX)
    assert len(essais) == bornes.ESSAIS


# --- Par bloc, pour la vue en voiture ------------------------------------------------------------

def _bloc_de(lon, lat):
    from vue3d.carres import lambert93
    x, y = lambert93(lon, lat)
    return int(x // bornes.BLOC_M), int(y // bornes.BLOC_M)


def test_un_bloc_ne_garde_que_ses_stations(tmp_path):
    bi, bj = _bloc_de(5.6164, 43.4629)                       # Rousset
    lues = []

    def lire(w, s, e, n):
        lues.append((w, s, e, n))
        # Une station au cœur du bloc, une autre dans l'emprise en degrés mais
        # dans le bloc voisin (les méridiens convergent).
        return {"lu_le": "2026-10-23", "lignes": [_point("S1", "P1", lon=(w + e) / 2, lat=(s + n) / 2),
                                                  _point("S2", "P2", lon=w + 1e-4, lat=s + 1e-4)]}

    bloc = bornes.bornes_du_bloc(bi, bj, lire)
    assert [st["nom"] for st in bloc["stations"]] == ["Station S1"]
    assert bloc["bloc"] == [bi, bj] and bloc["nombre_points"] == 1 and bloc["lu_le"] == "2026-10-23"


def test_un_bloc_est_garde_une_semaine_puis_relu(tmp_path):
    import datetime
    jour = [datetime.date(2026, 10, 23)]
    lectures = []

    def lire(*bbox):
        lectures.append(bbox)
        return {"lu_le": jour[0].isoformat(), "lignes": []}

    blocs = bornes.BlocsBornes(str(tmp_path), lire=lire, aujourdhui=lambda: jour[0])
    bi, bj = _bloc_de(5.54, 43.4751)
    chemin = blocs.obtenir(bi, bj)
    assert blocs.obtenir(bi, bj) == chemin and len(lectures) == 1
    jour[0] += datetime.timedelta(days=bornes.BLOC_JOURS - 1)
    blocs.obtenir(bi, bj)
    assert len(lectures) == 1 and blocs.a_jour(bi, bj)
    jour[0] += datetime.timedelta(days=1)
    assert not blocs.a_jour(bi, bj)
    blocs.obtenir(bi, bj)
    assert len(lectures) == 2


def test_une_relecture_en_echec_garde_le_bloc_d_avant(tmp_path):
    import datetime, gzip, json
    jour = [datetime.date(2026, 10, 1)]
    panne = [False]

    def lire(*bbox):
        if panne[0]:
            raise requests.RequestException("data.gouv.fr injoignable")
        return {"lu_le": jour[0].isoformat(), "lignes": []}

    blocs = bornes.BlocsBornes(str(tmp_path), lire=lire, aujourdhui=lambda: jour[0])
    bi, bj = _bloc_de(5.54, 43.4751)
    chemin = blocs.obtenir(bi, bj)
    jour[0] = datetime.date(2026, 10, 23)
    panne[0] = True
    assert blocs.obtenir(bi, bj) == chemin
    with gzip.open(chemin, "rt") as f:
        assert json.load(f)["lu_le"] == "2026-10-01"
    # Sans bloc gardé, l'échec remonte, et rien n'est écrit.
    with pytest.raises(requests.RequestException):
        blocs.obtenir(bi + 1, bj)
    assert not (tmp_path / "carres" / "bornes-v1" / str(bi + 1)).exists()


def test_un_bloc_hors_de_france_est_refuse(tmp_path):
    with pytest.raises(bornes.BlocHorsEmprise):
        bornes.BlocsBornes(str(tmp_path), lire=None).obtenir(-5, 0)
