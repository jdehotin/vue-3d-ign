// Le guidage : l'itinéraire jusqu'à `vers`, son suivi, le nouveau calcul hors
// du tracé, la prochaine manœuvre et l'heure d'arrivée.

import { versLambert93 } from '../socle/lambert93.js';
import { voiture, VERS, PAR, itineraire, poserItineraire } from '../socle/etat.js';
import { annoncer } from '../interface/ecran.js';
import { carrePret, projeterSurTrace, pointArete, capDepuis, ecartCap, suites, permise } from './graphe.js';

// L'itinéraire vient du service de la Géoplateforme : gratuit, sans clé,
// ouvert aux pages d'autres origines (Access-Control-Allow-Origin: *), et
// calculé sur la BD TOPO entière, quand le graphe de la page ne tient que
// les carrés lus. Sans trafic ni fermetures : le temps est celui des
// vitesses de la BD TOPO. La page le suit sur son graphe (route/graphe).
const SERVICE = 'https://data.geopf.fr/navigation/itineraire';
const DELAI_MS = 20000;
// Un relevé de moins de PRECISION_DEPART_M, pour partir : le premier relevé
// d'un téléphone vient souvent du Wi-Fi, à plusieurs centaines de mètres.
// Passé ATTENTE_PRECISION_S sans mieux (un ordinateur, sans GPS), le relevé
// qu'on a, à PRECISION_MAX_M au plus.
const PRECISION_DEPART_M = 50, ATTENTE_PRECISION_S = 8, PRECISION_MAX_M = 2000;
// Hors du tracé : la route prévue ne le suit plus (le relevé est calé sur
// une autre route), et le relevé en est à plus de HORS_TRACE_M, RELEVES_HORS
// fois de suite. En ville, le GPS s'égare de 20 à 30 m quand il en annonce 8
// (route/graphe, caler) : un seul des deux signes, ou une seule fois, ne
// suffit pas. À confirmer sur la route.
const HORS_TRACE_M = 25, RELEVES_HORS = 3;
const ARRIVEE_M = 20;

export const guidage = {
    etat: VERS ? 'attente' : null,          // attente, calcul, suivi, hors, arrivee, erreur
    demandes: 0, enCours: false, echecs: 0, prochainEssai: 0, maintenant: 0,
    derniereDemande: null, dernierFix: null, relevesHors: 0, premierReleve: null,
    parRestants: PAR.slice(),               // les points de passage pas encore franchis
};

/** Le tracé de la réponse du service, en Lambert-93, et le temps le long de lui. */
export function lireTrace(r) {
    const xs = [], ys = [], cum = [];
    for (const [lon, lat] of r.geometry.coordinates) {
        const [x, y] = versLambert93(lon, lat);
        if (xs.length) {
            const l = Math.hypot(x - xs[xs.length - 1], y - ys[ys.length - 1]);
            if (l < 0.01) continue;
            cum.push(cum[cum.length - 1] + l);
        } else cum.push(0);
        xs.push(x); ys.push(y);
    }
    if (!xs.length) throw new Error('tracé vide');
    // Départ et arrivée au même endroit : un tracé d'un point, doublé.
    if (xs.length < 2) { xs.push(xs[0]); ys.push(ys[0]); cum.push(0); }
    const longueur = cum[cum.length - 1];
    // Le temps de chaque étape : de l'autoroute à la rue, la vitesse change.
    // Les distances du service, géodésiques, sont ramenées au tracé, en
    // Lambert-93.
    const echelle = r.distance > 0 ? longueur / r.distance : 1;
    const etD = [0], etT = [0], bornes = [];
    let d = 0, t = 0;
    for (const p of r.portions || []) {
        for (const s of p.steps || []) { d += s.distance * echelle; t += s.duration; etD.push(d); etT.push(t); }
        bornes.push(d);
    }
    if (etD.length < 2) { etD.push(longueur); etT.push(r.duration || 0); }
    return { xs: Float64Array.from(xs), ys: Float64Array.from(ys), cum: Float64Array.from(cum), longueur,
             duree: etT[etT.length - 1], etD, etT, bornes, t: 0, quitte: false };
}

/** Le temps qui reste jusqu'à l'arrivée, en secondes, pour qui est en `t` sur le tracé `tr`. */
export function tempsRestant(tr, t = tr.t) {
    const D = tr.etD, T = tr.etT;
    let k = 1;
    while (k < D.length - 1 && D[k] < t) k++;
    const u = Math.min(Math.max((t - D[k - 1]) / (D[k] - D[k - 1] || 1), 0), 1);
    return Math.max(tr.duree - (T[k - 1] + (T[k] - T[k - 1]) * u), 0);
}

