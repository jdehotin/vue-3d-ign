"""Toits de roofer (3DBAG) : une couche à part, optionnelle, pour comparer.

roofer (https://github.com/3DBAG/roofer, GPLv3) reconstruit chaque bâtiment
en LoD2.2 à partir de son emprise et du nuage de points classé : il fait les
Pays-Bas entiers (3DBAG), et l'IGN s'en sert pour son démonstrateur
batiment3d.ign.fr. La page montre ses bâtiments à la place des siens, au même
endroit et aux mêmes couleurs : seule la géométrie change.

Mesuré le 21 novembre 2026 sur le LiDAR brut (points bâti, le plus haut de
chaque maille de 0,5 m, emprise rétrécie de 1 m), écart de forme médian :

                          toits en pans    toute la vue      roofer
    Gordes (1 000 m)      0,07 m (75)      0,39 m (490)      0,02-0,03 m
    Strasbourg (1 000 m)  0,18 m (251)     1,28 m (1 213)    0,07 m

roofer y reconstruit 97 à 100 % des emprises, quand les pans n'en ont que
15 à 20 %. D'où cette couche : voir l'écart, bâtiment par bâtiment.

Lecture : les dalles COPC du LiDAR HD sur l'emprise élargie de
ROOFER_TAMPON_M, par plages (vue3d/nuage.py), en ne gardant que le sol (2)
et le bâti (6, et 67 « divers bâti » ramené à 6, comme la chaîne de l'IGN
ignfab/roofer-with-ignf-datasets). Calcul : roofer sur les emprises de la
scène, découpées comme elle, dans un dossier temporaire. Seuls les toits et
les murs sont transmis, triangulés, en mètres locaux autour du centre de
l'emprise ; les hauteurs depuis le sol que roofer a retenu (rf_h_ground),
posé par la page sur le point bas du relief comme ses propres pans.

roofer tourne dans son image Docker (VUE3D_ROOFER=docker) ou en exécutable
local (VUE3D_ROOFER=/chemin/vers/roofer) ; sans VUE3D_ROOFER, la couche
n'existe pas et rien n'est chargé.
"""

import json
import logging
import math
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import Polygon

from .couches import lire_couche
from .geopf import en_parallele
from .nuage import COUCHE_DALLES, depuis_lambert93, lire_points, vers_lambert93

journal = logging.getLogger(__name__)

ROOFER_VERSION = 1
ROOFER_IMAGE = "3dgi/3dbag-pipeline-tools:2026.07.29"
ROOFER_DANS_IMAGE = "/opt/3dbag-pipeline/tools/bin/roofer"
# Le sol autour de l'emprise : roofer y lit l'altitude du terrain
# (--h-terrain-strategy buffer_user). 10 m, comme la chaîne de l'IGN.
ROOFER_TAMPON_M = 10
# Au-delà, le nuage ne tient plus en mémoire : 22,6 millions de points pour
# 1 000 m à Gordes (bâti et sol : 11,7 millions à Strasbourg), et une zone de
# 2 000 m en lirait quatre fois plus.
ROOFER_ZONE_MAX_M = 1000
# 667 bâtiments en 15 s à Gordes, 1 373 en moins d'une minute à Strasbourg,
# image amd64 émulée sur un Mac M : large.
ROOFER_DELAI_S = 600
CLASSE_SOL, CLASSE_BATI, CLASSE_DIVERS_BATI = 2, 6, 67


class RooferIndisponible(Exception):
    """Le nuage n'a pas pu être lu, ou roofer n'a pas abouti : rien n'est écrit."""


class RooferDesactive(Exception):
    """Service lancé sans VUE3D_ROOFER."""


def lecteur(mode=None):
    """Le Roofer de VUE3D_ROOFER (« docker » ou le chemin d'un exécutable),
    ou None sans lui."""
    mode = (os.environ.get("VUE3D_ROOFER", "") if mode is None else mode).strip()
    if not mode or mode == "aucun":
        return None
    return Roofer(mode)


