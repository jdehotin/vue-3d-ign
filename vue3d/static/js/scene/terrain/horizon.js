// L'horizon jusqu'à 60 km, et le ciel.

import * as THREE from 'three';
import { FONDS, ALTI_URL, ALTI_NIVEAU_MIN, ALTI_NIVEAU_MAX } from '../../commun/tuiles.js';
import { ECHELLE_ZONE } from '../socle/point.js';
import { chargerImage } from '../socle/reseau.js';
import { ARTEFACT } from '../socle/chargement.js';
import { M_PAR_DEGRE_LAT, M_PAR_DEGRE_LON, toLocal, toLonLat } from '../socle/projection.js';
import {
    terrain, altitudeRef, relief, exagVert, anneauRelief, horizonActif, basculerHorizonActif,
} from './etat.js';
import {
    scene, FOND_SCENE, brumeScene, brumeHorizon, ciel, camera, renderer, sol,
} from '../socle/rendu.js';
import { citerSource, majCredits } from '../interface/credits.js';
import { relireTuile, versTuile, versLonLat, quandLeFondChange, fondActif } from './fond.js';
import { TERRAIN_ZOOM, TERRAIN_URL, MAT_TERRAIN, versPixel, poserSurLeRelief } from './relief.js';
import { poserFondAnneau } from './anneau.js';

// Au-delà de l'anneau, le paysage jusqu'à HORIZON_RAYON : des tuiles du
// découpage XYZ des fonds de l'IGN, d'autant plus grossières qu'elles sont loin
// de la caméra, qu'elles suivent — c'est ce qui laisse le drone quitter la
// scène. Chaque tuile porte le fond actif à son niveau de zoom et 33 × 33
// sommets, dont l'altitude est interpolée dans les tuiles natives du RGE ALTI.
//
// Natives, et non lues au WMS. Le WMS rééchantillonne au plus proche une
// pyramide en degrés carrés, dont le pixel est 1,4 fois plus haut que large à
// 44° de latitude : une grille carrée en mètres y répète une ligne sur quatre
// (plages de 1,25 à 1,28 lignes, de 55 à 880 m par pixel, versant nord du
// Luberon, mesuré le 2026-10-10), et le relief sortait en gradins. Il limite
// de plus chaque adresse à 40 requêtes par seconde (en-tête ratelimit-limit) :
// une requête par tuile, 400 en 4 s à l'ouverture de Gordes, y étaient
// refusées en 429. Les tuiles WMTS de la même pyramide (WGS84G, niveaux 6 à
// 14, 256 × 256 flottants) rendent les mêmes valeurs aux centres des pixels,
// sans aucune répétition du niveau 8 au niveau 14, et n'annoncent aucune
// limite ; l'interpolation se fait ici.
//
// Deux tuiles voisines d'un même niveau lisent les mêmes pixels : leur bord
// commun est identique au bit près, leurs normales aussi. Entre deux niveaux,
// les sommets du bord fin tombent entre ceux du bord grossier ; une jupe
// pendue sous chaque bord bouche la fente.
//
// L'horizon ne remplace ni la scène ni l'anneau : il est percé (masque) là où
// ils ont des facettes, sauf sur une bande de HORIZON_RECOUVREMENT au bord où il
// passe dessous, repoussé en profondeur. Les deux portent la même orthophoto :
// là où leurs altitudes se croisent, c'est la même image qui affleure. La mer,
// trou de l'anneau, reste à l'horizon, posée à 0 m.
export const HORIZON_ZOOM_MIN = 9;          // ~55 km de côté en France
export const HORIZON_ZOOM_MAX = 17;         // ~220 m de côté, 0,9 m par pixel, 7 m entre sommets
export const HORIZON_MAILLES = 32;
const HORIZON_RAYON = 60000;
// Une tuile se divise quand la caméra est à moins de HORIZON_FINESSE fois sa
// largeur. Hors du champ, la distance compte HORIZON_HORS_CHAMP fois plus : ce
// qu'on ne regarde pas reste grossier, et se précise quand la caméra tourne.
// Mesuré à l'ouverture de Gordes (orthophoto + altitudes, puis un tour
// d'orbite) : 2,5 sans tenir compte du champ, 15 + 21 Mo ; 2,5, 7,1 + 6,7 Mo ;
// 2, 5,9 + 2,7 Mo, puis 3,9 Mo ; 1,5, 4,8 + 2,3 Mo, puis 0,9 Mo, sans
// différence à l'œil en vue rasante à 60 m ni vers le Ventoux à 30 km.
const HORIZON_FINESSE = 1.5;
const HORIZON_HORS_CHAMP = 4;
// Tuiles en chargement à la fois (orthophoto et altitudes) : data.geopf.fr
// parle HTTP/2, l'horizon de Gordes est complet en 5 à 6 s.
const HORIZON_PARALLELE = 12;
// Tuiles gardées, chargées ou non. Chacune tient ~340 Ko de texture sur le
// GPU (256² pixels et leurs mipmaps) ; un tour d'orbite à Gordes en montre
// 200 à 250.
const HORIZON_CACHE = 400;
// Largeur de la bande où l'horizon passe sous l'anneau, deux mailles et demie
// de celui-ci : une fente entre leurs bords y montre l'horizon, pas le ciel.
const HORIZON_RECOUVREMENT = 40;
// La pyramide rend −99 999 hors du territoire : la mer et l'étranger. Ces
// trous sont comblés par AWS Terrain Tiles, le relief mondial de repli de la
// scène, ramené à 0 m en mer où il porte la bathymétrie : sans quoi Kehl, en
// face de Strasbourg, tombait à 0 m, 140 m sous le Rhin.
const HORIZON_SANS_ALTITUDE = -100;
// La réfraction courbe les rayons vers le sol : le géomètre compte un rayon
// terrestre apparent de R / (1 − k), k = 0,13. À 50 km, l'horizon descend de
// 170 m ; sans courbure, la plaine montait jusqu'au ciel.
export const RAYON_TERRE_APPARENT = 6371000 / (1 - 0.13);

