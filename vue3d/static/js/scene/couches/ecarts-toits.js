// Les toits dessinés, vérifiés contre le nuage LiDAR HD.

import * as THREE from 'three';
import { toLocal } from '../socle/projection.js';
import { terrain } from '../terrain/etat.js';
import { meshesToits } from '../batiments/etat.js';
import { toitReleve, terrainSousEmprise } from '../terrain/relief.js';
import { NUAGE, pointsNuage } from './nuage.js';

// Les toits sont tirés du MNH à 0,5 m (vue3d/toits.py, vue3d/pans.py) ; les
// points « bâtiment » bruts du nuage en sont un contrôle indépendant. Chaque
// point qui tombe sous un toit dessiné — dessus plat, toit résumé, pans ou
// surface, selon les boutons des toits — est comparé à l'altitude du toit à sa
// verticale. Refait à chaque lecture du nuage, sur les seuls toits que le carré
// contient entiers pour la première, et à chaque reconstruction des bâtiments.
//
// Comparé au toit modélisé, pas au toit rendu : sans l'exagération, et sans
// l'enfoncement de tous les volumes (ENFONCEMENT, baseBatiment).
//
// Deux mesures par toit. Son décalage : l'écart médian, qui dit surtout où est
// posé son pied — le point bas du RGE ALTI sous le contour, quand le serveur
// mesure les pans depuis celui du sol LiDAR. Sa forme : la part de ses points
// à plus de ECART_TOIT_M du toit, décalage ôté. Un toit est « en écart » quand
// cette part atteint PART_EN_ECART, sur POINTS_MIN_ECART points au moins.
// Toits en écart, zone de 1 000 m — node outils/mesure-ecarts-toits.mjs :
//
//                          au seuil de   30 %      40 %      50 %
//   pans mesurés      Gordes            4 / 76    0 / 76    0 / 76
//                     tour Eiffel       4 / 17    1 / 17    0 / 17
//                     Strasbourg       88 / 272  47 / 272  17 / 272
//   villas à toit-terrasse d'un coteau provençal, toit résumé seul
//   (en pans, aucune : de 2 à 20 % de leurs points hors de la forme)
//                                       7 / 8     5 / 8     2 / 8
//
// À Strasbourg, ville dense, la couche allégée garde un point pour 1,5 à 2 m
// de bâti : un toit raide à lucarnes s'y lit moins bien — le carré proche,
// plus dense, y voyait ses pans à 35 % hors de leur forme, la zone entière à 47.
// Le décalage, lui, est de −0,4 à −0,6 m en médiane pour les pans et les
// surfaces mesurées, de +0,1 à +0,4 m pour les toits plats.
export const ECART_TOIT_M = 0.5;
const POINTS_MIN_ECART = 20;
const PART_EN_ECART = 0.4;
// Points à moins de MARGE_ECART_M du contour : non comptés (façades, débords,
// précision de 2,5 m de l'emprise BD TOPO). Sur cette bande, à Strasbourg,
// 71 % des points étaient hors de la forme ; au-delà, 42 à 47 %.
const MARGE_ECART_M = 1;
// Cases de l'index des triangles, en mètres.
const PAS_ECARTS_M = 2;
// Seul compte le point le plus haut de chaque maille de MAILLE_ECART_M : le
// LiDAR voit aussi les façades, et le nuage allégé en garde un point par
// voxel, bien plus sur un mur de 10 m que sur le toit au-dessus. Le MNH, dont
// les toits sont tirés, ne garde lui aussi que le dessus.
const MAILLE_ECART_M = 1;
// Couleur d'un point comparé : gris pâle à ±TOLERANCE_COULEUR_M, puis vers le
// bleu (point sous le toit : toit trop haut) ou le rouge (point au-dessus :
// toit trop bas), pleins à ±1 m. La paire divergente du skill dataviz.
const TOLERANCE_COULEUR_M = 0.25;
const COULEURS_ECART = { sous: 0x2a78d6, egal: 0xf0efec, sur: 0xe34948 };
const CLASSE_BATIMENT = 6;
// anneau → { n, mediane, part, enEcart, phase } du dernier contrôle.
export let ecartsParToit = new Map();
export let bilanEcarts = null;