class Roofer:
    """La lecture du nuage (`nuage`, la source de la couche) et le lancement
    de roofer (`lancer`), injectables pour les tests."""

    def __init__(self, mode, image=ROOFER_IMAGE, executer=subprocess.run):
        self.mode = mode
        self.image = image
        self._executer = executer

    def __call__(self, west, south, east, north):
        return self.nuage(west, south, east, north)

    def nuage(self, west, south, east, north, lire=None):
        """Points sol et bâti du LiDAR HD sur l'emprise élargie, en Lambert-93 :
        dict(x, y, z, c), {'trop_grande': True} au-delà de ROOFER_ZONE_MAX_M,
        ou None si aucune dalle ne la couvre — un fait.

        Raises:
            requests.RequestException si une dalle n'a pu être lue.
        """
        if (north - south) * 111320 > ROOFER_ZONE_MAX_M + 1:
            return {"trop_grande": True}
        lon, lat = [west, east, east, west], [south, south, north, north]
        xs, ys = vers_lambert93(lon, lat)
        x0, y0 = float(min(xs)) - ROOFER_TAMPON_M, float(min(ys)) - ROOFER_TAMPON_M
        x1, y1 = float(max(xs)) + ROOFER_TAMPON_M, float(max(ys)) + ROOFER_TAMPON_M
        urls = sorted({(f.get("properties") or {}).get("url_npl")
                       for f in lire_couche(COUCHE_DALLES, west, south, east, north)["features"]}
                      - {None})
        if not urls:
            return None
        args = {"lire": lire} if lire else {}
        lus = en_parallele(*(lambda u=u: lire_points(u, x0, y0, x1, y1, **args)[0] for u in urls))
        morceaux = []
        for x, y, z, c in lus:
            garde = (c == CLASSE_SOL) | (c == CLASSE_BATI) | (c == CLASSE_DIVERS_BATI)
            morceaux.append((x[garde], y[garde], z[garde],
                             np.where(c[garde] == CLASSE_DIVERS_BATI, CLASSE_BATI, c[garde])))
        x, y, z, c = (np.concatenate([m[k] for m in morceaux]) for k in range(4))
        return {"x": x, "y": y, "z": z, "c": c.astype(np.uint8)}

    def commande(self, dossier, jobs=None):
        """La ligne de roofer sur les fichiers de `dossier` (lidar.laz,
        batiments.geojson), sa sortie dans `dossier`/sortie."""
        jobs = jobs or os.cpu_count() or 4
        options = ["-j", str(jobs), "--srs", "EPSG:2154", "--id-attribute", "id",
                   "--h-terrain-strategy", "buffer_user",
                   "--h-terrain-attribute", "altitude_minimale_sol",
                   "--h-roof-attribute", "altitude_maximale_toit"]
        if self.mode == "docker":
            # Sans réseau : roofer n'a rien à lire ailleurs que dans le dossier.
            docker = shutil.which("docker") or "/usr/local/bin/docker"
            return [docker, "run", "--rm", "--platform", "linux/amd64", "--network", "none",
                    "-v", f"{dossier}:/data", self.image, ROOFER_DANS_IMAGE, *options,
                    "/data/lidar.laz", "/data/batiments.geojson", "/data/sortie"]
        return [self.mode, *options, f"{dossier}/lidar.laz", f"{dossier}/batiments.geojson",
                f"{dossier}/sortie"]

    def lancer(self, dossier):
        """roofer sur `dossier` ; le texte de sa sortie CityJSONSeq.

        Raises:
            RooferIndisponible s'il échoue, dépasse ROOFER_DELAI_S ou n'écrit rien.
        """
        try:
            fini = self._executer(self.commande(dossier), capture_output=True, text=True,
                                  timeout=ROOFER_DELAI_S)
        except (OSError, subprocess.SubprocessError) as exc:
            raise RooferIndisponible(f"roofer n'a pas pu être lancé : {exc}") from exc
        if fini.returncode != 0:
            raise RooferIndisponible(f"roofer a échoué (code {fini.returncode}) : "
                                     f"{(fini.stderr or fini.stdout or '')[-300:]}")
        sorties = sorted(Path(dossier, "sortie").glob("*.city.jsonl"))
        if not sorties:
            raise RooferIndisponible("roofer n'a rien écrit")
        return "".join(s.read_text() for s in sorties)


def _parties(geometrie):
    """Les polygones (anneaux en lon/lat) d'un Polygon ou d'un MultiPolygon."""
    if not geometrie:
        return []
    if geometrie["type"] == "Polygon":
        return [geometrie["coordinates"]]
    if geometrie["type"] == "MultiPolygon":
        return geometrie["coordinates"]
    return []