export const tuilesHorizon = new Map();          // "z/x/y" → tuile, chargée ou non
export let horizonMontre = false;
let generationFondHorizon = 0;
poserSurLeRelief({ placer: () => deplacerHorizon() });
let horizonEnVol = 0;
let derniereSelectionHorizon = -Infinity;
let masqueHorizon = null;               // { source, minX, minZ, px, pz, nx, nz, cumul }
const groupeHorizon = new THREE.Group();
scene.add(groupeHorizon);
const uniformsHorizon = {
    uMasque: { value: null },
    uMasqueBornes: { value: new THREE.Vector4() },
    uMasqueActif: { value: 0 },
};

function parentHorizon(t) {
    return t.z > HORIZON_ZOOM_MIN ? tuilesHorizon.get(`${t.z - 1}/${t.x >> 1}/${t.y >> 1}`) : undefined;
}

function tuileHorizon(z, x, y) {
    const cle = `${z}/${x}/${y}`;
    let t = tuilesHorizon.get(cle);
    if (t) return t;
    const [o, n] = versLonLat(x, y, z);
    const [e, s] = versLonLat(x + 1, y + 1, z);
    const [ax, ay] = toLocal(o, n), [bx, by] = toLocal(e, s);
    const p = parentHorizon({ z, x, y });
    t = { z, x, y, cle, o, e, s, n, minX: ax, maxX: bx, minZ: -ay, maxZ: -by, largeur: bx - ax,
          image: null, sansImage: -1, fondGen: -1, mesh: null, enCours: false,
          reessai: 0, vue: 0,
          // Avant ses altitudes, celles de son parent bornent la distance à la caméra.
          ymin: p ? p.ymin : 0, ymax: p ? p.ymax : 0 };
    tuilesHorizon.set(cle, t);
    return t;
}

// Niveau de la pyramide pour une tuile de zoom z : z − 5, dont le pixel
// (56 km / 2^L en longitude, 78 km / 2^L en latitude à 44°) fait deux à trois
// fois l'écart des sommets de la tuile (900 km / 2^z / 32). Une tuile
// d'altitudes pèse 210 Ko compressée ; l'ouverture de Gordes en lisait 99
// (21 Mo) à z − 3, 32 (6,7 Mo) à z − 4, 11 (2,3 Mo) à z − 5 avec la finesse
// retenue, sans relief perdu à l'œil en vue rasante à 60 m.
const ALTI_CACHE = 64;                  // 256 Kio chacune
const tuilesAltitude = new Map();         // "niveau/ligne/colonne" → promesse de Float32Array

