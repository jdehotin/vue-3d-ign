// Les toits : surface mesurée au LiDAR, pans, toits découpés, dessus plats.

import * as THREE from 'three';
import { toLocal } from '../socle/projection.js';
import { ENFONCEMENT } from '../terrain/etat.js';
import { geometrieFacettes, normalesPliees } from '../geometrie/normales.js';
import {
    MAT_TOIT_VOISIN, DESSUS_DECALAGE, MAT_DESSUS, groupeBatiments, meshes, meshesToits,
    TOITS_GRILLE,
} from './etat.js';

// Le serveur envoie, pour chaque toit fiable, la fenêtre de la grille MNH à
// 0,5 m qui couvre l'emprise : des hauteurs rapportées au point le plus bas du
// terrain sous le contour, bords et feuillage déjà écartés (vue3d/toits.py).
//
// Le toit est cette grille découpée sur le contour : chaque maille (le carré
// entre quatre centres de cellules) est coupée par l'emprise, triangulée, et
// ses sommets prennent la hauteur interpolée. Les murs montent sous le bord du
// toit, aux mêmes points et aux mêmes hauteurs : pas de fente entre les deux.
//
// Une emprise à cours intérieures (les trous du polygone BD TOPO) est d'abord
// découpée en triangles, et chaque triangle traité comme une emprise : une
// maille coupée par un contour troué n'a pas de forme simple, coupée par un
// triangle elle reste convexe. Les cours restent ouvertes, murs compris : au
// château de Versailles, le toit en couvrait cinq, 724 m² de trop.

export const ANGLE_PLI_TOIT = 40 * Math.PI / 180;
// Au-delà, une facette n'est plus un pan mais la marche entre deux corps : un
// mur. Le serveur refuse déjà un toit plus raide qu'environ 50°
// (TOITS_PENTE_MAX) ; texturée par la photo, projetée à la verticale, la
// marche s'y couvrait de traînées comme une façade.
const PENTE_MUR_COS = Math.cos(60 * Math.PI / 180);

/** Hauteurs d'une surface, en mètres, lignes depuis le nord. */
function decoderSurface(s) {
    const z = new Float64Array(s.l * s.h);
    let tete = 0;
    for (let j = 0; j < s.h; j++) {
        // Tête de ligne : écart à la tête précédente ; ensuite, à la voisine.
        tete += s.z[j * s.l];
        let v = tete;
        z[j * s.l] = v;
        for (let i = 1; i < s.l; i++) { v += s.z[j * s.l + i]; z[j * s.l + i] = v; }
    }
    for (let k = 0; k < z.length; k++) z[k] = s.zero_m + z[k] * s.pas_m;
    return z;
}

/** Découpe d'un polygone par le demi-plan `garder` (Sutherland–Hodgman). */
function couperPolygone(pts, garder, intersection) {
    const out = [];
    for (let k = 0; k < pts.length; k++) {
        const a = pts[k], b = pts[(k + 1) % pts.length];
        const ga = garder(a), gb = garder(b);
        if (ga) out.push(a);
        if (ga !== gb) out.push(intersection(a, b));
    }
    return out;
}

/**
 * Toit résumé découpé sur l'emprise : les pans d'une ou plusieurs boîtes — deux
 * pans sur un faîtage, ou pyramide — mais au-dessus du seul bâtiment.
 *
 * Posé sur sa boîte entière, le toit résumé débordait : la boîte englobe
 * l'emprise dans le repère du faîtage, et une maison en L, un faîtage mesuré
 * en biais ou une aile courbe en laissent une bonne part au-dessus du jardin
 * ou de la cour. Mesuré sur 391 toits résumés de huit lieux : le débord vaut
 * 31 % de l'emprise en médiane, plus de la moitié pour un toit sur trois, et
 * plus que l'emprise elle-même pour un sur dix. Vu du ciel, c'était un
 * rectangle de photo aérienne — pelouse et pavés compris — plus grand que la
 * maison ; à Chambord, deux « corps » de 53 × 43 m sur une aile de 10 m de
 * large.
 *
 * `boites` : [{ rect, g, f, pyramide, suivantX }] — rectangle orienté, hauteurs
 * de gouttière et de faîtage, forme, et pour deux pans le côté que suit le
 * faîtage. `hMur` : le haut des murs, d'où montent les pignons. Null si rien
 * de l'emprise n'est sous une boîte.
 */
