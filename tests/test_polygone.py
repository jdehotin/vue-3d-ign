"""Zone en polygone (vue3d/polygone.py) : lecture, découpe, cache et scène.

Le contour remplace le carré centré sur le point : sa boîte englobante est lue
auprès des sources, son bord découpe tout ce qui est dessiné, et sa vue masque
le terrain au-delà. Ces tests tiennent les deux promesses du nom : rien hors du
contour n'est gardé, et deux lectures du même contour — à l'écriture près —
donnent la même zone, donc la même scène en cache.
"""
import math

import numpy as np
import pytest
import shapely
from shapely.geometry import shape

from vue3d import scene
from vue3d.batiments import decouper_batiments
from vue3d.polygone import Polygone, analyser, decouper_features, decouper_sources
from vue3d.scene import Cache, HorsEmprise, emprise, zone_normalisee

# Un rectangle d'environ 200 × 290 m au sud-ouest du village de Gordes.
OUEST, SUD, DLON, DLAT = 5.1900, 43.9100, 0.0025, 0.0026
CONTOUR = (f"{SUD},{OUEST};{SUD},{OUEST + DLON};"
           f"{SUD + DLAT},{OUEST + DLON};{SUD + DLAT},{OUEST}")


def _contour(lat0, lon0, dlat, dlon):
    """Le texte `poly=` d'un rectangle, dans l'ordre des sommets."""
    return (f"{lat0},{lon0};{lat0},{lon0 + dlon};"
            f"{lat0 + dlat},{lon0 + dlon};{lat0 + dlat},{lon0}")


def _polygone_grille(grille, x0, y0, x1, y1):
    """Polygone (Polygone) d'un rectangle en mètres dans la grille des tests."""
    ouest, sud, est, nord = grille["bbox"]
    nx, ny = grille["width"], grille["height"]

    def ll(x, y):
        return (sud + (nord - sud) * y / (ny * 0.5), ouest + (est - ouest) * x / (nx * 0.5))

    return Polygone([ll(x0, y0), ll(x1, y0), ll(x1, y1), ll(x0, y1)])


# --- Lecture et normalisation ------------------------------------------------------

def test_un_contour_se_lit_dans_l_ordre_et_se_reecrit():
    """L'ordre des sommets fait la forme : il se garde, et le contour se
    réécrit sous une forme qui se relit à l'identique."""
    p = Polygone(analyser(CONTOUR))
    attendus = [(SUD, OUEST), (SUD, OUEST + DLON), (SUD + DLAT, OUEST + DLON),
                (SUD + DLAT, OUEST)]
    assert p.sommets == tuple((round(lat, 6), round(lon, 6)) for lat, lon in attendus)
    relu = Polygone(analyser(p.texte))
    assert relu == p and relu.cle == p.cle


def test_les_espaces_et_le_point_final_ne_changent_pas_le_contour():
    """Un contour fermé, ou écrit sur plusieurs lignes, est le même : la clé du
    cache ne dépend pas de la mise en forme."""
    ouvert = Polygone(analyser(CONTOUR))
    ferme = Polygone(analyser(CONTOUR + f";{SUD},{OUEST}"))
    en_lignes = Polygone(analyser(CONTOUR.replace(";", "\n")))
    assert ferme.cle == ouvert.cle and en_lignes.cle == ouvert.cle


def test_un_contour_reduit_a_deux_sommets_est_le_meme():
    """Un sommet répété ne compte pas : il ferait une arête de longueur nulle."""
    p = Polygone(analyser(f"{SUD},{OUEST};{SUD},{OUEST};{SUD},{OUEST + DLON};"
                          f"{SUD + DLAT},{OUEST + DLON}"))
    assert len(p.sommets) == 3


@pytest.mark.parametrize("brute", [
    "", "43.9,5.2", "43.9,5.2;43.9,5.2;43.9,5.2",
    "a,b;43.9,5.2;43.91,5.21", "43.9,5.2;43.91,5.21;43.9,5.2;43.91,5.21",
    "43.910,5.190;43.910,5.195;43.910,5.197",         # alignés : aire nulle
])
def test_un_contour_mal_forme_est_refuse(brute):
    """Moins de trois sommets, des coordonnées illisibles, des sommets alignés
    ou un « huit » : mieux vaut refuser que dessiner une surface inventée."""
    with pytest.raises(ValueError):
        Polygone(analyser(brute))


