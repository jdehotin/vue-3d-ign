// L'eau de surface de la BD TOPO, drapée sur le relief.

import * as THREE from 'three';
import { ARTEFACT } from '../socle/chargement.js';
import { toLocal, toLonLat } from '../socle/projection.js';
import { terrain, altitudeRef, relief, exagVert, BORNES } from '../terrain/etat.js';
import { scene } from '../socle/rendu.js';
import { poserSurLeRelief } from '../terrain/relief.js';

// Étendues (lacs, retenues, bassins, rivières larges) et cours d'eau étroits de
// la BD TOPO, découpés sur l'emprise par le serveur (vue3d/eau.py). L'eau est
// posée sur le relief de la scène, comme le sol : l'altitude que porte la BD
// TOPO vient d'une autre source, et les mêler la ferait flotter ou sombrer.
//
// Un lac arrive en quelques grands triangles ; posés tels quels, ils couperaient
// le relief. Ils sont redécoupés jusqu'à EAU_MAILLE, l'ordre du maillage du
// terrain (un sommet tous les 2 m), et chaque sommet prend l'altitude du sol.
export const EAU_MAILLE = 2.5;
// Au-dessus du sol : l'ortho drapée montre déjà l'eau, le bleu s'y superpose.
// Assez pour ne pas scintiller avec le terrain, trop peu pour se voir.
export const EAU_DECALAGE = 0.15;
export const MAT_EAU = new THREE.MeshStandardMaterial({
    color: 0x2f6f9f, roughness: 0.12, metalness: 0.0, transparent: true, opacity: 0.8,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
export const MAT_EAU_INTERMITTENTE = MAT_EAU.clone();
MAT_EAU_INTERMITTENTE.opacity = 0.45;
export const groupeEau = new THREE.Group();
scene.add(groupeEau);
poserSurLeRelief({ construire: construireEau, placer: () => { if (drapes.length) placerDrapes(); } });
// Eau et routes : maillages drapés sur le sol, replacés à chaque exagération.
const drapes = [];            // { mesh, alts, decalage } — altitude du sol sous chaque sommet

/** Coupe au milieu de leur plus long côté les triangles plus grands que `maille`. */
export function subdiviser(tris, maille) {
    const out = [];
    const pile = tris.slice();
    while (pile.length) {
        const t = pile.pop();
        const l = [0, 1, 2].map(k => Math.hypot(t[(k + 1) % 3][0] - t[k][0], t[(k + 1) % 3][1] - t[k][1]));
        const k = l.indexOf(Math.max(...l));
        if (l[k] <= maille) { out.push(t); continue; }
        const a = t[k], b = t[(k + 1) % 3], c = t[(k + 2) % 3];
        const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        pile.push([a, m, c], [m, b, c]);
    }
    return out;
}

/** Triangles (en mètres locaux, sens trigonométrique) d'un polygone GeoJSON. */
export function trianglesPolygone(anneaux) {
    const contour = anneaux[0].map(([lo, la]) => new THREE.Vector2(...toLocal(lo, la)));
    const trous = anneaux.slice(1).map(a => a.map(([lo, la]) => new THREE.Vector2(...toLocal(lo, la))));
    // triangulateShape retire les sommets de fermeture en place : les index
    // renvoyés portent sur les tableaux ainsi raccourcis.
    const faces = THREE.ShapeUtils.triangulateShape(contour, trous);
    const pts = contour.concat(...trous).map(v => [v.x, v.y]);
    return faces.map(([a, b, c]) => {
        const t = [pts[a], pts[b], pts[c]];
        const aire = (t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[2][0] - t[0][0]) * (t[1][1] - t[0][1]);
        return aire >= 0 ? t : [t[0], t[2], t[1]];
    });
}

/** Triangles d'un ruban de `largeur` le long d'une ligne, un point tous les 2 m. */
export function trianglesRuban(ligne, largeur) {
    const brut = ligne.map(([lo, la]) => toLocal(lo, la));
    const pts = [brut[0]];
    for (let i = 1; i < brut.length; i++) {
        const [ax, ay] = brut[i - 1], [bx, by] = brut[i];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 2));
        for (let k = 1; k <= n; k++) pts.push([ax + (bx - ax) * k / n, ay + (by - ay) * k / n]);
    }
    if (pts.length < 2) return [];
    const bords = pts.map((p, i) => {
        const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, pts.length - 1)];
        const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
        const nx = -dy / l * largeur / 2, ny = dx / l * largeur / 2;
        return [[p[0] + nx, p[1] + ny], [p[0] - nx, p[1] - ny]];   // gauche, droite
    });
    const tris = [];
    for (let i = 0; i < bords.length - 1; i++) {
        const [g0, d0] = bords[i], [g1, d1] = bords[i + 1];
        // Dans le sens trigonométrique vu du ciel : droite, droite suivante, gauche suivante…
        tris.push([d0, d1, g1], [d0, g1, g0]);
    }
    return tris;
}