/**
 * Écart vertical de chaque point au toit sous lui.
 *
 * `tri` : 9 nombres par triangle, (x, z, altitude) de ses trois sommets ;
 * `toitDe` : le toit de chacun. Un triangle vertical (pignon, marche) n'a pas
 * d'aire au plan et ne couvre rien. Sous plusieurs triangles, le plus haut,
 * celui que voit le LiDAR. Rend { toit, ecart } : le toit sous chaque point
 * (−1 : aucun) et l'altitude du point moins celle du toit.
 */
function ecartsSousToits(tri, toitDe, xs, zs, alts, pas = PAS_ECARTS_M) {
    const nt = toitDe.length, n = xs.length;
    const toit = new Int32Array(n).fill(-1), ecart = new Float32Array(n);
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < 9 * nt; k += 3) {
        x0 = Math.min(x0, tri[k]); x1 = Math.max(x1, tri[k]);
        z0 = Math.min(z0, tri[k + 1]); z1 = Math.max(z1, tri[k + 1]);
    }
    if (!nt) return { toit, ecart };
    const nx = Math.floor((x1 - x0) / pas) + 1, nz = Math.floor((z1 - z0) / pas) + 1;
    // Chaque triangle dans les cases de sa boîte, en deux passes : compter,
    // puis ranger dans un tableau plat.
    const cases = (t, f) => {
        const a = 9 * t;
        const i0 = Math.floor((Math.min(tri[a], tri[a + 3], tri[a + 6]) - x0) / pas);
        const i1 = Math.floor((Math.max(tri[a], tri[a + 3], tri[a + 6]) - x0) / pas);
        const j0 = Math.floor((Math.min(tri[a + 1], tri[a + 4], tri[a + 7]) - z0) / pas);
        const j1 = Math.floor((Math.max(tri[a + 1], tri[a + 4], tri[a + 7]) - z0) / pas);
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) f(j * nx + i);
    };
    const aire = new Float64Array(nt);
    const debut = new Int32Array(nx * nz + 1);
    for (let t = 0; t < nt; t++) {
        const a = 9 * t;
        aire[t] = (tri[a + 3] - tri[a]) * (tri[a + 7] - tri[a + 1]) - (tri[a + 6] - tri[a]) * (tri[a + 4] - tri[a + 1]);
        if (Math.abs(aire[t]) > 1e-6) cases(t, c => debut[c + 1]++);
    }
    for (let c = 0; c < nx * nz; c++) debut[c + 1] += debut[c];
    const rang = debut.slice(0, nx * nz), liste = new Int32Array(debut[nx * nz]);
    for (let t = 0; t < nt; t++) if (Math.abs(aire[t]) > 1e-6) cases(t, c => { liste[rang[c]++] = t; });

    for (let p = 0; p < n; p++) {
        const x = xs[p], z = zs[p];
        const i = Math.floor((x - x0) / pas), j = Math.floor((z - z0) / pas);
        if (i < 0 || j < 0 || i >= nx || j >= nz || !Number.isFinite(alts[p])) continue;
        let haut = -Infinity, sous = -1;
        for (let k = debut[j * nx + i]; k < debut[j * nx + i + 1]; k++) {
            const t = liste[k], a = 9 * t, d = aire[t];
            // Coordonnées barycentriques au plan.
            const u = ((tri[a + 3] - x) * (tri[a + 7] - z) - (tri[a + 6] - x) * (tri[a + 4] - z)) / d;
            const v = ((tri[a + 6] - x) * (tri[a + 1] - z) - (tri[a] - x) * (tri[a + 7] - z)) / d;
            const w = 1 - u - v;
            if (u < -1e-9 || v < -1e-9 || w < -1e-9) continue;
            const y = u * tri[a + 2] + v * tri[a + 5] + w * tri[a + 8];
            if (y > haut) { haut = y; sous = toitDe[t]; }
        }
        if (sous >= 0) { toit[p] = sous; ecart[p] = alts[p] - haut; }
    }
    return { toit, ecart };
}