def test_les_quatre_coins_d_une_boite_en_zigzag_redeviennent_le_tour():
    """SO, SE, NO, NE : l'ordre d'une énumération minLat/maxLat — un « huit » —
    se lit comme la boîte, même surface ; un vrai « huit » reste refusé."""
    zigzag = Polygone(analyser("43.90,5.19;43.90,5.21;43.92,5.19;43.92,5.21"))
    tour = Polygone(analyser("43.90,5.19;43.90,5.21;43.92,5.21;43.92,5.19"))
    assert zigzag == tour and zigzag.aire_m2 == tour.aire_m2
    with pytest.raises(ValueError):
        Polygone(analyser("43.90,5.19;43.92,5.21;43.92,5.19;43.905,5.21"))


def test_l_aire_du_contour_est_celle_de_shapely():
    """L'aire du lacet sur les sommets projetés vaut celle du polygone en
    mètres : c'est elle qui est annoncée à l'utilisateur (10 km² conseillés)."""
    p = Polygone(analyser(CONTOUR))
    kx = 111320 * math.cos(math.radians((p.sud + p.nord) / 2))
    attendue = shapely.transform(p.forme(), lambda c: c * [kx, 111320]).area
    assert p.aire_m2 == pytest.approx(attendue, rel=1e-9)
    assert p.aire_m2 == pytest.approx(DLON * DLAT * kx * 111320, rel=1e-9)


# --- Refus de la page et du service -------------------------------------------------

def test_un_contour_hors_de_france_est_refuse():
    with pytest.raises(HorsEmprise):
        zone_normalisee(None, polygone="10.0,5.2;10.0,5.3;10.1,5.3")


def test_un_contour_plus_grand_que_la_boite_du_service_est_refuse():
    """La boîte est ce qui est lu : au-delà du double des 10 km² conseillés, la
    construction ne tiendrait pas en mémoire."""
    trop = _contour(48.80, 2.10, 0.05, 0.07)          # ~5,4 × 5,1 km, ~27 km²
    with pytest.raises(ValueError) as refus:
        zone_normalisee(None, polygone=trop)
    assert "km²" in str(refus.value)


def test_le_contour_est_prefere_a_la_zone():
    """`poly=` remplace `zone=` : une page qui garde les deux ne charge pas un
    carré autour du contour."""
    p = zone_normalisee("500", polygone=CONTOUR)
    assert isinstance(p, Polygone)
    assert zone_normalisee(p) is p                       # déjà lu : rendu tel quel


def test_l_emprise_est_la_boite_du_contour_et_le_cote_le_plus_grand():
    p = Polygone(analyser(CONTOUR))
    assert emprise(0, 0, p) == (p.ouest, p.sud, p.est, p.nord)
    cote_ns = (p.nord - p.sud) * 111320
    cote_eo = (p.est - p.ouest) * 111320 * math.cos(math.radians((p.nord + p.sud) / 2))
    assert p.cote_max_m == pytest.approx(max(cote_ns, cote_eo))
    assert scene.cote_zone(p) == p.cote_max_m
    assert scene.facteur_zone(p) == pytest.approx(p.cote_max_m / scene.SCENE_COTE_M)


# --- Appartenance -------------------------------------------------------------------

def test_le_masque_et_le_masque_tableau_s_accorde():
    """Le filtre d'un point et celui d'un tableau — le nuage en compte des
    millions — disent la même chose."""
    p = Polygone(analyser(CONTOUR))
    lons = np.linspace(p.ouest - 0.01, p.est + 0.01, 41)
    lats = np.linspace(p.sud - 0.01, p.nord + 0.01, 37)
    lons, lats = np.meshgrid(lons, lats)
    attendu = np.array([[p.masque(lon, lat) for lon in lons[0]] for lat in lats[:, 0]])
    assert np.array_equal(p.masque_tableau(lons, lats), attendu)
    assert attendu.any() and not attendu.all()


# --- Découpe des sources -------------------------------------------------------------

def _carre(lon0, lat0, cote_deg):
    return {"type": "Polygon", "coordinates": [[
        [lon0, lat0], [lon0 + cote_deg, lat0], [lon0 + cote_deg, lat0 + cote_deg],
        [lon0, lat0 + cote_deg], [lon0, lat0]]]}