async function demander(f, maintenant) {
    guidage.enCours = true;
    guidage.demandes++;
    guidage.derniereDemande = { x: f.x, y: f.y, t: maintenant };
    if (!itineraire || itineraire.quitte) guidage.etat = 'calcul';
    const url = new URL(SERVICE);
    url.search = new URLSearchParams({
        resource: 'bdtopo-osrm', profile: 'car', optimization: 'fastest', geometryFormat: 'geojson',
        getSteps: 'true', getBbox: 'false', start: `${f.lon},${f.lat}`, end: `${VERS.lon},${VERS.lat}`,
    });
    if (guidage.parRestants.length) {
        url.searchParams.set('intermediates', guidage.parRestants.map(p => `${p.lon},${p.lat}`).join('|'));
    }
    const abandon = new AbortController(), minuterie = setTimeout(() => abandon.abort(), DELAI_MS);
    try {
        const r = await fetch(url, { signal: abandon.signal });
        if (!r.ok) throw new Error(`réponse ${r.status}`);
        poserItineraire(lireTrace(await r.json()));
        guidage.echecs = 0;
        guidage.relevesHors = 0;
        guidage.etat = 'suivi';
        // La route prévue se refait sur le nouveau tracé, sans attendre le relevé suivant.
        voiture.recalculer = true;
    } catch (e) {
        guidage.echecs++;
        const attente = Math.min(10 * 2 ** (guidage.echecs - 1), 60);
        guidage.prochainEssai = guidage.maintenant + attente * 1000;
        if (!itineraire) guidage.etat = 'erreur';
        annoncer(`Itinéraire indisponible : nouvel essai dans ${attente} s`);
        console.warn('itinéraire :', e.message || e);
    } finally {
        clearTimeout(minuterie);
        guidage.enCours = false;
    }
}

/** Le tracé : demandé au premier relevé, suivi, redemandé quand la voiture le quitte. */
export function majGuidage(maintenant) {
    if (!VERS) return;
    guidage.maintenant = maintenant;
    const f = voiture.fix, tr = itineraire;
    const peutDemander = f && f.precision <= PRECISION_DEPART_M && !guidage.enCours && maintenant >= guidage.prochainEssai;
    if (!tr) {
        if (f && guidage.premierReleve == null) guidage.premierReleve = maintenant;
        const assez = f && (f.precision <= PRECISION_DEPART_M
            || (f.precision <= PRECISION_MAX_M && maintenant - guidage.premierReleve > ATTENTE_PRECISION_S * 1000));
        if (assez && !guidage.enCours && maintenant >= guidage.prochainEssai) demander(f, maintenant);
        return;
    }
    // L'avancée sur le tracé : celle de la voiture sur la route prévue, qui le suit.
    const ch = voiture.chemin, surTrace = !!ch && ch.t0 != null;
    if (surTrace) tr.t = Math.min(ch.t0 + voiture.dChemin, tr.longueur);
    if (guidage.etat === 'arrivee') return;
    if (surTrace && tr.longueur - tr.t < ARRIVEE_M) { guidage.etat = 'arrivee'; return; }
    if (!f || f === guidage.dernierFix) return;
    guidage.dernierFix = f;
    // Hors du tracé ? Jugé sur ce qui est lu : ailleurs, la route prévue ne
    // peut pas le suivre.
    let hors = false;
    if (!surTrace && carrePret(f.x, f.y)) {
        const q = projeterSurTrace(tr, f.x, f.y, tr.t - 150, tr.t + 1500);
        hors = !q || q.d > HORS_TRACE_M;
    }
    guidage.relevesHors = hors ? guidage.relevesHors + 1 : 0;
    tr.quitte = guidage.relevesHors >= RELEVES_HORS;
    if (guidage.etat !== 'calcul' || !tr.quitte) guidage.etat = tr.quitte ? 'hors' : 'suivi';
    if (!tr.quitte || !peutDemander) return;
    // Pas deux demandes du même endroit coup sur coup : hors de toute route
    // (un parking), le tracé serait le même.
    const dd = guidage.derniereDemande;
    if (dd && Math.hypot(f.x - dd.x, f.y - dd.y) < 30 && maintenant - dd.t < 60000) return;
    // Les points de passage franchis ne sont plus demandés.
    const passes = tr.bornes.slice(0, -1).filter(b => b <= tr.t + 30).length;
    guidage.parRestants = guidage.parRestants.slice(passes);
    demander(f, maintenant);
}

