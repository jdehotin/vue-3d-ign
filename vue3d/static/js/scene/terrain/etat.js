// L'état du relief, que tout le reste lit : terrain, anneau, exagération,
// origine des altitudes ; la pose d'un objet sur le sol.

import { CENTER } from '../socle/point.js';
import { DEMI_EMPRISE_DEG } from '../socle/projection.js';

// Le terrain arrive de façon asynchrone, après les bâtiments le plus souvent :
// bâtiments et marqueurs sont donc reconstruits à son arrivée, et à chaque
// changement d'exagération.
export let terrain = null;      // { alt, min, max, mesh, hauteurs }
export let altitudeRef = 0;     // altitude du centre du site — l'origine des Y de la scène
export let relief = true;
export let exagVert = 1;
export let anneauRelief = null; // { mesh, hauteurs, min, bornes, alt }, au-delà de l'emprise
// Le relief a répondu, ou a fini d'échouer : les couches peuvent être posées.
export let reliefRegle = false;
// L'horizon demandé (son bouton) ; il n'est montré qu'au-delà d'un recul.
export let horizonActif = true;

export function poserTerrain(t) { terrain = t; }
export function poserAltitudeRef(a) { altitudeRef = a; }
export function poserAnneauRelief(a) { anneauRelief = a; }
export function marquerReliefRegle() { reliefRegle = true; }
/** Le relief affiché ou mis à plat, et son exagération verticale. */
export function reglerRelief(actif, exag = exagVert) { relief = actif; exagVert = exag; }
export function basculerHorizonActif() { horizonActif = !horizonActif; }

// Emprise du relief : la même que celle de l'ortho, pour que la texture
// recouvre entièrement le maillage et que les UV restent dans [0,1].
//
// Autour du point de l'URL tant que la scène n'est pas arrivée ; ensuite, son
// emprise exacte (chargerRelief). Le serveur centre la scène sur le point
// arrondi à 4 décimales : pour un point saisi à 6 décimales, les deux emprises
// différaient de quelques mètres, et les sommets des bords sud et est, hors de
// la grille d'altitude, retombaient à l'altitude du centre — un mur en
// équerre sur deux côtés de la scène (constaté : 4 m en latitude, 1,5 m en
// longitude).
export let BORNES = {
    o: CENTER[0] - DEMI_EMPRISE_DEG, e: CENTER[0] + DEMI_EMPRISE_DEG,
    s: CENTER[1] - DEMI_EMPRISE_DEG, n: CENTER[1] + DEMI_EMPRISE_DEG,
};
export function poserBornes(b) { BORNES = b; }

/**
 * Y de la scène pour un point posé sur le terrain.
 *
 * L'exagération ne s'applique qu'aux ALTITUDES. Un objet posé dessus reçoit
 * l'élévation ainsi calculée, mais garde ses dimensions réelles : un facteur 3
 * doit creuser la vallée, pas étirer les maisons.
 */
export function ySol(lon, lat) {
    if (!relief || !terrain) return 0;
    const a = terrain.alt(lon, lat);
    return a == null ? 0 : (a - altitudeRef) * exagVert;
}

// Enfoncement des objets sous le terrain. Le maillage est trianglé alors que
// l'échantillonnage est bilinéaire : sans cette marge, un mur se décolle du sol
// sur les arêtes.
//
// Constante, et non proportionnelle à l'exagération : les volumes ne sont pas
// dilatés, et 0,5 × 5 enfoncerait une maison de 4,8 m de plus de la moitié de
// sa hauteur. Le minimum pris sur l'emprise couvre déjà l'essentiel de l'écart ;
// il ne reste que la courbure du terrain à l'intérieur d'une maille.
export const ENFONCEMENT = 0.5;

/**
 * Y de la base d'un bâtiment : le point le PLUS BAS du terrain sous son
 * emprise, enfoncé de la marge ci-dessus.
 *
 * Le minimum, et non le centre : un bâtiment à cheval sur une rupture de pente
 * flotterait de son côté aval.
 *
 * On ne soustrait JAMAIS deux altitudes de sources différentes. Le terrain sert
 * à PLACER les bâtiments ; leur hauteur vient de la BD TOPO seule, où gouttière
 * et sol partagent le même géoïde. Mélanger les deux verserait l'écart entre
 * référentiels dans la hauteur des murs.
 */
export function baseBatiment(anneau) {
    if (!relief || !terrain) return 0;
    let min = Infinity;
    for (const [lon, lat] of anneau) {
        const a = terrain.alt(lon, lat);
        if (a != null) min = Math.min(min, a);
    }
    if (min === Infinity) return 0;
    return (min - altitudeRef) * exagVert - ENFONCEMENT;
}
