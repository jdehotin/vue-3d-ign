// Les altitudes du RGE ALTI, en tuiles natives.

import { ALTI_URL } from '../../commun/tuiles.js';
import { depuisLambert93 } from '../socle/lambert93.js';
import { DELAI_ALTI_MS } from './tuiles.js';
import { lireEnCache } from './cache.js';

// Les tuiles natives du RGE ALTI (WMTS, pyramide WGS84G, 256 × 256 flottants),
// lues comme l'horizon de la page, et pour les mêmes raisons (le WMS sort en
// gradins et limite à 40 requêtes par seconde). Un trou (−99 999 : la mer,
// l'étranger) vaut 0 m.
// Le niveau des tuiles du sol les plus fines (zoom 18 − 5, comme la page :
// un pixel de 9,5 m sur 6,7 m à 45°) : bâtiments, route et voiture s'y posent.
export const NIVEAU_PROCHE = 13;
export const ALTI_CACHE = 160;                 // 256 Kio chacune
// Hors de la pyramide (la mer au large, l'étranger), l'IGN répond 404 ; mais
// il en rend aussi pour une tuile qui existe : 7/32/132, de Digne au Verdon,
// en 404 dans une Tesla le 23 octobre 2026, en 200 trois fois de suite
// redemandée le même jour. Prise pour la mer, tout ce pan du relief restait à
// 0 m pour la vie de la page. Trois réponses pour une absence, à 1,5 s
// d'écart, comme le serveur pour une photo (vue3d/tuiles.py).
const ALTI_ESSAIS_404 = 3, ALTI_PAUSE_404_MS = 1500;
export const altis = new Map();                // "niveau/ligne/colonne" → { promesse, valeurs }
export const erreursAlti = new Map();          // "niveau/ligne/colonne" → la dernière erreur, pour les signalements
function tuileAlti(niveau, ligne, colonne) {
    const cle = `${niveau}/${ligne}/${colonne}`;
    let t = altis.get(cle);
    if (t) return t;
    t = { valeurs: null };
    t.promesse = (async () => {
        const url = ALTI_URL(niveau, ligne, colonne);
        let reponse = await lireEnCache(url, DELAI_ALTI_MS);
        for (let essai = 1; reponse.status === 404 && essai < ALTI_ESSAIS_404; essai++) {
            await new Promise(r => setTimeout(r, ALTI_PAUSE_404_MS));
            reponse = await lireEnCache(url, DELAI_ALTI_MS);
        }
        if (reponse.status === 404) { t.absente = true; return new Float32Array(256 * 256).fill(NaN); }
        const type = reponse.headers.get('content-type') || '';
        if (!reponse.ok || !type.startsWith('image/x-bil')) throw new Error(`RGE ALTI : ${reponse.status} ${type}`);
        const v = new Float32Array(await reponse.arrayBuffer());
        if (v.length !== 256 * 256) throw new Error('RGE ALTI tronqué');
        for (let i = 0; i < v.length; i++) if (v[i] < -100) v[i] = NaN;
        return v;
    })().then(v => { t.valeurs = v; erreursAlti.delete(cle); return v; },
              e => {
                  if (altis.get(cle) === t) altis.delete(cle);
                  erreursAlti.delete(cle);
                  erreursAlti.set(cle, String(e?.message || e).slice(0, 160));
                  if (erreursAlti.size > 20) erreursAlti.delete(erreursAlti.keys().next().value);
                  throw e;
              });
    t.promesse.catch(() => {});
    altis.set(cle, t);
    if (altis.size > ALTI_CACHE) {
        // Les plus anciennes déjà lues : celles qu'on attend restent.
        for (const [k, v] of altis) {
            if (altis.size <= ALTI_CACHE) break;
            if (v.valeurs) altis.delete(k);
        }
    }
    return t;
}
export const pasAlti = niveau => 180 / 2 ** niveau / 256;

/** Les tuiles d'altitude qui couvrent une emprise en degrés, lues. */
export function preparerAltitudes(o, s, e, n, niveau) {
    const p = pasAlti(niveau);
    const c0 = Math.floor(((o + 180) / p - 1) / 256), c1 = Math.floor(((e + 180) / p + 1) / 256);
    const l0 = Math.floor(((90 - n) / p - 1) / 256), l1 = Math.floor(((90 - s) / p + 1) / 256);
    const attentes = [];
    for (let l = l0; l <= l1; l++) for (let c = c0; c <= c1; c++) attentes.push(tuileAlti(niveau, l, c).promesse);
    return Promise.all(attentes);
}

let derniereAlti = { cle: null, valeurs: null };
function pixelAlti(niveau, i, j) {
    const cle = `${niveau}/${j >> 8}/${i >> 8}`;
    let valeurs = derniereAlti.cle === cle ? derniereAlti.valeurs : null;
    if (!valeurs) {
        const t = altis.get(cle);
        if (!t || !t.valeurs) return NaN;
        valeurs = t.valeurs;
        derniereAlti = { cle, valeurs };
    }
    const v = valeurs[(j & 255) * 256 + (i & 255)];
    return Number.isNaN(v) ? 0 : v;
}

/** Altitude bilinéaire, centres des pixels aux demi-entiers ; NaN tant que la tuile n'est pas lue. */
export function altitude(lon, lat, niveau = NIVEAU_PROCHE) {
    const p = pasAlti(niveau);
    const fx = (lon + 180) / p - 0.5, fy = (90 - lat) / p - 0.5;
    const i = Math.floor(fx), j = Math.floor(fy), ax = fx - i, ay = fy - j;
    return (pixelAlti(niveau, i, j) * (1 - ax) + pixelAlti(niveau, i + 1, j) * ax) * (1 - ay)
         + (pixelAlti(niveau, i, j + 1) * (1 - ax) + pixelAlti(niveau, i + 1, j + 1) * ax) * ay;
}
export const altitudeL93 = (x, y) => altitude(...depuisLambert93(x, y));