/** Une tuile native de 256 × 256 altitudes, lue une fois pour toutes ses voisines. */
function tuileAltitude(niveau, ligne, colonne) {
    const cle = `${niveau}/${ligne}/${colonne}`;
    let promesse = tuilesAltitude.get(cle);
    if (promesse) {
        tuilesAltitude.delete(cle);     // la plus récemment servie passe en queue
        tuilesAltitude.set(cle, promesse);
        return promesse;
    }
    promesse = (async () => {
        const reponse = await fetch(ALTI_URL(niveau, ligne, colonne));
        // Hors des limites de la pyramide : un trou, que Terrain Tiles comblera.
        if (reponse.status === 404) return new Float32Array(256 * 256).fill(NaN);
        const type = reponse.headers.get('content-type') || '';
        if (!reponse.ok || !type.startsWith('image/x-bil')) throw new Error(`RGE ALTI : ${reponse.status} ${type}`);
        const valeurs = new Float32Array(await reponse.arrayBuffer());
        if (valeurs.length !== 256 * 256) throw new Error('RGE ALTI tronqué');
        for (let i = 0; i < valeurs.length; i++) if (valeurs[i] < HORIZON_SANS_ALTITUDE) valeurs[i] = NaN;
        return valeurs;
    })();
    // En échec, elle sera redemandée ; les tuiles gardent ce qu'elles en ont lu.
    promesse.catch(() => tuilesAltitude.delete(cle));
    tuilesAltitude.set(cle, promesse);
    if (tuilesAltitude.size > ALTI_CACHE) tuilesAltitude.delete(tuilesAltitude.keys().next().value);
    return promesse;
}

const tuilesTerrarium = new Map();        // "z/x/y" → promesse de Float32Array, NaN où rien n'est publié
let horizonTerrarium = false;           // un trou a été comblé : les crédits citent la source
citerSource('horizon', () => ({ montre: horizonMontre, terrarium: horizonTerrarium }));
quandLeFondChange(() => rhabillerHorizon());

/** Une tuile Terrain Tiles décodée ; absente ou illisible, des trous. */
function tuileTerrarium(z, x, y) {
    const cle = `${z}/${x}/${y}`;
    let promesse = tuilesTerrarium.get(cle);
    if (promesse) return promesse;
    promesse = chargerImage(TERRAIN_URL(z, x, y)).then(img => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 256;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0);
        const px = ctx.getImageData(0, 0, 256, 256).data;
        const valeurs = new Float32Array(256 * 256);
        for (let i = 0; i < valeurs.length; i++) {
            const j = i * 4;
            valeurs[i] = px[j + 3] === 0 ? NaN : px[j] * 256 + px[j + 1] + px[j + 2] / 256 - 32768;
        }
        horizonTerrarium = true;
        majCredits();
        return valeurs;
    }, () => new Float32Array(256 * 256).fill(NaN));
    tuilesTerrarium.set(cle, promesse);
    if (tuilesTerrarium.size > ALTI_CACHE) tuilesTerrarium.delete(tuilesTerrarium.keys().next().value);
    return promesse;
}

/**
 * Échantillonneur bilinéaire sur les pixels d'une pyramide qui couvrent une
 * fenêtre [x0, x1] × [y0, y1] : `lire(ligne, colonne)` rend la promesse d'une
 * tuile de 256 × 256 valeurs. `position(lon, lat)` donne le pixel fractionnaire,
 * centres des pixels aux demi-entiers.
 */
async function echantillonneurPyramide(x0, x1, y0, y1, lire, position) {
    const lues = [];
    for (let ligne = y0 >> 8; ligne <= y1 >> 8; ligne++) {
        for (let colonne = x0 >> 8; colonne <= x1 >> 8; colonne++) {
            lues.push(lire(ligne, colonne).then(v => ({ ligne, colonne, v })));
        }
    }
    const l = x1 - x0 + 1, h = y1 - y0 + 1, grille = new Float32Array(l * h);
    for (const { ligne, colonne, v } of await Promise.all(lues)) {
        for (let y = Math.max(y0, ligne << 8); y <= Math.min(y1, (ligne << 8) + 255); y++) {
            for (let x = Math.max(x0, colonne << 8); x <= Math.min(x1, (colonne << 8) + 255); x++) {
                grille[(y - y0) * l + x - x0] = v[(y & 255) * 256 + (x & 255)];
            }
        }
    }
    const echantillon = (lon, lat) => {
        const [px, py] = position(lon, lat);
        const fx = Math.min(Math.max(px - 0.5 - x0, 0), l - 1);
        const fy = Math.min(Math.max(py - 0.5 - y0, 0), h - 1);
        const i = Math.min(Math.floor(fx), l - 2), j = Math.min(Math.floor(fy), h - 2);
        const ax = fx - i, ay = fy - j, k = j * l + i;
        // Un trou voisin rend NaN : 0 × NaN reste NaN.
        return (grille[k] * (1 - ax) + grille[k + 1] * ax) * (1 - ay)
             + (grille[k + l] * (1 - ax) + grille[k + l + 1] * ax) * ay;
    };
    echantillon.trous = grille.some(Number.isNaN);
    return echantillon;
}

