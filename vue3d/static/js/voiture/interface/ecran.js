// L'écran : bandeau, annonce, lien vers la vue 3D.

import { depuisLambert93 } from '../socle/lambert93.js';
import { voiture } from '../socle/etat.js';

// Le bandeau (rue, GPS, carrés), l'annonce passagère et le lien vers la vue 3D,
// que les carrés, la position et les signalements écrivent aussi.
export const elVitesse = document.getElementById('vitesse'), elRue = document.getElementById('rue');
export const elNom = document.getElementById('rue-nom'), elNumero = document.getElementById('rue-numero');
export const elGps = document.getElementById('etat-gps'), elCarres = document.getElementById('etat-carres');

let effacerAnnonce = null;
export function annoncer(texte, duree = 6) {
    const el = document.getElementById('annonce');
    el.textContent = texte;
    el.hidden = false;
    clearTimeout(effacerAnnonce);
    effacerAnnonce = setTimeout(() => { el.hidden = true; }, duree * 1000);
}

export function majLienQuitter() {
    const v = voiture;
    const [lon, lat] = depuisLambert93(v.vue ? v.x : v.attendu.x, v.vue ? v.y : v.attendu.y);
    document.getElementById('b-quitter').href = `./?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;
}
/** Le texte, sûr dans du HTML. */
export const echapperHtml = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
