// Le drone, au clavier ou au doigt.

import * as THREE from 'three';
import { ARTEFACT } from '../socle/chargement.js';
import { toLonLat, POINTS_CARDINAUX } from '../socle/projection.js';
import {
    terrain, altitudeRef, relief, exagVert, anneauRelief, BORNES, ySol,
} from '../terrain/etat.js';
import { scene, camera, controls } from '../socle/rendu.js';
import { groupeBatiments } from '../batiments/etat.js';
import { versPixel } from '../terrain/relief.js';
import {
    HORIZON_ZOOM_MIN, HORIZON_ZOOM_MAX, HORIZON_MAILLES, RAYON_TERRE_APPARENT, tuilesHorizon,
    horizonMontre,
} from '../terrain/horizon.js';
import { btnOrbit, vitesse, arreterOrbite } from './boutons.js';
import { decalage, aideVue, placerFleches } from './decalage.js';

// Un quadricoptère au clavier, vu de derrière : il quitte la scène et survole
// l'horizon, que la caméra entraîne avec elle. Des commandes d'arcade — la
// touche fixe une vitesse, l'inertie la rejoint — et pas de chute : le drone
// se pose sur ce qu'il survole, terrain, anneau, horizon ou toit, sans jamais
// passer dessous. La vitesse de pointe suit le curseur « vitesse » :
// DRONE_PAS_VITESSE m/s par cran, 65 km/h au cran de départ.
const DRONE_PAS_VITESSE = 3;
const DRONE_INERTIE_S = 0.6;                        // ~63 % de la vitesse voulue en 0,6 s
const DRONE_LACET = 75 * Math.PI / 180;             // rad/s, flèche tenue
const DRONE_GARDE = 1.5;                            // m au-dessus de ce qu'il survole
const DRONE_PLAFOND = 4000;                         // m au-dessus du point
export const DRONE_RECUL = { min: 4, depart: 9, max: 80 }; // caméra derrière le drone, m
const DRONE_INCLINAISON = 18 * Math.PI / 180;       // à pleine vitesse, pour l'œil seulement
// Au doigt (téléphone, tablette, écran d'une voiture), ni molette, ni survol,
// ni clavier : l'aide le dit, et le drone a ses touches à l'écran.
const AU_DOIGT = matchMedia('(pointer: coarse)').matches;
export const TACTILE = AU_DOIGT || navigator.maxTouchPoints > 0;
if (AU_DOIGT) aideVue.textContent = 'Glisser pour pivoter · pincer pour zoomer · '
    + 'toucher un bâtiment pour sa fiche';
const AIDE_ORBITE = aideVue.textContent;
const AIDE_DRONE = AU_DOIGT
    ? 'Drone : à gauche avancer, reculer, tourner · à droite monter, descendre, glisser · '
      + 'pincer pour le recul · son bouton pour sortir'
    : 'Drone : ↑ ↓ avancer, reculer · ← → tourner · Q D glisser · espace monter · '
      + 'Maj descendre · molette pour le recul · Échap pour sortir';
// Pas Entrée : retenue ici, elle n'activerait plus le bouton qui a le focus.
const TOUCHES_DRONE = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
                               'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight']);
export let droneActif = false;
export const drone = { position: new THREE.Vector3(), vitesse: new THREE.Vector3(), cap: 0, lacet: 0,
                tangage: 0, roulis: 0, recul: DRONE_RECUL.depart, sol: null };
