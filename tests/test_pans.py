"""Toits en pans (vue3d/pans.py) sur des grilles synthétiques, sans réseau."""

import math
from collections import Counter

import numpy as np
from shapely import affinity
from shapely.geometry import Point, box

from vue3d.toits import cellules_du_toit, pans_toit


def _grille(fonction, taille=60, pas=0.5):
    """Grille MNH de 30 m centrée sur l'origine : xs croissants, ys décroissants."""
    xs = (np.arange(taille) + 0.5) * pas - taille * pas / 2
    ys = -xs
    X, Y = np.meshgrid(xs, ys)
    return np.vectorize(fonction)(X, Y).astype(np.float32), xs, ys


def _pans(fonction, emprise, gouttiere=3.0):
    h, xs, ys = _grille(fonction)
    cel = cellules_du_toit(emprise, h, xs, ys, gouttiere)
    return pans_toit(emprise, cel), cel


def _sommets(p, cel):
    """Sommets transmis, en mètres dans le repère de la grille (x est, y nord)."""
    X, Y = cel["X"], cel["Y"]
    dx, dy = X[0, 1] - X[0, 0], Y[0, 0] - Y[1, 0]
    s = np.array(p["sommets"], dtype=float).reshape(-1, 3)
    return np.c_[X[0, 0] + s[:, 0] * dx / 10, Y[0, 0] - s[:, 1] * dy / 10, s[:, 2] / 10]


def _bords_libres(p, sommets):
    """Arêtes portées par un seul triangle : le plancher n'est pas transmis, ce
    doivent être exactement les pieds des murs, au sol."""
    t = np.array(p["triangles"]).reshape(-1, 3)
    orientees = Counter((int(a), int(b)) for tri in t for a, b in zip(tri, np.roll(tri, -1)))
    libres = [(a, b) for (a, b), n in orientees.items() if (b, a) not in orientees]
    assert all(n == 1 for n in orientees.values()), "arête parcourue deux fois dans le même sens"
    return libres, all(sommets[a][2] == 0 and sommets[b][2] == 0 for a, b in libres)


def _uv(x, y, angle=30):
    a = math.radians(angle)
    return x * math.cos(a) + y * math.sin(a), -x * math.sin(a) + y * math.cos(a)


def _deux_pans_tourne(x, y):
    """Toit à deux pans de 16 × 10 m, faîtage à 7 m, gouttière à 4 m, tourné."""
    u, v = _uv(x, y)
    return 7.0 - 3.0 * abs(v) / 5 if abs(u) <= 8 and abs(v) <= 5 else 0.0


def test_un_toit_a_deux_pans_tourne_donne_deux_plans_et_un_volume_ferme():
    emprise = affinity.rotate(box(-8, -5, 8, 5), 30, origin=(0, 0))
    p, cel = _pans(_deux_pans_tourne, emprise)
    assert p is not None and p["n_pans"] == 2
    s = _sommets(p, cel)
    libres, au_sol = _bords_libres(p, s)
    assert libres and au_sol
    toit = np.array(p["triangles"][:3 * p["n_toit"]])
    # Chaque sommet du toit est sur le toit vrai, au quantum près (0,1 m) et au
    # lissage du faîtage par la médiane 3×3 près.
    attendu = np.array([7.0 - 3.0 * abs(_uv(x, y)[1]) / 5 for x, y, _ in s[toit]])
    assert np.abs(s[toit][:, 2] - attendu).max() <= 0.2
    # Faîtage : les sommets les plus hauts sont à 7 m, et il n'y en a qu'une
    # ligne — pas de mur entre les deux pans.
    assert abs(s[toit][:, 2].max() - 7.0) <= 0.1


def test_une_surelevation_donne_un_mur_entre_deux_niveaux():
    """Moitié ouest à 7 m, moitié est à 4 m : deux pans plats et un mur de 3 m."""
    emprise = box(-7, -5, 7, 5)
    p, cel = _pans(lambda x, y: (7.0 if x < 0 else 4.0) if abs(x) <= 7 and abs(y) <= 5 else 0.0,
                   emprise)
    assert p is not None and p["n_pans"] == 2
    s = _sommets(p, cel)
    assert _bords_libres(p, s)[1]
    # Un mur intérieur, vertical, qui monte de 4 à 7 m près de x = 0.
    murs = np.array(p["triangles"][3 * p["n_toit"]:]).reshape(-1, 3)
    interieurs = [t for t in murs if all(abs(s[i][0]) < 1.0 and s[i][2] > 0 for i in t)]
    assert interieurs
    hauteurs = {round(s[i][2], 1) for t in interieurs for i in t}
    assert hauteurs == {4.0, 7.0}


