"""Canalisations BD TOPO (vue3d/reseaux.py) : segments découpés à l'emprise,
nature et position gardées — sans réseau."""
from vue3d import reseaux
from vue3d.reseaux import RESEAUX_VERSION, reseaux_pour_emprise

# ~100 m de côté vers 45° N.
EMPRISE = (2.0, 45.0, 2.00127, 45.0009)


def _pt(fx, fy, z=None):
    """Point à la fraction (fx, fy) de l'emprise, d'ouest en est et du sud au nord."""
    o, s, e, n = EMPRISE
    p = [o + (e - o) * fx, s + (n - s) * fy]
    return p if z is None else p + [z]


def _canalisation(points, nature="Eau", position=-1, geometrie="LineString"):
    coordonnees = [points] if geometrie == "MultiLineString" else points
    return {"type": "Feature",
            "properties": {"nature": nature, "position_par_rapport_au_sol": position},
            "geometry": {"type": geometrie, "coordinates": coordonnees}}


def test_une_canalisation_garde_sa_nature_et_sa_position():
    couche = reseaux_pour_emprise(*EMPRISE, {"features": [
        _canalisation([_pt(.2, .5), _pt(.8, .5)], nature="Gaz", position=-1)]})
    assert couche["version"] == RESEAUX_VERSION
    (r,) = couche["reseaux"]
    assert r["nature"] == "Gaz" and r["position"] == -1
    assert len(r["ligne"]) == 2


def test_un_segment_qui_deborde_est_coupe_au_bord_de_l_emprise():
    couche = reseaux_pour_emprise(*EMPRISE, {"features": [
        _canalisation([_pt(-.5, .5), _pt(.5, .5)])]})
    (r,) = couche["reseaux"]
    o, _, e, _ = EMPRISE
    assert min(x for x, _ in r["ligne"]) >= o and max(x for x, _ in r["ligne"]) <= e


def test_une_ligne_coupee_en_deux_par_l_emprise_donne_deux_segments():
    # Entre, ressort par le nord, rentre : deux morceaux dans le cadre.
    couche = reseaux_pour_emprise(*EMPRISE, {"features": [
        _canalisation([_pt(.2, .5), _pt(.2, 1.5), _pt(.8, 1.5), _pt(.8, .5)],
                      geometrie="MultiLineString")]})
    assert len(couche["reseaux"]) == 2


def test_les_altitudes_sont_ignorees_et_les_coordonnees_arrondies_au_centimetre():
    couche = reseaux_pour_emprise(*EMPRISE, {"features": [
        _canalisation([_pt(.2, .5, 120.0), _pt(.8, .5, 121.0)])]})
    for x, y, *reste in couche["reseaux"][0]["ligne"]:
        assert not reste
        assert round(x, reseaux.DECIMALES) == x and round(y, reseaux.DECIMALES) == y


def test_rien_dans_l_emprise_rend_none():
    assert reseaux_pour_emprise(*EMPRISE, {"features": []}) is None
    assert reseaux_pour_emprise(*EMPRISE, None) is None
    # Entièrement dehors : rien.
    assert reseaux_pour_emprise(*EMPRISE, {"features": [
        _canalisation([_pt(2, 2), _pt(3, 3)])]}) is None


def test_une_geometrie_absente_ou_illisible_est_ecartee_sans_perdre_les_autres():
    bonne = _canalisation([_pt(.2, .5), _pt(.8, .5)])
    sans = {"type": "Feature", "properties": {}, "geometry": None}
    illisible = {"type": "Feature", "properties": {}, "geometry": {"type": "LineString", "coordinates": [[1]]}}
    couche = reseaux_pour_emprise(*EMPRISE, {"features": [sans, illisible, bonne]})
    assert len(couche["reseaux"]) == 1


def test_fetch_lit_la_couche_canalisation_de_la_bd_topo(monkeypatch):
    lues = []
    monkeypatch.setattr(reseaux, "lire_couche", lambda couche, *bbox: lues.append((couche, bbox)) or {})
    reseaux.fetch_reseaux(*EMPRISE)
    assert lues == [("BDTOPO_V3:canalisation", EMPRISE)]