/**
 * Altitude aux points d'une tuile de l'horizon, une maille de marge comprise :
 * le RGE ALTI natif, au niveau z − 5 ; dans ses trous, Terrain Tiles au zoom
 * z − 3, dont le pixel est l'écart des sommets, ramené à 0 m en mer.
 */
async function altitudesTuile(t) {
    const niveau = Math.min(Math.max(t.z - 5, ALTI_NIVEAU_MIN), ALTI_NIVEAU_MAX);
    const p = 180 / 2 ** niveau / 256;
    const marge = 360 / 2 ** t.z / HORIZON_MAILLES;
    const rge = await echantillonneurPyramide(
        Math.floor((t.o - marge + 180) / p - 0.5), Math.floor((t.e + marge + 180) / p - 0.5) + 1,
        Math.floor((90 - t.n - marge) / p - 0.5), Math.floor((90 - t.s + marge) / p - 0.5) + 1,
        (ligne, colonne) => tuileAltitude(niveau, ligne, colonne),
        (lon, lat) => [(lon + 180) / p, (90 - lat) / p]);
    if (!rge.trous) return rge;
    const zt = Math.min(Math.max(t.z - 3, 0), TERRAIN_ZOOM);
    const [ax, ay] = versPixel(t.o - marge, t.n + marge, zt);
    const [bx, by] = versPixel(t.e + marge, t.s - marge, zt);
    const secours = await echantillonneurPyramide(
        Math.floor(ax - 0.5), Math.floor(bx - 0.5) + 1, Math.floor(ay - 0.5), Math.floor(by - 0.5) + 1,
        (ligne, colonne) => tuileTerrarium(zt, colonne, ligne),
        (lon, lat) => versPixel(lon, lat, zt));
    return (lon, lat) => {
        const v = rge(lon, lat);
        if (!Number.isNaN(v)) return v;
        const w = secours(lon, lat);
        return Number.isNaN(w) ? 0 : Math.max(w, 0);
    };
}

/**
 * Image du fond actif pour une tuile, ou null. Hors couverture, l'IGN répond
 * 404 au-delà d'un zoom (mer au large dès le 16, Italie et Suisse dès le 13) :
 * les descendantes d'une tuile sans image n'en demandent pas, elles empruntent
 * celle d'un ancêtre. Mais la Géoplateforme refuse aussi, de loin en loin, une
 * tuile qui existe (un 404 pendant un vol au-dessus de Gordes, absent au vol
 * suivant) : un refus se fait relire par le serveur avant de valoir absence,
 * sans quoi toute une branche restait floue.
 */
async function imageTuile(t, gen) {
    if (!fondActif) return null;
    for (let a = parentHorizon(t); a; a = parentHorizon(a)) {
        if (a.sansImage === gen) { t.sansImage = gen; return null; }
    }
    const url = FONDS[fondActif](t.z, t.x, t.y);
    try {
        return await chargerImage(url);
    } catch (e) {
        try {
            return await relireTuile(url);
        } catch (e) {
            t.sansImage = gen;
            return null;
        }
    }
}

function materiauHorizon() {
    const m = new THREE.MeshStandardMaterial({
        color: MAT_TERRAIN.color, roughness: 1, metalness: 0,
        // Sur la bande où il passe sous l'anneau, l'anneau l'emporte.
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4 });
    m.onBeforeCompile = shader => {
        Object.assign(shader.uniforms, uniformsHorizon);
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec2 vSol;\nvarying float vNormaleY;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSol = position.xz;\nvNormaleY = normal.y;');
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nvarying vec2 vSol;\nvarying float vNormaleY;\n'
                + 'uniform sampler2D uMasque;\nuniform vec4 uMasqueBornes;\nuniform float uMasqueActif;')
            .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n'
                + 'if (uMasqueActif > 0.5) {\n'
                + '  vec2 m = (vSol - uMasqueBornes.xy) / (uMasqueBornes.zw - uMasqueBornes.xy);\n'
                + '  if (m.x > 0.0 && m.x < 1.0 && m.y > 0.0 && m.y < 1.0 && texture2D(uMasque, m).r > 0.5) discard;\n'
                + '}')
            // La même teinte de paroi que le terrain de la scène.
            .replace('#include <map_fragment>', '#include <map_fragment>\n'
                + 'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.22, 0.21, 0.2), smoothstep(0.77, 0.5, vNormaleY));');
    };
    m.customProgramCacheKey = () => 'horizon';
    return m;
}

