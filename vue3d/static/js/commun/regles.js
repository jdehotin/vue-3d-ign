// Les règles communes aux deux pages, pour qu'un bâtiment ou un arbre y ait la
// même forme.

// Repli quand ni le LiDAR ni la BD TOPO ne sont crédibles : 3 m par étage
// BD TOPO connu, un étage sinon. Un ordre de grandeur, affiché comme tel.
export const HAUTEUR_PAR_ETAGE = 3;
// Dénivelé maximal d'un toit, en fraction de sa largeur : environ 50°, la règle
// que le serveur applique au LiDAR (TOITS_PENTE_MAX dans vue3d/toits.py). La
// BD TOPO annonçait un toit à 67° au Mont-Saint-Michel.
export const PENTE_TOIT_MAX = 0.6;
// En deçà, c'est un buisson ou une haie : un tronc n'aurait pas de sens.
export const HAUTEUR_MIN_TRONC = 3;

/** Aléa déterministe d'une position : un arbre garde sa forme et sa teinte d'une vue à l'autre. */
export function alea(x, y) {
    const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return v - Math.floor(v);
}