/** Un maillage drapé à partir de triangles locaux ; les hauteurs viennent de placerDrapes(). */
export function maillageDrape(tris, materiau, groupe, decalage) {
    const positions = new Float32Array(tris.length * 9);
    const normales = new Float32Array(tris.length * 9);
    const alts = new Float64Array(tris.length * 3);
    let k = 0;
    for (const t of tris) {
        for (const [x, y] of t) {
            positions[k * 3] = x; positions[k * 3 + 2] = -y;
            // Normales au zénith : une eau plane renvoie la lumière d'un bloc,
            // même là où elle suit la pente d'une rivière, et une route ne se
            // moire pas des facettes du relief.
            normales[k * 3 + 1] = 1;
            // Ramené dans l'emprise : le bord d'un ruban la déborde de sa
            // demi-largeur, et un sommet sans altitude filait jusqu'au zéro de
            // la scène — un trait bleu tiré vers le ciel au Mont-Saint-Michel.
            const [lo, la] = toLonLat(x, y);
            const a = terrain ? terrain.alt(Math.min(Math.max(lo, BORNES.o), BORNES.e),
                                            Math.min(Math.max(la, BORNES.s), BORNES.n)) : null;
            alts[k++] = a == null ? NaN : a;
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normales, 3));
    const mesh = new THREE.Mesh(geo, materiau);
    mesh.receiveShadow = true;
    groupe.add(mesh);
    drapes.push({ mesh, alts, decalage });
    return mesh;
}

function construireEau() {
    const eau = ARTEFACT && ARTEFACT.eau;
    if (!eau || groupeEau.children.length) return;
    const polygones = g => g.type === 'Polygon' ? [g.coordinates]
                         : g.type === 'MultiPolygon' ? g.coordinates : [];
    const lignes = g => g.type === 'LineString' ? [g.coordinates]
                      : g.type === 'MultiLineString' ? g.coordinates : [];
    const materiau = e => e.persistance === 'Intermittent' ? MAT_EAU_INTERMITTENTE : MAT_EAU;
    for (const s of eau.surfaces) {
        const tris = polygones(s.geometrie).flatMap(p => subdiviser(trianglesPolygone(p), EAU_MAILLE));
        if (tris.length) maillageDrape(tris, materiau(s), groupeEau, EAU_DECALAGE);
    }
    for (const c of eau.cours) {
        const tris = lignes(c.geometrie).flatMap(l => trianglesRuban(l, c.largeur_m));
        if (tris.length) maillageDrape(tris, materiau(c), groupeEau, EAU_DECALAGE);
    }
    placerDrapes();
}

/** Même règle que le terrain : l'altitude suit l'exagération, un peu au-dessus. */
export function placerDrapes() {
    for (const { mesh, alts, decalage } of drapes) {
        const pos = mesh.geometry.attributes.position;
        for (let k = 0; k < pos.count; k++) {
            const a = alts[k];
            pos.setY(k, (relief && terrain && !Number.isNaN(a) ? (a - altitudeRef) * exagVert : 0) + decalage);
        }
        pos.needsUpdate = true;
        mesh.geometry.computeBoundingSphere();
    }
}