// --- Les manœuvres -------------------------------------------------------------
// Tirées du graphe le long de la route prévue, pas des consignes du service :
// celles-ci ne disent pas les ronds-points (« turn », « end of road »), et
// donnent une « fork » à chaque séparation de chaussées (17 sur 87 km d'Aix
// à Avignon).

/** Les sorties de l'anneau au nœud `m`, pour qui y roule sur `r` : les branches qu'on peut prendre. */
const sortiesAu = (m, r) => m.aretes.filter(c => c !== r && c.nature !== 'Rond-point' && c.n0 !== c.n1 && permise(c, m)).length;

/** La manœuvre au bout de l'étape `i` du parcours `P` d'une route prévue, ou null : la route continue. */
export function manoeuvre(P, i) {
    const e = P[i], f = P[i + 1], a = e.a, b = f.a;
    const n = e.sens > 0 ? a.n1 : a.n0;
    if (b === a) return { type: 'demi-tour', angle: 180, vers: b };
    const capArrivee = pointArete(a, e.sens > 0 ? a.L : 0, e.sens).cap;
    const angle = ecartCap(capDepuis(b, n), capArrivee);
    if (a.nature === 'Rond-point') {
        // Sur l'anneau : la sortie, s'il y en a une ici.
        return b.nature === 'Rond-point' ? null : { type: 'sortir', angle, vers: b };
    }
    if (b.nature === 'Rond-point') {
        // Le rond-point, annoncé à l'entrée, avec le numéro de la sortie.
        let sortie = 0, j = i + 1;
        for (; j + 1 < P.length && P[j + 1].a.nature === 'Rond-point'; j++) {
            const r = P[j].a;
            sortie += sortiesAu(P[j].sens > 0 ? r.n1 : r.n0, r);
        }
        const finAnneau = P[j + 1];
        if (!finAnneau) return { type: 'rond-point', sortie: null, angle: 0, vers: null };
        const r = P[j].a, m = P[j].sens > 0 ? r.n1 : r.n0;
        return { type: 'rond-point', sortie: sortie + 1, vers: finAnneau.a,
                 angle: ecartCap(capDepuis(finAnneau.a, m), capArrivee) };
    }
    const options = suites(a, n, capArrivee);
    if (!options.some(o => o.a !== b)) return null;        // pas d'autre route ici
    if (options[0].a === b && Math.abs(angle) < 45) return null;   // la suite naturelle
    if (b.nature === 'Bretelle' && a.nature !== 'Bretelle') return { type: 'sortie', angle, vers: b };
    if (Math.abs(angle) < 30) {
        const autre = options.find(o => o.a !== b);
        return { type: 'serrer', angle, vers: b,
                 cote: ecartCap(capDepuis(b, n), capDepuis(autre.a, n)) > 0 ? 'droite' : 'gauche' };
    }
    return { type: 'tourner', angle, vers: b };
}

/**
 * La prochaine manœuvre de la route prévue, et à combien de mètres (`d`) ;
 * l'arrivée, si elle vient avant ; sinon, la route à suivre jusqu'au bout de
 * ce qui est lu. Null sans tracé, ou hors de lui.
 */
export function prochaineManoeuvre() {
    const v = voiture, ch = v.chemin;
    if (!itineraire || !ch || ch.t0 == null) return null;
    const P = ch.parcours;
    let i = 0;
    while (i + 1 < P.length && P[i + 1].debut <= v.dChemin) i++;
    for (; i + 1 < P.length; i++) {
        if (P[i + 1].t == null) return null;            // la route prévue quitte le tracé
        const m = manoeuvre(P, i);
        // L'arrivée sur l'anneau même (place de la Nation) : pas de sortie à dire.
        if (m && m.type === 'rond-point' && m.sortie == null && ch.fin === 'arrivee') break;
        if (m) return { ...m, d: P[i + 1].debut - v.dChemin, t: P[i + 1].t };
    }
    if (ch.fin === 'arrivee') return { type: 'arrivee', angle: 0, d: ch.longueur - v.dChemin, vers: null };
    return { type: 'suivre', angle: 0, d: ch.longueur - v.dChemin, vers: P[i].a };
}