export function geometrieToitDecoupe(anneau, trous, boites, hMur) {
    const ouvrir = a => {
        const p = a.map(([lo, la]) => toLocal(lo, la));
        const [fx, fy] = p[0], [lx, ly] = p[p.length - 1];
        return fx === lx && fy === ly ? p.slice(0, -1) : p;
    };
    const pts = ouvrir(anneau);
    if (pts.length < 3) return null;
    const cours = trous.map(ouvrir).filter(c => c.length >= 3);
    const v2de = a => a.map(([x, y]) => new THREE.Vector2(x, y));
    const sommets = pts.concat(...cours);
    // Des triangles : une pièce convexe le reste sous chaque coupe.
    const pieces = THREE.ShapeUtils.triangulateShape(v2de(pts), cours.map(v2de))
        .map(tri => tri.map(k => sommets[k]));
    const aireDe = a => {
        let s = 0;
        for (let k = 0; k < a.length; k++) { const p = a[k], q = a[(k + 1) % a.length]; s += p[0] * q[1] - q[0] * p[1]; }
        return s / 2;
    };
    // Coupe par le demi-plan où la fonction affine `f` est positive.
    const couper = (poly, f) => couperPolygone(poly, p => f(p) >= 0, (a, b) => {
        const fa = f(a), t = fa / (fa - f(b));
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    });

    const v = [];
    for (const b of boites) {
        const { ang, x0, x1, y0, y1 } = b.rect;
        const cos = Math.cos(ang), sin = Math.sin(ang);
        const versBoite = ([x, y]) => [x * cos + y * sin, -x * sin + y * cos];
        const versMonde = ([u, w]) => [u * cos - w * sin, u * sin + w * cos];
        const mu = (x0 + x1) / 2, mw = (y0 + y1) / 2;
        const du = Math.max((x1 - x0) / 2, 1e-6), dw = Math.max((y1 - y0) / 2, 1e-6);
        const suivantX = b.suivantX ?? (x1 - x0 >= y1 - y0);
        // Lignes où le toit se plie, et pans de part et d'autre : chacun est
        // l'intersection de demi-plans, et la hauteur y est affine.
        const plis = b.pyramide
            ? [p => (p[0] - mu) / du - (p[1] - mw) / dw, p => (p[0] - mu) / du + (p[1] - mw) / dw]
            : [suivantX ? p => p[1] - mw : p => p[0] - mu];
        const pans = b.pyramide ? [[1, 1], [-1, 1], [-1, -1], [1, -1]] : [[1], [-1]];
        const hauteur = b.pyramide
            ? p => b.g + (b.f - b.g) * (1 - Math.max(Math.abs(p[0] - mu) / du, Math.abs(p[1] - mw) / dw))
            : suivantX ? p => b.g + (b.f - b.g) * (1 - Math.abs(p[1] - mw) / dw)
                       : p => b.g + (b.f - b.g) * (1 - Math.abs(p[0] - mu) / du);
        const poser = (p, h) => { const [x, y] = versMonde(p); v.push(x, h, -y); };
        const dansLaBoite = poly => {
            for (const f of [p => p[0] - x0, p => x1 - p[0], p => p[1] - y0, p => y1 - p[1]]) {
                if (poly.length < 3) break;
                poly = couper(poly, f);
            }
            return poly;
        };

        // --- Pans : chaque triangle de l'emprise, ramené à la boîte puis à chaque pan.
        const dedans = [];
        for (const piece of pieces) {
            const c = dansLaBoite(piece.map(versBoite));
            if (c.length < 3 || Math.abs(aireDe(c)) < 1e-6) continue;
            dedans.push(c);
            for (const signes of pans) {
                let pan = c;
                signes.forEach((s, k) => { if (pan.length >= 3) pan = couper(pan, p => s * plis[k](p)); });
                if (pan.length < 3 || Math.abs(aireDe(pan)) < 1e-9) continue;
                // Sens trigonométrique vu du ciel : la face regarde en haut.
                if (aireDe(pan) < 0) pan = pan.slice().reverse();
                for (let k = 1; k < pan.length - 1; k++) {
                    for (const p of [pan[0], pan[k], pan[k + 1]]) poser(p, hauteur(p));
                }
            }
        }
        if (!dedans.length) continue;

        // --- Pignons : du haut des murs jusqu'au toit, le long d'un segment
        // parcouru avec l'extérieur à sa droite, recoupé là où le toit se plie.
        const pignon = (a, c) => {
            const ts = [0, 1];
            for (const pli of plis) {
                const fa = pli(a), fc = pli(c);
                if (fa * fc < 0) ts.push(fa / (fa - fc));
            }
            ts.sort((p, q) => p - q);
            for (let m = 0; m < ts.length - 1; m++) {
                const p = [a[0] + (c[0] - a[0]) * ts[m], a[1] + (c[1] - a[1]) * ts[m]];
                const q = [a[0] + (c[0] - a[0]) * ts[m + 1], a[1] + (c[1] - a[1]) * ts[m + 1]];
                const hp = hauteur(p), hq = hauteur(q);
                if (hp - hMur < 1e-3 && hq - hMur < 1e-3) continue;
                poser(p, hMur); poser(q, hMur); poser(q, hq);
                poser(p, hMur); poser(q, hq); poser(p, hp);
            }
        };
        // Part d'un segment dans un polygone convexe : [t0, t1], ou null. À un
        // dixième de millimètre près : la boîte est celle de l'emprise, et ses
        // côtés portent des côtés du contour, que l'arrondi jetait dehors —
        // un pignon sur deux manquait.
        const dansConvexe = (a, c, poly) => {
            const sens = aireDe(poly) >= 0 ? 1 : -1;
            let t0 = 0, t1 = 1;
            for (let k = 0; k < poly.length; k++) {
                const p = poly[k], q = poly[(k + 1) % poly.length];
                const longueur = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
                const cote = r => sens * ((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]))
                                  / longueur + 1e-4;
                const fa = cote(a), fc = cote(c);
                if (fa < 0 && fc < 0) return null;
                if (fa < 0) t0 = Math.max(t0, fa / (fa - fc));
                else if (fc < 0) t1 = Math.min(t1, fa / (fa - fc));
            }
            return t1 - t0 > 1e-9 ? [t0, t1] : null;
        };
        const entre = (a, c, t) => [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t];
        const boite = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        // Le contour de l'emprise, et ses cours, là où ils passent sous la boîte.
        for (const [tour, versDehors] of [[pts, 1], ...cours.map(c => [c, -1])]) {
            const sens = (aireDe(tour) > 0 ? 1 : -1) * versDehors;
            for (let k = 0; k < tour.length; k++) {
                let a = versBoite(tour[k]), c = versBoite(tour[(k + 1) % tour.length]);
                if (sens < 0) [a, c] = [c, a];
                const t = dansConvexe(a, c, boite);
                if (t) pignon(entre(a, c, t[0]), entre(a, c, t[1]));
            }
        }
        // Les bords de la boîte qui traversent l'emprise : un corps de toit
        // parmi d'autres s'arrête en plein bâtiment.
        if (boites.length > 1) {
            for (let k = 0; k < 4; k++) {
                const a = boite[k], c = boite[(k + 1) % 4];
                for (const piece of pieces) {
                    const t = dansConvexe(a, c, piece.map(versBoite));
                    if (t) pignon(entre(a, c, t[0]), entre(a, c, t[1]));
                }
            }
        }
    }
    if (!v.length) return null;
    return geometrieFacettes(new Float32Array(v));
}

