// Le relief du terrain, et les couches qui s'y posent.

import * as THREE from 'three';
import { CENTER, ZONE, ECHELLE_ZONE } from '../socle/point.js';
import { chargerImage } from '../socle/reseau.js';
import { ARTEFACT, chargementArtefact } from '../socle/chargement.js';
import { M_PAR_DEGRE_LAT, toLocal, toLonLat } from '../socle/projection.js';
import {
    terrain, altitudeRef, relief, exagVert, anneauRelief, poserTerrain, poserAltitudeRef,
    marquerReliefRegle, BORNES, poserBornes, baseBatiment,
} from './etat.js';
import { scene, sol } from '../socle/rendu.js';
import { normalesIndexees, sphereEnglobante } from '../geometrie/normales.js';
import { groupeBatiments } from '../batiments/etat.js';
import { pointDansAnneau } from '../geometrie/polygones.js';
import { cadrer } from '../interface/cadrage.js';
import { citerSource, majCredits } from '../interface/credits.js';
import {
    versTuile, versLonLat, fondTexture, fondBornes, quandLeFondEstPose, poserFond, fondActif,
} from './fond.js';

// Deux sources, dans cet ordre.
//
// 1. RGE ALTI (IGN, Géoplateforme). Une requête WMS rend directement une
//    grille de flottants : ni tuiles à assembler, ni image à décoder, ni clé
//    d'API. C'est un modèle de TERRAIN, et il tient l'erreur sous le mètre
//    quel que soit le relief.
// 2. AWS Terrain Tiles, en repli mondial. En Europe la source est EU-DEM,
//    maillée à 25 m, et c'est un modèle de SURFACE : il lit la végétation et
//    les toitures, d'où un biais positif qui croît avec la pente.
//
// Mesuré contre les altitude_minimale_sol de la BD TOPO (photogrammétrie IGN),
// erreur absolue médiane sur 246 à 999 emprises par site :
//
//                              RGE ALTI     Terrarium
//   Gonfreville (plat)           0,61 m   1,21 m (biais +0,37)
//   Roches-Roussillon (pente)    0,54 m   1,47 m (biais +0,75)
//   Lacq                         0,72 m   2,18 m (biais +2,18)
const RGE_URL = 'https://data.geopf.fr/wms-r/wms';
// Le WMS mêle ses −99 999 (mer, étranger) aux altitudes voisines : sous
// −20 m, c'est un trou, et le mélange déborde de ~6 m autour. Mêmes seuil et
// élargissement que le serveur, mesurés dans vue3d/relief.py.
const RELIEF_TROU_SOUS_M = -20;
const RELIEF_TROU_ELARGISSEMENT_M = 6;
export const TERRAIN_ZOOM = 15;         // maximum publié ; au-delà, 404
export const TERRAIN_URL = (z, x, y) =>
    `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

export const MAT_TERRAIN = new THREE.MeshStandardMaterial({ color: 0x39424c, roughness: 1 });
quandLeFondEstPose(() => appliquerTextureTerrain());

// Pixel global à 256 px par tuile ; versTuile() en est le quotient entier.
export const versPixel = (lon, lat, z) => {
    const n = 2 ** z * 256;
    const rad = lat * Math.PI / 180;
    return [
        (lon + 180) / 360 * n,
        (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n,
    ];
};

/** Interpolation bilinéaire sur une grille régulière, ligne 0 au nord. */
function echantillonneur(valeurs, largeur, hauteur, bornes) {
    // Un sommet posé exactement sur le bord y revient à un cheveu au-delà :
    // les positions d'un maillage sont en Float32, soit ~4 µm d'erreur à
    // 128 m du centre. Mesuré à Gordes et Versailles, les colonnes ouest et
    // est entières (179 sommets chacune) étaient refusées et retombaient à
    // l'altitude du centre — un mur tout le long de l'emprise. Un millième de
    // maille de dépassement (1 mm pour le relief fin) est donc ramené au bord.
    const TOLERANCE = 1e-3;
    return function (lon, lat) {
        let fx = (lon - bornes.o) / (bornes.e - bornes.o) * (largeur - 1);
        let fy = (bornes.n - lat) / (bornes.n - bornes.s) * (hauteur - 1);
        if (!(fx >= -TOLERANCE && fy >= -TOLERANCE
              && fx <= largeur - 1 + TOLERANCE && fy <= hauteur - 1 + TOLERANCE)) return null;
        fx = Math.min(Math.max(fx, 0), largeur - 1);
        fy = Math.min(Math.max(fy, 0), hauteur - 1);
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const x1 = Math.min(x0 + 1, largeur - 1), y1 = Math.min(y0 + 1, hauteur - 1);
        const ax = fx - x0, ay = fy - y0;
        const v = (x, y) => valeurs[y * largeur + x];
        return (v(x0, y0) * (1 - ax) + v(x1, y0) * ax) * (1 - ay)
             + (v(x0, y1) * (1 - ax) + v(x1, y1) * ax) * ay;
    };
}

/**
 * Bouche les trous (NaN) d'une grille de proche en proche depuis leur bord :
 * chaque trou qui touche une valeur connue (4-voisinage) en prend la moyenne,
 * puis ses voisins encore vides à la passe suivante. La moyenne de toute la
 * grille posait le coin de mer de Monaco à 30 m, son rivage étant entre 0,5
 * et 6,8 m. Rend le nombre de trous ; une grille toute en trous reste telle.
 */
function boucherTrous(valeurs, largeur) {
    const n = valeurs.length;
    let trous = 0;
    for (let i = 0; i < n; i++) if (Number.isNaN(valeurs[i])) trous++;
    if (trous === 0 || trous === n) return trous;
    const voisins = new Int32Array(4);
    const lireVoisins = i => {
        const x = i % largeur;
        voisins[0] = x > 0 ? i - 1 : -1;
        voisins[1] = x < largeur - 1 ? i + 1 : -1;
        voisins[2] = i >= largeur ? i - largeur : -1;
        voisins[3] = i + largeur < n ? i + largeur : -1;
    };
    const vu = new Uint8Array(n);
    let front = [];
    for (let i = 0; i < n; i++) {
        if (!Number.isNaN(valeurs[i])) continue;
        lireVoisins(i);
        if (voisins.some(v => v >= 0 && !Number.isNaN(valeurs[v]))) { front.push(i); vu[i] = 1; }
    }
    while (front.length) {
        // Toutes les moyennes d'une passe avant d'en écrire une : le résultat
        // ne dépend pas de l'ordre de parcours.
        const moyennes = front.map(i => {
            lireVoisins(i);
            let somme = 0, connus = 0;
            for (const v of voisins) if (v >= 0 && !Number.isNaN(valeurs[v])) { somme += valeurs[v]; connus++; }
            return somme / connus;
        });
        front.forEach((i, k) => { valeurs[i] = moyennes[k]; });
        const suivant = [];
        for (const i of front) {
            lireVoisins(i);
            for (const v of voisins) if (v >= 0 && !vu[v] && Number.isNaN(valeurs[v])) { vu[v] = 1; suivant.push(v); }
        }
        front = suivant;
    }
    return trous;
}

/**
 * Trous d'une grille brute du RGE ALTI : sous RELIEF_TROU_SOUS_M, élargis de
 * `pas` pixels en croix, comme relief._elargir côté serveur.
 */
function masqueTrous(grille, largeur, pas) {
    const n = grille.length;
    let masque = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (grille[i] < RELIEF_TROU_SOUS_M) masque[i] = 1;
    for (let p = 0; p < pas; p++) {
        const m = masque.slice();
        for (let i = 0; i < n; i++) {
            if (!masque[i]) continue;
            const x = i % largeur;
            if (x > 0) m[i - 1] = 1;
            if (x < largeur - 1) m[i + 1] = 1;
            if (i >= largeur) m[i - largeur] = 1;
            if (i + largeur < n) m[i + largeur] = 1;
        }
        masque = m;
    }
    return masque;
}

/**
 * RGE ALTI par WMS, en BIL float32.
 *
 * Trois pièges, tous vérifiés contre le service :
 *  - en WMS 1.3.0 avec EPSG:4326 la BBOX s'écrit lat,lon. Inversée, le service
 *    répond 200 avec une grille entièrement nodata (ou pire, plausible) ;
 *  - le corps est du float32 little-endian brut, première ligne au NORD ;
 *  - hors couverture (étranger, Nouvelle-Calédonie) tout vaut -99999. Décodé
 *    sans filtre, ça creuse un gouffre de cent kilomètres sous la scène. Au
 *    bord d'un tel trou, le service mêle ce -99999 aux voisins (-99 955 m à
 *    Monaco) : d'où le seuil et l'élargissement de masqueTrous.
 */
async function chargerRgeAlti() {
    const [ax, ay] = toLocal(BORNES.o, BORNES.n);
    const [bx, by] = toLocal(BORNES.e, BORNES.s);
    // ~1 m par maille, ce que rend la source ; 1024 = 4 Mio, le plafond utile.
    const taille = Math.min(1024, Math.max(256, Math.round(Math.abs(bx - ax))));

    const url = `${RGE_URL}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap`
        + '&LAYERS=ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES&STYLES=&CRS=EPSG:4326'
        + '&FORMAT=image/x-bil;bits=32'
        + `&WIDTH=${taille}&HEIGHT=${taille}`
        + `&BBOX=${BORNES.s},${BORNES.o},${BORNES.n},${BORNES.e}`;

    const reponse = await fetch(url);
    const type = reponse.headers.get('content-type') || '';
    // Une erreur WMS arrive en XML avec un code 200 : c'est le type qui tranche.
    if (!reponse.ok || !type.startsWith('image/x-bil')) return null;

    const grille = new Float32Array(await reponse.arrayBuffer());
    if (grille.length !== taille * taille) return null;

    const maille = (BORNES.n - BORNES.s) * M_PAR_DEGRE_LAT / (taille - 1);
    const trous = masqueTrous(grille, taille, Math.ceil(RELIEF_TROU_ELARGISSEMENT_M / maille));
    let nodata = 0;
    const valeurs = new Float64Array(grille.length);
    for (let i = 0; i < grille.length; i++) {
        if (trous[i]) { valeurs[i] = NaN; nodata++; }
        else valeurs[i] = grille[i];
    }
    // Au-delà de quelques pour cent de trous on est en bord de couverture :
    // mieux vaut le repli mondial qu'un rapiéçage.
    if (nodata / grille.length > 0.02) return null;
    boucherTrous(valeurs, taille);

    return { nom: 'RGE ALTI (IGN)', precision: '1 m, modèle de terrain',
             alt: echantillonneur(valeurs, taille, taille, BORNES) };
}

/**
 * AWS Terrain Tiles, encodage terrarium.
 *
 * Une tuile absente laisse ses pixels à alpha 0 ; les décoder rendrait
 * −32768 m. D'où le test d'alpha avant décodage, et le bouchage des trous.
 */
async function chargerTerrarium() {
    const [tx0, ty0] = versTuile(BORNES.o, BORNES.n, TERRAIN_ZOOM);
    const [tx1, ty1] = versTuile(BORNES.e, BORNES.s, TERRAIN_ZOOM);
    const nx = tx1 - tx0 + 1, ny = ty1 - ty0 + 1;

    const canvas = document.createElement('canvas');
    canvas.width = nx * 256;
    canvas.height = ny * 256;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // L'altitude est encodée dans les octets R/G/B : tout lissage interpolerait
    // des octets encodés, ce qui n'a aucun sens. Dessin à l'échelle 1:1.
    ctx.imageSmoothingEnabled = false;

    let recues = 0;
    await Promise.all(Array.from({ length: nx * ny }, (_, k) => {
        const x = tx0 + (k % nx), y = ty0 + Math.floor(k / nx);
        return chargerImage(TERRAIN_URL(TERRAIN_ZOOM, x, y))
            .then(img => { ctx.drawImage(img, (x - tx0) * 256, (y - ty0) * 256); recues++; })
            .catch(() => { /* tuile absente : alpha 0, donc trou */ });
    }));
    if (!recues) return null;

    const W = canvas.width, H = canvas.height;
    const px = ctx.getImageData(0, 0, W, H).data;
    const valeurs = new Float64Array(W * H);
    for (let i = 0; i < W * H; i++) {
        const j = i * 4;
        valeurs[i] = px[j + 3] === 0 ? NaN
                   : (px[j] * 256 + px[j + 1] + px[j + 2] / 256) - 32768;
    }
    if (boucherTrous(valeurs, W) === valeurs.length) return null;

    // Emprise réelle du composite, alignée sur les tuiles.
    const [lonO, latN] = versLonLat(tx0, ty0, TERRAIN_ZOOM);
    const [lonE, latS] = versLonLat(tx1 + 1, ty1 + 1, TERRAIN_ZOOM);
    return { nom: 'AWS Terrain Tiles', precision: '25 m, modèle de surface',
             alt: echantillonneur(valeurs, W, H, { o: lonO, e: lonE, s: latS, n: latN }) };
}

/** Drape l'ortho sur le terrain, par projection zénithale comme pour les toits. */
function appliquerTextureTerrain() {
    if (!terrain) return;
    const geo = terrain.mesh.geometry;
    if (!fondTexture || !fondBornes) { terrain.mesh.material = MAT_TERRAIN; return; }
    const pos = geo.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
        uv[i * 2] = (pos.getX(i) - fondBornes.minX) / (fondBornes.maxX - fondBornes.minX);
        uv[i * 2 + 1] = 1 - (pos.getZ(i) - fondBornes.minZ) / (fondBornes.maxZ - fondBornes.minZ);
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const m = new THREE.MeshStandardMaterial({ map: fondTexture, roughness: 1, metalness: 0 });
    // Photo projetée du zénith : sur une paroi, un pixel s'étire de 1/cos de la
    // pente, ×1,3 à 40°, ×2 à 60°, en traînées verticales. Au rocher du
    // Mont-Saint-Michel, elles se voient dès 40° : on y glisse vers une teinte
    // de granite, pleine à 60°. Le relief étant posé sans rotation, la
    // normale du maillage est déjà celle du monde.
    m.onBeforeCompile = shader => {
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying float vNormaleY;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvNormaleY = normal.y;');
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nvarying float vNormaleY;')
            .replace('#include <map_fragment>', '#include <map_fragment>\n'
                + 'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.22, 0.21, 0.2), smoothstep(0.77, 0.5, vNormaleY));');
    };
    m.customProgramCacheKey = () => 'terrain-parois';
    terrain.mesh.material = m;
}

/** Redéplace les vertex du terrain selon l'exagération courante. */
function deplacerTerrain() {
    const pos = terrain.mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        pos.array[3 * i + 1] = (terrain.hauteurs[i] - altitudeRef) * exagVert;
    }
    pos.needsUpdate = true;
    // Les calculs de three.js sans leurs objets intermédiaires : 263 000
    // sommets en zone de 1 000 m, refaits à chaque cran du curseur.
    normalesIndexees(terrain.mesh.geometry);
    sphereEnglobante(terrain.mesh.geometry);
}

/**
 * Repose chaque bâtiment sur son emprise. Aucune géométrie n'est retouchée.
 *
 * Seule la BASE suit l'exagération : le bâtiment reçoit l'élévation du sol
 * telle qu'elle est rendue dans la scène, exagération comprise, mais garde sa
 * hauteur réelle. Dilater les volumes eux-mêmes transformait les maisons en
 * tours dès ×3.
 *
 * Sur une forte pente, le toit est de plus relevé au-dessus du terrain médian
 * de l'emprise (releveSol) : les murs s'allongent vers le bas d'autant, le
 * toit monte, le bâtiment ne flotte toujours pas côté aval. Seules les
 * hauteurs comptées depuis le sol local y ont droit (releve !== false) :
 * celles de la BD TOPO partent déjà du point bas, les relever comptait la
 * pente deux fois.
 */
export function rebaserBatiments() {
    for (const o of groupeBatiments.children) {
        const ud = o.userData;
        if (!ud.anneau) continue;
        const base = baseBatiment(ud.anneau);
        const d = toitReleve(ud) ? releveSol(ud.anneau) : 0;
        if (o.name === 'toit') {
            o.position.y = base + d;
        } else {
            o.position.y = base;
            o.scale.y = ud.hMur > 0 ? (ud.hMur + d) / ud.hMur : 1;
        }
    }
}

// Relèvement sur la pente. La base est le point le plus bas du terrain sous le
// contour, pour qu'un bâtiment à cheval sur une rupture de pente ne flotte pas
// côté aval ; mais les hauteurs LiDAR se comptent depuis son sol, plus haut :
// le MNH est une hauteur au-dessus du sol de chaque cellule. Posées sur le
// point bas, elles enfouissaient le toit sous le terrain. Mesuré, toits
// passant sous le point le plus haut du terrain de leur emprise :
//
//                     posés au point bas   relevés du terrain médian
//   Mont-Saint-Michel       15 / 104                1
//   Rocamadour              13 / 139                3
//   Gordes                   3 / 249                1
//
// L'écart médiane − point bas y atteint 23 m au Mont, 63 m à Rocamadour, pour
// 1 à 2 m en médiane : il ne change presque rien ailleurs.
// Les hauteurs BD TOPO, elles, partent d'un sol que ses propres levés placent
// au point bas du pied du bâtiment — la référence de la base : leur relevé
// comptait la pente deux fois (+2,3 m sur une cabane aux murs déjà annoncés à
// 8,1 m). releve === false les en dispense. Mesuré (même critère, enfoncement
// déduit) : la dispense ne ré-enfouit rien à Gordes (10 avant comme après) ni
// au Mont (7) ; à Rocamadour, 1 toit sur 19 en repli BD TOPO passe sous le
// point le plus haut de son emprise (16 → 17) sans passer sous le terrain
// médian — accepté. Un garde-fou « relever quand même si médiane − point bas
// dépasse la hauteur du bâtiment » ne se déclenchait sur aucun des trois
// sites : retiré.
const cacheSolEmprise = new WeakMap();

/** Le toit est-il relevé du point bas au terrain médian de son emprise ? */
export function toitReleve(ud) { return !(ud.surface || ud.releve === false); }

/** Terrain sous une emprise : point le plus bas du contour, médiane dedans. */
export function terrainSousEmprise(anneau) {
    const deja = cacheSolEmprise.get(anneau);
    if (deja && deja.terrain === terrain) return deja;
    let min = Infinity;
    let o = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
    for (const [lon, lat] of anneau) {
        const a = terrain.alt(lon, lat);
        if (a != null) min = Math.min(min, a);
        o = Math.min(o, lon); e = Math.max(e, lon); s = Math.min(s, lat); n = Math.max(n, lat);
    }
    // Une grille de 10 × 10 points sur la boîte, gardés dans l'emprise.
    const dedans = [];
    for (let i = 0; i < 10; i++) {
        for (let j = 0; j < 10; j++) {
            const lon = o + (e - o) * (i + 0.5) / 10, lat = s + (n - s) * (j + 0.5) / 10;
            if (!pointDansAnneau(lon, lat, anneau)) continue;
            const a = terrain.alt(lon, lat);
            if (a != null) dedans.push(a);
        }
    }
    dedans.sort((a, b) => a - b);
    const med = dedans.length ? dedans[dedans.length >> 1] : min;
    const r = { terrain, min, med };
    cacheSolEmprise.set(anneau, r);
    return r;
}

/** Relèvement du toit, en unités de scène (l'exagération s'applique au terrain). */
function releveSol(anneau) {
    if (!relief || !terrain) return 0;
    const { min, med } = terrainSousEmprise(anneau);
    return Number.isFinite(min) && Number.isFinite(med) ? Math.max(med - min, 0) * exagVert : 0;
}

// La source du relief affiché, citée par les crédits.
export let sourceRelief = null;
citerSource('relief', () => sourceRelief);

/**
 * Les couches posées sur le relief, dans l'ordre de la page : chacune s'inscrit
 * (poserSurLeRelief) avec `construire`, appelée quand le relief est connu ou a
 * fini d'échouer, et `placer`, à chaque changement d'exagération. Celles qui
 * ont `apresBatiments` sont replacées après eux : les panneaux se posent sur
 * les toits rebasés.
 */
const couchesSurLeRelief = [];
export function poserSurLeRelief(couche) {
    couchesSurLeRelief.push(couche);
}

/**
 * Nouvelle exagération : tout se translate, rien ne se reconstruit.
 *
 * C'est ce qui rend le curseur utilisable — il émet un événement par cran de
 * glissement, et reconstruire les volumes (ou recharger l'ortho) à chaque fois
 * rendait la scène inutilisable.
 */
export function appliquerExageration() {
    if (terrain) deplacerTerrain();
    for (const c of couchesSurLeRelief) if (c.placer && !c.apresBatiments) c.placer();
    // Le grand plan gris sert de fond au-delà de l'emprise, et sous les trous
    // de l'anneau : on le glisse sous le point le plus bas du terrain pour
    // qu'il ne le traverse pas.
    const plusBas = anneauRelief ? Math.min(terrain.min, anneauRelief.min) : terrain?.min;
    sol.position.y = (relief && terrain)
        ? Math.min(0, (plusBas - altitudeRef) * exagVert) - 0.5
        : 0;
    rebaserBatiments();
    for (const c of couchesSurLeRelief) if (c.placer && c.apresBatiments) c.placer();
}

/** Bascule du relief : le fond passe du plan plat au maillage, ou l'inverse. */
export function appliquerRelief() {
    if (terrain) terrain.mesh.visible = relief;
    // Sans relief, la scène repose sur le grand plan à 0 : un anneau à plat
    // le z-fighterait sans rien montrer de plus.
    if (anneauRelief) anneauRelief.mesh.visible = relief;
    appliquerExageration();
    poserFond(fondActif);
}

/**
 * Charge le relief après la scène, sans la bloquer : une panne des deux
 * sources doit coûter le relief, pas la vue.
 */
/**
 * Relief embarqué dans l'artefact : la même grille RGE ALTI que la vue
 * téléchargeait, quantifiée au décimètre sur des entiers 16 bits.
 *
 * 263 Ko de flottants bruts à chaque ouverture contre 11 à 46 Ko une fois
 * l'artefact compressé, et une requête de moins sur l'hôte de l'IGN, déjà
 * chargé des tuiles.
 */
function reliefDeLArtefact() {
    const r = ARTEFACT && ARTEFACT.relief;
    const alt = decoderRelief(r, true);
    if (!alt) return null;
    return { nom: r.source || 'RGE ALTI (IGN)',
             precision: r.precision || '1 m, modèle de terrain', alt };
}

/**
 * Échantillonneur d'une grille de relief de l'artefact, ou null.
 *
 * Sans bouchage, un trou vaut NaN, et l'interpolation bilinéaire le propage à
 * toute maille qui le touche : c'est ce que veut l'anneau, dont la mer et
 * l'étranger doivent rester vides plutôt que rapiécés.
 */
export function decoderRelief(r, boucher) {
    if (!r || !r.altitudes) return null;
    const brut = atob(r.altitudes);
    const n = brut.length >> 1;
    if (n !== r.width * r.height) return null;
    const octets = new Uint8Array(brut.length);
    for (let i = 0; i < brut.length; i++) octets[i] = brut.charCodeAt(i);
    const entiers = new Int16Array(octets.buffer);
    const valeurs = new Float64Array(n);
    let connus = 0;
    for (let i = 0; i < n; i++) {
        // -32768 marque un trou, comme côté serveur. Sous RELIEF_TROU_SOUS_M
        // aussi : une scène mise en cache avant que le serveur ne reconnaisse
        // les trous mêlés aux voisins (Monaco : tout à −96 678 m) ne doit pas
        // envoyer l'anneau et l'horizon à 96 km au-dessus d'elle.
        const a = r.zero_m + entiers[i] * r.pas_m;
        valeurs[i] = entiers[i] === -32768 || a < RELIEF_TROU_SOUS_M ? NaN : a;
        if (!Number.isNaN(valeurs[i])) connus++;
    }
    if (!connus) return null;
    if (boucher) boucherTrous(valeurs, r.width);
    const b = r.bbox;
    return echantillonneur(valeurs, r.width, r.height, { o: b[0], s: b[1], e: b[2], n: b[3] });
}

/**
 * Les couches construites, dans l'ordre de leur inscription. Le relief est
 * réglé avant : ouvrages, nuage, détections, panneaux et bornes l'attendent
 * (les précédentes ne le lisent pas).
 */
function construireCouchesSurLeRelief() {
    marquerReliefRegle();
    for (const c of couchesSurLeRelief) if (c.construire) c.construire();
}

async function chargerRelief() {
    const noteT = document.getElementById('note-terrain');

    await chargementArtefact;
    if (ARTEFACT && ARTEFACT.bbox) {
        const [o, s, e, n] = ARTEFACT.bbox;
        poserBornes({ o, s, e, n });
    }
    let source = reliefDeLArtefact();
    if (!source) {
        try { source = await chargerRgeAlti(); }
        catch (e) { console.warn('RGE ALTI indisponible :', e); }
    }
    if (!source) {
        try { source = await chargerTerrarium(); }
        catch (e) { console.warn('Terrain Tiles indisponible :', e); }
    }
    if (!source) {
        noteT.textContent = "Relief indisponible : aucune source d'altitude n'a répondu.";
        document.getElementById('s-src').textContent = 'aucune';
        construireCouchesSurLeRelief();     // à plat, faute de terrain
        return;
    }

    // Zéro de la scène = altitude au centre de l'emprise, pour que le cadrage
    // et les distances restent valables d'un site à 0 m comme à 900 m.
    poserAltitudeRef(source.alt(CENTER[0], CENTER[1]) ?? 0);

    const [ax, ay] = toLocal(BORNES.o, BORNES.n);
    const [bx, by] = toLocal(BORNES.e, BORNES.s);
    const largeur = Math.abs(bx - ax), profondeur = Math.abs(by - ay);
    // Un vertex tous les ~2 m, plafonné à 256 subdivisions — 512 pour une
    // zone élargie, dont le relief serveur a jusqu'à 512 points de côté, et
    // 1 024 au-delà de 1 000 m, où il en a 512 par kilomètre
    // (scene.RELIEF_POINTS_PAR_KM).
    const segMax = ECHELLE_ZONE > 1 ? (ZONE > 1000 ? 1024 : 512) : 256;
    const segX = Math.min(segMax, Math.max(16, Math.round(largeur / 2)));
    const segZ = Math.min(segMax, Math.max(16, Math.round(profondeur / 2)));

    const geo = new THREE.PlaneGeometry(largeur, profondeur, segX, segZ);
    geo.rotateX(-Math.PI / 2);          // le +Y du plan devient le nord (-Z)
    const cx = (ax + bx) / 2, cz = (-ay + -by) / 2;
    geo.translate(cx, 0, cz);
    // Abscisses et profondeurs des lignes du maillage, par la même formule que
    // PlaneGeometry : l'anneau s'y raccorde sommet pour sommet.
    const lignes = {
        xs: Array.from({ length: segX + 1 }, (_, i) => cx + i * largeur / segX - largeur / 2),
        zs: Array.from({ length: segZ + 1 }, (_, j) => cz + j * profondeur / segZ - profondeur / 2),
    };

    const pos = geo.attributes.position;
    const hauteurs = new Float64Array(pos.count);
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < pos.count; i++) {
        const [lon, lat] = toLonLat(pos.getX(i), -pos.getZ(i));
        const a = source.alt(lon, lat) ?? altitudeRef;
        hauteurs[i] = a;
        min = Math.min(min, a); max = Math.max(max, a);
    }

    const mesh = new THREE.Mesh(geo, MAT_TERRAIN);
    mesh.receiveShadow = true;
    // Le terrain projette aussi : c'est ce qui fait apparaître l'ombre d'un
    // coteau sur le bâtiment visé quand le soleil rase, et sans quoi le curseur
    // horaire ne montrerait que les ombres des bâtiments.
    mesh.castShadow = true;
    scene.add(mesh);
    poserTerrain({ alt: source.alt, min, max, mesh, hauteurs, lignes });
    construireCouchesSurLeRelief();
    sourceRelief = source.nom;
    majCredits();

    document.getElementById('s-src').textContent = source.nom;
    document.getElementById('s-alt').textContent = `${altitudeRef.toFixed(0)} m`;
    document.getElementById('s-amp').textContent = `${(max - min).toFixed(1)} m`;
    noteT.textContent = `${source.precision}. Les bâtiments sont posés sur le point `
        + `le plus bas du terrain sous leur emprise ; leurs hauteurs viennent de `
        + `la BD TOPO, jamais d'une différence entre sources.`;

    // Le relief arrive après les bâtiments : tout est replacé, et l'ortho
    // redrapée sur le maillage au lieu du plan plat.
    appliquerRelief();
    cadrer();
}
chargerRelief();
