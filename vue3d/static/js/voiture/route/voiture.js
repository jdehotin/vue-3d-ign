// La voiture : ses relevés, son avance le long de la route prévue.

import { PARAMS, RAD } from '../socle/parametres.js';
import { versLambert93, convergence } from '../socle/lambert93.js';
import { ORIGINE, RECALAGE_M, recaler } from '../socle/monde.js';
import {
    voiture, HAUTEUR_DEFAUT, camVue, ITINERAIRE_CHEMIN_MAX_M, itineraire,
} from '../socle/etat.js';
import { majLienQuitter } from '../interface/ecran.js';
import { altitudeL93 } from '../sol/altitudes.js';
import {
    pointArete, ecartCap, cheminDepuis, pointDuChemin, areteDuChemin, caler, altitudeApproche,
} from './graphe.js';
import { altitudeSousTerre, sortieDuTunnel } from './tunnels.js';
import { majBoutonVue } from '../interface/camera.js';
import { poserVoiture } from '../interface/maquette.js';

// Un relevé par seconde au mieux : entre deux, la voiture avance le long de
// la route prévue à sa vitesse, et l'image se raccorde en douceur au relevé
// suivant. Sans relevé, elle s'arrête au bout de EXTRAPOLATION_S ; dans un
// tunnel, où le GPS ne capte plus, à la sortie, EXTRAPOLATION_S passées : à
// 40 s au plus, comme avant, elle se figeait au bout de 800 m à 70 km/h.
const EXTRAPOLATION_S = 3;
const LISSAGE_POSITION_S = 0.3, LISSAGE_CAP_S = 0.35;
const SAUT_M = 150;

function longueurPrevue() {
    // Deux minutes et demie de route devant soi, de 2 à 6 km : à 130 km/h,
    // 5,4 km, lus en quelques secondes (0,2 s par carré, quatre à la fois).
    return Math.min(Math.max(voiture.v * 150, 2000), 6000);
}

function recalculerChemin() {
    voiture.recalculer = false;
    const an = voiture.ancre;
    if (!an || !an.a) { voiture.chemin = null; return; }
    // Le chemin part de la position affichée, pas du relevé : il garde la
    // même abscisse pour la voiture, que la boucle fait avancer.
    // Sur un itinéraire, jusqu'à l'arrivée (20 km au plus) : la distance qui
    // reste se lit dès le départ.
    voiture.chemin = cheminDepuis(an, itineraire ? ITINERAIRE_CHEMIN_MAX_M : longueurPrevue());
    voiture.dChemin = 0;
    voiture.tChemin = an.t;
}

const HISTORIQUE_S = 4;
const historique = [];
export function recevoirPosition(pos) {
    const c = pos.coords;
    const [x, y] = versLambert93(c.longitude, c.latitude);
    const maintenant = performance.now();
    let v = Number.isFinite(c.speed) && c.speed != null ? c.speed : null;
    let cap = Number.isFinite(c.heading) && c.heading != null && (v == null || v > 1)
        ? c.heading - convergence(c.longitude) : null;
    // Sans vitesse ni cap du GPS : tirés des relevés des dernières secondes,
    // pas des deux derniers, que leur bruit de quelques mètres faisait
    // tourner de 40° à 30 km/h.
    historique.push({ x, y, t: maintenant });
    while (historique.length > 2 && maintenant - historique[0].t > HISTORIQUE_S * 1000) historique.shift();
    const ancien = historique[0], dt = (maintenant - ancien.t) / 1000;
    const d = Math.hypot(x - ancien.x, y - ancien.y);
    if (v == null && dt > 0.8) v = d / dt;
    if (cap == null && d > 10) cap = Math.atan2(x - ancien.x, y - ancien.y) / RAD;
    voiture.fix = { x, y, t: maintenant, precision: c.accuracy || 30, v: v || 0, cap,
                    lon: c.longitude, lat: c.latitude };
    voiture.precision = voiture.fix.precision;
    if (!voiture.vue) {
        voiture.vue = true;
        if (Math.hypot(x - ORIGINE.x, y - ORIGINE.y) > RECALAGE_M) recaler(x, y);
        voiture.x = x; voiture.y = y;
        voiture.cap = cap ?? 0;
        camVue.cap = voiture.cap;
        document.getElementById('accueil').hidden = true;
        // La France vue de haut, en attendant : on descend derrière la voiture.
        if (voiture.attendu?.provisoire) {
            camVue.mode = PARAMS.get('vue') === '2d' ? '2d' : '3d';
            camVue.hauteur = HAUTEUR_DEFAUT;
            majBoutonVue();
        }
        majLienQuitter();
    }
    calerReleve();
}

