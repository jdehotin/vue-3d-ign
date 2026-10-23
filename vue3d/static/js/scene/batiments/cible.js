// Le bâtiment visé par le point.

import { CENTER } from '../socle/point.js';
import { toLocal } from '../socle/projection.js';
import { groupeBatiments, CIBLE } from './etat.js';
import { pointDansAnneau } from '../geometrie/polygones.js';
import { polygonesDe } from './toits.js';
import { afficherFicheBatiment } from '../interface/fiche.js';

// Celui qui contient le point ; sinon le plus proche, un point saisi à la main
// ou pris au GPS tombant souvent dans un jardin, une cour ou la rue. Au-delà
// de RAYON_VISE, le plus proche n'est plus « le » bâtiment du point : la
// fiche reste vide et le masque solaire se mesure depuis le sol.
//
// La distance est prise au contour, non au centre de la boîte englobante : un
// grand bâtiment en L voisin l'emportait sur la maison devant laquelle on se
// tient.
const RAYON_VISE = 25;

/**
 * Distance du point à une emprise, en mètres ; 0 s'il est dedans. Dans une
 * cour intérieure, il n'est pas dans le bâtiment : la distance est celle du
 * bord de la cour.
 */
function distanceAuPoint(anneau, trous = []) {
    const auBord = contour => {
        const pts = contour.map(([lo, la]) => toLocal(lo, la));
        let d = Infinity;
        for (let i = 0; i < pts.length - 1; i++) {
            const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
            const lx = bx - ax, ly = by - ay, l2 = lx * lx + ly * ly;
            const t = l2 > 0 ? Math.min(Math.max(-(ax * lx + ay * ly) / l2, 0), 1) : 0;
            d = Math.min(d, Math.hypot(ax + t * lx, ay + t * ly));
        }
        return d;
    };
    if (!pointDansAnneau(CENTER[0], CENTER[1], anneau)) return auBord(anneau);
    const cour = trous.find(t => pointDansAnneau(CENTER[0], CENTER[1], t));
    return cour ? auBord(cour) : 0;
}

export function trouverCible(features) {
    let meilleur = null;
    for (const f of features) {
        for (const { anneau, trous } of polygonesDe(f.geometry)) {
            if (!anneau || anneau.length < 4) continue;
            const distance = distanceAuPoint(anneau, trous);
            if (!meilleur || distance < meilleur.distance) {
                meilleur = { anneau, p: f.properties || {}, distance };
            }
        }
    }
    return meilleur && meilleur.distance <= RAYON_VISE ? meilleur : null;
}

/** Ouvre la fiche du bâtiment visé et dit dans la note comment il a été choisi. */
export function afficherCible() {
    const noteB = document.getElementById('note-batiment');
    if (!CIBLE) {
        noteB.textContent = `Aucun bâtiment à moins de ${RAYON_VISE} m du point. `
            + 'Cliquer un bâtiment pour afficher sa fiche BD TOPO.';
        return;
    }
    // Le bâtiment visé peut être remplacé par ses parties OSM : sa fiche
    // s'ouvre alors depuis l'une d'elles, qui porte les mêmes propriétés.
    const mesh = groupeBatiments.children.find(o => o.userData.anneau === CIBLE.anneau)
        || groupeBatiments.children.find(o => o.userData.monument
               && o.userData.p && CIBLE.p && o.userData.p.cleabs === CIBLE.p.cleabs);
    if (mesh) afficherFicheBatiment(mesh.userData);
    noteB.textContent = (CIBLE.distance === 0
        ? 'Le bâtiment qui contient le point, en orange.'
        : `Le point n'est dans aucune emprise : le bâtiment le plus proche, `
          + `à ${CIBLE.distance.toFixed(1).replace('.', ',')} m, est en orange.`)
        + ' Cliquer un autre bâtiment pour sa fiche.';
}
