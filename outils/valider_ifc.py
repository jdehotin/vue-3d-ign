"""Valide un fichier IFC exporté par la page, avec ifcopenshell.

    pip install ifcopenshell pytest     # hors requirements.txt ; pytest sert aux règles EXPRESS
    python outils/valider_ifc.py vue3d-43.9116-5.2003.ifc

Ce qu'un logiciel de conception ferait du fichier, sans en avoir un :
- le schéma IFC 4, attributs et cardinalités, et les règles EXPRESS qu'il
  porte (`ifcopenshell.validate`, règles comprises) ;
- la géométrie de chaque élément, tessellée par le noyau d'ifcopenshell :
  un élément qui n'en rend aucune est une erreur ;
- le géoréférencement : un IfcMapConversion vers le CRS que l'export a écrit
  (Lambert-93 par défaut, CC ou UTM au choix), et l'emprise du modèle dans ce
  système et en altitude, à comparer à la scène ;
- le décompte des éléments par type, et des maillages fermés.

Sort en erreur s'il trouve un défaut de schéma ou de géométrie, après le bilan.
"""
import collections
import math
import sys

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.validate


def valider(chemin):
    modele = ifcopenshell.open(chemin)
    erreurs = []

    releve = ifcopenshell.validate.json_logger()
    ifcopenshell.validate.validate(modele, releve, express_rules=True)
    for s in releve.statements:
        erreurs.append(f"schéma : {s.get('message', s)}"[:300])

    print(f"schéma {modele.schema}, {len(list(modele))} entités")
    conversions = modele.by_type("IfcMapConversion")
    if len(conversions) != 1:
        erreurs.append(f"{len(conversions)} IfcMapConversion, une attendue")
    else:
        c = conversions[0]
        print(f"géoréférencement : {c.TargetCRS.Name} ({c.TargetCRS.Description}), "
              f"origine {c.Eastings:.0f} E, {c.Northings:.0f} N, {c.OrthogonalHeight:.0f} m")
        if not c.TargetCRS.Name.startswith("EPSG:"):
            erreurs.append(f"système {c.TargetCRS.Name}, un code EPSG attendu")
    # L'ancrage : le site à l'origine, que l'IfcMapConversion situe (Revit,
    # ArchiCAD, Bonsai), ou le site posé à ses coordonnées et une conversion
    # nulle (Trimble Connect et les visionneuses qui ignorent IfcMapConversion).
    # Le décalage ne doit jamais être porté deux fois — le modèle partirait à
    # 1 200 km —, ni par personne — il reviendrait à zéro.
    sites = modele.by_type("IfcSite")
    if not sites:
        erreurs.append("aucun IfcSite")
    elif conversions:
        site, c = sites[0], conversions[0]
        pose = [0.0, 0.0, 0.0]
        if site.ObjectPlacement and site.ObjectPlacement.is_a("IfcLocalPlacement"):
            point = site.ObjectPlacement.RelativePlacement.Location
            if point and point.Coordinates:
                pose = [float(v) for v in point.Coordinates]
        sur_site = any(abs(v) > 1e-6 for v in pose)
        conversion = any(abs(v) > 1e-6 for v in (c.Eastings, c.Northings, c.OrthogonalHeight))
        print(f"site : {site.Name}, placement {pose[0]:.0f} E, {pose[1]:.0f} N, "
              f"{pose[2]:.0f} m, réf. {site.RefLatitude} / {site.RefLongitude} "
              f"à {site.RefElevation:.0f} m — "
              + ("ancrage absolu (le site porte le décalage)" if sur_site else "origine locale"))
        if sur_site and conversion:
            erreurs.append("géoréférencement : le site et l'IfcMapConversion portent tous "
                           "deux le décalage")
        if not sur_site and not conversion:
            erreurs.append("géoréférencement : ni le site ni l'IfcMapConversion ne situe le modèle")
    contexte = modele.by_type("IfcGeometricRepresentationContext")[0]
    if contexte.TrueNorth:
        x, y = contexte.TrueNorth.DirectionRatios
        print(f"nord vrai : {math.degrees(math.atan2(x, y)):+.2f}° du nord de la grille")

    reglages = ifcopenshell.geom.settings()
    reglages.set("use-world-coords", True)
    produits = [p for p in modele.by_type("IfcProduct") if p.Representation]
    par_type = collections.Counter()
    sans_geometrie = []
    bornes = [math.inf] * 3 + [-math.inf] * 3
    for p in produits:
        try:
            forme = ifcopenshell.geom.create_shape(reglages, p)
        except RuntimeError as e:
            sans_geometrie.append(f"{p.is_a()} {p.Name} : {e}")
            continue
        v = forme.geometry.verts
        if not v:
            sans_geometrie.append(f"{p.is_a()} {p.Name} : aucun sommet")
            continue
        for k in range(3):
            bornes[k] = min(bornes[k], min(v[k::3]))
            bornes[k + 3] = max(bornes[k + 3], max(v[k::3]))
        par_type[p.ObjectType or (p.PredefinedType if hasattr(p, "PredefinedType") else p.is_a())] += 1
    erreurs += [f"géométrie : {s}" for s in sans_geometrie[:20]]
    fermes = modele.by_type("IfcTriangulatedFaceSet")
    print(f"éléments : {dict(par_type)}")
    print(f"maillages : {len(fermes)}, dont {sum(1 for f in fermes if f.Closed)} fermés ; "
          f"{sum(len(f.CoordIndex) for f in fermes)} triangles")
    if conversions and produits:
        c = conversions[0]
        print(f"emprise : {bornes[0] + c.Eastings:.1f} à {bornes[3] + c.Eastings:.1f} E, "
              f"{bornes[1] + c.Northings:.1f} à {bornes[4] + c.Northings:.1f} N, "
              f"{bornes[2] + c.OrthogonalHeight:.1f} à {bornes[5] + c.OrthogonalHeight:.1f} m")
    print("ERREURS :", "\n  " + "\n  ".join(erreurs) if erreurs else "aucune")
    return not erreurs


if __name__ == "__main__":
    sys.exit(0 if all(valider(c) for c in sys.argv[1:]) else 1)
