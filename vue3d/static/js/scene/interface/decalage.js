// Les flèches qui décalent la scène d'un quart de zone.

import * as THREE from 'three';
import { LAT0, LON0, ZONE, CLE_POSE } from '../socle/point.js';
import { chargementArtefact } from '../socle/chargement.js';
import {
    M_PAR_DEGRE_LAT, M_PAR_DEGRE_LON, toLonLat, DEMI_EMPRISE_DEG,
} from '../socle/projection.js';
import { ySol } from '../terrain/etat.js';
import { host, camera, controls } from '../socle/rendu.js';
import { orbite } from './boutons.js';

// Un point pris à quelques dizaines de mètres près laisse au bord, coupé, ce
// qu'on voulait voir. Une flèche par point cardinal décale le point d'un quart
// du côté de la zone — 89 m du nord au sud, 64 m d'est en ouest à Gordes :
// trois quarts de la scène restent en vue, et un écart de quelques dixièmes
// de la zone se rattrape en un ou deux clics. La page se recharge sur la
// nouvelle scène, la caméra à la même place par rapport au point : la vue
// glisse d'autant, sans changer de cap.
const DECALAGE = 0.25;
const VERS = {
    n: { x: 0, z: -1, nom: 'le nord' }, e: { x: 1, z: 0, nom: "l'est" },
    s: { x: 0, z: 1, nom: 'le sud' }, o: { x: -1, z: 0, nom: "l'ouest" },
};
export const decalage = document.getElementById('decalage');
const flechesDecalage = [...decalage.querySelectorAll('button')].map(b => {
    const v = VERS[b.dataset.vers];
    // Le nord est -Z, l'est +X ; l'emprise a le même écart en degrés dans les
    // deux sens (scene.emprise).
    const dLat = -v.z * 2 * DEMI_EMPRISE_DEG * DECALAGE;
    const dLon = v.x * 2 * DEMI_EMPRISE_DEG * DECALAGE;
    const metres = Math.round(Math.abs(dLat) * M_PAR_DEGRE_LAT + Math.abs(dLon) * M_PAR_DEGRE_LON);
    b.title = `Décaler la scène de ${metres} m vers ${v.nom}`;
    b.setAttribute('aria-label', b.title);
    b.addEventListener('click', () => decaler(dLat, dLon));
    return { b, pointe: b.firstElementChild, x: v.x, z: v.z };
});

function decaler(dLat, dLon) {
    // Arrondi comme la clé du cache (scene.SCENE_ARRONDI) : la page est
    // centrée sur le point même de sa scène, et un aller-retour retombe sur
    // la scène de départ.
    const lat = Number((LAT0 + dLat).toFixed(4)), lon = Number((LON0 + dLon).toFixed(4));
    const t = controls.target;
    try {
        sessionStorage.setItem(CLE_POSE, JSON.stringify({ lat, lon, zone: ZONE, orbite,
            cible: [t.x, t.y - ySol(...toLonLat(t.x, -t.z)), t.z],
            ecart: camera.position.clone().sub(t).toArray() }));
    } catch (e) { /* stockage refusé : la nouvelle scène sera cadrée d'office */ }
    const u = new URL(location.href);
    u.searchParams.set('lat', lat);
    u.searchParams.set('lon', lon);
    location.assign(u.pathname + u.search + u.hash);
}

// Les flèches courent sur une ellipse inscrite dans la vue : loin des coins,
// où sont l'aide, la boussole et les crédits ; sous l'aide en haut, qui tient
// sur trois lignes sur un téléphone, au-dessus des crédits en bas.
export const aideVue = document.getElementById('hint');
const creditsVue = document.getElementById('credits');
let ellipseDecalage = null;
function mesurerDecalage() {
    const w = host.clientWidth, h = host.clientHeight;
    const haut = Math.max(64, aideVue.getBoundingClientRect().bottom - host.getBoundingClientRect().top + 27);
    const bas = creditsVue.offsetHeight + 42, cote = 40;
    ellipseDecalage = { cx: w / 2, cy: (haut + h - bas) / 2,
                        a: Math.max(w / 2 - cote, 20), b: Math.max((h - haut - bas) / 2, 20) };
}
window.addEventListener('resize', mesurerDecalage);
if (window.ResizeObserver) {
    const ro = new ResizeObserver(mesurerDecalage);
    ro.observe(host);
    ro.observe(creditsVue);
}
mesurerDecalage();
chargementArtefact.then(a => { if (a) decalage.hidden = false; });

const versCible = new THREE.Vector3(), droiteEcran = new THREE.Vector3(), hautEcran = new THREE.Vector3();
/** Pose chaque flèche dans la direction où son point cardinal part à l'écran. */
export function placerFleches() {
    if (decalage.hidden || !ellipseDecalage) return;
    // Droite et haut de l'écran, dans la scène. Au centre de la vue, où est
    // la cible, la perspective ne fait que les mettre à l'échelle : la
    // direction d'un vecteur du sol y est exacte.
    versCible.subVectors(controls.target, camera.position).normalize();
    droiteEcran.set(-versCible.z, 0, versCible.x).normalize();
    hautEcran.crossVectors(droiteEcran, versCible);
    const { cx, cy, a, b } = ellipseDecalage;
    for (const f of flechesDecalage) {
        const angle = Math.atan2(f.x * droiteEcran.x + f.z * droiteEcran.z,
                                 f.x * hautEcran.x + f.z * hautEcran.z);
        const ux = Math.sin(angle), uy = -Math.cos(angle);
        const r = 1 / Math.hypot(ux / a, uy / b);
        f.b.style.transform = `translate(${(cx + r * ux).toFixed(1)}px,${(cy + r * uy).toFixed(1)}px)`;
        f.pointe.style.transform = `rotate(${(angle * 180 / Math.PI).toFixed(1)}deg)`;
    }
}
