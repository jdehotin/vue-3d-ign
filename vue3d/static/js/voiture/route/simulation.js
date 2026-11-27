// La conduite simulée, et son itinéraire jusqu'à `vers`.

import { PARAMS, VITESSE_SIMU_KMH, SIMU_LIMITE, HASARD_SIMU } from '../socle/parametres.js';
import { depuisLambert93, convergence } from '../socle/lambert93.js';
import { voiture, VERS, itineraire } from '../socle/etat.js';
import {
    pointArete, capDepuis, ecartCap, carrePret, suites, suiteProbable, suiteSurTrace, arriveeSur, surTrace,
    pointDuTrace, caler,
} from './graphe.js';
import { limiteDe } from './limitations.js';
import { recevoirPosition } from './voiture.js';

// Une voiture virtuelle roule sur le graphe à vitesse constante, tourne au
// hasard aux carrefours (la suite la plus probable deux fois sur trois),
// fait demi-tour au bout d'une impasse, et attend au bord de ce qui n'est
// pas encore lu. Elle donne un relevé par seconde, bruité comme un GPS : la
// page ne sait rien d'autre d'elle.

// --- Itinéraire de la simulation ---------------------------------------------------
// Vers `vers=lat,lon` (socle/etat), le long du tracé du service de l'IGN
// (route/guidage), comme au GPS.
// `attente=1` : la voiture simulée attend au départ que la page l'en libère
// (window.__voiture.partir()) ; un film commence ainsi sur un sol chargé.
let simuPartie = PARAMS.get('attente') !== '1';
export function partirSimu() { simuPartie = true; }
// `devier=<s>` : passé ce temps de route, la voiture simulée quitte le tracé
// au carrefour suivant, une fois, pour éprouver le nouveau calcul de
// l'itinéraire (outils/essai-voiture.mjs).
const DEVIER_S = Number(PARAMS.get('devier')) || null;

export const simu = { a: null, s: 0, sens: 1, dernier: -Infinity, etat: { capEntree: null }, v: 0, arrive: false,
                      // Sur le tracé : `t`, son abscisse en `sDebut` ; `fin`, celle de l'arrivée sur `a`.
                      t: null, sDebut: 0, fin: null, suivante: undefined, trace: null, roule: 0, deviee: false,
                      // Ce que la voiture simulée ne prend pas : chemins, voies réservées.
                      evitees: { has: b => b.nature === 'Chemin' || b.nature === 'Route empierrée'
                                           || !!(b.acces && b.acces.startsWith('Restreint')) } };

/** La voiture simulée entre sur `a` dans le sens `sens`, à l'abscisse `s` ; `t`, la sienne sur le tracé, ou null. */
function entrer(a, sens, s, t) {
    simu.a = a; simu.sens = sens; simu.s = s; simu.sDebut = s; simu.t = t;
    simu.fin = t != null ? arriveeSur(a, sens, s, t) : null;
    simu.suivante = undefined;
}
/** L'abscisse sur le tracé du bout de `simu.a`, null hors du tracé. */
const tAuNoeud = () => simu.t == null ? null : simu.t + Math.abs((simu.sens > 0 ? simu.a.L : 0) - simu.sDebut);

/**
 * Un nouveau tracé : au départ, la voiture se pose sur son début, dans son
 * sens ; en route (un nouveau calcul), elle s'y raccroche où elle est, quitte
 * à faire demi-tour. Faux tant que le début n'est pas lu.
 */
function prendreTrace() {
    if (!simu.roule) {
        const p = pointDuTrace(itineraire, 0), cap = pointDuTrace(itineraire, 10).cap;
        const m = caler(p.x, p.y, 5, cap);
        if (!m) return false;
        simu.a = m.a; simu.s = m.s; simu.sens = m.sens;
    }
    simu.trace = itineraire;
    let t = surTrace(simu.a, simu.s, simu.sens, itineraire.t);
    if (t == null && simu.a.sens !== (simu.sens > 0 ? '+' : '-')) {
        const r = surTrace(simu.a, simu.s, -simu.sens, itineraire.t);
        if (r != null) { simu.sens = -simu.sens; t = r; }
    }
    entrer(simu.a, simu.sens, simu.s, t);
    return true;
}

/** La suite de la voiture simulée au nœud `n` : celle du tracé, sinon la plus probable. */
function choisir(a, n) {
    const t = tAuNoeud();
    if (t != null) {
        const sur = suiteSurTrace(a, simu.sens, n, t);
        if (sur && DEVIER_S && !simu.deviee && simu.roule >= DEVIER_S) {
            // Une rue qui mène quelque part : pas une cour, d'où la voiture
            // ressortirait aussitôt sur le tracé (une cour du faubourg
            // Saint-Antoine, au premier essai).
            const capArrivee = pointArete(a, simu.sens > 0 ? a.L : 0, simu.sens).cap;
            const autre = suites(a, n, capArrivee).find(o => o.a !== sur.a && !simu.evitees.has(o.a)
                && (o.sens > 0 ? o.a.n1 : o.a.n0).aretes.length >= 3);
            if (autre) { simu.deviee = true; return { ...autre, t: null }; }
        }
        if (sur) return sur;
    }
    const p = suiteProbable(a, simu.sens, n, simu.etat, simu.evitees, VERS ? 0 : HASARD_SIMU);
    // Revenue sur le tracé, la voiture le suit de nouveau.
    return p && { ...p, t: itineraire ? surTrace(p.a, p.sens > 0 ? 0 : p.a.L, p.sens, itineraire.t) : null };
}