/** Plaque l'image de la tuile, sinon un morceau de celle de son plus proche ancêtre. */
function habillerTuile(t) {
    const m = t.mesh.material;
    if (m.map) { m.map.dispose(); m.map = null; }
    let a = t;
    while (a && !(a.fondGen === generationFondHorizon && a.image)) a = parentHorizon(a);
    if (fondActif && a) {
        const tex = new THREE.Texture(a.image);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
        if (a !== t) {
            // flipY : v = 1 est le haut de l'image, donc le nord.
            const s = 2 ** (t.z - a.z), ix = t.x - a.x * s, iy = t.y - a.y * s;
            tex.repeat.set(1 / s, 1 / s);
            tex.offset.set(ix / s, (s - iy - 1) / s);
        }
        tex.needsUpdate = true;
        m.map = tex;
        m.color.set(0xffffff);
    } else {
        m.color.copy(MAT_TERRAIN.color);
    }
    m.needsUpdate = true;
}

function construireTuile(t, alt) {
    const N = HORIZON_MAILLES, L = N + 1, nb = L * L;
    // Différences centrées d'une maille, la même pour toutes les tuiles d'un
    // niveau à une latitude donnée : deux voisines ont la même normale au bord.
    const dLon = 360 / 2 ** t.z / N;
    t.xz = new Float64Array(nb * 2);
    t.alts = new Float64Array(nb);
    t.pentes = new Float64Array(nb * 2);
    const uv = new Float32Array((nb + 4 * L) * 2);
    for (let j = 0; j < L; j++) {
        for (let i = 0; i < L; i++) {
            const k = j * L + i;
            const [lon, lat] = versLonLat(t.x + i / N, t.y + j / N, t.z);
            const [lx, ly] = toLocal(lon, lat);
            t.xz[2 * k] = lx;
            t.xz[2 * k + 1] = -ly;
            const dLat = dLon * Math.cos(lat * Math.PI / 180);
            t.alts[k] = alt(lon, lat);
            t.pentes[2 * k] = (alt(lon + dLon, lat) - alt(lon - dLon, lat)) / (2 * dLon * M_PAR_DEGRE_LON);   // vers l'est (+X)
            t.pentes[2 * k + 1] = (alt(lon, lat - dLat) - alt(lon, lat + dLat)) / (2 * dLat * M_PAR_DEGRE_LAT); // vers le sud (+Z)
            uv[2 * k] = i / N;
            uv[2 * k + 1] = 1 - j / N;
        }
    }
    // Les bords, parcourus l'extérieur à gauche : nord d'ouest en est, est du
    // nord au sud, sud d'est en ouest, ouest du sud au nord. La jupe pend sous
    // chacun, tournée vers le dehors.
    const bords = [];
    for (let i = 0; i < L; i++) bords.push(i);
    for (let j = 0; j < L; j++) bords.push(j * L + N);
    for (let i = N; i >= 0; i--) bords.push(N * L + i);
    for (let j = N; j >= 0; j--) bords.push(j * L);
    t.bords = bords;
    for (let b = 0; b < bords.length; b++) {
        uv[2 * (nb + b)] = uv[2 * bords[b]];
        uv[2 * (nb + b) + 1] = uv[2 * bords[b] + 1];
    }
    const index = [];
    for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
            const a = j * L + i, c = a + L;
            index.push(a, c, a + 1, c, c + 1, a + 1);       // le même ordre que l'anneau : vers le ciel
        }
    }
    for (let c = 0; c < 4; c++) {
        for (let k = 0; k < N; k++) {
            const b = c * L + k, e0 = bords[b], e1 = bords[b + 1], s0 = nb + b, s1 = s0 + 1;
            index.push(e0, e1, s0, s0, e1, s1);
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((nb + 4 * L) * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array((nb + 4 * L) * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(index);
    t.mesh = new THREE.Mesh(geo, materiauHorizon());
    t.mesh.matrixAutoUpdate = false;
    t.mesh.visible = false;
    placerTuile(t);
    habillerTuile(t);
    groupeHorizon.add(t.mesh);
}

/** Altitudes de la tuile selon l'exagération, courbure de la Terre déduite. */
function placerTuile(t) {
    const N = HORIZON_MAILLES, L = N + 1, nb = L * L;
    const geo = t.mesh.geometry;
    const pos = geo.attributes.position.array, nor = geo.attributes.normal.array;
    let ymin = Infinity, ymax = -Infinity;
    for (let k = 0; k < nb; k++) {
        const x = t.xz[2 * k], z = t.xz[2 * k + 1];
        const y = (t.alts[k] - altitudeRef) * exagVert - (x * x + z * z) / (2 * RAYON_TERRE_APPARENT);
        pos[3 * k] = x; pos[3 * k + 1] = y; pos[3 * k + 2] = z;
        ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
        const gx = -t.pentes[2 * k] * exagVert, gz = -t.pentes[2 * k + 1] * exagVert;
        const l = Math.hypot(gx, 1, gz);
        nor[3 * k] = gx / l; nor[3 * k + 1] = 1 / l; nor[3 * k + 2] = gz / l;
    }
    // Assez profonde pour l'écart d'un bord fin au bord grossier voisin, qui
    // coupe une maille d'une pente à 45° : une demi-maille.
    const jupe = (5 + 0.5 * t.largeur / N) * exagVert;
    for (let b = 0; b < t.bords.length; b++) {
        const k = t.bords[b], q = nb + b;
        pos[3 * q] = pos[3 * k]; pos[3 * q + 1] = pos[3 * k + 1] - jupe; pos[3 * q + 2] = pos[3 * k + 2];
        nor[3 * q] = nor[3 * k]; nor[3 * q + 1] = nor[3 * k + 1]; nor[3 * q + 2] = nor[3 * k + 2];
    }
    t.ymin = ymin; t.ymax = ymax;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.normal.needsUpdate = true;
    geo.computeBoundingSphere();
}

/** Toutes les tuiles construites, après un changement d'exagération. */
function deplacerHorizon() {
    for (const t of tuilesHorizon.values()) if (t.mesh) placerTuile(t);
}

async function chargerTuile(t) {
    t.enCours = true;
    horizonEnVol++;
    const gen = generationFondHorizon;
    try {
        const [alt, image] = await Promise.all([
            t.mesh ? null : altitudesTuile(t),
            t.fondGen === gen ? t.image : imageTuile(t, gen)]);
        // Un autre fond a été choisi pendant le chargement : on la redemandera.
        if (gen === generationFondHorizon) { t.image = image; t.fondGen = gen; }
        if (!tuilesHorizon.has(t.cle)) return;          // évincée entre-temps
        if (!t.mesh) construireTuile(t, alt);
        else habillerTuile(t);
    } catch (e) {
        // Altitudes refusées : la tuile se redemandera plus tard, son parent la couvre.
        t.reessai = performance.now() + 15000;
    } finally {
        t.enCours = false;
        horizonEnVol--;
    }
}

/**
 * Masque de ce que couvrent la scène et l'anneau, érodé de
 * HORIZON_RECOUVREMENT : une grille calée sur celle de l'anneau, une case
 * couverte quand l'anneau y a une facette (son centre a une altitude) ou
 * qu'elle tombe dans l'emprise fine. Sert au nuanceur, qui y perce l'horizon,
 * et au choix des tuiles, qui saute celles qu'il couvre entièrement.
 */
function construireMasqueHorizon() {
    const source = anneauRelief || terrain;
    const { xs, zs } = terrain.lignes;
    const fin = { minX: xs[0], maxX: xs[xs.length - 1], minZ: zs[0], maxZ: zs[zs.length - 1] };
    const dansFin = (x, z) => x >= fin.minX && x <= fin.maxX && z >= fin.minZ && z <= fin.maxZ;
    let b, pas, couvre;
    if (anneauRelief) {
        b = anneauRelief.bornes;
        pas = (b.maxX - b.minX) / (ARTEFACT.anneau.width - 1);
        couvre = (x, z) => dansFin(x, z) || Number.isFinite(anneauRelief.alt(...toLonLat(x, -z)));
    } else {
        b = fin;
        pas = 16;
        couvre = dansFin;
    }
    const nx = Math.max(1, Math.round((b.maxX - b.minX) / pas));
    const nz = Math.max(1, Math.round((b.maxZ - b.minZ) / pas));
    const px = (b.maxX - b.minX) / nx, pz = (b.maxZ - b.minZ) / nz;
    const brut = new Uint8Array(nx * nz);
    for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) brut[j * nx + i] = couvre(b.minX + (i + 0.5) * px, b.minZ + (j + 0.5) * pz) ? 1 : 0;
    }
    // Érosion carrée : une case reste couverte si toutes ses voisines à
    // moins de HORIZON_RECOUVREMENT le sont ; hors de la grille, rien ne l'est.
    const r = Math.ceil(HORIZON_RECOUVREMENT / Math.min(px, pz));
    const donnees = new Uint8Array(nx * nz);
    const cumul = new Int32Array((nx + 1) * (nz + 1));
    for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
            let ok = i >= r && j >= r && i < nx - r && j < nz - r;
            for (let v = -r; ok && v <= r; v++) {
                for (let u = -r; u <= r; u++) if (!brut[(j + v) * nx + i + u]) { ok = false; break; }
            }
            donnees[j * nx + i] = ok ? 255 : 0;
        }
    }
    for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
            cumul[(j + 1) * (nx + 1) + i + 1] = (donnees[j * nx + i] ? 1 : 0)
                + cumul[j * (nx + 1) + i + 1] + cumul[(j + 1) * (nx + 1) + i] - cumul[j * (nx + 1) + i];
        }
    }
    const texture = new THREE.DataTexture(donnees, nx, nz, THREE.RedFormat, THREE.UnsignedByteType);
    texture.magFilter = texture.minFilter = THREE.NearestFilter;
    texture.needsUpdate = true;
    uniformsHorizon.uMasque.value?.dispose();
    uniformsHorizon.uMasque.value = texture;
    uniformsHorizon.uMasqueBornes.value.set(b.minX, b.minZ, b.maxX, b.maxZ);
    uniformsHorizon.uMasqueActif.value = 1;
    masqueHorizon = { source, minX: b.minX, minZ: b.minZ, px, pz, nx, nz, cumul };
}

