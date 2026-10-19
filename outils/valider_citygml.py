"""Valide la géométrie d'un fichier CityGML exporté par la page.

    python outils/valider_citygml.py vue3d-43.9116-5.2003.gml

Le schéma se vérifie à part, contre les XSD de CityGML 2.0 :

    citygml-tools validate vue3d-43.9116-5.2003.gml    # github.com/citygml4j/citygml-tools

Ici, les contrôles géométriques de val3dity, refaits en Python sans
dépendance (val3dity n'a pas de paquet Python publié) :
- anneaux : quatre points au moins, fermés, sans point répété ni
  croisement, d'aire non nulle ;
- polygones : plans à 1 cm près (la tolérance par défaut de val3dity), cours
  dans leur anneau extérieur et tournées en sens inverse ;
- surfaces des bâtiments : toits tournés vers le ciel, sols vers la terre,
  murs à moins de 60° de la verticale ;
- arbres et masses : surfaces fermées — chaque arête portée par deux
  polygones, en sens opposés — et tournées vers l'extérieur ;
- objets génériques (masse, pylône, mais aussi l'aplat d'un tronçon de route
  ou d'une étendue d'eau, ou le tube d'un conducteur) : orientation cohérente —
  aucune arête portée deux fois du même côté ; et, quand la surface est fermée,
  volume tourné vers l'extérieur. Une surface ouverte (aplat, tube) n'enferme
  rien : son volume signé ne veut rien dire et n'est pas jugé ;
- relief : triangles tournés vers le ciel ;
- gml:id uniques, et chaque coordonnée dans l'enveloppe du modèle.

Sort en erreur s'il trouve un défaut, après le bilan.
"""
import collections
import sys
import xml.etree.ElementTree as ET

GML = "{http://www.opengis.net/gml}"
CORE = "{http://www.opengis.net/citygml/2.0}"
BLDG = "{http://www.opengis.net/citygml/building/2.0}"
TOLERANCE_PLAN_M = 0.01
ERREURS_MONTREES = 20


def anneau(lr):
    v = [float(x) for x in lr.find(f"{GML}posList").text.split()]
    return [tuple(v[i:i + 3]) for i in range(0, len(v), 3)]


def newell(pts):
    """Aire vectorielle d'un anneau fermé (dernier point = premier)."""
    x = y = z = 0.0
    ox, oy, oz = pts[0]
    for (ax, ay, az), (bx, by, bz) in zip(pts, pts[1:]):
        ax, ay, az, bx, by, bz = ax - ox, ay - oy, az - oz, bx - ox, by - oy, bz - oz
        x += ay * bz - az * by
        y += az * bx - ax * bz
        z += ax * by - ay * bx
    return x / 2, y / 2, z / 2


def projeter(pts, normale):
    """Les points dans le plan de coordonnées où le polygone s'étale le plus."""
    k = max(range(3), key=lambda i: abs(normale[i]))
    a, b = [i for i in range(3) if i != k]
    return [(p[a], p[b]) for p in pts]


def se_croisent(p, q, r, s):
    def orient(a, b, c):
        v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        return 0 if abs(v) < 1e-12 else (1 if v > 0 else -1)
    return orient(p, q, r) * orient(p, q, s) < 0 and orient(r, s, p) * orient(r, s, q) < 0


def dedans(pt, poly):
    x, y = pt
    c = False
    for (ax, ay), (bx, by) in zip(poly, poly[1:]):
        if (ay > y) != (by > y) and x < ax + (y - ay) * (bx - ax) / (by - ay):
            c = not c
    return c


def controler_polygone(anneaux, erreurs, ou):
    """Contrôles d'un polygone ; rend sa normale unitaire, None s'il est invalide."""
    for pts in anneaux:
        if len(pts) < 4 or pts[0] != pts[-1]:
            erreurs.append(f"{ou} : anneau non fermé ou de moins de quatre points")
            return None
        if any(a == b for a, b in zip(pts, pts[1:])):
            erreurs.append(f"{ou} : point répété")
            return None
    a = newell(anneaux[0])
    aire = (a[0] ** 2 + a[1] ** 2 + a[2] ** 2) ** 0.5
    if aire < 1e-6:
        erreurs.append(f"{ou} : aire nulle")
        return None
    n = (a[0] / aire, a[1] / aire, a[2] / aire)
    ext = anneaux[0]
    cx, cy, cz = (sum(p[i] for p in ext[:-1]) / (len(ext) - 1) for i in range(3))
    ecart = max(abs((p[0] - cx) * n[0] + (p[1] - cy) * n[1] + (p[2] - cz) * n[2]) for r in anneaux for p in r)
    if ecart > TOLERANCE_PLAN_M:
        erreurs.append(f"{ou} : non plan, {ecart * 1000:.1f} mm")
    plans = [projeter(r, n) for r in anneaux]
    for pl in plans:
        if len(pl) > 4:
            segs = list(zip(pl, pl[1:]))
            for i in range(len(segs)):
                for j in range(i + 2, len(segs)):
                    if i == 0 and j == len(segs) - 1:
                        continue
                    if se_croisent(*segs[i], *segs[j]):
                        erreurs.append(f"{ou} : anneau qui se croise")
                        return n
    for r, pl in zip(anneaux[1:], plans[1:]):
        b = newell(r)
        if b[0] * a[0] + b[1] * a[1] + b[2] * a[2] >= 0:
            erreurs.append(f"{ou} : cour tournée comme l'extérieur")
        if not dedans(pl[0], plans[0]):
            erreurs.append(f"{ou} : cour hors de l'anneau extérieur")
    return n


