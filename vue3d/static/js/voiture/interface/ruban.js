// La route prévue, en ruban, et le tunnel où elle passe, vu à travers le relief.

import * as THREE from 'three';
import { RAD } from '../socle/parametres.js';
import { ORIGINE } from '../socle/monde.js';
import { scene, courber } from '../socle/rendu.js';
import { voiture } from '../socle/etat.js';
import { altitudeL93 } from '../sol/altitudes.js';
import { pointArete, pointDuChemin, areteDuChemin, altitudeApproche } from '../route/graphe.js';
import { altitudeSousTerre } from '../route/tunnels.js';
import { echelleMaquette, parDessus } from './maquette.js';

// Le kilomètre suivant, en bleu transparent, comme l'itinéraire d'un GPS :
// c'est la route que la page suppose, et le long de laquelle elle charge.
const RUBAN_M = 1200, RUBAN_PAS_M = 8, RUBAN_LARGEUR_M = 5;
const MAT_RUBAN = courber(new THREE.MeshBasicMaterial({ color: 0x3d8bff, transparent: true, opacity: 0.5,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 }));
const ruban = new THREE.Mesh(new THREE.BufferGeometry(), MAT_RUBAN);
ruban.frustumCulled = false;
ruban.renderOrder = 2;
scene.add(ruban);
// Sous terre, le relief le cacherait : il est dessiné par-dessus, comme la
// voiture, dans une voûte translucide, de VOUTE_DERRIERE_M derrière elle
// jusqu'au bout du ruban. La voûte, à la largeur de la chaussée (7 m sans
// largeur connue) et VOUTE_DEBORD_M de part et d'autre, grossit avec la
// voiture quand la caméra recule.
const VOUTE_DERRIERE_M = 60, VOUTE_HAUTEUR_M = 6, VOUTE_DEBORD_M = 1.5, VOUTE_COTES = 10;
const rubanSousTerre = new THREE.Mesh(new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ color: 0x3d8bff, transparent: true, opacity: 0.45, depthWrite: false }));
const voute = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({
    color: 0xb9c0c8, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }));
for (const m of [rubanSousTerre, voute]) { m.frustumCulled = false; parDessus.add(m); }

/** Un ruban qu'on allonge d'une paire de sommets (gauche, droite) ; `relier` la raccorde à la précédente. */
function bande() {
    const pos = [], idx = [];
    return { pos, idx, ajouter(g, dr, relier) {
        const k = pos.length / 3;
        pos.push(...g, ...dr);
        if (relier && k) idx.push(k - 2, k - 1, k, k - 1, k + 1, k);
    } };
}
function remplacer(mesh, pos, idx, nor = null) {
    mesh.geometry.dispose();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    if (nor) geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setIndex(idx);
    mesh.geometry = geo;
    mesh.visible = idx.length > 0;
}

let dernierRuban = -Infinity;
export function majRuban(maintenant) {
    if (maintenant - dernierRuban < 250) return;
    dernierRuban = maintenant;
    const ch = voiture.chemin;
    if (!ch || !voiture.vue) { ruban.visible = rubanSousTerre.visible = voute.visible = false; return; }
    const dessus = bande(), dessous = bande(), vo = { pos: [], nor: [], idx: [] };
    const echelle = Math.min(Math.max(echelleMaquette() * 0.6, 1), 4), largeur = RUBAN_LARGEUR_M * echelle;
    const d0 = voiture.dChemin + 4 * echelleMaquette(), d1 = Math.min(voiture.dChemin + RUBAN_M, ch.longueur);
    let prec = null, voutePrec = false;
    for (let d = Math.max(voiture.dChemin - VOUTE_DERRIERE_M, 0); d <= d1; d += RUBAN_PAS_M) {
        const p = pointDuChemin(ch, d);
        const e = areteDuChemin(ch, d);
        let alt = altitudeL93(p.x, p.y), sousTerre = false;
        if (e.a.sol > 0) { const z = pointArete(e.a, e.s).z; if (Number.isFinite(z)) alt = Math.max(alt || -1e9, z); }
        else if (e.a.sol < 0) { const z = altitudeSousTerre(e.a, e.s); if (Number.isFinite(z)) { alt = z; sousTerre = true; } }
        else { const z = altitudeApproche(e.a, e.s); if (Number.isFinite(z)) alt = Math.max(alt || -1e9, z); }
        if (!Number.isFinite(alt)) alt = voiture.alt;
        // Vers la droite de la route, en Lambert-93.
        const rx = Math.cos(p.cap * RAD), ry = -Math.sin(p.cap * RAD);
        if (d >= d0) {
            const g = [p.x - rx * largeur / 2 - ORIGINE.x, alt + 0.6, ORIGINE.y - (p.y - ry * largeur / 2)];
            const dr = [p.x + rx * largeur / 2 - ORIGINE.x, alt + 0.6, ORIGINE.y - (p.y + ry * largeur / 2)];
            // À l'entrée et à la sortie, les deux rubans se rejoignent sur le même point.
            const b = sousTerre ? dessous : dessus;
            if (prec && prec !== b) prec.ajouter(g, dr, true);
            b.ajouter(g, dr, prec === b);
            prec = b;
        }
        if (!sousTerre) { voutePrec = false; continue; }
        // Un arceau de la voûte, du pied droit au pied gauche par la clé.
        const l = ((e.a.largeur > 0 ? e.a.largeur : 7) / 2 + VOUTE_DEBORD_M) * echelle, h = VOUTE_HAUTEUR_M * echelle;
        const k = vo.pos.length / 3;
        for (let q = 0; q <= VOUTE_COTES; q++) {
            const t = Math.PI * q / VOUTE_COTES, c = Math.cos(t), s = Math.sin(t);
            vo.pos.push(p.x + rx * c * l - ORIGINE.x, alt + s * h, ORIGINE.y - (p.y + ry * c * l));
            const nx = rx * c / l, ny = s / h, nz = -ry * c / l, n = Math.hypot(nx, ny, nz) || 1;
            vo.nor.push(nx / n, ny / n, nz / n);
        }
        if (voutePrec) {
            for (let q = 0; q < VOUTE_COTES; q++) {
                const a = k - VOUTE_COTES - 1 + q, b = k + q;
                vo.idx.push(a, b, a + 1, a + 1, b, b + 1);
            }
        }
        voutePrec = true;
    }
    remplacer(ruban, dessus.pos, dessus.idx);
    remplacer(rubanSousTerre, dessous.pos, dessous.idx);
    remplacer(voute, vo.pos, vo.idx, vo.nor);
}
