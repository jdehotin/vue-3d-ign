"""Zone de forme libre : un contour au lieu du carré centré sur le point.

La zone d'une scène est un carré centré sur le point (`scene.emprise`), ou, à la
demande, le contour d'un polygone (`?poly=…`, `scene.polygone_normalisee`). Le
polygone remplace l'emprise : les sources sont lues sur sa boîte englobante puis
découpées à son contour (`decouper_features`), la scène porte le contour —
`polygone` — pour que la vue masque le terrain au-delà, et les houppiers sont
gardés par leur sommet (scene.assembler). Rien en dehors du contour n'est donc
calculé, dessiné, ni exporté.

Le contour s'écrit `poly=lat,lon;lat,lon;…` dans l'URL, l'ordre des coordonnées
du reste de la page (`?lat=…&lon=…`) ; les points peuvent aussi être séparés par
des espaces ou des retours à la ligne. Les sommets sont arrondis à 6 décimales
(une dizaine de centimètres) : deux contours qui n'en diffèrent que par leurs
dernières décimales partagent leur scène, comme le point arrondi du cache.

Trois sommets au moins, et une aire non nulle : en deçà, ce n'est pas une
surface. Un contour dont un côté se croise (un « huit ») est refusé plutôt que
réparé — `shapely` en tirerait une surface que l'utilisateur n'a pas dessinée.
"""

import hashlib
import math

import numpy as np
import shapely
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon, mapping, shape

# Arrondi des sommets : 6 décimales, une dizaine de centimètres.
ARRONDI = 6
# Sommets d'un contour fermé : trois au moins, sans compter le dernier s'il
# répète le premier.
SOMMETS_MIN = 3
# Mètres d'un degré : la latitude partout, la longitude à la latitude du lieu.
M_PAR_DEGRE_LAT = 111320.0


def _coordonnees(valeur):
    """Un sommet (lat, lon) d'un couple « lat,lon » de texte."""
    morceaux = [m for m in valeur.replace(";", ",").split(",") if m.strip()]
    if len(morceaux) != 2:
        raise ValueError(f"couple lat,lon attendu, lu {valeur!r}")
    try:
        lat, lon = (float(m) for m in morceaux)
    except ValueError as exc:
        raise ValueError(f"coordonnées illisibles en {valeur!r}") from exc
    if not (math.isfinite(lat) and math.isfinite(lon)):
        raise ValueError(f"coordonnées non finies en {valeur!r}")
    return lat, lon


def analyser(valeur):
    """Sommets (lat, lon) lus dans `poly=…`, dans l'ordre reçu.

    `valeur` est le texte de l'URL, ou déjà une suite de couples (lat, lon).

    Raises:
        ValueError si la valeur est vide, ou si un couple est illisible.
    """
    if isinstance(valeur, (tuple, list)):
        return [(float(p[0]), float(p[1])) for p in valeur]
    morceaux = [m for m in str(valeur).replace(";", " ").replace("\n", " ").split() if m.strip()]
    if not morceaux:
        raise ValueError("contour vide")
    return [_coordonnees(m) for m in morceaux]


def _rectangle_remis_en_ordre(points):
    """Les quatre coins d'une boîte lus en zigzag (SO, SE, NO, NE) deviennent
    le tour de la boîte, sinon ils dessinent un « huit » que le contour refuse.

    C'est l'ordre d'un lecteur qui énumère « minLat/minLon, minLat/maxLon,
    maxLat/minLon, maxLat/maxLon » — celui de l'emprise d'un projet Connect
    selon l'appelant. Seuls les quatre coins exacts d'une boîte sont remis en
    ordre : l'intention est sans ambiguïté et la surface ne change pas. Tout
    autre contour croisé reste refusé.
    """
    if len(points) != 4:
        return points
    lats = sorted({p[0] for p in points})
    lons = sorted({p[1] for p in points})
    if len(lats) != 2 or len(lons) != 2 or len(set(points)) != 4:
        return points
    (s, n), (o, e) = lats, lons
    if _est_tour(points):
        return points
    return [(s, o), (s, e), (n, e), (n, o)]


def _est_tour(points):
    """Vrai si les quatre sommets se suivent le long d'un tour : deux côtés
    consécutifs ne sont jamais une diagonale."""
    return all(points[i][0] == points[(i + 1) % 4][0]
               or points[i][1] == points[(i + 1) % 4][1] for i in range(4))