/**
 * Murs et toit d'un bâtiment à surface mesurée, en coordonnées de scène, base
 * à 0. Null si la géométrie est dégénérée.
 */
function geometriesSurface(anneau, s, trous = []) {
    const G = TOITS_GRILLE;
    const [w, sud, e, n] = G.bbox;
    // Centres des cellules de la fenêtre, en mètres locaux : x vers l'est, y
    // vers le nord. La projection locale est affine, la grille reste régulière.
    const lonCol = i => w + (e - w) * (s.i0 + i + 0.5) / G.width;
    const latLig = j => n - (n - sud) * (s.j0 + j + 0.5) / G.height;
    const [X0, Y0] = toLocal(lonCol(0), latLig(0));
    const [X1, Y1] = toLocal(lonCol(s.l - 1), latLig(s.h - 1));
    const dx = (X1 - X0) / (s.l - 1), dy = (Y0 - Y1) / (s.h - 1);
    const z = decoderSurface(s);
    // Le serveur rapporte les hauteurs au terrain ; la base du bâtiment est
    // enfoncée d'ENFONCEMENT sous lui (baseBatiment).
    const hauteur = (x, y) => {
        const fi = Math.min(Math.max((x - X0) / dx, 0), s.l - 1);
        const fj = Math.min(Math.max((Y0 - y) / dy, 0), s.h - 1);
        const i = Math.min(Math.floor(fi), s.l - 2), j = Math.min(Math.floor(fj), s.h - 2);
        const ai = fi - i, aj = fj - j, v = (a, b) => z[b * s.l + a];
        return (v(i, j) * (1 - ai) + v(i + 1, j) * ai) * (1 - aj)
             + (v(i, j + 1) * (1 - ai) + v(i + 1, j + 1) * ai) * aj + ENFONCEMENT;
    };

    // Anneau en mètres locaux, sans son dernier sommet s'il répète le premier.
    const ouvrir = a => {
        const p = a.map(([lo, la]) => toLocal(lo, la));
        const [fx, fy] = p[0], [lx, ly] = p[p.length - 1];
        return fx === lx && fy === ly ? p.slice(0, -1) : p;
    };
    const pts = ouvrir(anneau);
    if (pts.length < 3) return null;
    const cours = trous.map(ouvrir).filter(c => c.length >= 3);
    // Pièces à couper maille par maille : l'emprise, ou ses triangles.
    const v2de = a => a.map(([x, y]) => new THREE.Vector2(x, y));
    const sommets = pts.concat(...cours);
    const pieces = !cours.length ? [pts]
        : THREE.ShapeUtils.triangulateShape(v2de(pts), cours.map(v2de))
              .map(tri => tri.map(k => sommets[k]));

    // --- Toit : maille par maille. Les facettes trop raides rejoignent les murs.
    const toit = [], murs = [];
    const coupeX = x0 => (a, b) => [x0, a[1] + (b[1] - a[1]) * (x0 - a[0]) / (b[0] - a[0])];
    const coupeY = y0 => (a, b) => [a[0] + (b[0] - a[0]) * (y0 - a[1]) / (b[1] - a[1]), y0];
    const v2 = [], v2Libres = [];
    for (const piece of pieces) {
        let minY = Infinity, maxY = -Infinity;
        for (const p of piece) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
        // Une ligne et une colonne de marge : l'arrondi ne doit écarter aucune maille.
        const jDeb = Math.max(Math.floor((Y0 - maxY) / dy) - 1, 0);
        const jFin = Math.min(Math.floor((Y0 - minY) / dy) + 1, s.h - 2);
        // La pièce coupée aux deux bords d'une colonne ne dépend que de la
        // colonne : calculée une fois, puis coupée à chaque ligne. Les mêmes
        // coupes dans le même ordre, donc les mêmes sommets. Recoupée entière
        // à chaque maille, l'emprise coûtait 141 ms de coupes aux surfaces
        // mesurées de Strasbourg en zone de 1 000 m, 62 ms ainsi.
        const colonnes = [];
        for (let j = jDeb; j <= jFin; j++) {
            const yh = Y0 - j * dy, yb = yh - dy;
            // La bande de la ligne dit quelles colonnes la pièce y touche : la
            // boîte d'un triangle long et oblique est presque vide.
            let bande = couperPolygone(piece, p => p[1] >= yb, coupeY(yb));
            bande = couperPolygone(bande, p => p[1] <= yh, coupeY(yh));
            if (bande.length < 3) continue;
            let minX = Infinity, maxX = -Infinity;
            for (const p of bande) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); }
            const iDeb = Math.max(Math.floor((minX - X0) / dx) - 1, 0);
            const iFin = Math.min(Math.floor((maxX - X0) / dx) + 1, s.l - 2);
            for (let i = iDeb; i <= iFin; i++) {
                let colonne = colonnes[i];
                if (colonne === undefined) {
                    const xg = X0 + i * dx, xd = xg + dx;
                    colonne = couperPolygone(piece, p => p[0] >= xg, coupeX(xg));
                    colonnes[i] = colonne = couperPolygone(colonne, p => p[0] <= xd, coupeX(xd));
                }
                let c = couperPolygone(colonne, p => p[1] >= yb, coupeY(yb));
                c = couperPolygone(c, p => p[1] <= yh, coupeY(yh));
                if (c.length < 3) continue;
                // Des Vector2 réutilisés : triangulateShape n'en lit que x et y.
                v2.length = 0;
                for (let k = 0; k < c.length; k++) {
                    const v = v2Libres[k] || (v2Libres[k] = new THREE.Vector2());
                    v2.push(v.set(c[k][0], c[k][1]));
                }
                const tris = THREE.ShapeUtils.triangulateShape(v2, []);
                for (let t = 0; t < tris.length; t++) {
                    // Le plan (x, y) devient (x, -z) : l'ordre qui tourne dans le
                    // sens trigonométrique vu du nord... est inversé vu du ciel.
                    // On l'impose d'après l'aire, pour que la face regarde en haut.
                    const pa = c[tris[t][0]], pb = c[tris[t][1]], pd = c[tris[t][2]];
                    const aire = (pb[0] - pa[0]) * (pd[1] - pa[1]) - (pd[0] - pa[0]) * (pb[1] - pa[1]);
                    if (Math.abs(aire) < 1e-9) continue;
                    const p1 = aire > 0 ? pb : pd, p2 = aire > 0 ? pd : pb;
                    // Pente : composante verticale de la normale, |aire| étant la
                    // projection au sol de ce même produit vectoriel. Sommets
                    // (x, h, −y), relevés une seule fois, sans tableau de passage.
                    const x0 = pa[0], h0 = hauteur(pa[0], pa[1]), z0 = -pa[1];
                    const x1 = p1[0], h1 = hauteur(p1[0], p1[1]), z1 = -p1[1];
                    const x2 = p2[0], h2 = hauteur(p2[0], p2[1]), z2 = -p2[1];
                    const ux = x1 - x0, uy = h1 - h0, uz = z1 - z0;
                    const vx = x2 - x0, vy = h2 - h0, vz = z2 - z0;
                    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
                    const raide = ny < PENTE_MUR_COS * Math.hypot(nx, ny, nz);
                    (raide ? murs : toit).push(x0, h0, z0, x1, h1, z1, x2, h2, z2);
                }
            }
        }
    }
    if (!toit.length) return null;

    // --- Murs : chaque côté coupé aux lignes de la grille, là où le bord du
    // toit change de pente, et monté jusqu'à lui. Ceux d'une cour regardent
    // la cour : l'extérieur du bâtiment y est à l'intérieur de l'anneau.
    const debutPourtour = murs.length;
    for (const [anneauMur, versDehors] of [[pts, 1], ...cours.map(c => [c, -1])]) {
        let aire = 0;
        for (let k = 0; k < anneauMur.length; k++) {
            const [ax, ay] = anneauMur[k], [bx, by] = anneauMur[(k + 1) % anneauMur.length];
            aire += ax * by - bx * ay;
        }
        const sens = (aire > 0 ? 1 : -1) * versDehors;     // +1 : contour trigonométrique
        for (let k = 0; k < anneauMur.length; k++) {
            const a = anneauMur[k], b = anneauMur[(k + 1) % anneauMur.length];
            const ts = [0, 1];
            for (let i = 0; i < s.l; i++) {
                const x = X0 + i * dx;
                if ((x - a[0]) * (x - b[0]) < 0) ts.push((x - a[0]) / (b[0] - a[0]));
            }
            for (let j = 0; j < s.h; j++) {
                const y = Y0 - j * dy;
                if ((y - a[1]) * (y - b[1]) < 0) ts.push((y - a[1]) / (b[1] - a[1]));
            }
            ts.sort((p, q) => p - q);
            for (let m = 0; m < ts.length - 1; m++) {
                const p = [a[0] + (b[0] - a[0]) * ts[m], a[1] + (b[1] - a[1]) * ts[m]];
                const q = [a[0] + (b[0] - a[0]) * ts[m + 1], a[1] + (b[1] - a[1]) * ts[m + 1]];
                const hp = hauteur(p[0], p[1]), hq = hauteur(q[0], q[1]);
                // Face vers l'extérieur : à droite du côté parcouru dans le sens
                // trigonométrique, à gauche sinon.
                const quad = [[p, 0], [q, 0], [q, hq], [p, 0], [q, hq], [p, hp]];
                const tri = sens > 0 ? quad : [quad[0], quad[2], quad[1], quad[3], quad[5], quad[4]];
                for (const [[x, y], h] of tri) murs.push(x, h, -y);
            }
        }
    }

    const geo = v => geometrieFacettes(new Float32Array(v));
    // Le bruit du LiDAR, quelques centimètres d'une cellule à l'autre, incline
    // chaque facette de 0,5 m : ombrée à plat, la toiture paraissait rocheuse.
    // Lisser les hauteurs l'éloignait du LiDAR sans la rendre moins rugueuse sur
    // les toits raides ; on lisse donc l'ombrage seul, au-dessous d'un angle de
    // pli. Mesuré entre facettes voisines (Gordes, Strasbourg, une maison) :
    // 11° en médiane, 16 à 24° au 75e centile — le bruit — et 3 à 7 % au-delà
    // de 45° : faîtages, noues et marches, qui doivent rester nets.
    // Les marches du toit — ses facettes trop raides pour la photo — sont
    // rendues à part des murs du pourtour : elles sont du toit, et en prennent
    // la teinte. Peintes comme les murs, les tours coniques de Chambord, raides
    // de 65 à 75°, se mouchetaient vues du dessus, en orange sur le bâtiment
    // visé. Le pourtour seul porte le liseré de la cible (habillerCible).
    // Les normales du toit ne sont calculées qu'une fois, pliées : celles par
    // facette qu'y mettait geo() étaient aussitôt remplacées.
    const geoToit = new THREE.BufferGeometry();
    geoToit.setAttribute('position', new THREE.BufferAttribute(new Float32Array(toit), 3));
    return { toit: normalesPliees(geoToit, ANGLE_PLI_TOIT),
             murs: geo(murs.slice(debutPourtour)),
             marches: debutPourtour ? geo(murs.slice(0, debutPourtour)) : null };
}

