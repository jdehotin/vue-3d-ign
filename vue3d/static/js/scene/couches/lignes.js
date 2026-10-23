// Les lignes à haute tension et leurs pylônes.

import * as THREE from 'three';
import { ARTEFACT } from '../socle/chargement.js';
import { toLocal } from '../socle/projection.js';
import { terrain, altitudeRef, relief, exagVert, anneauRelief } from '../terrain/etat.js';
import { scene } from '../socle/rendu.js';
import { ajouterCiblesSurvol, majCiblesSurvol } from '../interface/survol.js';
import { poserSurLeRelief } from '../terrain/relief.js';
import { groupeEau } from './eau.js';

// Réseau de transport de la BD TOPO (vue3d/lignes.py) : chaque sommet d'une
// ligne est un support, avec la hauteur de son pylône BD TOPO ou, à défaut, la
// médiane de sa tension. Les lignes viennent de toute l'emprise de l'anneau :
// un pylône de 35 m se voit de loin, et c'est souvent au-delà de la scène
// qu'il passe.
//
// La flèche des câbles est une convention : 3 % de la portée, l'ordre de
// grandeur d'une ligne tendue à température moyenne. La BD TOPO ne la donne
// pas, et le MNH LiDAR ne voit pas les câbles — vérifié sous une portée de
// 225 kV de 489 m entre pylônes de 27 et 21 m : 0 à 18 m, la végétation seule.
const FLECHE_PART = 0.03;
// Le point bas d'un câble ne descend pas à moins de ce dégagement au-dessus du
// pied des pylônes : ordre de grandeur des distances de sécurité en HTB.
const DEGAGEMENT_M = 8;
// Demi-longueur de la traverse : les phases s'écartent avec la tension.
const BRAS_PAR_TENSION = { '63 kV': 2.5, '90 kV': 3, '150 kV': 4, '225 kV': 5, '400 kV': 8 };
export const MAT_PYLONE = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.5, roughness: 0.55 });
export const MAT_CABLE = new THREE.LineBasicMaterial({ color: 0x23272c });
const groupeLignes = new THREE.Group();
scene.add(groupeLignes);
const lignesElec = [];       // { tension, supports: [{ x, y, h, alt, ang, groupe }], cables }
const pylonesSurvol = [];    // fûts des pylônes, pour l'infobulle
ajouterCiblesSurvol(() => groupeLignes.visible ? pylonesSurvol : []);
poserSurLeRelief({ construire: construireLignes, placer: () => { if (lignesElec.length) placerLignes(); } });

/** Sol sous un point : terrain de la scène, sinon anneau, sinon null. */
function altSolEtendu(lon, lat) {
    const a = terrain ? terrain.alt(lon, lat) : null;
    if (a != null) return a;
    const b = anneauRelief ? anneauRelief.alt(lon, lat) : null;
    return b != null && !Number.isNaN(b) ? b : null;
}

function construireLignes() {
    const lignes = ARTEFACT && ARTEFACT.lignes;
    if (!lignes || lignesElec.length) return;
    for (const l of lignes) {
        const bras = BRAS_PAR_TENSION[l.tension] || 3;
        const s = l.supports.map(([lon, lat, h, mesuree]) => {
            const [x, y] = toLocal(lon, lat);
            return { x, y, h, mesuree, alt: altSolEtendu(lon, lat) };
        });
        // Un support hors de tout relief (au-delà de l'anneau, ou en mer)
        // prend le sol de son voisin : le câble va jusqu'au bord sans plonger.
        for (let i = 1; i < s.length; i++) if (s[i].alt == null) s[i].alt = s[i - 1].alt;
        for (let i = s.length - 2; i >= 0; i--) if (s[i].alt == null) s[i].alt = s[i + 1].alt;
        for (const p of s) if (p.alt == null) p.alt = altitudeRef;
        s.forEach((p, i) => {
            // Traverse perpendiculaire à la ligne : bissectrice des portées voisines.
            const a = s[Math.max(i - 1, 0)], b = s[Math.min(i + 1, s.length - 1)];
            p.ang = Math.atan2(b.y - a.y, b.x - a.x);
            const g = new THREE.Group();
            const fut = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 1.8, p.h, 4, 1), MAT_PYLONE);
            fut.position.y = p.h / 2;
            fut.rotation.y = Math.PI / 4;
            fut.userData = { pylone: true, tension: l.tension, gestionnaire: l.gestionnaire, h: p.h, mesuree: p.mesuree };
            const traverse = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.5, 2 * bras), MAT_PYLONE);
            traverse.position.y = p.h - 2;
            g.add(fut, traverse);
            g.position.set(p.x, 0, -p.y);
            g.rotation.y = p.ang;          // +X local le long de la ligne, la traverse en Z
            fut.castShadow = traverse.castShadow = true;
            groupeLignes.add(g);
            pylonesSurvol.push(fut);
            p.groupe = g;
        });
        const cables = new THREE.LineSegments(new THREE.BufferGeometry(), MAT_CABLE);
        groupeLignes.add(cables);
        lignesElec.push({ tension: l.tension, bras, supports: s, cables });
    }
    placerLignes();
    majCiblesSurvol();
}

/** Pieds des pylônes sur le sol exagéré, hauteurs réelles ; câbles recalculés. */
function placerLignes() {
    const SEGMENTS = 16;
    for (const l of lignesElec) {
        for (const p of l.supports) {
            p.base = relief && terrain ? (p.alt - altitudeRef) * exagVert : 0;
            p.groupe.position.y = p.base;
        }
        // Trois phases : les deux bouts de la traverse et le sommet.
        const attaches = [[-l.bras, -2], [l.bras, -2], [0, 0]];
        const pts = [];
        for (let i = 0; i < l.supports.length - 1; i++) {
            const A = l.supports[i], B = l.supports[i + 1];
            const portee = Math.hypot(B.x - A.x, B.y - A.y);
            const fleche = Math.max(0, Math.min(FLECHE_PART * portee,
                Math.min(A.h, B.h) - 2 - DEGAGEMENT_M));
            for (const [z, dy] of attaches) {
                // Point d'attache : décalé de z le long de la traverse, tournée de `ang`.
                const bout = (P) => [P.x + z * Math.sin(P.ang), P.base + P.h + dy, -P.y + z * Math.cos(P.ang)];
                const a = bout(A), b = bout(B);
                let prec = a;
                for (let k = 1; k <= SEGMENTS; k++) {
                    const t = k / SEGMENTS;
                    const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - 4 * fleche * t * (1 - t),
                               a[2] + (b[2] - a[2]) * t];
                    pts.push(...prec, ...q);
                    prec = q;
                }
            }
        }
        l.cables.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        l.cables.geometry.computeBoundingSphere();
    }
}

document.getElementById('t-lignes').addEventListener('click', e => {
    groupeLignes.visible = !groupeLignes.visible;
    e.currentTarget.classList.toggle('on', groupeLignes.visible);
    majCiblesSurvol();
});

document.getElementById('t-eau').addEventListener('click', e => {
    groupeEau.visible = !groupeEau.visible;
    e.currentTarget.classList.toggle('on', groupeEau.visible);
});