class Polygone:
    """Contour fermé (lat, lon) : emprise, découpe et appartenance.

    Args:
        sommets: suite de (lat, lon), dans l'ordre du contour.
    Raises:
        ValueError si le contour a moins de trois sommets distincts, une aire
            nulle, ou un côté qui en croise un autre.
    """

    def __init__(self, sommets):
        points = []
        for lat, lon in sommets:
            p = (round(float(lat), ARRONDI), round(float(lon), ARRONDI))
            # Un sommet répété — le dernier ferme souvent le contour — ne
            # compte pas : il ferait une arête de longueur nulle.
            if not points or p != points[-1]:
                points.append(p)
        if len(points) >= 2 and points[0] == points[-1]:
            points.pop()
        if len(points) < SOMMETS_MIN:
            raise ValueError(f"un contour a au moins {SOMMETS_MIN} sommets, "
                             f"reçu {len(points)}")
        points = _rectangle_remis_en_ordre(points)
        self.sommets = tuple(points)
        lats = [p[0] for p in points]
        lons = [p[1] for p in points]
        self.sud, self.nord = min(lats), max(lats)
        self.ouest, self.est = min(lons), max(lons)
        # Projection locale en mètres, la même partout : latitude au mètre, et
        # longitude au cosinus de la latitude médiane (comme l'emprise du
        # serveur, qui a le même écart en degrés dans les deux sens).
        self._kx = M_PAR_DEGRE_LAT * math.cos(math.radians((self.sud + self.nord) / 2))
        self._ky = M_PAR_DEGRE_LAT
        # Aire par la formule du lacet sur les sommets projetés, décalés du
        # coin sud-ouest pour ne pas perdre de chiffres sur une longitude
        # française (0,5 · 10⁻⁶ de degré = 5 cm).
        xs = [(lon - self.ouest) * self._kx for _, lon in points]
        ys = [(lat - self.sud) * self._ky for lat, _ in points]
        self.aire_m2 = abs(sum(xs[i] * ys[(i + 1) % len(xs)] - xs[(i + 1) % len(xs)] * ys[i]
                               for i in range(len(xs)))) / 2
        if self.aire_m2 <= 0.0:
            raise ValueError("un contour d'aire nulle (sommets alignés)")
        self.cote_m = (self.nord - self.sud) * self._ky
        self.cote_max_m = max((self.nord - self.sud) * self._ky,
                              (self.est - self.ouest) * self._kx)
        self.texte = ";".join(f"{lat:.{ARRONDI}f},{lon:.{ARRONDI}f}" for lat, lon in points)
        self.cle = hashlib.sha1(self.texte.encode()).hexdigest()[:10]
        # Validé dès la lecture : un contour croisé, ou qui se touche, doit être
        # refusé tout de suite, pas à la première découpe.
        self._forme = Polygon([(lon, lat) for lat, lon in points])
        if not self._forme.is_valid:
            raise ValueError("contour croisé (côtés qui se coupent)")

    def __repr__(self):
        return f"Polygone({self.texte})"

    def __str__(self):
        return f"poly-{self.cle}"

    def __hash__(self):
        return hash(self.sommets)

    def __eq__(self, autre):
        return isinstance(autre, Polygone) and autre.sommets == self.sommets

    def anneau(self):
        """Contour [lon, lat] pour la scène, premier sommet non répété."""
        return [[lon, lat] for lat, lon in self.sommets]

    def forme(self, retrait_m=0.0):
        """Contour en `shapely`, éventuellement en retrait de `retrait_m`.

        Le retrait est mesuré en mètres, comme DECOUPE_RETRAIT_M des bâtiments :
        appliqué en degrés, il serait plus court d'est en ouest. Un retrait qui
        viderait le contour est ignoré — mieux vaut une découpe au ras qu'une
        scène vide.
        """
        return self._retrecie(retrait_m) if retrait_m else self._forme

    def _retrecie(self, retrait_m):
        kx, ky = self._kx, self._ky
        en_m = shapely.transform(self._forme, lambda c: c * [kx, ky])
        retrecie = en_m.buffer(-retrait_m)
        if retrecie.is_empty:
            return self._forme
        return shapely.transform(retrecie, lambda c: c / [kx, ky])

    def masque(self, lon, lat):
        """Le point (lon, lat) est-il dans le contour ? Lancer de rayon, sur le
        contour en degrés — le même test que la page (pointDansAnneau)."""
        dedans = False
        n = len(self.sommets)
        for i in range(n):
            lat_i, lon_i = self.sommets[i]
            lat_j, lon_j = self.sommets[i - 1]
            if (lat_i > lat) != (lat_j > lat):
                if lon < (lon_j - lon_i) * (lat - lat_i) / (lat_j - lat_i) + lon_i:
                    dedans = not dedans
        return dedans

    def masque_tableau(self, lons, lats):
        """Masque booléen (tableaux numpy) des points dans le contour.

        Le même lancer de rayon que `masque`, en tableau : le nuage LiDAR en
        compte des millions, un appel par point coûterait des secondes.
        """
        lons = np.asarray(lons, dtype=np.float64)
        lats = np.asarray(lats, dtype=np.float64)
        dedans = np.zeros(lons.shape, dtype=bool)
        n = len(self.sommets)
        for i in range(n):
            lat_i, lon_i = self.sommets[i]
            lat_j, lon_j = self.sommets[i - 1]
            if lat_i == lat_j:
                continue                        # arête horizontale : elle ne traverse pas
            traversant = (lat_i > lats) != (lat_j > lats)
            longueur = (lon_j - lon_i) * (lats - lat_i) / (lat_j - lat_i) + lon_i
            dedans ^= traversant & (lons < longueur)
        return dedans

    def decouper(self, geom, retrait_m=0.0):
        """Partie de `geom` (shapely, en degrés) dans le contour ; None si vide.

        Les polygones et leurs trous survivent, comme les lignes et les points
        d'un ouvrage à cheval sur le bord. L'altitude (Z) des lignes survit
        aussi — GEOS l'interpole au point de coupe : les murs et les ponts de
        la BD TOPO sont dessinés d'après elle (ouvrages.decouper_ligne), et un
        `force_2d` les ferait tous disparaître.
        """
        if geom is None or geom.is_empty:
            return None
        morceau = geom.intersection(self.forme(retrait_m))
        if morceau.is_empty or isinstance(morceau, GeometryCollection) and not morceau.geoms:
            return None
        if isinstance(morceau, (Polygon, MultiPolygon)) and morceau.area == 0:
            return None
        return morceau