/**
 * Toit et murs d'un bâtiment en pans (vue3d/pans.py), en coordonnées de
 * scène, base à 0 comme geometriesSurface. Les sommets arrivent en dixièmes
 * de maille depuis la première cellule de la fenêtre (vers l'est, vers le
 * sud) et en décimètres au-dessus du point bas du terrain ; les triangles,
 * orientés vers l'extérieur, commencent par ceux du toit.
 */
function geometriesPans(s) {
    const G = TOITS_GRILLE;
    const [w, sud, e, n] = G.bbox;
    const lonCol = i => w + (e - w) * (s.i0 + i + 0.5) / G.width;
    const latLig = j => n - (n - sud) * (s.j0 + j + 0.5) / G.height;
    const [X0, Y0] = toLocal(lonCol(0), latLig(0));
    const [X1, Y1] = toLocal(lonCol(1), latLig(1));
    const dx = (X1 - X0) / 10, dy = (Y0 - Y1) / 10;
    const S = s.sommets;
    // Même zéro que la surface : le toit est relevé d'ENFONCEMENT, dont
    // baseBatiment() enfonce la base ; le pied des murs reste enfoncé.
    const point = k => {
        const h = S[3 * k + 2] / 10;
        return [X0 + S[3 * k] * dx, h > 0 ? h + ENFONCEMENT : 0, -(Y0 - S[3 * k + 1] * dy)];
    };
    const geo = (debut, fin) => {
        const v = [];
        for (let t = debut; t < fin; t++)
            for (let m = 0; m < 3; m++) v.push(...point(s.triangles[3 * t + m]));
        // Non indexée : une normale par facette, les pans restent nets et le
        // faîtage franc.
        return geometrieFacettes(new Float32Array(v));
    };
    return { toit: geo(0, s.n_toit), murs: geo(s.n_toit, s.triangles.length / 3) };
}