/** Distance d'un point (x, z) au contour fermé `contour` ([[x, z], …]). */
export function distanceAuContour(x, z, contour) {
    let d = Infinity;
    for (let k = 0; k + 1 < contour.length; k++) {
        const [ax, az] = contour[k], [bx, bz] = contour[k + 1];
        const ux = bx - ax, uz = bz - az, l = ux * ux + uz * uz;
        const s = l ? Math.min(Math.max(((x - ax) * ux + (z - az) * uz) / l, 0), 1) : 0;
        d = Math.min(d, Math.hypot(x - ax - s * ux, z - az - s * uz));
    }
    return d;
}

/**
 * Altitude réelle du pied d'un toit : le point bas du terrain sous son
 * emprise, relevé au terrain médian s'il l'est (rebaserBatiments). Sans
 * terrain, 0 : les hauteurs se comptent du sol. null si le terrain manque
 * sous l'emprise.
 */
function piedReelDuToit(ud) {
    if (!terrain) return 0;
    const { min, med } = terrainSousEmprise(ud.anneau);
    if (!Number.isFinite(min)) return null;
    return min + (toitReleve(ud) && Number.isFinite(med) ? Math.max(med - min, 0) : 0);
}

/** L'anneau tient-il dans la boîte (ouest, sud, est, nord) ? */
function anneauDansBoite(anneau, [o, s, e, n]) {
    return anneau.every(([lon, lat]) => lon >= o && lon <= e && lat >= s && lat <= n);
}

