// Le bandeau : rue, vitesse et limitation, prochain panneau, GPS, carrés prêts.

import { SIMU, VITESSE_SIMU_KMH, SIMU_LIMITE, RAD } from '../socle/parametres.js';
import { voiture, VERS, itineraire } from '../socle/etat.js';
import {
    elVitesse, elRue, elNom, elNumero, elGps, elCarres, majLienQuitter, echapperHtml,
} from './ecran.js';
import { manquees } from '../sol/manquees.js';
import { carres, carreDe } from '../carres/grille.js';
import { pointDuChemin } from '../route/graphe.js';
import { PAS_COULOIR_M } from '../carres/batiments.js';
import { limiteDe } from '../route/limitations.js';
import { prochainSignal } from '../route/signalisation.js';
import { simu } from '../route/simulation.js';
import { guidage, prochaineManoeuvre, tempsRestant } from '../route/guidage.js';
import { direGuidage } from './voix.js';
import { majAlerteSol } from './signalements.js';

const PETITS_MOTS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'et', 'en', 'au', 'aux', 'sur', 'sous', 'à']);
// Les abréviations du nom collaboratif (« R DE LA CHAUSSEE D'ANTIN »), quand
// la BAN n'en donne pas.
const ABREVIATIONS = { r: 'rue', av: 'avenue', ave: 'avenue', bd: 'boulevard', pl: 'place', rte: 'route',
    che: 'chemin', chem: 'chemin', imp: 'impasse', all: 'allée', qu: 'quai', sq: 'square', crs: 'cours',
    fg: 'faubourg', pass: 'passage', rpt: 'rond-point', espl: 'esplanade', prom: 'promenade', sen: 'sente' };