export const touchesDrone = new Set();
const btnDrone = document.getElementById('t-drone');
const hudDrone = document.getElementById('hud-drone');
const padDrone = document.getElementById('pad-drone');
// Une touche à l'écran tient enfoncée sa touche du clavier tant que le doigt
// est dessus ; capturé, il la relâche même s'il glisse hors du bouton.
for (const b of padDrone.querySelectorAll('button')) {
    const relacher = () => { touchesDrone.delete(b.dataset.touche); b.classList.remove('appui'); };
    b.addEventListener('pointerdown', e => {
        e.preventDefault();
        b.setPointerCapture(e.pointerId);
        touchesDrone.add(b.dataset.touche);
        b.classList.add('appui');
    });
    for (const fin of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(fin, relacher);
    b.addEventListener('contextmenu', e => e.preventDefault());
}

// Un quadricoptère d'un mètre d'envergure, l'avant vers −Z et marqué
// d'orange. Il ne porte pas d'ombre : en vol, il ferait redessiner la carte
// d'ombre à chaque image. Une tache sombre au sol, qui pâlit avec la
// hauteur, dit où il est.
const groupeDrone = new THREE.Group();
groupeDrone.visible = false;
scene.add(groupeDrone);
const modeleDrone = new THREE.Group();
{
    const sombre = new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.6, metalness: 0.2 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xe07b00, roughness: 0.5 });
    const helice = new THREE.MeshBasicMaterial({ color: 0xd0d4d8, transparent: true, opacity: 0.35, depthWrite: false });
    modeleDrone.add(new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.5), sombre));
    const nez = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.06, 0.08), accent);
    nez.position.set(0, 0.02, -0.27);
    modeleDrone.add(nez);
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const bras = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.5), sombre);
        bras.position.set(sx * 0.175, 0, sz * 0.175);
        bras.rotation.y = sx * sz * Math.PI / 4;
        const moteur = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.06, 12), sz < 0 ? accent : sombre);
        moteur.position.set(sx * 0.35, 0.03, sz * 0.35);
        const disque = new THREE.Mesh(new THREE.CircleGeometry(0.17, 24), helice);
        disque.rotation.x = -Math.PI / 2;
        disque.position.set(sx * 0.35, 0.07, sz * 0.35);
        modeleDrone.add(bras, moteur, disque);
    }
    modeleDrone.scale.setScalar(1.4);
}
const ombreDrone = new THREE.Mesh(new THREE.CircleGeometry(0.7, 24), new THREE.MeshBasicMaterial({
    color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
ombreDrone.rotation.x = -Math.PI / 2;
groupeDrone.add(modeleDrone, ombreDrone);

/** Altitude de l'horizon sous un point, sur sa tuile chargée la plus fine ; null sinon. */
function altitudeHorizon(lon, lat, x, z) {
    const N = HORIZON_MAILLES, L = N + 1;
    for (let niveau = HORIZON_ZOOM_MAX; niveau >= HORIZON_ZOOM_MIN; niveau--) {
        const [px, py] = versPixel(lon, lat, niveau);
        const t = tuilesHorizon.get(`${niveau}/${Math.floor(px / 256)}/${Math.floor(py / 256)}`);
        if (!t || !t.mesh) continue;
        const fx = (px / 256 - t.x) * N, fy = (py / 256 - t.y) * N;
        const i = Math.min(Math.floor(fx), N - 1), j = Math.min(Math.floor(fy), N - 1);
        const ax = fx - i, ay = fy - j, k = j * L + i;
        const h = (t.alts[k] * (1 - ax) + t.alts[k + 1] * ax) * (1 - ay)
                + (t.alts[k + L] * (1 - ax) + t.alts[k + L + 1] * ax) * ay;
        return (h - altitudeRef) * exagVert - (x * x + z * z) / (2 * RAYON_TERRE_APPARENT);
    }
    return null;
}

const rayonSol = new THREE.Raycaster(), versLeBas = new THREE.Vector3(0, -1, 0), origineSol = new THREE.Vector3();
/**
 * Y de ce que l'on survole en (x, z), en unités de scène : le terrain fin,
 * sinon l'anneau, sinon l'horizon, et le toit le plus haut si `toits` ;
 * null si rien n'y est chargé.
 */
function solSous(x, z, toits) {
    const [lon, lat] = toLonLat(x, -z);
    const dansEmprise = lon >= BORNES.o && lon <= BORNES.e && lat >= BORNES.s && lat <= BORNES.n;
    let y = null;
    if (!relief) y = 0;     // sans relief, tout repose sur le plan à 0
    else if (terrain && dansEmprise) y = ySol(lon, lat);
    else if (anneauRelief && Number.isFinite(anneauRelief.alt(lon, lat))) {
        y = (anneauRelief.alt(lon, lat) - altitudeRef) * exagVert;
    } else if (horizonMontre) y = altitudeHorizon(lon, lat, x, z);
    if (toits && dansEmprise) {
        rayonSol.set(origineSol.set(x, DRONE_PLAFOND + 1000, z), versLeBas);
        const toit = rayonSol.intersectObjects(groupeBatiments.children, true)[0];
        if (toit) y = Math.max(y ?? -Infinity, toit.point.y);
    }
    return y;
}

function entrerDrone() {
    droneActif = true;
    btnDrone.classList.add('on');
    arreterOrbite();
    controls.enabled = false;
    // Il décolle de ce que l'on regardait, dans le sens du regard.
    const t = controls.target;
    const sol = solSous(t.x, t.z, true);
    drone.position.set(t.x, Math.max(t.y, sol ?? t.y) + 25, t.z);
    drone.cap = Math.atan2(t.x - camera.position.x, -(t.z - camera.position.z));
    drone.vitesse.set(0, 0, 0);
    drone.lacet = drone.tangage = drone.roulis = 0;
    drone.recul = DRONE_RECUL.depart;
    touchesDrone.clear();
    groupeDrone.visible = true;
    aideVue.textContent = AIDE_DRONE;
    hudDrone.hidden = false;
    padDrone.hidden = !TACTILE;
    decalage.hidden = true;
}

export function sortirDrone() {
    droneActif = false;
    btnDrone.classList.remove('on');
    controls.enabled = true;
    controls.target.copy(drone.position);
    groupeDrone.visible = false;
    aideVue.textContent = AIDE_ORBITE;
    hudDrone.hidden = true;
    padDrone.hidden = true;
    for (const b of padDrone.querySelectorAll('.appui')) b.classList.remove('appui');
    decalage.hidden = !ARTEFACT;
    controls.update();
    // Cachées pendant le vol, les flèches pointaient encore où elles étaient
    // au décollage jusqu'à l'image suivante.
    placerFleches();
}

btnDrone.addEventListener('click', () => {
    if (droneActif) sortirDrone(); else entrerDrone();
    // Sinon l'espace, qui fait monter, presserait encore le bouton.
    btnDrone.blur();
});
btnOrbit.addEventListener('click', () => { if (droneActif) sortirDrone(); });
window.addEventListener('keydown', e => {
    if (!droneActif || e.target.closest?.('input, select, textarea')) return;
    if (e.code === 'Escape') { sortirDrone(); return; }
    if (!TOUCHES_DRONE.has(e.code) || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    touchesDrone.add(e.code);
});
window.addEventListener('keyup', e => touchesDrone.delete(e.code));
// Une touche relâchée hors de la fenêtre n'envoie pas de keyup.
window.addEventListener('blur', () => touchesDrone.clear());

const avantDrone = new THREE.Vector3(), droiteDrone = new THREE.Vector3(), vouluDrone = new THREE.Vector3();
const cibleDrone = new THREE.Vector3(), cameraVoulue = new THREE.Vector3();
let dernierHud = 0;

export function majDrone(dt, maintenant) {
    const k = touchesDrone;
    const avance = (k.has('ArrowUp') || k.has('KeyW')) - (k.has('ArrowDown') || k.has('KeyS'));
    const glisse = k.has('KeyD') - k.has('KeyA');
    const tourne = k.has('ArrowRight') - k.has('ArrowLeft');
    const monte = k.has('Space') - (k.has('ShiftLeft') || k.has('ShiftRight'));
    const vmax = Number(vitesse.value) * DRONE_PAS_VITESSE;

    drone.lacet += (tourne * DRONE_LACET - drone.lacet) * (1 - Math.exp(-dt / 0.15));
    drone.cap += drone.lacet * dt;
    avantDrone.set(Math.sin(drone.cap), 0, -Math.cos(drone.cap));
    droiteDrone.set(Math.cos(drone.cap), 0, Math.sin(drone.cap));
    vouluDrone.copy(avantDrone).multiplyScalar(avance * vmax)
        .addScaledVector(droiteDrone, glisse * vmax * 0.7);
    vouluDrone.y = monte * Math.max(5, vmax * 0.5);
    drone.vitesse.lerp(vouluDrone, 1 - Math.exp(-dt / DRONE_INERTIE_S));
    drone.position.addScaledVector(drone.vitesse, dt);

    drone.sol = solSous(drone.position.x, drone.position.z, true);
    if (drone.sol !== null && drone.position.y < drone.sol + DRONE_GARDE) {
        drone.position.y = drone.sol + DRONE_GARDE;
        drone.vitesse.y = Math.max(drone.vitesse.y, 0);
    }
    drone.position.y = Math.min(drone.position.y, DRONE_PLAFOND);

    // Piqué en accélérant, penché dans les virages et les glissades.
    const vf = drone.vitesse.dot(avantDrone) / Math.max(vmax, 1);
    const vd = drone.vitesse.dot(droiteDrone) / Math.max(vmax, 1);
    const lisse = 1 - Math.exp(-dt / 0.2);
    drone.tangage += (-vf * DRONE_INCLINAISON - drone.tangage) * lisse;
    drone.roulis += (-(vd + 0.5 * drone.lacet / DRONE_LACET) * DRONE_INCLINAISON - drone.roulis) * lisse;
    modeleDrone.position.copy(drone.position);
    modeleDrone.rotation.set(drone.tangage, -drone.cap, drone.roulis, 'YXZ');
    ombreDrone.visible = drone.sol !== null;
    if (ombreDrone.visible) {
        const haut = drone.position.y - drone.sol;
        ombreDrone.position.set(drone.position.x, drone.sol + 0.05, drone.position.z);
        ombreDrone.material.opacity = 0.4 * Math.min(Math.max(1 - haut / 60, 0), 1);
    }

    // La caméra suit, derrière et au-dessus, sans passer sous le sol ni dans
    // un bâtiment : elle monte sur le toit.
    cibleDrone.copy(drone.position).y += 0.8;
    cameraVoulue.copy(drone.position).addScaledVector(avantDrone, -drone.recul);
    cameraVoulue.y += 1 + 0.35 * drone.recul;
    const solCamera = solSous(cameraVoulue.x, cameraVoulue.z, true);
    if (solCamera !== null) cameraVoulue.y = Math.max(cameraVoulue.y, solCamera + 1.5);
    camera.position.lerp(cameraVoulue, 1 - Math.exp(-dt / 0.2));
    camera.lookAt(cibleDrone);
    controls.target.copy(cibleDrone);

    if (maintenant - dernierHud > 150) {
        dernierHud = maintenant;
        const altitude = altitudeRef + drone.position.y / exagVert;
        const auSol = drone.sol === null ? '—' : `${Math.round((drone.position.y - drone.sol) / exagVert)} m`;
        const vitesseH = Math.hypot(drone.vitesse.x, drone.vitesse.z) * 3.6;
        const cap = ((drone.cap * 180 / Math.PI) % 360 + 360) % 360;
        hudDrone.textContent = `altitude ${Math.round(altitude)} m · sol à ${auSol} · `
            + `${Math.round(vitesseH)} km/h · cap ${Math.round(cap)}° ${POINTS_CARDINAUX[Math.round(cap / 45) % 8]}`;
    }
}
