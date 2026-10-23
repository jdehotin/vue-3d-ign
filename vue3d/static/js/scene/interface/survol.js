// Les cibles du survol et du clic : bâtiments, végétation, et ce que chaque
// couche y inscrit.

import { meshes } from '../batiments/etat.js';
import { groupeVegetation } from '../vegetation/etat.js';

// Cibles du raycaster de survol, recalculées à chaque reconstruction plutôt
// qu'à chaque mouvement de souris : sur une scène dense, concaténer deux
// tableaux de plusieurs centaines d'entrées à chaque pointermove crée un
// déchet permanent que le ramasse-miettes finit par faire payer en saccades.
export const ciblesSurvol = [];
// Les cibles de chaque couche, déclarées par elle (ajouterCiblesSurvol), dans
// l'ordre de la page : une fonction qui les rend, vide si la couche est masquée.
const sourcesSurvol = [];
/** `source()` rend les objets de la couche qui répondent au survol, [] si elle est masquée. */
export function ajouterCiblesSurvol(source) {
    sourcesSurvol.push(source);
}
/**
 * Reconstruit les cibles du raycaster : volumes bâtis, végétation, puis les
 * couches.
 *
 * Appelée après chaque reconstruction.
 */
export function majCiblesSurvol() {
    ciblesSurvol.length = 0;
    // Les volumes restent toujours là : ils ne répondent pas au survol, mais ils
    // font écran aux repères qui passent derrière eux.
    ciblesSurvol.push(...meshes);
    // Un calque masqué ne doit pas répondre au survol : three.js ne teste pas la
    // visibilité au lancer de rayon, une pastille cachée resterait sensible.
    // Même règle pour la végétation : masquée, elle ne doit pas rester sensible.
    // Les troncs sont exclus : ils ne portent pas d'infobulle.
    if (groupeVegetation.visible) ciblesSurvol.push(
        ...groupeVegetation.children.filter(o => o.userData.vegetation));
    for (const source of sourcesSurvol) ciblesSurvol.push(...source());
}
