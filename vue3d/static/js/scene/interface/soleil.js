// Le soleil du lieu, à l'heure et au jour choisis, et les ombres portées.

import * as THREE from 'three';
import { CENTER } from '../socle/point.js';
import { POINTS_CARDINAUX } from '../socle/projection.js';
import { ambiance, DISTANCE_SOLEIL, soleil } from '../socle/rendu.js';
import { majCiel } from '../terrain/horizon.js';

// La course du soleil est calculée pour la position du point, au jour et à
// l'heure choisis ; la scène s'ouvre sur aujourd'hui, à midi.
//
// Le curseur de saison déplace le JOUR simulé dans l'année. Il n'existe pas de
// réglage direct de la hauteur du soleil : hauteur et azimut sont couplés par
// la latitude et la date, un soleil déplacé à la main dessinerait des ombres
// qui n'existent pas ici. En changeant le jour, tout suit correctement — la
// hauteur à midi (64,5° au solstice d'été contre 17,7° à celui d'hiver, à 49°
// de latitude), les azimuts de lever et de coucher, la longueur du jour. C'est
// le complément du « masque au sud » : le 21 décembre est le cas d'épreuve, un
// obstacle inoffensif en juin peut ombrer tout l'hiver.
//
// Algorithme NOAA (Astronomical Almanac). Précision de l'ordre du centième de
// degré, très au-delà de ce qu'exige un rendu.
const RAD = Math.PI / 180;
const FUSEAU = 'Europe/Paris';   // celui des horodatages de l'application

/** Décalage d'un fuseau à un instant donné, en minutes. Gère l'heure d'été. */
function decalageMinutes(instant, fuseau) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: fuseau, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const p = Object.fromEntries(fmt.formatToParts(instant).map(x => [x.type, x.value]));
    const h = p.hour === '24' ? 0 : Number(p.hour);   // certains moteurs rendent 24
    const enUTC = Date.UTC(+p.year, p.month - 1, +p.day, h, +p.minute, +p.second);
    return (enUTC - instant.getTime()) / 60000;
}

/** Instant UTC correspondant à une heure locale du fuseau de l'application. */
function instantLocal(annee, mois, jour, heures) {
    const h = Math.floor(heures);
    const mn = Math.round((heures - h) * 60);
    const brut = new Date(Date.UTC(annee, mois - 1, jour, h, mn));
    // Une seule correction suffit hors des deux heures de bascule d'heure d'été.
    return new Date(brut.getTime() - decalageMinutes(brut, FUSEAU) * 60000);
}

/**
 * Azimut (0 = nord, sens horaire) et hauteur du soleil, en degrés.
 */
function positionSoleil(instant, lat, lon) {
    const jj = instant.getTime() / 86400000 + 2440587.5;     // jour julien
    const t = (jj - 2451545) / 36525;                         // siècles juliens

    const L0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
    const M = 357.52911 + t * (35999.05029 - 0.0001537 * t);
    const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
    const centre = Math.sin(M * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t))
                 + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * t)
                 + Math.sin(3 * M * RAD) * 0.000289;
    const omega = 125.04 - 1934.136 * t;
    const lambda = L0 + centre - 0.00569 - 0.00478 * Math.sin(omega * RAD);
    const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
    const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
    const declinaison = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) / RAD;

    // Équation du temps, en minutes : l'écart entre midi solaire et midi horloge.
    const y = Math.tan(eps / 2 * RAD) ** 2;
    const eqTemps = 4 / RAD * (
        y * Math.sin(2 * L0 * RAD)
        - 2 * e * Math.sin(M * RAD)
        + 4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD)
        - 0.5 * y * y * Math.sin(4 * L0 * RAD)
        - 1.25 * e * e * Math.sin(2 * M * RAD));

    const minutesUTC = instant.getUTCHours() * 60 + instant.getUTCMinutes()
                     + instant.getUTCSeconds() / 60;
    const solaire = (minutesUTC + eqTemps + 4 * lon + 1440) % 1440;
    const angleHoraire = solaire / 4 - 180;                   // degrés, 0 à midi vrai

    const cosZ = Math.sin(lat * RAD) * Math.sin(declinaison * RAD)
               + Math.cos(lat * RAD) * Math.cos(declinaison * RAD) * Math.cos(angleHoraire * RAD);
    const zenith = Math.acos(Math.min(1, Math.max(-1, cosZ))) / RAD;
    const hauteur = 90 - zenith;

    let azimut;
    const den = Math.cos(lat * RAD) * Math.sin(zenith * RAD);
    if (Math.abs(den) < 1e-9) {
        azimut = 180;                                          // soleil au zénith
    } else {
        const q = (Math.sin(lat * RAD) * Math.cos(zenith * RAD) - Math.sin(declinaison * RAD)) / den;
        const a = Math.acos(Math.min(1, Math.max(-1, q))) / RAD;
        // Convention NOAA. Le complément à 540 le matin et l'ajout de 180
        // l'après-midi ne sont pas interchangeables avec un simple 360 - a :
        // celui-ci intervertit les saisons (lever au sud-est en juin).
        azimut = angleHoraire > 0 ? (a + 180) % 360 : (540 - a) % 360;
    }
    return { azimut, hauteur };
}

// Date de la scène : aujourd'hui, à midi. Le curseur de saison la déplace.
const DATE_SCENE = (() => {
    const n = new Date();
    return { annee: n.getFullYear(), mois: n.getMonth() + 1, jour: n.getDate(),
             heure: 12 };
})();

