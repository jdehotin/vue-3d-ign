// Les routes de la BD TOPO, en rubans sur le relief.

import * as THREE from 'three';
import { ARTEFACT } from '../socle/chargement.js';
import { scene } from '../socle/rendu.js';
import { poserSurLeRelief } from '../terrain/relief.js';
import { trianglesRuban, maillageDrape, placerDrapes } from './eau.js';

// Tronçons de route BD TOPO, déjà dans la scène pour Street View, dessinés en
// rubans sur le relief. Largeur de chaussée quand elle est renseignée : 267
// tronçons sur 367 dans cinq scènes (Gordes, Strasbourg, Carcassonne,
// Versailles, Annecy) — 3 m en médiane à une chaussée, 5,5 m à deux, 4 m pour
// un rond-point. Jamais pour les chemins, sentiers, routes empierrées et
// escaliers : leur largeur ci-dessous est une convention.
//
// Seuls les tronçons au niveau du sol : un pont (4 sur 367) posé sur le relief
// plongerait dans la rivière, un tunnel traverserait la colline.
const ROUTE_DECALAGE = 0.1;            // sous l'eau (EAU_DECALAGE), sur le sol
const LARGEUR_ROUTE_PAR_NATURE = {
    'Route à 1 chaussée': 3, 'Route à 2 chaussées': 5.5, 'Rond-point': 4, 'Bretelle': 4,
    'Route empierrée': 3, 'Chemin': 2.5, 'Sentier': 1.2, 'Escalier': 1.5,
};
const NATURES_TERRE = new Set(['Route empierrée', 'Chemin', 'Sentier', 'Escalier']);
export const MAT_ROUTE = new THREE.MeshStandardMaterial({
    color: 0x5f636a, roughness: 0.95, transparent: true, opacity: 0.9,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
export const MAT_CHEMIN = MAT_ROUTE.clone();
MAT_CHEMIN.color.set(0x9c8a6e);
MAT_CHEMIN.opacity = 0.75;
const groupeRoutes = new THREE.Group();
scene.add(groupeRoutes);
poserSurLeRelief({ construire: construireRoutes });

function construireRoutes() {
    const routes = ARTEFACT && ARTEFACT.routes;
    if (!routes || groupeRoutes.children.length) return;
    const parMateriau = new Map([[MAT_ROUTE, []], [MAT_CHEMIN, []]]);
    for (const f of routes.features || []) {
        const p = f.properties || {};
        if (p.fictif || String(p.position_par_rapport_au_sol ?? '0') !== '0') continue;
        const g = f.geometry || {};
        const lignes = g.type === 'LineString' ? [g.coordinates]
                     : g.type === 'MultiLineString' ? g.coordinates : [];
        const largeur = p.largeur_de_chaussee > 0 ? p.largeur_de_chaussee
                      : (LARGEUR_ROUTE_PAR_NATURE[p.nature] || 3);
        const tris = parMateriau.get(NATURES_TERRE.has(p.nature) ? MAT_CHEMIN : MAT_ROUTE);
        for (const l of lignes) tris.push(...trianglesRuban(l, largeur));
    }
    // Un maillage par matériau plutôt que par tronçon : quelques centaines de
    // tronçons feraient autant d'appels de dessin.
    for (const [materiau, tris] of parMateriau) {
        if (tris.length) maillageDrape(tris, materiau, groupeRoutes, ROUTE_DECALAGE);
    }
    placerDrapes();
}

document.getElementById('t-routes').addEventListener('click', e => {
    groupeRoutes.visible = !groupeRoutes.visible;
    e.currentTarget.classList.toggle('on', groupeRoutes.visible);
});