def decouper_features(collection, polygone, retrait_m=0.0):
    """GeoJSON (FeatureCollection) découpé au contour, propriétés comprises.

    Renvoie une copie : les features hors du contour sont retirées, celles qui
    le chevauchent gardent leur partie intérieure. Les géométries illisibles
    sont laissées telles quelles — les toitures et la vue les ignorent déjà
    (batiments.decouper_batiments), et rien ici ne doit inventer une erreur de
    source.

    Args:
        collection: GeoJSON, ou None.
        polygone: Polygone, ou None pour ne rien découper.
        retrait_m: retrait du contour, en mètres (bâtiments).
    """
    if not collection or not polygone:
        return collection
    gardees = []
    for f in collection.get("features", []):
        geometrie = f.get("geometry")
        if not geometrie:
            continue
        try:
            morceau = polygone.decouper(shape(geometrie), retrait_m)
        except Exception:
            gardees.append(f)
            continue
        if morceau is None:
            continue
        gardees.append({**f, "geometry": mapping(morceau)})
    return {**collection, "features": gardees}


def decouper_sources(brut, polygone):
    """Sources d'une couche ramenées au contour, quand leur forme s'y prête.

    Ne touche qu'aux GeoJSON et à leurs dictionnaires : une réponse lue sur la
    boîte du contour — les bâtiments, l'eau, les routes de la scène, les
    ouvrages, les emprises, les parcelles DVF — est découpée au bord, et rien
    n'est alors dessiné au-delà. Les autres formes (le nuage LiDAR en tableaux,
    les lignes ponctuelles des bornes ou des DPE) sont rendues telles quelles :
    c'est à leur couche de les filtrer, avec le même `polygone`.
    """
    if not isinstance(brut, dict):
        return brut
    if brut.get("type") == "FeatureCollection":
        return decouper_features(brut, polygone)
    return {cle: (decouper_features(v, polygone)
                  if isinstance(v, dict) and v.get("type") == "FeatureCollection" else v)
            for cle, v in brut.items()}