/**
 * Dessus plat d'une emprise, à la hauteur `h` : un toit-terrasse, ou ce que les
 * toits résumés laissent à découvert — les tours rondes d'un château sous des
 * corps de toit rectangulaires. C'est un toit : il reçoit la photo aérienne,
 * dont la projection à la verticale est exacte sur une face horizontale. Peint
 * comme les murs, un quartier de toits plats était un damier gris vu du ciel.
 */
function geometrieDessus(anneau, trous, h) {
    const geo = new THREE.ShapeGeometry(anneauVersShape(anneau, trous));
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, h + DESSUS_DECALAGE, 0);
    return geo;
}

/** Pose un toit résumé ; `ud` est le userData de ses murs. */
export function poserToit(geo, ud) {
    const toit = new THREE.Mesh(geo, MAT_TOIT_VOISIN);
    toit.castShadow = true; toit.receiveShadow = true;
    toit.userData = ud;
    toit.name = 'toit';
    groupeBatiments.add(toit);
    meshes.push(toit);
    meshesToits.push(toit);
}

/** Pose le dessus plat d'un volume ; `ud` est le userData de ses murs. */
export function poserDessus(anneau, trous, h, ud) {
    const dessus = new THREE.Mesh(geometrieDessus(anneau, trous, h), MAT_DESSUS);
    dessus.receiveShadow = true;
    dessus.userData = { ...ud, dessus: true };
    dessus.name = 'toit';
    groupeBatiments.add(dessus);
    meshes.push(dessus);
    meshesToits.push(dessus);
}

