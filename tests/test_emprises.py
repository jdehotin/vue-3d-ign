"""Emprises BD TOPO (vue3d/emprises.py) : cimetières, aérodromes et leurs
pistes, postes de transformation et haies — sans réseau."""
import pytest

from vue3d.emprises import (EMPRISES_VERSION, HAIE_HAUTEUR_M, HAIE_LARGEUR_M,
                            emprises_pour_emprise)

# ~100 m de côté vers 45° N.
EMPRISE = (2.0, 45.0, 2.00127, 45.0009)


def _pt(fx, fy, z=None):
    """Point à la fraction (fx, fy) de l'emprise, d'ouest en est et du sud au nord."""
    o, s, e, n = EMPRISE
    p = [o + (e - o) * fx, s + (n - s) * fy]
    return p if z is None else p + [z]


def _polygone(points, **props):
    return {"type": "Feature", "properties": {"etat_de_l_objet": "En service", **props},
            "geometry": {"type": "MultiPolygon", "coordinates": [[points + [points[0]]]]}}


def _ligne(points, **props):
    return {"type": "Feature", "properties": {"etat_de_l_objet": "En service", **props},
            "geometry": {"type": "LineString", "coordinates": points}}


def _carre(fx0, fy0, fx1, fy1, **props):
    return _polygone([_pt(fx0, fy0), _pt(fx1, fy0), _pt(fx1, fy1), _pt(fx0, fy1)], **props)


def _emprises(cimetieres=(), aerodromes=(), pistes=(), postes=(), haies=()):
    brut = {"cimetieres": {"features": list(cimetieres)},
            "aerodromes": {"features": list(aerodromes)},
            "pistes": {"features": list(pistes)},
            "postes": {"features": list(postes)},
            "haies": {"features": list(haies)}}
    return emprises_pour_emprise(*EMPRISE, brut)


def test_un_cimetiere_est_un_aplat_decoupe_et_nomme():
    c = _emprises(cimetieres=[_carre(0.2, 0.4, 0.8, 0.6, toponyme="Cimetière du Sud",
                                     nature="Militaire")])
    (cimetiere,) = c["cimetieres"]
    assert cimetiere["nom"] == "Cimetière du Sud"
    assert cimetiere["nature"] == "Militaire"
    assert cimetiere["geometrie"]["type"] == "MultiPolygon"
    assert c["version"] == EMPRISES_VERSION
    assert c["aerodromes"] == [] and c["haies"] == []


def test_un_aplat_qui_sort_de_l_emprise_est_coupe_a_son_bord():
    (cimetiere,) = _emprises(cimetieres=[_carre(0.5, 0.4, 1.5, 0.6)])["cimetieres"]
    lons = [p[0] for poly in cimetiere["geometrie"]["coordinates"] for p in poly[0]]
    assert max(lons) == pytest.approx(EMPRISE[2])


def test_un_aplat_dont_seule_la_boite_touche_l_emprise_est_ecarte():
    """Le WFS le rend quand même : constaté sur des emprises de bord."""
    assert _emprises(cimetieres=[_carre(-0.9, 0.4, 0.0, 0.6)]) is None


def test_les_emprises_en_projet_et_fictives_ne_sont_pas_dessinees():
    projet = dict(_carre(0.2, 0.2, 0.8, 0.3))
    projet["properties"]["etat_de_l_objet"] = "En projet"
    fictif = _carre(0.2, 0.4, 0.8, 0.5, fictif=True)
    assert _emprises(aerodromes=[projet, fictif]) is None


def test_l_altitude_d_une_piste_est_ignoree_le_relief_commande():
    """La vue drape l'aplat : les sommets en 3D de la BD TOPO ne servent pas."""
    piste = _polygone([_pt(0.2, 0.4, 143.6), _pt(0.8, 0.4, 143.8),
                       _pt(0.8, 0.6, 144.1), _pt(0.2, 0.6, 144.0)],
                      nature="Piste en dur")
    (aplat,) = _emprises(pistes=[piste])["pistes"]
    assert aplat["nature"] == "Piste en dur"
    assert all(len(p) == 2 for poly in aplat["geometrie"]["coordinates"] for p in poly[0])


def test_un_aerodrome_garde_ses_codes_et_son_usage():
    (aerodrome,) = _emprises(aerodromes=[_carre(0.1, 0.1, 0.9, 0.9,
                                                toponyme="Aérodrome de Strasbourg-Neuhof",
                                                nature="Aérodrome", categorie="Nationale",
                                                usage="Civil", code_icao="LFGC",
                                                code_iata=None)])["aerodromes"]
    assert aerodrome["oaci"] == "LFGC" and aerodrome["iata"] is None
    assert aerodrome["usage"] == "Civil" and aerodrome["categorie"] == "Nationale"


def test_une_haie_sans_mesure_prend_les_deux_conventions():
    """La BD TOPO laisse hauteur et largeur vides sur toutes les haies vues."""
    (haie,) = _emprises(haies=[_ligne([_pt(0.2, 0.5), _pt(0.8, 0.5)])])["haies"]
    assert haie["h"] == HAIE_HAUTEUR_M and haie["largeur_m"] == HAIE_LARGEUR_M
    assert haie["h_mesuree"] is False and haie["largeur_mesuree"] is False
    assert [p[:2] for p in haie["ligne"]] == [_pt(0.2, 0.5), _pt(0.8, 0.5)]


def test_une_haie_mesuree_garde_sa_hauteur_et_sa_largeur():
    (haie,) = _emprises(haies=[_ligne([_pt(0.2, 0.5), _pt(0.8, 0.5)],
                                      hauteur=4.5, largeur=2.0)])["haies"]
    assert haie["h"] == 4.5 and haie["largeur_m"] == 2.0
    assert haie["h_mesuree"] is True and haie["largeur_mesuree"] is True


def test_une_haie_qui_sort_de_l_emprise_est_coupee_a_son_bord():
    """Elle revient en deux morceaux, comme une route qui sort et rentre."""
    haies = _emprises(haies=[_ligne([_pt(0.5, 0.2), _pt(1.5, 0.2), _pt(1.5, 0.8),
                                     _pt(0.5, 0.8)])])["haies"]
    assert len(haies) == 2
    lons = [p[0] for haie in haies for p in haie["ligne"]]
    assert max(lons) == pytest.approx(EMPRISE[2])


def test_une_emprise_vide_n_a_pas_de_couche():
    assert _emprises() is None
    assert emprises_pour_emprise(*EMPRISE, None) is None
