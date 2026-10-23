"""Signalements de la vue en voiture (vue3d/signalements.py, POST /api/signalement)."""
import base64
import json
import os

import pytest

from vue3d import app as module_app
from vue3d import signalements as module_signalements
from vue3d.signalements import SignalementInvalide, Signalements, SignalementsComplets

JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64


def corps(capture=JPEG, etat=None):
    s = {"etat": etat if etat is not None else {"pris": "2026-10-23T12:32:00Z", "alerte": "sans photo (zoom 18)"}}
    if capture is not None:
        s["capture"] = "data:image/jpeg;base64," + base64.b64encode(capture).decode()
    return json.dumps(s).encode()


@pytest.fixture
def client(tmp_path):
    return module_app.creer_app(str(tmp_path)).test_client()


def test_un_signalement_est_garde_avec_sa_capture(client, tmp_path):
    r = client.post("/api/signalement", data=corps(), content_type="application/json",
                    headers={"User-Agent": "Tesla"})
    assert r.status_code == 201
    assert r.headers["Cache-Control"] == "no-store"
    ident = r.get_json()["id"]
    dossier = tmp_path / "signalements"
    garde = json.loads((dossier / f"{ident}.json").read_text())
    assert garde["etat"]["alerte"] == "sans photo (zoom 18)"
    assert garde["agent"] == "Tesla" and garde["capture"] is True
    assert (dossier / f"{ident}.jpg").read_bytes() == JPEG


def test_sans_capture_l_etat_suffit(client, tmp_path):
    r = client.post("/api/signalement", data=corps(capture=None), content_type="application/json")
    assert r.status_code == 201
    noms = os.listdir(tmp_path / "signalements")
    assert noms == [f"{r.get_json()['id']}.json"]


@pytest.mark.parametrize("donnees", [
    b"pas du json",
    json.dumps([1, 2]).encode(),
    json.dumps({"capture": None}).encode(),
    corps(capture=b"GIF89a"),
    json.dumps({"etat": {}, "capture": "data:image/png;base64,AAAA"}).encode(),
    json.dumps({"etat": {}, "capture": "data:image/jpeg;base64,@@@"}).encode(),
])
def test_un_corps_qui_n_est_pas_un_signalement_400(client, tmp_path, donnees):
    r = client.post("/api/signalement", data=donnees, content_type="application/json")
    assert r.status_code == 400
    assert not (tmp_path / "signalements").exists()


def test_un_signalement_trop_gros_413(client, tmp_path, monkeypatch):
    monkeypatch.setattr(module_app, "SIGNALEMENT_OCTETS_MAX", 1000)
    r = client.post("/api/signalement", data=corps(capture=JPEG * 50), content_type="application/json")
    assert r.status_code == 413
    assert not (tmp_path / "signalements").exists()


def test_au_dela_du_nombre_garde_rien_n_est_ecrit(tmp_path, monkeypatch):
    monkeypatch.setattr(module_signalements, "SIGNALEMENTS_MAX", 2)
    s = Signalements(str(tmp_path))
    s.enregistrer(corps())
    s.enregistrer(corps())
    with pytest.raises(SignalementsComplets):
        s.enregistrer(corps())
    assert len(os.listdir(tmp_path)) == 4            # deux JSON, deux captures


def test_plein_le_service_repond_507(client, tmp_path, monkeypatch):
    monkeypatch.setattr(module_signalements, "SIGNALEMENTS_MAX", 1)
    assert client.post("/api/signalement", data=corps(), content_type="application/json").status_code == 201
    assert client.post("/api/signalement", data=corps(), content_type="application/json").status_code == 507


def test_le_quota_borne_les_signalements_d_une_adresse(tmp_path, monkeypatch):
    monkeypatch.setattr(module_app, "SIGNALEMENTS_PAR_HEURE", 2)
    client = module_app.creer_app(str(tmp_path), quota=5).test_client()
    codes = [client.post("/api/signalement", data=corps(), content_type="application/json").status_code
             for _ in range(3)]
    assert codes == [201, 201, 429]
    assert len([n for n in os.listdir(tmp_path / "signalements") if n.endswith(".json")]) == 2


def test_un_etat_qui_n_est_pas_un_objet_est_refuse(tmp_path):
    with pytest.raises(SignalementInvalide):
        Signalements(str(tmp_path)).enregistrer(json.dumps({"etat": "texte"}).encode())