def test_le_contour_ramene_les_sources_geojson_a_son_bord():
    """Une source lue sur la boîte est découpée au bord : un objet à cheval
    garde sa partie intérieure, un objet au-delà disparaît."""
    p = Polygone(analyser(CONTOUR))
    brut = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"nom": "à cheval"},
         "geometry": _carre(OUEST - 0.01, SUD - 0.01, 0.02)},
        {"type": "Feature", "properties": {"nom": "au-delà"},
         "geometry": _carre(OUEST + 0.1, SUD + 0.1, 0.002)},
    ]}
    gardes = decouper_sources(brut, p)["features"]
    assert [f["properties"]["nom"] for f in gardes] == ["à cheval"]
    bornes = shape(gardes[0]["geometry"]).bounds
    assert bornes[0] >= p.ouest - 1e-9 and bornes[2] <= p.est + 1e-9


def test_la_decoupe_d_une_ligne_garde_son_altitude():
    """Les murs et les ponts de la BD TOPO sont des lignes 3D : la coupe doit
    interpoler l'altitude au bord. Sans elle (un `force_2d`), ouvrages.py
    écarte tout sommet sans z et la couche se vide — arrivé une fois."""
    from shapely.geometry import LineString
    p = Polygone(analyser(CONTOUR))
    milieu = (p.sud + p.nord) / 2
    ligne = LineString([(p.ouest - 0.01, milieu, 100.0), (p.est + 0.01, milieu, 200.0)])
    morceau = p.decouper(ligne)
    assert morceau.geom_type == "LineString"
    zs = [q[2] for q in morceau.coords]
    assert len(zs) >= 2 and all(z is not None for z in zs)
    assert all(100.0 < z < 200.0 for z in zs)


def test_les_dictionnaires_de_sources_suivent_leurs_geojson_sans_perdre_le_reste():
    """Les quatre couches d'ouvrages arrivent en dictionnaire : chaque GeoJSON
    est découpé, le reste (dates, absences) est rendu tel quel."""
    p = Polygone(analyser(CONTOUR))
    brut = {"murs": {"type": "FeatureCollection", "features": [
                {"type": "Feature", "properties": {},
                 "geometry": _carre(OUEST + 0.05, SUD + 0.05, 0.002)}]},
            "lu_le": "2026-01-01",
            "lignes": [1, 2]}
    garde = decouper_sources(brut, p)
    assert garde["murs"]["features"] == [] and garde["lu_le"] == "2026-01-01"
    assert garde["lignes"] == [1, 2]


def test_deux_contours_differents_ne_partagent_pas_leur_cache(tmp_path):
    """La clé du dossier, c'est le contour : deux contours voisins ne se
    servent pas la scène l'un de l'autre, et un même contour s'y retrouve."""
    cache = Cache(str(tmp_path))
    a = Polygone(analyser(CONTOUR))
    b = Polygone(analyser(_contour(SUD, OUEST, DLAT, DLON * 2)))
    assert cache._dossier_point(43.91, 5.19, a) == cache._dossier_point(43.91, 5.19, a)
    assert cache._dossier_point(43.91, 5.19, a) != cache._dossier_point(43.91, 5.19, b)
    assert cache._dossier_point(43.91, 5.19, a) != cache._dossier_point(43.91, 5.19, 500)


# --- Découpe de ce qui est dessiné --------------------------------------------------

def test_les_batiments_sont_decoupes_au_contour():
    """Le WFS rend les bâtiments entiers : hors du contour ils disparaissent,
    à cheval ils sont coupés — comme au bord d'une zone carrée."""
    p = Polygone(analyser(CONTOUR))
    ouest, sud, est, nord = p.ouest, p.sud, p.est, p.nord
    dedans = {"type": "Feature", "properties": {"cleabs": "DEDANS"}, "geometry": _carre(
        ouest + (est - ouest) * 0.3, sud + (nord - sud) * 0.3, (est - ouest) * 0.2)}
    dehors = {"type": "Feature", "properties": {"cleabs": "DEHORS"},
              "geometry": _carre(est + 0.005, sud, 0.001)}
    a_cheval = {"type": "Feature", "properties": {"cleabs": "A_CHEVAL"}, "geometry": _carre(
        ouest + (est - ouest) * 0.5, sud + (nord - sud) * 0.4, (est - ouest) * 0.6)}
    gardes = decouper_batiments({"features": [dedans, dehors, a_cheval]},
                                ouest, sud, est, nord, p)["features"]
    par_cle = {f["properties"]["cleabs"]: f for f in gardes}
    assert set(par_cle) == {"DEDANS", "A_CHEVAL"}
    assert "coupe" not in par_cle["DEDANS"]["properties"]
    assert shape(par_cle["A_CHEVAL"]["geometry"]).bounds[2] <= est + 1e-9
    assert 0 < par_cle["A_CHEVAL"]["properties"]["coupe"]["part"] < 1