def polygones(elem):
    for p in elem.iter(f"{GML}Polygon"):
        yield [anneau(p.find(f"{GML}exterior/{GML}LinearRing"))] + \
              [anneau(i.find(f"{GML}LinearRing")) for i in p.findall(f"{GML}interior")]


def valider(chemin):
    erreurs, ids = [], collections.Counter()
    objets, surfaces = collections.Counter(), collections.Counter()
    nb_polygones = nb_triangles = 0
    bornes = None
    mini = [float("inf")] * 3
    maxi = [float("-inf")] * 3
    srs = None
    for _, elem in ET.iterparse(chemin, events=("end",)):
        if elem.tag == f"{GML}Envelope" and bornes is None:
            srs = elem.get("srsName")
            bornes = ([float(v) for v in elem.find(f"{GML}lowerCorner").text.split()],
                      [float(v) for v in elem.find(f"{GML}upperCorner").text.split()])
        if elem.tag != f"{CORE}cityObjectMember":
            continue
        objet = elem[0]
        genre = objet.tag.split("}")[1]
        objets[genre] += 1
        for e in objet.iter():
            i = e.get(f"{GML}id")
            if i:
                ids[i] += 1
        ou = f"{genre} {objet.get(f'{GML}id')}"
        for pl in objet.iter(f"{GML}posList"):
            v = [float(x) for x in pl.text.split()]
            for k in range(3):
                mini[k] = min(mini[k], min(v[k::3]))
                maxi[k] = max(maxi[k], max(v[k::3]))
        if genre == "Building":
            # Celles du bâtiment et celles de ses parties (bldg:BuildingPart).
            for b in objet.iter(f"{BLDG}boundedBy"):
                s = b[0]
                classe = s.tag.split("}")[1]
                surfaces[classe] += 1
                for anneaux in polygones(s):
                    nb_polygones += 1
                    n = controler_polygone(anneaux, erreurs, f"{ou} {classe}")
                    if n is None:
                        continue
                    if classe == "RoofSurface" and n[2] <= 0 or classe == "GroundSurface" and n[2] >= -0.5 \
                            or classe == "WallSurface" and abs(n[2]) > 0.5 + 1e-6:
                        erreurs.append(f"{ou} : {classe} de normale verticale {n[2]:+.2f}")
        elif genre in ("SolitaryVegetationObject", "GenericCityObject"):
            aretes = collections.Counter()
            volume = 0.0
            for anneaux in polygones(objet):
                nb_polygones += 1
                controler_polygone(anneaux, erreurs, ou)
                for r in anneaux:
                    aretes.update(zip(r, r[1:]))
                    a, p = newell(r), r[0]
                    volume += (p[0] * a[0] + p[1] * a[1] + p[2] * a[2]) / 3
            ouvertes = sum(1 for (p, q), c in aretes.items() if c != 1 or aretes.get((q, p)) != 1)
            doubles = sum(1 for c in aretes.values() if c != 1)
            if doubles:
                erreurs.append(f"{ou} : {doubles} arête(s) portée(s) deux fois du même côté, orientation incohérente")
            if ouvertes:
                # Un arbre est un volume : ses facettes se referment. Un aplat
                # de route ou d'eau, un tube de conducteur, non.
                if genre == "SolitaryVegetationObject":
                    erreurs.append(f"{ou} : surface ouverte, {ouvertes} arête(s) sans vis-à-vis")
            elif volume <= 0:
                erreurs.append(f"{ou} : surface fermée tournée vers l'intérieur ({volume:.3f} m³)")
        elif genre == "ReliefFeature":
            for t in objet.iter(f"{GML}Triangle"):
                nb_triangles += 1
                pts = anneau(t.find(f"{GML}exterior/{GML}LinearRing"))
                if len(pts) != 4 or pts[0] != pts[-1]:
                    erreurs.append(f"{ou} : triangle mal formé")
                elif newell(pts)[2] <= 0:
                    erreurs.append(f"{ou} : triangle tourné vers le bas")
        elem.clear()

    erreurs += [f"gml:id en double : {i}" for i, c in ids.items() if c > 1]
    if bornes is None:
        erreurs.append("pas d'enveloppe")
    elif any(mini[k] < bornes[0][k] - 1e-6 or maxi[k] > bornes[1][k] + 1e-6 for k in range(3)):
        erreurs.append(f"coordonnées hors de l'enveloppe : {mini} à {maxi}")
    if not srs or "EPSG::2154" not in srs:
        erreurs.append(f"système de coordonnées inattendu : {srs}")
    print(f"système : {srs}")
    print(f"objets : {dict(objets)}")
    print(f"surfaces des bâtiments : {dict(surfaces)}")
    print(f"polygones : {nb_polygones}, triangles de relief : {nb_triangles}, gml:id : {len(ids)}")
    if bornes:
        print("emprise : " + ", ".join(f"{a:.1f} à {b:.1f}" for a, b in zip(mini, maxi)))
    print("ERREURS :", f"{len(erreurs)}\n  " + "\n  ".join(erreurs[:ERREURS_MONTREES]) if erreurs else "aucune")
    return not erreurs


if __name__ == "__main__":
    sys.exit(0 if all(valider(c) for c in sys.argv[1:]) else 1)
