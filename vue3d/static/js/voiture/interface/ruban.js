// La route prévue, en ruban.

import * as THREE from 'three';
import { RAD } from '../socle/parametres.js';
import { ORIGINE } from '../socle/monde.js';
import { scene, courber } from '../socle/rendu.js';
import { voiture } from '../socle/etat.js';
import { altitudeL93 } from '../sol/altitudes.js';
import { pointArete, pointDuChemin, areteDuChemin } from '../route/graphe.js';
import { echelleMaquette } from './maquette.js';

// Le kilomètre suivant, en bleu transparent, comme l'itinéraire d'un GPS :
// c'est la route que la page suppose, et le long de laquelle elle charge.
const RUBAN_M = 1200, RUBAN_PAS_M = 8, RUBAN_LARGEUR_M = 5;
const MAT_RUBAN = courber(new THREE.MeshBasicMaterial({ color: 0x3d8bff, transparent: true, opacity: 0.5,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 }));
const ruban = new THREE.Mesh(new THREE.BufferGeometry(), MAT_RUBAN);
ruban.frustumCulled = false;
ruban.renderOrder = 2;
scene.add(ruban);
let dernierRuban = -Infinity;
export function majRuban(maintenant) {
    if (maintenant - dernierRuban < 250) return;
    dernierRuban = maintenant;
    const ch = voiture.chemin;
    if (!ch || !voiture.vue) { ruban.visible = false; return; }
    const pos = [], idx = [];
    const d0 = voiture.dChemin + 4 * echelleMaquette(), d1 = Math.min(voiture.dChemin + RUBAN_M, ch.longueur);
    const largeur = RUBAN_LARGEUR_M * Math.min(Math.max(echelleMaquette() * 0.6, 1), 4);
    for (let d = d0; d <= d1; d += RUBAN_PAS_M) {
        const p = pointDuChemin(ch, d);
        const e = areteDuChemin(ch, d);
        let alt = altitudeL93(p.x, p.y);
        if (e.a.sol > 0) { const z = pointArete(e.a, e.s).z; if (Number.isFinite(z)) alt = Math.max(alt || -1e9, z); }
        if (!Number.isFinite(alt)) alt = voiture.alt;
        const nx = Math.cos(p.cap * RAD) * largeur / 2, ny = -Math.sin(p.cap * RAD) * largeur / 2;
        const k = pos.length / 3;
        pos.push(p.x - nx - ORIGINE.x, alt + 0.6, ORIGINE.y - (p.y - ny),
                 p.x + nx - ORIGINE.x, alt + 0.6, ORIGINE.y - (p.y + ny));
        if (k) idx.push(k - 2, k - 1, k, k - 1, k + 1, k);
    }
    ruban.geometry.dispose();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    ruban.geometry = geo;
    ruban.position.set(0, 0, 0);
    ruban.visible = pos.length > 6;
}