def emprises_l93(features, nuage):
    """Le GeoJSON des emprises pour roofer, en Lambert-93, une entité par
    polygone (id « cleabs » ou « cleabs~k ») ; et, par id, l'anneau extérieur
    en lon/lat et les propriétés BD TOPO.

    Les altitudes de repli (sol, toit) manquent à beaucoup d'emprises
    (Strasbourg : 1 123 toits sur 1 373) : elles sont tirées du nuage, comme
    set_building_attributes.sh dans la chaîne de l'IGN. roofer ne s'en sert
    que si le nuage ne lui dit rien.
    """
    x, y, z, c = nuage["x"], nuage["y"], nuage["z"], nuage["c"]
    sol, bati = c == CLASSE_SOL, c == CLASSE_BATI
    entites, parties = [], {}
    for f in features:
        p = f.get("properties") or {}
        cle = p.get("cleabs")
        polys = _parties(f.get("geometry"))
        for k, anneaux in enumerate(polys):
            if not anneaux or len(anneaux[0]) < 4:
                continue
            ident = cle if len(polys) == 1 else f"{cle}~{k}"
            l93 = []
            for anneau in anneaux:
                a = np.asarray(anneau, dtype=np.float64)[:, :2]
                ax, ay = vers_lambert93(a[:, 0], a[:, 1])
                l93.append(np.column_stack([ax, ay]).round(3).tolist())
            asol, atoit = p.get("altitude_minimale_sol"), p.get("altitude_maximale_toit")
            if asol is None or atoit is None:
                e = np.asarray(l93[0])
                dans = ((x > e[:, 0].min() - 5) & (x < e[:, 0].max() + 5)
                        & (y > e[:, 1].min() - 5) & (y < e[:, 1].max() + 5))
                if asol is None and (dans & sol).any():
                    asol = float(z[dans & sol].min())
                if atoit is None and (dans & bati).any():
                    atoit = float(z[dans & bati].max())
            if asol is None or atoit is None:
                continue
            entites.append({"type": "Feature",
                            "geometry": {"type": "Polygon", "coordinates": l93},
                            "properties": {"id": ident, "altitude_minimale_sol": asol,
                                           "altitude_maximale_toit": atoit}})
            parties[ident] = {"cleabs": cle, "anneau": [[round(v[0], 7), round(v[1], 7)]
                                                       for v in anneaux[0]]}
    return {"type": "FeatureCollection", "name": "batiments", "features": entites}, parties


def trianguler(anneaux):
    """Triangles (i, j, k) d'une face plane, anneaux d'index dans `sommets`,
    orientés comme elle (normale de Newell) ; [] pour une face dégénérée.

    Args:
        anneaux: (sommets, [anneau extérieur, trous…]) — sommets (n, 3).
    """
    sommets, bords = anneaux
    ext = sommets[bords[0]]
    q = np.roll(ext, -1, axis=0)
    n = np.array([np.sum((ext[:, 1] - q[:, 1]) * (ext[:, 2] + q[:, 2])),
                  np.sum((ext[:, 2] - q[:, 2]) * (ext[:, 0] + q[:, 0])),
                  np.sum((ext[:, 0] - q[:, 0]) * (ext[:, 1] + q[:, 1]))])
    if not np.any(n):
        return []
    # Projetée sur le plan qui la voit le mieux : on retire l'axe dominant de
    # sa normale. La triangulation contrainte ne crée aucun sommet, chaque
    # sommet de triangle se retrouve donc par ses coordonnées.
    axes = [a for a in range(3) if a != int(np.argmax(np.abs(n)))]
    index = {}
    for b in bords:
        for i in b:
            index[tuple(np.round(sommets[i][axes], 6))] = i
    try:
        poly = Polygon(sommets[bords[0]][:, axes], [sommets[b][:, axes] for b in bords[1:]])
        if not poly.is_valid or poly.area < 1e-6:
            return []
        tris = shapely.constrained_delaunay_triangles(poly)
    except (ValueError, shapely.errors.GEOSException):
        return []
    out = []
    for t in shapely.get_parts(tris):
        coins = [index.get(tuple(np.round(xy, 6))) for xy in np.asarray(t.exterior.coords)[:3]]
        if None in coins or len(set(coins)) < 3:
            continue
        a, b, c = (sommets[i] for i in coins)
        if np.dot(np.cross(b - a, c - a), n) < 0:
            coins = [coins[0], coins[2], coins[1]]
        out.append(coins)
    return out


def lire_cityjsonseq(texte):
    """Par id d'emprise : sommets (n, 3) en Lambert-93, faces LoD2.2 avec
    leur type sémantique, et les attributs rf_* de roofer."""
    lignes = [ligne for ligne in texte.splitlines() if ligne.strip()]
    tr = json.loads(lignes[0])["transform"]
    echelle, translation = np.asarray(tr["scale"]), np.asarray(tr["translate"])
    batiments = {}
    for ligne in lignes[1:]:
        o = json.loads(ligne)
        if "CityObjects" not in o:
            continue
        sommets = np.asarray(o.get("vertices") or [[0, 0, 0]], dtype=np.float64) * echelle + translation
        objets = o["CityObjects"].values()
        batiment = next((b for b in objets if b["type"] == "Building"), None)
        if batiment is None:
            continue
        att = batiment.get("attributes") or {}
        faces = []
        for partie in objets:
            if partie["type"] != "BuildingPart":
                continue
            for g in partie.get("geometry") or []:
                if str(g.get("lod")) != "2.2" or g["type"] != "Solid":
                    continue
                surfaces = (g.get("semantics") or {}).get("surfaces") or []
                valeurs = (g.get("semantics") or {}).get("values") or [[] for _ in g["boundaries"]]
                for coque, sem in zip(g["boundaries"], valeurs):
                    for face, s in zip(coque, sem or [None] * len(coque)):
                        genre = surfaces[s]["type"] if s is not None and s < len(surfaces) else "WallSurface"
                        faces.append((genre, face))
        batiments[att.get("id")] = {"sommets": sommets, "faces": faces, "attributs": att}
    return batiments


