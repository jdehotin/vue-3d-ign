// Les tuiles que lisent les deux pages : les fonds de l'IGN, par le serveur, et
// les altitudes du RGE ALTI, à la Géoplateforme.

// Couches et zooms que le serveur accepte : tuiles.COUCHES et TUILES_ZOOM
// (vue3d/tuiles.py, 9 à 18).
export const FONDS = {
    ortho: (z, x, y) => `api/tuile/ortho/${z}/${x}/${y}`,
    // PLANIGNV2 : PNG seulement, publié jusqu'au zoom 19 comme l'orthophoto.
    plan: (z, x, y) => `api/tuile/plan/${z}/${x}/${y}`,
};

// Les tuiles natives du RGE ALTI (WMTS, pyramide WGS84G, 256 × 256
// flottants) : le WMS sort en gradins et limite à 40 requêtes par seconde.
// Un trou (−99 999 : la mer, l'étranger) est à traiter par l'appelant.
export const ALTI_URL = (niveau, ligne, colonne) =>
    'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0'
    + '&LAYER=ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES&STYLE=normal&FORMAT=image/x-bil;bits=32'
    + `&TILEMATRIXSET=WGS84G_6_14&TILEMATRIX=${niveau}&TILEROW=${ligne}&TILECOL=${colonne}`;
// Les niveaux de la pyramide WGS84G_6_14.
export const ALTI_NIVEAU_MIN = 6, ALTI_NIVEAU_MAX = 14;
