// Lambert-93, aller et retour, et la convergence des méridiens.

import { RAD } from './parametres.js';

// Le monde est en Lambert-93 : la projection des carrés (le serveur les lit
// en EPSG:2154), conforme, à moins de 0,1 % d'écart d'échelle sur la France.
// Constantes de l'IGN (ALG0019), comme versLambert93 de index.html et
// vue3d/nuage.py ; un sommet de Gordes rendu par le WFS en EPSG:2154 et en
// EPSG:4326 se retrouve au centième de mètre.
const L93 = { e: 0.0818191910428158, n: 0.7256077650532670, c: 11754255.426096,
              xs: 700000, ys: 12655612.049876, lon0: 3 * RAD };

export function versLambert93(lon, lat) {
    const phi = lat * RAD, s = Math.sin(phi);
    const iso = Math.log(Math.tan(Math.PI / 4 + phi / 2) * ((1 - L93.e * s) / (1 + L93.e * s)) ** (L93.e / 2));
    const r = L93.c * Math.exp(-L93.n * iso), g = L93.n * (lon * RAD - L93.lon0);
    return [L93.xs + r * Math.sin(g), L93.ys - r * Math.cos(g)];
}

/** Réciproque : la latitude isométrique, puis la latitude par point fixe. */
export function depuisLambert93(x, y) {
    const dx = x - L93.xs, dy = L93.ys - y;
    const r = Math.hypot(dx, dy), g = Math.atan2(dx, dy);
    const iso = -Math.log(r / L93.c) / L93.n;
    let phi = 2 * Math.atan(Math.exp(iso)) - Math.PI / 2;
    for (let k = 0; k < 12; k++) {
        const s = L93.e * Math.sin(phi);
        const suivant = 2 * Math.atan(((1 + s) / (1 - s)) ** (L93.e / 2) * Math.exp(iso)) - Math.PI / 2;
        if (Math.abs(suivant - phi) < 1e-12) { phi = suivant; break; }
        phi = suivant;
    }
    return [(L93.lon0 + g / L93.n) / RAD, phi / RAD];
}

/** Écart du nord du quadrillage au nord vrai, en degrés (convergence des méridiens). */
export const convergence = lon => L93.n * (lon - 3);
