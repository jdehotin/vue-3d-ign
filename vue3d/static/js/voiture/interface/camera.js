// La caméra, derrière la voiture ou au-dessus, et ses gestes.

import * as THREE from 'three';
import { RAD } from '../socle/parametres.js';
import { ORIGINE } from '../socle/monde.js';
import { hote, renderer, camera, ciel } from '../socle/rendu.js';
import { voiture, PENTE_DEFAUT, camVue } from '../socle/etat.js';
import { altitudeL93 } from '../sol/altitudes.js';
import { ecartCap } from '../route/graphe.js';
import { fond, changerFond } from '../sol/sol.js';
import { montrerRoutesAuSol } from '../carres/routes.js';

// De derrière (3D), à un recul qui grandit avec la vitesse, ou de dessus (2D),
// la route vers le haut de l'écran. Un doigt tourne la vue autour de la
// voiture, deux doigts ou la molette règlent le recul ; huit secondes sans
// geste, elle revient derrière.
const RETOUR_GESTE_S = 8;
// La voiture sous le centre de l'écran, à cette part de sa demi-hauteur :
// vers 71 % de la hauteur depuis le haut, plus bas qu'à l'origine (60 %),
// à la demande de Yannick ; la route devant elle a la place.
const POSITION_VOITURE = 0.42;
export const RECUL = [15, 600], HAUTEUR = [60, 3000];
const coupe = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
function sousTerre(oui, altitude = 0) {
    ciel.visible = !oui;
    coupe.constant = altitude;
    if (oui !== renderer.clippingPlanes.length > 0) renderer.clippingPlanes = oui ? [coupe] : [];
}
export function majCamera(dt, maintenant) {
    const v = voiture;
    if (!v.vue && !v.attendu) return;
    const x = v.vue ? v.x : v.attendu.x, y = v.vue ? v.y : v.attendu.y;
    let alt = v.vue ? v.alt : altitudeL93(x, y);
    if (!Number.isFinite(alt)) alt = camVue.altAttente ?? 0;
    camVue.altAttente = alt;
    if (maintenant - camVue.dernierGeste > RETOUR_GESTE_S * 1000) {
        const k = 1 - Math.exp(-dt / 1.2);
        camVue.lacet -= camVue.lacet * k;
        camVue.tangage -= camVue.tangage * k;
    }
    camVue.cap += ecartCap(v.cap, camVue.cap) * (1 - Math.exp(-dt / 0.6));
    const cap = (camVue.cap + camVue.lacet) * RAD;
    const ux = Math.sin(cap), uy = Math.cos(cap);
    const px = x - ORIGINE.x, pz = ORIGINE.y - y;
    if (camVue.mode === '3d') {
        // Plus loin et plus haut quand on roule vite : on voit venir.
        const recul = camVue.recul * (1 + 0.4 * Math.min(v.v / 36, 1));
        const pente = Math.min(Math.max(PENTE_DEFAUT + camVue.tangage, 4), 80) * RAD;
        const cx = px - ux * recul * Math.cos(pente), cz = pz + uy * recul * Math.cos(pente);
        let cy = alt + recul * Math.sin(pente) + 3;
        const sol = altitudeL93(cx + ORIGINE.x, ORIGINE.y - cz);
        // Au-dessus du relief, sauf derrière une voiture sous terre : tenue
        // au-dessus, la caméra passait à Fourvière dans les toits de la
        // colline, 60 à 85 m au-dessus de la voiture, et serait jusqu'à
        // 2,3 km au-dessus d'elle au Mont-Blanc. Elle la suit dans le tunnel,
        // où l'on ne voit plus que la voûte, la route et la voiture
        // (interface/ruban), sur le noir de la roche : le ciel s'efface, et
        // tout ce qui passe au-dessus de la caméra est coupé — vue d'en
        // dessous, la ville de Fourvière n'était que murs, fûts et bords de
        // tuiles pendus en l'air. Ce qui est plus bas qu'elle reste : la
        // sortie, au bout.
        if (Number.isFinite(sol) && !(v.arete?.sol < 0)) cy = Math.max(cy, sol + 6);
        sousTerre(Number.isFinite(sol) && cy < sol, cy);
        camera.position.set(cx, cy, cz);
        camera.up.set(0, 1, 0);
        // La visée, d'après la place voulue de la voiture à l'écran, et non
        // un point devant elle : elle reste à POSITION_VOITURE quels que
        // soient le recul, la vitesse et l'inclinaison réglée au doigt.
        const versVoiture = Math.atan2(cy - alt - 1, recul * Math.cos(pente));
        const visee = Math.max(versVoiture - Math.atan(POSITION_VOITURE * Math.tan(camera.fov / 2 * RAD)), 2 * RAD);
        camVue.cible.set(cx + ux * Math.cos(visee) * 100, cy - Math.sin(visee) * 100, cz - uy * Math.cos(visee) * 100);
    } else {
        // De dessus, la caméra vise devant la voiture d'autant : elle se
        // tient à la même place de l'écran. Toujours au-dessus du relief :
        // sous terre, la carte reste, et le tunnel s'y voit par transparence.
        const h = camVue.hauteur, devant = POSITION_VOITURE * h * Math.tan(camera.fov / 2 * RAD);
        const sol = altitudeL93(x, y), haut = Number.isFinite(sol) ? Math.max(alt, sol) : alt;
        camera.position.set(px + ux * devant, haut + h, pz - uy * devant);
        sousTerre(false);
        camera.up.set(ux, 0, -uy);
        camVue.cible.set(px + ux * devant, alt, pz - uy * devant);
    }
    camera.lookAt(camVue.cible);
    ciel.position.copy(camera.position);
    document.getElementById('aiguille').setAttribute('transform', `rotate(${-(camVue.cap + camVue.lacet)} 26 26)`);
}