/** Boîte d'un corps de toit LiDAR, centrée, dans le repère de son axe. */
export function rectangleDeCorps(corps) {
    const ang = (corps.axe_deg != null ? corps.axe_deg : 0) * Math.PI / 180;
    // Le centre (cx, cy) est en mètres locaux ; on le ramène dans le repère
    // tourné, où la boîte est axée.
    const cos = Math.cos(-ang), sin = Math.sin(-ang);
    const cx = corps.cx * cos - corps.cy * sin, cy = corps.cx * sin + corps.cy * cos;
    return { ang, x0: cx - corps.longueur / 2, x1: cx + corps.longueur / 2,
                  y0: cy - corps.largeur / 2, y1: cy + corps.largeur / 2 };
}

export function anneauVersShape(anneau, trous = []) {
    const tracer = (chemin, pts) => {
        pts.forEach(([lon, lat], i) => {
            const [x, y] = toLocal(lon, lat);
            // Le plan de la Shape est extrudé vers +Z puis couché : on inverse y.
            if (i === 0) chemin.moveTo(x, y); else chemin.lineTo(x, y);
        });
        return chemin;
    };
    const forme = tracer(new THREE.Shape(), anneau);
    // Cours intérieures : l'extrusion les laisse ouvertes et leur donne des murs.
    for (const trou of trous) forme.holes.push(tracer(new THREE.Path(), trou));
    return forme;
}

