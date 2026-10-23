// La position : le GPS, et l'écran gardé allumé.

import { DEPART_SIMU } from '../socle/parametres.js';
import { depuisLambert93 } from '../socle/lambert93.js';
import { voiture } from '../socle/etat.js';
import { annoncer } from './ecran.js';
import { recevoirPosition } from '../route/voiture.js';
import { accueil } from './affichage.js';

const MESSAGES_GEOLOC = {
    1: "La géolocalisation est refusée : à autoriser dans les réglages du site, ou essayez la simulation.",
    2: "Position indisponible : ni GPS, ni Wi-Fi, ni réseau exploitable.",
    3: "Le navigateur n'a pas donné de position à temps.",
};
const lienSimu = () => {
    const p = voiture.attendu ? depuisLambert93(voiture.attendu.x, voiture.attendu.y) : [DEPART_SIMU.lon, DEPART_SIMU.lat];
    return `voiture?simu=1&lat=${p[1].toFixed(5)}&lon=${p[0].toFixed(5)}`;
};
let suivi = null;
export function demarrerGps() {
    if (!navigator.geolocation || !window.isSecureContext) {
        accueil(`<p>${!window.isSecureContext ? 'La géolocalisation exige une page en https.'
            : 'Ce navigateur ne donne pas de position.'}</p>`,
            [['Essayer en simulation', lienSimu(), true], ['Vue 3D', './']]);
        return;
    }
    if (!voiture.vue) {
        accueil('<p><span class="roue"></span>Recherche de votre position…</p>'
            + '<p>La vue suit la voiture comme un GPS, et charge les bâtiments le long de la route, devant vous.</p>',
            [['Essayer en simulation', lienSimu()], ['Vue 3D', './']]);
    }
    suivi = navigator.geolocation.watchPosition(recevoirPosition, err => {
        if (err.code === 1) {
            navigator.geolocation.clearWatch(suivi);
            accueil(`<p>${MESSAGES_GEOLOC[1]}</p>`, [['Essayer en simulation', lienSimu(), true], ['Vue 3D', './']]);
        } else if (voiture.vue) {
            // Un tunnel, un parking : le suivi continue, la voiture file sur sa route.
            annoncer(MESSAGES_GEOLOC[err.code] || err.message);
        }
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}

// L'écran reste allumé tant que la page est au premier plan.
let verrouEcran = null;
export async function garderEcran() {
    try { verrouEcran = await navigator.wakeLock?.request('screen'); } catch (e) { /* refusé : tant pis */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') garderEcran(); });
// Chrome ne l'accorde souvent qu'après un geste.
window.addEventListener('pointerdown', () => { if (!verrouEcran || verrouEcran.released) garderEcran(); });