def test_deux_plans_qui_se_croisent_le_long_d_une_frontiere():
    """Au nord un pan qui monte vers l'est, au sud un toit plat à la même
    hauteur au milieu : le mur change de côté en x = 0, où les deux plans se
    croisent. Le volume reste fermé et le croisement est un sommet."""
    def toit(x, y):
        if abs(x) > 7 or abs(y) > 5:
            return 0.0
        return 8.0 + 0.7 * x if y > 0 else 8.0
    p, cel = _pans(toit, box(-7, -5, 7, 5), gouttiere=4.0)
    assert p is not None and p["n_pans"] == 2
    s = _sommets(p, cel)
    assert _bords_libres(p, s)[1]
    assert (np.abs(s[:, 0]) <= 0.35).any()


def test_une_cour_interieure_reste_ouverte():
    """Toit plat autour d'une cour : le plancher et le toit sont percés, les
    murs de la cour descendent au sol, et aucun sommet n'est dans la cour."""
    emprise = box(-10, -8, 10, 8).difference(box(-4, -3, 4, 3))
    p, cel = _pans(lambda x, y: 6.0 if emprise.contains(Point(x, y)) else 0.0, emprise)
    assert p is not None and p["n_pans"] == 1
    s = _sommets(p, cel)
    libres, au_sol = _bords_libres(p, s)
    assert au_sol
    # Pieds de murs sur les deux contours : l'extérieur et la cour.
    pieds = {i for a, b in libres for i in (a, b)}
    assert any(abs(s[i][0]) <= 4.1 and abs(s[i][1]) <= 3.1 for i in pieds)
    assert not any(abs(x) < 3.9 and abs(y) < 2.9 for x, y, _ in s)


def test_un_toit_sans_plans_garde_sa_surface():
    """Moitié est hérissée de blocs d'un mètre à des hauteurs quelconques
    (±2 m) — assez larges pour passer la médiane 3×3, trop petits pour faire
    des pans : les pans ne couvrent pas 80 % du toit, la surface reste le
    repli. (Un bruit cellule à cellule ne suffirait pas : la médiane l'efface.)"""
    blocs = np.random.default_rng(0).uniform(-2, 2, size=(30, 30))
    def toit(x, y):
        if abs(x) > 7 or abs(y) > 5:
            return 0.0
        return 6.0 if x < 0 else 6.0 + blocs[int(y + 15), int(x + 15)]
    p, _ = _pans(toit, box(-7, -5, 7, 5))
    assert p is None


def test_le_volume_est_deterministe():
    emprise = affinity.rotate(box(-8, -5, 8, 5), 30, origin=(0, 0))
    assert _pans(_deux_pans_tourne, emprise)[0] == _pans(_deux_pans_tourne, emprise)[0]


def test_les_pans_reutilisent_la_segmentation():
    """Segmenter d'abord, pour juger le toit plat, puis passer la segmentation
    aux pans : le même volume qu'en segmentant dans pans_toit."""
    from vue3d.toits import segmenter_toit
    emprise = affinity.rotate(box(-8, -5, 8, 5), 30, origin=(0, 0))
    p, cel = _pans(_deux_pans_tourne, emprise)
    assert p is not None and pans_toit(emprise, cel, segmentation=segmenter_toit(cel)) == p


def _part_plate(fonction, emprise):
    from vue3d.pans import part_plate
    from vue3d.toits import TOITS_PLAT_ETENDUE_M, TOITS_PLAT_PENTE_DEG, segmenter_toit
    h, xs, ys = _grille(fonction)
    cel = cellules_du_toit(emprise, h, xs, ys, 3.0)
    _, etiquettes, plans = segmenter_toit(cel)
    return part_plate(etiquettes, plans, cel["valides"], cel["X"], cel["Y"],
                      TOITS_PLAT_PENTE_DEG, TOITS_PLAT_ETENDUE_M)


def test_part_plate_compte_la_terrasse_et_pas_le_versant():
    """Une terrasse à l'ouest, un versant à 31° à l'est : la moitié du toit
    est plate ; deux terrasses étagées, tout le toit."""
    emprise = box(-10, -6, 10, 6)
    dedans = lambda x, y: abs(x) <= 10 and abs(y) <= 6
    terrasse_et_versant = lambda x, y: (6.0 if x < 0 else 6.0 + 0.6 * x) if dedans(x, y) else 0.0
    assert 0.35 <= _part_plate(terrasse_et_versant, emprise) <= 0.65
    etagees = lambda x, y: (6.0 if x < 0 else 5.0) if dedans(x, y) else 0.0
    assert _part_plate(etagees, emprise) >= 0.95
    assert _part_plate(_deux_pans_tourne, affinity.rotate(box(-8, -5, 8, 5), 30, origin=(0, 0))) == 0


def test_un_ruban_de_cellules_ne_passe_pas_pour_plat():
    """Une annexe de 2,5 m de large : sans le bord, il reste deux cellules en
    travers, où la pente ne se lit pas. Son pan, horizontal ou non, ne compte
    pas ; à 5 m de large, il compte."""
    etroite = box(-8, -1.25, 8, 1.25)
    assert _part_plate(lambda x, y: 6.0 if etroite.contains(Point(x, y)) else 0.0, etroite) == 0
    large = box(-8, -2.5, 8, 2.5)
    assert _part_plate(lambda x, y: 6.0 if large.contains(Point(x, y)) else 0.0, large) == 1
