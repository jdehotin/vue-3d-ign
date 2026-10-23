// La projection locale en mètres autour du point, les points cardinaux, et
// l'emprise chargée.

import { LAT0, LON0, CENTER, ZONE } from './point.js';
import { ARTEFACT } from './chargement.js';

// Équirectangulaire centrée sur le point : à cette échelle (quelques
// centaines de mètres) la distorsion est négligeable, et ça évite d'embarquer
// une bibliothèque de projection.
export const M_PAR_DEGRE_LAT = 111320;
export const M_PAR_DEGRE_LON = 111320 * Math.cos(CENTER[1] * Math.PI / 180);
export const toLocal = (lon, lat) => [
    (lon - CENTER[0]) * M_PAR_DEGRE_LON,
    (lat - CENTER[1]) * M_PAR_DEGRE_LAT,
];
// Réciproque, nécessaire pour échantillonner le relief sous un vertex du sol.
export const toLonLat = (x, y) => [
    CENTER[0] + x / M_PAR_DEGRE_LON,
    CENTER[1] + y / M_PAR_DEGRE_LAT,
];
// Les huit directions, du nord dans le sens des aiguilles d'une montre : le
// cap du drone, l'azimut du soleil.
export const POINTS_CARDINAUX = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];

// Emprise chargée autour du point : celle de la scène une fois arrivée, sinon
// la règle du serveur pour la zone (la moitié du côté, en degrés de latitude,
// dans les deux sens : plus étroite d'est en ouest). Hors d'elle,
// ni bâtiments, ni orthophoto, ni végétation. « Ma position » proposait de
// recentrer au-delà de 500 m seulement : entre 130 et 500 m du point, le
// repère flottait sur le relief nu sans que rien ne le dise.
export const DEMI_EMPRISE_DEG = ZONE / 2 / 111320;

/** Emprise chargée, [ouest, sud, est, nord] en degrés. */
export function emprise() {
    return (ARTEFACT && ARTEFACT.bbox) || [LON0 - DEMI_EMPRISE_DEG, LAT0 - DEMI_EMPRISE_DEG,
                                           LON0 + DEMI_EMPRISE_DEG, LAT0 + DEMI_EMPRISE_DEG];
}

/** Distance en mètres d'un point à l'emprise chargée ; 0 à l'intérieur. */
export function distanceAEmprise(lon, lat) {
    const [o, s, e, n] = emprise();
    return Math.hypot(Math.max(o - lon, 0, lon - e) * M_PAR_DEGRE_LON,
                      Math.max(s - lat, 0, lat - n) * M_PAR_DEGRE_LAT);
}