/** Vrai si le masque couvre toute la tuile : rien n'en serait dessiné. */
function tuileMasquee(t) {
    const m = masqueHorizon;
    const i0 = Math.floor((t.minX - m.minX) / m.px), i1 = Math.ceil((t.maxX - m.minX) / m.px);
    const j0 = Math.floor((t.minZ - m.minZ) / m.pz), j1 = Math.ceil((t.maxZ - m.minZ) / m.pz);
    if (i0 < 0 || j0 < 0 || i1 > m.nx || j1 > m.nz) return false;
    const w = m.nx + 1;
    const n = m.cumul[j1 * w + i1] - m.cumul[j0 * w + i1] - m.cumul[j1 * w + i0] + m.cumul[j0 * w + i0];
    return n === (i1 - i0) * (j1 - j0);
}

/**
 * Choisit les tuiles à montrer : une tuile assez proche se divise, mais ne
 * cède sa place que quand ses quatre enfants sont prêts — jamais de trou
 * pendant un chargement. Rend vrai si la tuile est couverte.
 */
const champHorizon = new THREE.Frustum(), boiteHorizon = new THREE.Box3(), matriceChamp = new THREE.Matrix4();

function couvrirHorizon(t, cam, liste, voulues, maintenant) {
    t.vue = maintenant;
    const dx = Math.max(t.minX - cam.x, 0, cam.x - t.maxX);
    const dz = Math.max(t.minZ - cam.z, 0, cam.z - t.maxZ);
    if (Math.hypot(dx, dz) > HORIZON_RAYON || tuileMasquee(t)) return true;
    const dy = Math.max(t.ymin - cam.y, 0, cam.y - t.ymax);
    // La boîte élargie d'une demi-tuile : celles du bord du champ comptent dedans.
    const marge = t.largeur / 2;
    boiteHorizon.min.set(t.minX - marge, t.ymin - marge, t.minZ - marge);
    boiteHorizon.max.set(t.maxX + marge, t.ymax + marge, t.maxZ + marge);
    const facteur = champHorizon.intersectsBox(boiteHorizon) ? 1 : HORIZON_HORS_CHAMP;
    if (t.z < HORIZON_ZOOM_MAX && facteur * Math.hypot(dx, dy, dz) < HORIZON_FINESSE * t.largeur) {
        const sous = [];
        let pretes = true;
        for (let k = 0; k < 4; k++) {
            const enfant = tuileHorizon(t.z + 1, 2 * t.x + (k & 1), 2 * t.y + (k >> 1));
            if (!couvrirHorizon(enfant, cam, sous, voulues, maintenant)) pretes = false;
        }
        if (pretes) { liste.push(...sous); return true; }
    }
    if (!t.enCours && (!t.mesh || (fondActif && t.fondGen !== generationFondHorizon))
        && maintenant >= t.reessai) {
        voulues.push({ t, d: Math.hypot(dx, dy, dz) });
    }
    if (t.mesh) { liste.push(t); return true; }
    return false;
}