def roofer_pour_emprise(west, south, east, north, nuage, scene, lancer):
    """La couche : les bâtiments de la scène reconstruits par roofer.

    Args:
        nuage: de `Roofer.nuage` ; None hors couverture LiDAR HD.
        scene: la scène du point, dont seuls les bâtiments sont lus.
        lancer: (dossier) -> texte CityJSONSeq (`Roofer.lancer`).

    Returns:
        None hors couverture ; {'trop_grande': True, 'zone_max_m'} au-delà de
        ROOFER_ZONE_MAX_M ; sinon dict(version, centre, batiments, sans_lod22),
        chaque bâtiment : cleabs, anneau (lon/lat), v (x, y, h : mètres locaux
        vers l'est et le nord, hauteur au-dessus de rf_h_ground), toit et murs
        (index des triangles), et ce que roofer dit de lui.

    Raises:
        RooferIndisponible si roofer n'a pas abouti.
    """
    if nuage is None:
        return None
    if nuage.get("trop_grande"):
        return {"version": ROOFER_VERSION, "trop_grande": True, "zone_max_m": ROOFER_ZONE_MAX_M}
    features = ((scene.get("batiments") or {}).get("features")) or []
    lon0, lat0 = (west + east) / 2, (south + north) / 2
    m_lon = 111320 * math.cos(math.radians(lat0))
    geojson, parties = emprises_l93(features, nuage)
    if not geojson["features"]:
        return {"version": ROOFER_VERSION, "centre": [lon0, lat0], "batiments": [], "sans_lod22": 0}

    import laspy
    with tempfile.TemporaryDirectory(prefix="vue3d-roofer-") as dossier:
        entete = laspy.LasHeader(point_format=6, version="1.4")
        entete.offsets = [math.floor(float(nuage["x"].min())), math.floor(float(nuage["y"].min())), 0.0]
        entete.scales = [0.01, 0.01, 0.01]
        las = laspy.LasData(entete)
        las.x, las.y, las.z, las.classification = nuage["x"], nuage["y"], nuage["z"], nuage["c"]
        las.write(os.path.join(dossier, "lidar.laz"))
        with open(os.path.join(dossier, "batiments.geojson"), "w") as f:
            json.dump(geojson, f)
        texte = lancer(dossier)
    try:
        lus = lire_cityjsonseq(texte)
    except (ValueError, KeyError, IndexError) as exc:
        raise RooferIndisponible(f"sortie de roofer illisible : {exc}") from exc

    batiments, sans = [], 0
    for ident, partie in parties.items():
        b = lus.get(ident)
        if not b or not b["faces"]:
            sans += 1
            continue
        att = b["attributs"]
        sol = att.get("rf_h_ground")
        s = b["sommets"]
        if sol is None:
            sol = float(s[:, 2].min())
        lon, lat = depuis_lambert93(s[:, 0], s[:, 1])
        locaux = np.column_stack([(lon - lon0) * m_lon, (lat - lat0) * 111320, s[:, 2] - sol])
        toit, murs = [], []
        for genre, face in b["faces"]:
            if genre == "GroundSurface":
                continue          # le plancher, jamais vu
            tris = trianguler((locaux, face))
            (toit if genre == "RoofSurface" else murs).extend(tris)
        if not toit:
            sans += 1
            continue
        # Les seuls sommets servis, renumérotés.
        utiles = sorted({i for t in toit + murs for i in t})
        renum = {i: k for k, i in enumerate(utiles)}
        rmse = att.get("rf_rmse_lod22")
        batiments.append({
            "cleabs": partie["cleabs"], "anneau": partie["anneau"],
            "v": [round(float(c), 2) for i in utiles for c in locaux[i]],
            "toit": [renum[i] for t in toit for i in t],
            "murs": [renum[i] for t in murs for i in t],
            "type": att.get("rf_roof_type"), "plans": att.get("rf_roof_planes"),
            "rmse": round(float(rmse), 2) if rmse is not None else None,
            "valide": att.get("rf_val3dity_lod22") == "[]",
        })
    journal.info("roofer : %d bâtiment(s) en LoD2.2, %d sans", len(batiments), sans)
    return {"version": ROOFER_VERSION, "centre": [lon0, lat0], "batiments": batiments,
            "sans_lod22": sans}