const pointeurs = new Map();
let pince = null;
hote.addEventListener('pointerdown', e => {
    hote.setPointerCapture(e.pointerId);
    pointeurs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    camVue.dernierGeste = performance.now();
    if (pointeurs.size === 2) {
        const [a, b] = [...pointeurs.values()];
        pince = { d: Math.hypot(a.x - b.x, a.y - b.y), recul: camVue.recul, hauteur: camVue.hauteur };
    }
});
hote.addEventListener('pointermove', e => {
    const p = pointeurs.get(e.pointerId);
    if (!p) return;
    camVue.dernierGeste = performance.now();
    if (pointeurs.size === 1) {
        camVue.lacet -= (e.clientX - p.x) * 0.3;
        if (camVue.mode === '3d') camVue.tangage += (e.clientY - p.y) * 0.15;
    }
    p.x = e.clientX; p.y = e.clientY;
    if (pointeurs.size === 2 && pince) {
        const [a, b] = [...pointeurs.values()];
        const k = pince.d / Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1);
        reglerRecul(pince.recul * k, pince.hauteur * k);
    }
});
const finPointeur = e => { pointeurs.delete(e.pointerId); if (pointeurs.size < 2) pince = null; };
hote.addEventListener('pointerup', finPointeur);
hote.addEventListener('pointercancel', finPointeur);
hote.addEventListener('wheel', e => {
    e.preventDefault();
    const k = Math.exp(e.deltaY * 0.0015);
    reglerRecul(camVue.recul * k, camVue.hauteur * k);
}, { passive: false });
function reglerRecul(recul, hauteur) {
    camVue.recul = Math.min(Math.max(recul, RECUL[0]), RECUL[1]);
    camVue.hauteur = Math.min(Math.max(hauteur, HAUTEUR[0]), HAUTEUR[1]);
}
document.getElementById('b-plus').addEventListener('click', () => reglerRecul(camVue.recul / 1.4, camVue.hauteur / 1.4));
document.getElementById('b-moins').addEventListener('click', () => reglerRecul(camVue.recul * 1.4, camVue.hauteur * 1.4));
document.getElementById('boussole').addEventListener('click', () => { camVue.lacet = 0; camVue.tangage = 0; });
const boutonVue = document.getElementById('b-vue');
export function majBoutonVue() { boutonVue.textContent = camVue.mode === '3d' ? '2D' : '3D'; }
boutonVue.addEventListener('click', () => { camVue.mode = camVue.mode === '3d' ? '2d' : '3d'; majBoutonVue(); });
majBoutonVue();
document.getElementById('b-fond').addEventListener('click', () => {
    changerFond(fond === 'ortho' ? 'plan' : 'ortho');
    montrerRoutesAuSol();
});
document.getElementById('b-fond').textContent = fond === 'ortho' ? 'Plan' : 'Photo';
montrerRoutesAuSol();
const boutonPlein = document.getElementById('b-plein');
if (document.fullscreenEnabled) {
    boutonPlein.hidden = false;
    boutonPlein.addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else document.documentElement.requestFullscreen().catch(() => {});
    });
}
window.addEventListener('keydown', e => {
    if (e.key === '+' || e.key === '=') reglerRecul(camVue.recul / 1.4, camVue.hauteur / 1.4);
    else if (e.key === '-') reglerRecul(camVue.recul * 1.4, camVue.hauteur * 1.4);
    else if (e.key === 'v') boutonVue.click();
    else if (e.key === 'p') document.getElementById('b-fond').click();
});