def test_les_houppiers_hors_du_contour_ne_sont_pas_gardes():
    """Le MNH se segmente sur toute la boîte — c'est elle qui est lue —, mais
    un houppier dont le sommet sort du contour n'est pas publié."""
    from tests.test_houppiers import _emprise, _grille, _polygone_m
    H = _grille(arbres=[(10, 10, 12, 4)])
    grille = _emprise(H)
    grille.update({"couvert": True, "source": "lidar_hd", "resolution_m": 0.5})
    veg = {"features": [dict(_polygone_m(grille, 0, 0, 40, 40),
                             properties={"nature": "Forêt fermée de feuillus"})]}
    args = ((*grille["bbox"],), {"features": []}, veg, None, grille, None)
    autours = _polygone_grille(grille, 0, 0, 30, 30)
    ailleurs = _polygone_grille(grille, 30, 30, 39, 39)
    dedans = scene.houppiers_pour_emprise(*args[0], *args[1:], polygone=autours)
    dehors = scene.houppiers_pour_emprise(*args[0], *args[1:], polygone=ailleurs)
    assert len(dedans["houppiers"]) == 1
    assert dehors["houppiers"] == [] and dehors["masses"] == []


def test_le_contour_est_embarque_dans_la_scene_et_pas_dans_une_zone_carree():
    """La vue masque le terrain au-delà du contour : il voyage avec la scène.
    Une zone carrée ne porte pas la clé, sa scène reste celle d'avant."""
    from tests.test_houppiers import _emprise, _grille
    H = _grille()
    grille = _emprise(H)
    grille.update({"couvert": True, "source": "lidar_hd", "resolution_m": 0.5})
    args = (*grille["bbox"], {"features": []}, {"features": []}, None, {"features": []},
            grille, np.full(H.shape, 20, dtype=np.int8), None)
    p = _polygone_grille(grille, 10, 10, 40, 40)
    carree, contouree = scene.assembler(*args), scene.assembler(*args, polygone=p)
    assert "polygone" not in carree
    assert contouree["polygone"] == p.anneau()
    assert contouree["batiments"] == carree["batiments"]


def test_les_bornes_hors_du_contour_ne_sont_pas_gardees():
    """Les couches ponctuelles se filtrent par leur point : une station de
    recharge au-delà du contour n'est pas publiée."""
    from vue3d.bornes import bornes_pour_emprise
    p = Polygone(analyser(CONTOUR))
    milieu = (p.ouest + p.est) / 2, (p.sud + p.nord) / 2

    def ligne(nom, lon, lat):
        return {"nom_station": nom, "consolidated_longitude": lon, "consolidated_latitude": lat,
                "id_station_itinerance": nom, "puissance_nominale": 22}
    brut = {"lignes": [ligne("DEDANS", *milieu),
                       ligne("DEHORS", p.est + 0.01, p.sud)],
            "lu_le": "2026-01-01"}
    gardees = bornes_pour_emprise(p.ouest, p.sud, p.est, p.nord, brut, polygone=p)["stations"]
    assert [s["nom"] for s in gardees] == ["DEDANS"]


def test_les_panneaux_sont_decoupes_au_contour():
    """Le registre donne des installations entières : la vue n'en garde que la
    partie dans le contour."""
    from vue3d.panneaux import panneaux_pour_emprise
    p = Polygone(analyser(CONTOUR))
    installation = {"contour": [[p.ouest, p.sud], [p.est + 0.01, p.sud],
                                [p.est + 0.01, p.nord], [p.ouest, p.nord]],
                    "surface": 100.0, "kwp": 20.0, "annee": 2020}
    panneaux = panneaux_pour_emprise(p.ouest, p.sud, p.est, p.nord, [installation],
                                     polygone=p)["panneaux"]
    assert len(panneaux) == 1
    lons = [x for x, _ in panneaux[0]["contour"]]
    assert max(lons) <= p.est + 0.01


def test_le_contour_remplace_la_zone_dans_le_dossier_d_une_couche(tmp_path):
    """Les couches d'un contour vivent à côté de sa scène, pas de celle du
    carré : leurs fichiers ne se mélangent pas."""
    cache = Cache(str(tmp_path))
    p = Polygone(analyser(CONTOUR))
    dossier = cache._dossier_point(43.91, 5.19, p)
    assert dossier.endswith(f"_{p}")
    assert f"_{p}" != "_z500"