function gauss() { return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random()); }
// Avec un itinéraire, la voiture simulée ralentit avant un virage (à 90°,
// au tiers de sa vitesse) et s'arrête à l'arrivée ; sa vitesse suit en une
// seconde.
const VIRAGE_APPROCHE_M = 35, ARRIVEE_APPROCHE_M = 45;
/** La vitesse de croisière de la voiture simulée, en m/s : la limitation du tronçon, avec `vitesse=limite`. */
function vitesseMaxSimu() {
    if (!SIMU_LIMITE) return VITESSE_SIMU_KMH / 3.6;
    const l = limiteDe(simu.a, simu.sens);
    if (l) simu.limite = l.v;
    return (simu.limite || VITESSE_SIMU_KMH) / 3.6;
}
function vitesseVoulueSimu() {
    const vmax = vitesseMaxSimu();
    if (simu.arrive) return 0;
    if (!itineraire) return vmax;
    if (simu.fin != null) {
        const reste = Math.abs(simu.fin - simu.s);
        return vmax * Math.min(Math.max(reste / ARRIVEE_APPROCHE_M, 0.15), 1);
    }
    const a = simu.a, fin = simu.sens > 0 ? a.L - simu.s : simu.s;
    if (simu.t == null || fin > VIRAGE_APPROCHE_M) return vmax;
    const n = simu.sens > 0 ? a.n1 : a.n0;
    if (simu.suivante === undefined) simu.suivante = suiteSurTrace(a, simu.sens, n, tAuNoeud());
    const suite = simu.suivante;
    if (!suite) return vmax;
    const virage = suite.a === a ? 180
        : Math.abs(ecartCap(capDepuis(suite.a, n), pointArete(a, simu.sens > 0 ? a.L : 0, simu.sens).cap));
    return vmax * Math.min(Math.max(1 - virage / 120, 0.33), 1);
}

/** Un relevé immobile au départ, une fois par seconde : la page attend avec la voiture. */
function attendreAuDepart(maintenant) {
    if (maintenant - simu.dernier < 1000) return;
    simu.dernier = maintenant;
    const [lon, lat] = depuisLambert93(voiture.attendu.x, voiture.attendu.y);
    recevoirPosition({ coords: { latitude: lat, longitude: lon, accuracy: 5, speed: 0, heading: null } });
}

export function majSimu(dt, maintenant) {
    if (VERS) {
        // En attendant le tracé, et que son début soit lu, la voiture attend au départ.
        if (!itineraire || (simu.trace !== itineraire && !prendreTrace())) { attendreAuDepart(maintenant); return; }
    } else if (!simu.a) {
        const d = voiture.attendu;
        const m = caler(d.x, d.y, 40, null);
        if (!m) return;
        entrer(m.a, m.a.sens === '-' ? -1 : 1, m.s, null);
    }
    simu.v += ((simuPartie ? vitesseVoulueSimu() : 0) - simu.v) * (1 - Math.exp(-dt / 1.0));
    if (simu.v > 0.1) simu.roule += dt;
    let reste = simu.v * dt;
    let arrete = simu.arrive;
    for (let garde = 0; reste > 0 && garde < 20 && !simu.arrive; garde++) {
        const a = simu.a;
        if (simu.fin != null) {
            const jusqua = Math.abs(simu.fin - simu.s);
            if (reste >= jusqua) { simu.s = simu.fin; simu.arrive = true; arrete = true; break; }
        }
        const fin = simu.sens > 0 ? a.L - simu.s : simu.s;
        if (reste < fin) { simu.s += simu.sens * reste; reste = 0; break; }
        reste -= fin;
        simu.s = simu.sens > 0 ? a.L : 0;
        const n = simu.sens > 0 ? a.n1 : a.n0;
        if (!carrePret(n.x, n.y)) { arrete = true; break; }
        const choix = choisir(a, n);
        if (!choix) {
            simu.etat.capEntree = null;
            entrer(a, -simu.sens, simu.s, null);
            continue;
        }
        entrer(choix.a, choix.sens, choix.sens > 0 ? 0 : choix.a.L, choix.t);
    }
    if (maintenant - simu.dernier < 1000) return;
    simu.dernier = maintenant;
    // Sous terre, le GPS ne capte pas : la page file sur sa lancée.
    if (simu.a.sol < 0) return;
    const p = pointArete(simu.a, simu.s, simu.sens);
    const [lon, lat] = depuisLambert93(p.x + 2.5 * gauss(), p.y + 2.5 * gauss());
    recevoirPosition({ coords: { latitude: lat, longitude: lon, accuracy: 5,
        speed: arrete ? 0 : simu.v, heading: arrete ? null : (p.cap + convergence(lon) + 360) % 360 } });
}