export function majHorizon(maintenant) {
    const montrer = horizonActif && relief && !!terrain;
    if (montrer !== horizonMontre) {
        horizonMontre = montrer;
        groupeHorizon.visible = montrer;
        // Le grand plan gris, sous la scène, couperait les vallées alentour.
        sol.visible = !montrer;
        majCredits();
    }
    if (!montrer || maintenant - derniereSelectionHorizon < 100) return;
    derniereSelectionHorizon = maintenant;
    if (!masqueHorizon || masqueHorizon.source !== (anneauRelief || terrain)) construireMasqueHorizon();

    const cam = camera.position;
    camera.updateMatrixWorld();
    champHorizon.setFromProjectionMatrix(matriceChamp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const [o, s] = toLonLat(cam.x - HORIZON_RAYON, -(cam.z + HORIZON_RAYON));
    const [e, n] = toLonLat(cam.x + HORIZON_RAYON, -(cam.z - HORIZON_RAYON));
    const [x0, y0] = versTuile(o, n, HORIZON_ZOOM_MIN);
    const [x1, y1] = versTuile(e, s, HORIZON_ZOOM_MIN);
    const liste = [], voulues = [];
    for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) couvrirHorizon(tuileHorizon(HORIZON_ZOOM_MIN, x, y), cam, liste, voulues, maintenant);
    }
    const montrees = new Set(liste);
    for (const t of tuilesHorizon.values()) if (t.mesh) t.mesh.visible = montrees.has(t);

    // Les plus grossières d'abord : elles couvrent tout de suite, les fines
    // suivent autour de la caméra.
    voulues.sort((a, b) => a.t.z - b.t.z || a.d - b.d);
    for (const { t } of voulues) {
        if (horizonEnVol >= HORIZON_PARALLELE) break;
        chargerTuile(t);
    }

    if (tuilesHorizon.size > HORIZON_CACHE) {
        const vieilles = [...tuilesHorizon.values()]
            .filter(t => !montrees.has(t) && !t.enCours && t.vue < maintenant)
            .sort((a, b) => a.vue - b.vue)
            .slice(0, tuilesHorizon.size - HORIZON_CACHE);
        for (const t of vieilles) {
            if (t.mesh) {
                groupeHorizon.remove(t.mesh);
                t.mesh.geometry.dispose();
                t.mesh.material.map?.dispose();
                t.mesh.material.dispose();
            }
            tuilesHorizon.delete(t.cle);
        }
    }
}