function nomDeVoie(nom) {
    let brut = String(nom || '').trim();
    if (!brut) return '';
    // Déjà en casse de nom propre (« Rond-point des Champs Elysées-Marcel
    // Dassault ») : tel quel. Seuls les noms tout en capitales (le nom
    // collaboratif) ou tout en minuscules (la BAN, parfois) sont refaits.
    const capitales = brut === brut.toUpperCase();
    if (!capitales && brut !== brut.toLowerCase()) return brut;
    brut = brut.toLowerCase().split(/\s+/).map((m, i) => (i === 0 && capitales && ABREVIATIONS[m]) || m).join(' ');
    const majuscule = mot => mot.split('-')
        .map((p, k) => !p || (k > 0 && PETITS_MOTS.has(p)) ? p : p[0].toUpperCase() + p.slice(1)).join('-');
    return brut.split(' ').map((mot, i) => {
        if (i > 0 && PETITS_MOTS.has(mot)) return mot;
        const m = /^([dl]')(.+)$/.exec(mot);
        if (i > 0 && m) return m[1] + majuscule(m[2]);
        return majuscule(mot);
    }).join(' ');
}
const NATURES = { 'Type autoroutier': 'Autoroute', 'Bretelle': 'Bretelle', 'Rond-point': 'Rond-point',
                  'Route à 2 chaussées': 'Route', 'Route à 1 chaussée': 'Route', 'Route empierrée': 'Route empierrée',
                  'Chemin': 'Chemin', 'Bac ou liaison maritime': 'Bac' };

const elCompteur = document.getElementById('compteur'), elLimite = document.getElementById('limite');
const elLimiteV = document.getElementById('limite-v'), elLimiteSource = document.getElementById('limite-source');
let limiteAffichee = null;
/**
 * Le panneau de la limitation du tronçon où l'on roule, dans son sens, et
 * d'où elle vient ; la vitesse en rouge au-delà. Sur un tronçon que règle la
 * signalisation locale, la dernière lue reste ; sur un tronçon dont le carré
 * n'est pas encore lu, plus de panneau : celle d'avant serait peut-être fausse.
 */
function majLimite(v) {
    const l = v.vue && v.arete && !v.horsRoute ? limiteDe(v.arete, v.sensArete) : undefined;
    if (l) limiteAffichee = l;
    else if (l === undefined) limiteAffichee = null;
    elLimite.hidden = !limiteAffichee;
    elCompteur.classList.toggle('exces', !!limiteAffichee && Math.round(v.v * 3.6) > limiteAffichee.v);
    if (!limiteAffichee) return;
    elLimiteV.textContent = limiteAffichee.v;
    elLimite.classList.toggle('estimee', !limiteAffichee.osm);
    elLimiteSource.textContent = limiteAffichee.osm ? 'OpenStreetMap' : 'estimée';
    elLimite.title = limiteAffichee.osm ? 'Limitation relevée dans OpenStreetMap'
        : 'Limitation estimée : la règle générale du code de la route, faute de donnée OpenStreetMap ici';
}
const elSignal = document.getElementById('signal'), elSignalD = document.getElementById('signal-d');
const NOMS_SIGNAUX = { stop: 'Stop', cedez: 'Cédez-le-passage', feu: 'Feu' };
/** Le prochain stop, cédez-le-passage ou feu de la route prévue, et à combien de mètres. */
function majSignal(v) {
    const s = prochainSignal(v);
    elSignal.hidden = !s;
    if (!s) return;
    elSignal.className = s.type;
    elSignalD.textContent = `${Math.round(s.d / 10) * 10} m`;
    elSignal.title = `${NOMS_SIGNAUX[s.type]} relevé dans OpenStreetMap ; un panneau qui n'y est pas saisi n'est pas annoncé`;
}
/** Une distance pour le bandeau : à 10 m près sous 100 m, à 50 m sous le km, en km au-delà. */
const distanceLisible = d => d >= 1000 ? (d / 1000).toFixed(1).replace('.', ',') + ' km'
    : Math.max(Math.round(d / (d < 100 ? 10 : 50)) * (d < 100 ? 10 : 50), 0) + ' m';
const heureLisible = s => {
    const h = new Date(Date.now() + s * 1000);
    return `${h.getHours()} h ${String(h.getMinutes()).padStart(2, '0')}`;
};
const nomDeLArete = a => a ? nomDeVoie(a.nom) || a.numero || '' : '';
const COTE = angle => angle > 0 ? 'à droite' : 'à gauche';
/** La consigne d'une manœuvre (route/guidage), en mots. */
function consigne(m) {
    const ab = Math.abs(m.angle);
    switch (m.type) {
        case 'arrivee': return VERS.nom ? `Arrivée : ${VERS.nom}` : 'Arrivée';
        case 'suivre': return 'Suivre la route';
        case 'demi-tour': return 'Faire demi-tour';
        case 'rond-point': return m.sortie ? `Au rond-point, ${m.sortie === 1 ? '1re' : m.sortie + 'e'} sortie` : 'Au rond-point';
        case 'sortir': return 'Sortir du rond-point';
        case 'sortie': return `Prendre la sortie ${COTE(m.angle)}`;
        case 'serrer': return `Serrer à ${m.cote}`;
        default: return ab < 60 ? `Légèrement ${COTE(m.angle)}` : ab < 135 ? `Tourner ${COTE(m.angle)}` : `Tourner franchement ${COTE(m.angle)}`;
    }
}
/** Le trait de la flèche d'une manœuvre, dans une boîte de 48 : il monte du bas et tourne de l'angle de la manœuvre. */
function fleche(m) {
    const pointe = (x, y, cap) => {
        const bout = d => `${(x + 8 * Math.sin((cap + 180 + d) * RAD)).toFixed(1)},${(y - 8 * Math.cos((cap + 180 + d) * RAD)).toFixed(1)}`;
        return `M${bout(-38)} L${x.toFixed(1)},${y.toFixed(1)} L${bout(38)}`;
    };
    const vers = (x0, y0, cap, l) => [x0 + l * Math.sin(cap * RAD), y0 - l * Math.cos(cap * RAD)];
    if (m.type === 'arrivee') return 'M16 44 V7 M16 8 H34 L30 14.5 L34 21 H16';
    if (m.type === 'demi-tour') return 'M30 44 V20 A8 8 0 0 0 14 20 V32 ' + pointe(14, 32, 180);
    if (m.type === 'rond-point' || m.type === 'sortir') {
        const cap = Math.max(Math.min(m.angle, 180), -180);
        const [x0, y0] = vers(24, 20, cap, 8), [x1, y1] = vers(24, 20, cap, 19);
        return `M24 44 V28 M${x0.toFixed(1)},${y0.toFixed(1)} L${x1.toFixed(1)},${y1.toFixed(1)} ` + pointe(x1, y1, cap);
    }
    const cap = m.type === 'serrer' ? (m.cote === 'droite' ? 35 : -35) : Math.max(Math.min(m.angle, 150), -150);
    const [x1, y1] = vers(24, 26, cap, 17);
    return `M24 44 V26 L${x1.toFixed(1)},${y1.toFixed(1)} ` + pointe(x1, y1, cap);
}
const elGuide = document.getElementById('guide'), elGuideFleche = document.getElementById('guide-fleche');
const elGuideD = document.getElementById('guide-d'), elGuideConsigne = document.getElementById('guide-consigne');
const elGuideArrivee = document.getElementById('guide-arrivee');
/** Vers une destination : la prochaine manœuvre, sa distance, l'heure d'arrivée. */
function majGuide() {
    elGuide.hidden = !VERS || !voiture.vue;
    document.body.classList.toggle('guidage', !elGuide.hidden);
    if (elGuide.hidden) return;
    const tr = itineraire, arrive = SIMU ? simu.arrive : guidage.etat === 'arrivee';
    const m = arrive ? { type: 'arrivee', angle: 0, d: 0 } : prochaineManoeuvre();
    let d = '', texte;
    if (m) {
        d = m.type === 'suivre' || arrive ? '' : distanceLisible(m.d);
        const nom = m.type === 'arrivee' ? '' : nomDeLArete(m.vers);
        texte = consigne(m) + (nom ? ' · ' + nom : '');
        elGuideFleche.setAttribute('d', fleche(m));
        direGuidage(m, nom, voiture.v, arrive ? 'arrivee' : guidage.etat, guidage.demandes);
    } else {
        texte = !tr ? (guidage.etat === 'erreur' ? 'Itinéraire indisponible' : 'Calcul de l\'itinéraire…')
            : guidage.etat === 'calcul' ? 'Nouvel itinéraire…' : 'Hors de l\'itinéraire';
        elGuideFleche.setAttribute('d', '');
    }
    elGuide.className = 'cartouche' + (m && (m.type === 'rond-point' || m.type === 'sortir') ? ' rond-point' : '');
    elGuideD.textContent = d;
    elGuideD.hidden = !d;
    elGuideConsigne.textContent = texte;
    elGuideArrivee.textContent = tr && !arrive
        ? `Arrivée ${heureLisible(tempsRestant(tr))} · ${distanceLisible(tr.longueur - tr.t)}` : '';
}

const elRond = document.querySelector('#etat .rond');
let dernierHud = -Infinity;
export function majHud(maintenant) {
    if (maintenant - dernierHud < 250) return;
    dernierHud = maintenant;
    const v = voiture;
    elVitesse.textContent = v.vue ? Math.round(v.v * 3.6) : '–';
    majLimite(v);
    majSignal(v);
    majGuide();
    const a = v.arete;
    if (a && !v.horsRoute) {
        const nom = nomDeVoie(a.nom);
        elNom.textContent = nom || NATURES[a.nature] || 'Route sans nom';
        elNumero.hidden = !a.numero;
        if (a.numero) {
            elNumero.textContent = a.numero;
            elNumero.className = 'numero ' + ({ D: 'd', E: 'e', C: 'c', V: 'c' }[a.numero[0]] || '');
        }
        elRue.hidden = false;
    } else {
        elRue.hidden = !v.vue;
        elNom.textContent = v.vue ? 'Hors des routes' : '';
        elNumero.hidden = true;
    }
    const age = v.fix ? (maintenant - v.fix.t) / 1000 : Infinity;
    elRond.className = 'rond' + (age > 10 ? ' perdu' : v.precision > 25 ? ' faible' : '');
    const resteArrivee = itineraire ? itineraire.longueur - itineraire.t : null;
    elGps.innerHTML = SIMU && VERS ? (simu.arrive ? `Arrivée${VERS.nom ? ' : <b>' + echapperHtml(VERS.nom) + '</b>' : ''}`
            : resteArrivee != null ? `${VERS.nom ? echapperHtml(VERS.nom) : 'Arrivée'} dans <b>${resteArrivee >= 1000
                ? (resteArrivee / 1000).toFixed(1).replace('.', ',') + ' km' : Math.round(resteArrivee / 10) * 10 + ' m'}</b>`
            : 'Calcul de l\'itinéraire…')
        : SIMU ? (SIMU_LIMITE ? 'Simulation <b>aux limitations</b>' : `Simulation à <b>${VITESSE_SIMU_KMH} km/h</b>`)
        : !v.fix ? 'Position attendue…'
        : age > 10 && v.arete?.sol < 0 ? 'Tunnel : <b>position estimée</b>'
        : age > 10 ? `<b>Signal GPS perdu</b> depuis ${Math.round(age)} s`
        : `GPS <b>± ${Math.round(v.precision)} m</b>`;
    // Jusqu'où les bâtiments sont prêts le long de la route prévue.
    let pret = 0;
    const ch = v.chemin;
    if (ch) {
        for (let d = v.dChemin; d <= ch.longueur; d += PAS_COULOIR_M) {
            const p = pointDuChemin(ch, d), c = carreDe(p.x, p.y);
            if (!c || !(c.mesh || c.etat === 'hors')) break;
            pret = d - v.dChemin;
        }
    }
    let charges = 0, construits = 0;
    for (const c of carres.values()) { if (c.etat === 'pret') charges++; if (c.mesh && c.mesh.visible) construits++; }
    elCarres.innerHTML = (ch ? `Bâtiments prêts sur <b>${pret >= 1000 ? (pret / 1000).toFixed(1).replace('.', ',') + ' km'
        : Math.round(pret / 50) * 50 + ' m'}</b> devant` : `${construits} carrés de bâtiments`)
        + (manquees.size ? `<br>${manquees.size} tuile${manquees.size > 1 ? 's' : ''} en attente de réseau` : '');
    const alerte = majAlerteSol(maintenant);
    if (alerte) elCarres.innerHTML += `<br><span class="alerte">⚠ Sol ${alerte}</span>`;
    if (v.vue) majLienQuitter();
}

export function accueil(html, actions) {
    document.getElementById('accueil-texte').innerHTML = html;
    const zone = document.getElementById('accueil-actions');
    zone.replaceChildren(...actions.map(([texte, faire, principal]) => {
        const el = typeof faire === 'string' ? document.createElement('a') : document.createElement('button');
        el.textContent = texte;
        if (typeof faire === 'string') el.href = faire; else el.addEventListener('click', faire);
        if (principal) el.className = 'principal';
        return el;
    }));
    document.getElementById('accueil').hidden = false;
}