const COULEUR_RASANTE = new THREE.Color(0xff9542);
const COULEUR_ZENITH  = new THREE.Color(0xfff2dd);

// Jour simulé par le curseur de saison ; on part d'aujourd'hui.
export const DATE_SIMULEE = { annee: DATE_SCENE.annee, mois: DATE_SCENE.mois, jour: DATE_SCENE.jour };

const MOIS_COURTS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin',
                     'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

function jourDeLAnnee(annee, mois, jour) {
    return Math.round((Date.UTC(annee, mois - 1, jour) - Date.UTC(annee, 0, 1)) / 86400000) + 1;
}

function poserJourSimule(n) {
    const d = new Date(Date.UTC(DATE_SIMULEE.annee, 0, 1) + (n - 1) * 86400000);
    DATE_SIMULEE.mois = d.getUTCMonth() + 1;
    DATE_SIMULEE.jour = d.getUTCDate();
}

export function majSoleil(heures) {
    const instant = instantLocal(DATE_SIMULEE.annee, DATE_SIMULEE.mois, DATE_SIMULEE.jour, heures);
    const { azimut, hauteur } = positionSoleil(instant, CENTER[1], CENTER[0]);

    // Repère de la scène : le nord est -Z, l'est +X.
    const cosH = Math.cos(hauteur * RAD);
    soleil.position.set(
        Math.sin(azimut * RAD) * cosH,
        Math.sin(hauteur * RAD),
        -Math.cos(azimut * RAD) * cosH).multiplyScalar(DISTANCE_SOLEIL);
    soleil.target.position.set(0, 0, 0);

    // Fondu au crépuscule : le soleil s'éteint sous l'horizon, et rougit en
    // rasant. Le ciel, lui, garde un reste de lumière — sinon la scène devient
    // illisible d'un cran de curseur à l'autre.
    const jour = Math.min(1, Math.max(0, (hauteur + 4) / 10));
    soleil.intensity = 2.0 * jour;
    soleil.castShadow = jour > 0.02;
    soleil.color.copy(COULEUR_RASANTE)
          .lerp(COULEUR_ZENITH, Math.min(1, Math.max(0, hauteur / 20)));
    ambiance.intensity = 0.3 + 0.8 * jour;
    majCiel(hauteur, jour);

    const h = Math.floor(heures) % 24, mn = Math.round((heures - Math.floor(heures)) * 60);
    document.getElementById('s-heure').textContent =
        `${String(h).padStart(2, '0')}:${String(mn).padStart(2, '0')}`;
    document.getElementById('s-saison').textContent =
        `${DATE_SIMULEE.jour} ${MOIS_COURTS[DATE_SIMULEE.mois - 1]}`;
    // La date affichée est TOUJOURS celle qui est simulée, marquée comme telle
    // dès qu'elle quitte aujourd'hui.
    const simulee = DATE_SIMULEE.mois !== DATE_SCENE.mois || DATE_SIMULEE.jour !== DATE_SCENE.jour;
    document.getElementById('s-date').textContent =
        `${String(DATE_SIMULEE.jour).padStart(2, '0')}/${String(DATE_SIMULEE.mois).padStart(2, '0')}/${DATE_SIMULEE.annee}`
        + (simulee ? ' (simulée)' : ' (aujourd’hui)');
    document.getElementById('s-azimut').textContent = hauteur > -0.83
        ? `${azimut.toFixed(0)}° ${POINTS_CARDINAUX[Math.round(azimut / 45) % 8]}` : '—';
    document.getElementById('s-hauteur').textContent = `${hauteur.toFixed(1)}°`;
    document.getElementById('note-soleil').textContent = hauteur <= -0.83
        ? 'Soleil sous l’horizon : aucune ombre portée.'
        : (hauteur < 10 ? 'Soleil rasant : les ombres portées sont longues et très sensibles au relief.'
                        : 'Ombres portées par le terrain et les bâtiments.');
}

const curseurHeure = document.getElementById('heure');
curseurHeure.value = DATE_SCENE.heure.toFixed(2);
curseurHeure.addEventListener('input', () => majSoleil(Number(curseurHeure.value)));

const curseurSaison = document.getElementById('saison');
curseurSaison.value = jourDeLAnnee(DATE_SCENE.annee, DATE_SCENE.mois, DATE_SCENE.jour);
curseurSaison.addEventListener('input', () => {
    poserJourSimule(Number(curseurSaison.value));
    majSoleil(Number(curseurHeure.value));
});
// Crans rapides : les deux solstices, l'équinoxe, et le retour à aujourd'hui. Le 21 décembre est le cas d'épreuve de l'ensoleillement.
for (const a of document.querySelectorAll('.saison-cran')) {
    a.addEventListener('click', e => {
        e.preventDefault();
        curseurSaison.value = jourDeLAnnee(DATE_SIMULEE.annee, +a.dataset.mois, +a.dataset.jour);
        poserJourSimule(Number(curseurSaison.value));
        majSoleil(Number(curseurHeure.value));
    });
}
document.getElementById('saison-aujourdhui').addEventListener('click', e => {
    e.preventDefault();
    curseurSaison.value = jourDeLAnnee(DATE_SCENE.annee, DATE_SCENE.mois, DATE_SCENE.jour);
    poserJourSimule(Number(curseurSaison.value));
    majSoleil(Number(curseurHeure.value));
});
majSoleil(DATE_SCENE.heure);
