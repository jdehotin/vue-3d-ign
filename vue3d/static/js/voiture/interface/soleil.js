// Le soleil et le ciel, à l'heure du lieu.

import * as THREE from 'three';
import { PARAMS, RAD } from '../socle/parametres.js';
import { depuisLambert93 } from '../socle/lambert93.js';
import { couleursCiel, ambiance, soleil } from '../socle/rendu.js';
import { voiture } from '../socle/etat.js';
import { tuilesSol, teinteSol, TEINTE_SOL_NUIT } from '../sol/tuiles.js';
import { ambianceVoiture, soleilVoiture } from './maquette.js';

// La position du soleil à l'heure qu'il est (algorithme de la NOAA, comme la
// page) ; la nuit, une lumière bleutée et un ciel sombre.
function positionSoleil(instant, lat, lon) {
    const jj = instant.getTime() / 86400000 + 2440587.5, t = (jj - 2451545) / 36525;
    const L0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
    const M = 357.52911 + t * (35999.05029 - 0.0001537 * t);
    const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
    const centre = Math.sin(M * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t))
                 + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * t) + Math.sin(3 * M * RAD) * 0.000289;
    const omega = 125.04 - 1934.136 * t;
    const lambda = L0 + centre - 0.00569 - 0.00478 * Math.sin(omega * RAD);
    const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
    const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
    const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) / RAD;
    const y = Math.tan(eps / 2 * RAD) ** 2;
    const eqTemps = 4 / RAD * (y * Math.sin(2 * L0 * RAD) - 2 * e * Math.sin(M * RAD)
        + 4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD) - 0.5 * y * y * Math.sin(4 * L0 * RAD)
        - 1.25 * e * e * Math.sin(2 * M * RAD));
    const minutes = instant.getUTCHours() * 60 + instant.getUTCMinutes() + instant.getUTCSeconds() / 60;
    const horaire = ((minutes + eqTemps + 4 * lon + 1440) % 1440) / 4 - 180;
    const cosZ = Math.sin(lat * RAD) * Math.sin(decl * RAD) + Math.cos(lat * RAD) * Math.cos(decl * RAD) * Math.cos(horaire * RAD);
    const zenith = Math.acos(Math.min(1, Math.max(-1, cosZ))) / RAD;
    const den = Math.cos(lat * RAD) * Math.sin(zenith * RAD);
    let azimut = 180;
    if (Math.abs(den) > 1e-9) {
        const q = (Math.sin(lat * RAD) * Math.cos(zenith * RAD) - Math.sin(decl * RAD)) / den;
        const a = Math.acos(Math.min(1, Math.max(-1, q))) / RAD;
        azimut = horaire > 0 ? (a + 180) % 360 : (540 - a) % 360;
    }
    return { azimut, hauteur: 90 - zenith };
}
const CIEL = {
    jour: { zenith: new THREE.Color(0x4f86c6), horizon: new THREE.Color(0xbcd0e2), ciel: new THREE.Color(0xdfe8f5) },
    nuit: { zenith: new THREE.Color(0x0b1018), horizon: new THREE.Color(0x1c2430), ciel: new THREE.Color(0x6f80a8) },
};
let dernierSoleil = -Infinity;
export function majCiel(maintenant) {
    if (maintenant - dernierSoleil < 30000) return;
    dernierSoleil = maintenant;
    const x = voiture.vue ? voiture.x : voiture.attendu?.x, y = voiture.vue ? voiture.y : voiture.attendu?.y;
    if (x == null) return;
    const [lon, lat] = depuisLambert93(x, y);
    const forcee = PARAMS.get('heure');
    const instant = forcee ? new Date(`${new Date().toISOString().slice(0, 10)}T${forcee}`) : new Date();
    const { azimut, hauteur } = positionSoleil(Number.isNaN(instant.getTime()) ? new Date() : instant, lat, lon);
    const jour = Math.min(Math.max((hauteur + 6) / 12, 0), 1);
    couleursCiel.zenith.copy(CIEL.nuit.zenith).lerp(CIEL.jour.zenith, jour);
    couleursCiel.horizon.copy(CIEL.nuit.horizon).lerp(CIEL.jour.horizon, jour);
    ambiance.color.copy(CIEL.nuit.ciel).lerp(CIEL.jour.ciel, jour);
    ambiance.intensity = 1.5;
    // La nuit, une lune fixe, haute au sud : sans elle, toutes les façades
    // prenaient la même teinte, et les rues se perdaient.
    soleil.color.setHex(jour > 0.5 ? 0xfff2dd : 0x9fb3e0);
    soleil.intensity = hauteur > 0 ? 2.0 * Math.min(Math.max(hauteur / 10, 0.3), 1) : 0.9;
    // Rasant, le soleil laisserait les façades à contre-jour noires : 12° au moins.
    const h = (hauteur > 0 ? Math.max(hauteur, 12) : 40) * RAD, a = (hauteur > 0 ? azimut : 200) * RAD;
    soleil.position.set(Math.sin(a) * Math.cos(h), Math.sin(h), -Math.cos(a) * Math.cos(h)).multiplyScalar(1000);
    ambianceVoiture.color.copy(ambiance.color); ambianceVoiture.intensity = ambiance.intensity;
    soleilVoiture.color.copy(soleil.color); soleilVoiture.intensity = soleil.intensity;
    soleilVoiture.position.copy(soleil.position);
    // Le fond de nuit : la photo assombrie, comme vue sous la lune.
    teinteSol.setHex(0xffffff).lerp(TEINTE_SOL_NUIT, 1 - jour);
    for (const t of tuilesSol.values()) if (t.mesh && t.mesh.material.map) t.mesh.material.color.copy(teinteSol);
    document.querySelector('meta[name=theme-color]').content = jour > 0.5 ? '#1f2328' : '#0b1018';
}