/** Compare les toits dessinés aux points du nuage ; fiche, panneau et couleurs. */
export function verifierToits() {
    ecartsParToit = new Map();
    bilanEcarts = null;
    if (!pointsNuage) { majLegendeEcarts(); return; }
    const debutMs = performance.now();
    // Au-delà d'une zone de 1 000 m, le nuage n'est lu que sur le kilomètre
    // central (nuage.NUAGE_COTE_MAX_M) : `boite`, comme le carré proche.
    const boite = NUAGE.proche || NUAGE.boite || null;
    const phase = NUAGE.proche ? 'carré proche' : NUAGE.boite ? 'kilomètre central' : 'zone entière';
    // Les toits, un par emprise ; leurs triangles en altitudes réelles.
    const toits = [], parAnneau = new Map(), tri = [], toitDe = [];
    for (const m of meshesToits) {
        const ud = m.userData;
        if (!ud.anneau || (boite && !anneauDansBoite(ud.anneau, boite))) continue;
        const pied = piedReelDuToit(ud);
        if (pied == null) continue;
        let k = parAnneau.get(ud.anneau);
        if (k === undefined) {
            parAnneau.set(ud.anneau, k = toits.length);
            toits.push({ ud, contour: ud.anneau.map(([lon, lat]) => { const [x, y] = toLocal(lon, lat); return [x, -y]; }),
                         ecarts: [] });
        }
        const pos = m.geometry.attributes.position, idx = m.geometry.index;
        const nv = idx ? idx.count : pos.count;
        for (let q = 0; q + 2 < nv; q += 3) {
            for (let c = 0; c < 3; c++) {
                const v = idx ? idx.getX(q + c) : q + c;
                tri.push(pos.getX(v) + m.position.x, pos.getZ(v) + m.position.z, pied + pos.getY(v) * m.scale.y);
            }
            toitDe.push(k);
        }
    }
    // Les points « bâtiment », à leur altitude réelle — hors des ouvrages
    // ajourés, qui ne sont pas des toits : les piliers de la tour Eiffel
    // tombaient sous les toits des pavillons à son pied.
    const { lon, lat, h, classe, pos, col, base } = pointsNuage;
    const idx = [];
    for (let i = NUAGE.n_ajoures; i < classe.length; i++) if (classe[i] === CLASSE_BATIMENT) idx.push(i);
    const xs = new Float64Array(idx.length), zs = new Float64Array(idx.length), alts = new Float64Array(idx.length);
    idx.forEach((i, p) => {
        xs[p] = pos[3 * i]; zs[p] = pos[3 * i + 2];
        const sol = terrain ? terrain.alt(lon[i], lat[i]) : 0;
        alts[p] = sol == null ? NaN : sol + h[i];
    });
    const { toit, ecart } = ecartsSousToits(Float64Array.from(tri), Int32Array.from(toitDe), xs, zs, alts);

    // Le dessus de chaque maille, toit par toit.
    let xmin = Infinity, zmin = Infinity, xmax = -Infinity;
    for (let p = 0; p < idx.length; p++) {
        if (toit[p] < 0) continue;
        xmin = Math.min(xmin, xs[p]); xmax = Math.max(xmax, xs[p]); zmin = Math.min(zmin, zs[p]);
    }
    const largeur = Math.floor((xmax - xmin) / MAILLE_ECART_M) + 1, dessus = new Map();
    for (let p = 0; p < idx.length; p++) {
        if (toit[p] < 0) continue;
        const cle = (toit[p] * 1e6 + Math.floor((zs[p] - zmin) / MAILLE_ECART_M)) * largeur
                    + Math.floor((xs[p] - xmin) / MAILLE_ECART_M);
        const q = dessus.get(cle);
        if (q === undefined || ecart[p] > ecart[q]) dessus.set(cle, p);
    }

    const compares = new Int32Array(idx.length).fill(-1);
    for (const p of dessus.values()) {
        const k = toit[p], t = toits[k];
        if (MARGE_ECART_M > 0 && distanceAuContour(xs[p], zs[p], t.contour) < MARGE_ECART_M) continue;
        compares[p] = k;
        t.ecarts.push(ecart[p]);
    }
    // Par toit : son décalage (l'écart médian), puis sa forme — la part des
    // points qui s'en écartent, décalage ôté.
    let verifies = 0, enEcart = 0;
    for (const t of toits) {
        const n = t.ecarts.length;
        if (!n) continue;
        const tries = Float64Array.from(t.ecarts).sort();
        t.mediane = n % 2 ? tries[n >> 1] : (tries[n / 2 - 1] + tries[n / 2]) / 2;
        const part = t.ecarts.filter(e => Math.abs(e - t.mediane) > ECART_TOIT_M).length / n;
        const ecarte = n >= POINTS_MIN_ECART && part >= PART_EN_ECART;
        verifies++;
        if (ecarte) enEcart++;
        ecartsParToit.set(t.ud.anneau, { n, mediane: t.mediane, part, enEcart: ecarte, phase });
    }
    // Couleurs : d'origine, puis celle de l'écart à la forme pour les points
    // comparés.
    col.set(base);
    const c = new THREE.Color(), egal = new THREE.Color(COULEURS_ECART.egal);
    const sous = new THREE.Color(COULEURS_ECART.sous), sur = new THREE.Color(COULEURS_ECART.sur);
    for (let p = 0; p < idx.length; p++) {
        if (compares[p] < 0) continue;
        const e = ecart[p] - toits[compares[p]].mediane;
        const f = Math.min(Math.max((Math.abs(e) - TOLERANCE_COULEUR_M) / (1 - TOLERANCE_COULEUR_M), 0), 1);
        c.lerpColors(egal, e < 0 ? sous : sur, f);
        col[3 * idx[p]] = c.r; col[3 * idx[p] + 1] = c.g; col[3 * idx[p] + 2] = c.b;
    }
    for (const k of pointsNuage.couleurs) k.needsUpdate = true;
    bilanEcarts = { verifies, enEcart, phase, ms: performance.now() - debutMs, toits, toit: compares, ecart, xs, zs };
    majLegendeEcarts();
}

/** La ligne des toits vérifiés, et la légende des couleurs avec les points. */
export function majLegendeEcarts() {
    const ligne = document.getElementById('l-ecarts');
    ligne.hidden = !bilanEcarts;
    if (bilanEcarts) {
        document.getElementById('s-ecarts').textContent = `${bilanEcarts.verifies} toit(s)`
            + `, ${bilanEcarts.enEcart} en écart · ${bilanEcarts.phase}`;
    }
    document.getElementById('legende-ecarts').hidden = !(bilanEcarts && bilanEcarts.verifies
        && pointsNuage && pointsNuage.bati.visible);
}