function calerReleve() {
    const f = voiture.fix;
    const m = caler(f.x, f.y, f.precision, f.v > 1.5 ? f.cap : null);
    voiture.horsRoute = !m;
    if (m) {
        voiture.ancre = { a: m.a, s: m.s, sens: m.sens, x: m.x, y: m.y, t: f.t, v: f.v };
    } else {
        voiture.ancre = { a: null, x: f.x, y: f.y, t: f.t, v: f.v, cap: f.cap };
    }
    recalculerChemin();
    // Le relevé arrive un peu derrière la voiture affichée, qui a filé sur
    // sa lancée : elle garde son avance plutôt que de reculer, pourvu
    // qu'elle soit sur la route prévue, devant le relevé.
    const ch = voiture.chemin, an = voiture.ancre;
    if (ch && an.v > 1) {
        const d = abscisseSurChemin(ch, voiture.x, voiture.y, Math.max(20, 2.5 * an.v));
        if (d != null && d > 0) an.t = performance.now() - d / an.v * 1000;
    }
}

/** Abscisse sur le chemin du point le plus proche de (x, y) parmi ses `dMax` premiers mètres, à moins de 10 m. */
function abscisseSurChemin(ch, x, y, dMax) {
    let meilleur = null;
    for (let k = 0; k + 1 < ch.xs.length && ch.cum[k] <= dMax; k++) {
        const lx = ch.xs[k + 1] - ch.xs[k], ly = ch.ys[k + 1] - ch.ys[k], l2 = lx * lx + ly * ly || 1;
        const u = Math.min(Math.max(((x - ch.xs[k]) * lx + (y - ch.ys[k]) * ly) / l2, 0), 1);
        const d = Math.hypot(x - ch.xs[k] - lx * u, y - ch.ys[k] - ly * u);
        if (d < 10 && (!meilleur || d < meilleur.d)) meilleur = { d, s: ch.cum[k] + Math.sqrt(l2) * u };
    }
    return meilleur && meilleur.s <= dMax ? meilleur.s : null;
}

export function majVoiture(dt, maintenant) {
    const v = voiture;
    if (!v.vue) return;
    if (v.recalculer && v.fix) calerReleve();
    const an = v.ancre;
    // Le dernier relevé tombe avant l'entrée du tunnel : c'est le tronçon où
    // la voiture arrive sur sa lancée qui compte.
    const depuis = (maintenant - an.t) / 1000;
    let limite = EXTRAPOLATION_S;
    if (v.chemin && an.v > 1 && depuis > EXTRAPOLATION_S) {
        const sortie = sortieDuTunnel(v.chemin, an.v * EXTRAPOLATION_S);
        if (sortie != null) limite = sortie / an.v + EXTRAPOLATION_S;
    }
    const ecoule = Math.min(depuis, limite);
    let cx, cy, ccap;
    const p = v.chemin && pointDuChemin(v.chemin, an.v * ecoule);
    if (p) {
        v.dChemin = an.v * ecoule;
        cx = p.x; cy = p.y; ccap = p.cap;
    } else {
        const cap = an.cap ?? v.cap;
        cx = an.x + an.v * ecoule * Math.sin(cap * RAD);
        cy = an.y + an.v * ecoule * Math.cos(cap * RAD);
        ccap = cap;
    }
    const k = 1 - Math.exp(-dt / LISSAGE_POSITION_S);
    if (Math.hypot(cx - v.x, cy - v.y) > SAUT_M) { v.x = cx; v.y = cy; }
    else { v.x += (cx - v.x) * k; v.y += (cy - v.y) * k; }
    // À l'arrêt, le cap reste : le GPS n'en donne plus, ou un faux.
    if (an.v > 0.8) v.cap += ecartCap(ccap, v.cap) * (1 - Math.exp(-dt / LISSAGE_CAP_S));
    // Figée faute de relevé, la voiture affiche 0, pas sa dernière vitesse.
    v.v += ((depuis > limite ? 0 : an.v || 0) - v.v) * (1 - Math.exp(-dt / 0.8));
    // L'altitude : celle du relief, sauf sur un pont et à son approche, où la
    // route BD TOPO porte la sienne (route/graphe), et dans un tunnel, sous le
    // relief (route/tunnels) ; lissée, pour ne pas sauter d'une tuile à l'autre.
    let alt = altitudeL93(v.x, v.y);
    if (p && an.a) {
        const e = areteDuChemin(v.chemin, v.dChemin);
        if (e.a.sol > 0) {
            const z = pointArete(e.a, e.s).z;
            if (Number.isFinite(z)) alt = Number.isFinite(alt) ? Math.max(alt, z) : z;
        } else if (e.a.sol < 0) {
            const z = altitudeSousTerre(e.a, e.s);
            if (Number.isFinite(z)) alt = z;
        } else {
            const z = altitudeApproche(e.a, e.s);
            if (Number.isFinite(z)) alt = Number.isFinite(alt) ? Math.max(alt, z) : z;
        }
        v.arete = e.a;
        v.sensArete = e.sens;
    } else {
        v.arete = null;
    }
    if (Number.isFinite(alt)) v.alt = v.altPret ? v.alt + (alt - v.alt) * (1 - Math.exp(-dt / 0.25)) : alt;
    v.altPret = v.altPret || Number.isFinite(alt);
    if (Math.hypot(v.x - ORIGINE.x, v.y - ORIGINE.y) > RECALAGE_M) recaler(v.x, v.y);
    poserVoiture();
}
