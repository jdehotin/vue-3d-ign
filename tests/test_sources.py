"""Catalogue des sources (vue3d/sources.py), lu par la fenêtre « Données » —
sans réseau."""
from types import SimpleNamespace

from vue3d import sources
from vue3d.scene import SCENE_VERSION

MODES = {"scene", "apres-scene", "au-clic"}
CHAMPS = {"id", "libelle", "theme", "mode", "version", "fournisseur", "licence",
          "lien", "description"}


def test_chaque_source_porte_tous_ses_champs_et_un_mode_connu():
    for s in sources.SOURCES:
        assert set(s) == CHAMPS, s["id"]
        assert s["mode"] in MODES, s["id"]
        assert s["lien"].startswith("https://"), s["id"]
        assert s["libelle"] and s["fournisseur"] and s["licence"] and s["description"]


def test_les_identifiants_sont_uniques():
    ids = [s["id"] for s in sources.SOURCES]
    assert len(ids) == len(set(ids))


def test_la_scene_seule_est_en_mode_scene_et_porte_sa_version():
    (scene,) = [s for s in sources.SOURCES if s["mode"] == "scene"]
    assert scene["id"] == "scene" and scene["version"] == SCENE_VERSION


def test_les_couches_retirees_ne_reviennent_pas_au_catalogue():
    # DVF, cimetières, RPG et chemins ont été retirés de la page et du serveur.
    ids = {s["id"] for s in sources.SOURCES}
    assert not ids & {"dvf", "cimetieres", "rpg", "chemins", "foret"}


def test_sans_detecteur_ni_registre_les_detections_et_les_panneaux_sont_indisponibles():
    cat = {s["id"]: s for s in sources.catalogue()}
    assert not cat["detections"]["disponible"] and not cat["panneaux"]["disponible"]
    assert all(s["disponible"] for i, s in cat.items() if i not in {"detections", "panneaux"})


def test_un_detecteur_rend_les_detections_disponibles():
    lire_vehicules = SimpleNamespace(detecteurs=["rtmdet"])
    cat = {s["id"]: s for s in sources.catalogue(lire_vehicules=lire_vehicules,
                                                 lire_panneaux=lambda *b: None)}
    assert cat["detections"]["disponible"] and cat["panneaux"]["disponible"]


def test_un_lecteur_de_vehicules_sans_detecteur_reste_indisponible():
    cat = {s["id"]: s for s in sources.catalogue(lire_vehicules=SimpleNamespace(detecteurs=[]))}
    assert not cat["detections"]["disponible"]


def test_le_catalogue_ne_modifie_pas_les_sources():
    avant = [dict(s) for s in sources.SOURCES]
    sources.catalogue(lire_vehicules=SimpleNamespace(detecteurs=["yolo"]))
    assert [dict(s) for s in sources.SOURCES] == avant
