// Les limitations de vitesse des carrés.

import { VITESSES_VERSION } from '../carres/grille.js';

// Par tronçon BD TOPO et dans chacun de ses sens (/api/vitesses) : celle
// d'OpenStreetMap, sinon la règle générale du code de la route, marquée
// comme estimée. Gardées par identifiant de tronçon, d'où que vienne le carré.
export const limites = new Map();             // cleabs → { plus, moins, osmPlus, osmMoins }
export const VIT_PARALLELE = 2;               // les deux places d'Overpass du serveur
export let vitEnVol = 0;

export async function chargerVitesses(c) {
    const g = c.vit;
    g.etat = 'charge';
    vitEnVol++;
    try {
        const reponse = await fetch(`api/vitesses?i=${c.i}&j=${c.j}&v=${VITESSES_VERSION}`);
        if (reponse.status === 422) { g.etat = 'hors'; return; }
        if (!reponse.ok) {
            g.etat = 'erreur';
            g.reessai = performance.now() + (Number(reponse.headers.get('retry-after')) || 30) * 1000;
            return;
        }
        for (const [id, plus, moins, osmPlus, osmMoins] of (await reponse.json()).vitesses) {
            limites.set(id, { plus, moins, osmPlus, osmMoins });
        }
        g.etat = 'pret';
    } catch (e) {
        g.etat = 'erreur';
        g.reessai = performance.now() + 30000;
    } finally {
        vitEnVol--;
    }
}

/**
 * La limitation de l'arête `a` dans le sens `sens` : { v (km/h), osm } ;
 * null si elle dépend de la signalisation locale (bretelle, rond-point),
 * undefined si son carré n'est pas encore lu.
 */
export function limiteDe(a, sens) {
    const l = a && limites.get(a.id);
    if (!l) return undefined;
    const v = sens > 0 ? l.plus : l.moins;
    return v == null ? null : { v, osm: !!(sens > 0 ? l.osmPlus : l.osmMoins) };
}