/**
 * Toit et murs mesurés d'une emprise (geometriesPans, geometriesSurface),
 * calculés une fois par mesure LiDAR et par emprise. construire() est
 * rappelée à l'arrivée des monuments OSM et à chaque bouton des toits : à
 * Strasbourg en zone de 1 000 m, refaire les 251 surfaces mesurées arrêtait
 * l'image 0,47 s après l'affichage, 0,09 s ainsi. Les sommets et les normales
 * sont repris tels quels dans de nouvelles géométries — les mêmes attributs
 * que la première fois, sans les coordonnées de texture qu'un fond y a
 * posées depuis.
 */
const cacheMesurees = new WeakMap();      // mesure LiDAR → [{ anneau, trous, tableaux }]

export function geometriesMesurees(anneau, lidar, trous) {
    const mesure = lidar.pans || lidar.surface;
    let liste = cacheMesurees.get(mesure);
    if (!liste) cacheMesurees.set(mesure, liste = []);
    const deja = liste.find(e => e.anneau === anneau && e.trous.length === trous.length
                                 && e.trous.every((t, i) => t === trous[i]));
    if (deja) {
        if (!deja.tableaux) return null;
        const r = {};
        for (const [cle, t] of Object.entries(deja.tableaux)) {
            if (!t) { r[cle] = null; continue; }
            r[cle] = new THREE.BufferGeometry();
            r[cle].setAttribute('position', new THREE.BufferAttribute(t.position, 3));
            r[cle].setAttribute('normal', new THREE.BufferAttribute(t.normal, 3));
        }
        return r;
    }
    const geos = lidar.pans ? geometriesPans(lidar.pans) : geometriesSurface(anneau, lidar.surface, trous);
    let tableaux = null;
    if (geos) {
        tableaux = {};
        for (const [cle, g] of Object.entries(geos)) {
            tableaux[cle] = g && { position: g.attributes.position.array, normal: g.attributes.normal.array };
        }
    }
    liste.push({ anneau, trous, tableaux });
    return geos;
}

/**
 * Polygones d'une emprise : contour extérieur (`anneau`) et cours intérieures
 * (`trous`). Le contour seul faisait d'un îlot un bloc plein.
 */
export function polygonesDe(geometry) {
    if (!geometry) return [];
    const polygones = geometry.type === 'Polygon' ? [geometry.coordinates]
                    : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
    return polygones.map(p => ({ anneau: p[0], trous: p.slice(1).filter(t => t.length >= 4) }));
}