/** Nouveau fond : chaque tuile redemande le sien, et garde l'ancien d'ici là. */
function rhabillerHorizon() {
    generationFondHorizon++;
    for (const t of tuilesHorizon.values()) {
        t.image = null;
        t.fondGen = -1;
        if (t.mesh && !fondActif) habillerTuile(t);
    }
    derniereSelectionHorizon = -Infinity;
}

/**
 * Ciel et brume suivent le bouton, pas l'arrivée des tuiles : changer de
 * brume recompile tous les nuanceurs, et on ne le fait pas pendant le
 * chargement de la scène.
 */
function appliquerCiel() {
    ciel.visible = horizonActif;
    ciel.scale.setScalar(1.5 * HORIZON_RAYON);
    scene.fog = horizonActif ? brumeHorizon : brumeScene;
    scene.background = horizonActif ? null : FOND_SCENE;
    camera.far = horizonActif ? 2 * HORIZON_RAYON : 5000 * ECHELLE_ZONE;
    if (!horizonActif) camera.near = 0.1;
    camera.updateProjectionMatrix();
}

const COULEURS_CIEL = {
    zenith: new THREE.Color(0x4f86c6), horizon: new THREE.Color(0xbcd0e2),
    rasant: new THREE.Color(0xe2b48c), nuit: new THREE.Color(0x0b1018), nuitHorizon: new THREE.Color(0x161c24),
};
/** Couleurs du ciel et de la brume d'après la hauteur du soleil, en degrés. */
export function majCiel(hauteur, jour) {
    const c = COULEURS_CIEL;
    brumeHorizon.color.copy(c.rasant).lerp(c.horizon, Math.min(1, Math.max(0, hauteur / 12)))
        .lerp(c.nuitHorizon, 1 - jour);
    ciel.material.uniforms.zenith.value.copy(c.zenith).lerp(c.nuit, 1 - jour);
}

const btnHorizon = document.getElementById('t-horizon');
btnHorizon.addEventListener('click', () => {
    basculerHorizonActif();
    btnHorizon.classList.toggle('on', horizonActif);
    appliquerCiel();
    poserFondAnneau();
});
appliquerCiel();
