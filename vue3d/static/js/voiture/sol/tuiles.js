// Le sol en tuiles : ses réglages, son groupe, et la lecture d'une image.

import * as THREE from 'three';
import { RAD } from '../socle/parametres.js';
import { scene } from '../socle/rendu.js';

// L'horizon de la page, repris pour un monde qui défile : des tuiles WMTS
// (Web Mercator) de l'orthophoto ou du plan, d'autant plus fines qu'elles
// sont près de la caméra, et grossières hors du champ ; une tuile ne cède sa
// place qu'une fois ses quatre enfants prêts. Une caméra fantôme, là où
// sera la voiture dans quelques secondes, demande d'avance celles qu'elle y
// verra.
export const SOL_ZOOM_MIN = 9;          // celui du serveur (tuiles.TUILES_ZOOM)
export const SOL_ZOOM_MAX = 18;         // ~150 m de côté, 0,6 m par pixel
export const SOL_MAILLES = 32;
export const SOL_RAYON = 40000;
export const SOL_FINESSE = 1.5;
export const SOL_HORS_CHAMP = 4;
export const SOL_PARALLELE = 10;
export const SOL_CACHE = 360;           // ~340 Ko de texture chacune sur le GPU
export const ANTICIPATION_S = [6, 12];  // la caméra fantôme : où sera la voiture
export const tuilesSol = new Map();
export const groupeSol = new THREE.Group();
scene.add(groupeSol);
export const COULEUR_SOL = new THREE.Color(0x8b8f87);
// La teinte posée sur l'image des tuiles : blanche le jour, bleu sombre la nuit.
export const teinteSol = new THREE.Color(0xffffff), TEINTE_SOL_NUIT = new THREE.Color(0x56627e);

export const versTuile = (lon, lat, z) => {
    const n = 2 ** z, r = lat * RAD;
    return [Math.floor((lon + 180) / 360 * n),
            Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n)];
};
export const versLonLat = (x, y, z) => {
    const n = 2 ** z;
    return [x / n * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) / RAD];
};

// En voiture, une image peut ne jamais répondre (une zone sans réseau) : elle
// tenait une des SOL_PARALLELE places pour toujours. Abandonnée au bout de
// ce délai, elle sera redemandée.
export const DELAI_IMAGE_MS = 10000, DELAI_ALTI_MS = 15000;
export function chargerImage(url, delai = DELAI_IMAGE_MS) {
    return new Promise((ok, ko) => {
        const img = new Image();
        const minuterie = setTimeout(() => { img.src = ''; ko(new Error(`image trop lente : ${url}`)); }, delai);
        img.crossOrigin = 'anonymous';
        img.onload = () => { clearTimeout(minuterie); ok(img); };
        img.onerror = e => { clearTimeout(minuterie); ko(e); };
        img.src = url;
    });
}
/** Une lecture qui ne répond pas dans le délai est abandonnée. */
export async function lireAvecDelai(url, delai) {
    const arret = new AbortController();
    const minuterie = setTimeout(() => arret.abort(), delai);
    try { return await fetch(url, { signal: arret.signal }); }
    finally { clearTimeout(minuterie); }
}
/** L'IGN n'a pas de photo ici, le serveur le confirme (404) : un fait, pas une panne. */
export class TuileAbsente extends Error {}
