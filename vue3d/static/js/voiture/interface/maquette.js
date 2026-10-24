// La maquette de la voiture, dessinée par-dessus la scène.

import * as THREE from 'three';
import { RAD } from '../socle/parametres.js';
import { ORIGINE } from '../socle/monde.js';
import { renderer, scene, camera } from '../socle/rendu.js';
import { voiture, camVue } from '../socle/etat.js';
import { uniformsBati } from '../carres/batiments.js';

// Une berline stylisée, à l'échelle (4,7 × 1,85 m) tant que la caméra est
// proche, puis grossie avec son recul comme l'icône d'un GPS : à 600 m, une
// voiture réelle ne ferait que quelques pixels. Grossie dès le recul par
// défaut (recul ÷ 24, ×1,9 à 45 m), elle faisait 3,5 m de large et couvrait
// 70 % de la route Cézanne sous elle, « très grosse par rapport à la route ».
const maquette = new THREE.Group();
const MAT_CAISSE = new THREE.MeshLambertMaterial({ color: 0xf2f4f6 });
const MAT_VITRES = new THREE.MeshLambertMaterial({ color: 0x1b2430 });
const MAT_PNEUS = new THREE.MeshLambertMaterial({ color: 0x15171a });
const MAT_PHARES = new THREE.MeshBasicMaterial({ color: 0xfffbe8 });
const MAT_FEUX = new THREE.MeshBasicMaterial({ color: 0xe0242a });
(function construireMaquette() {
    const extruder = (forme, largeur, mat) => {
        const geo = new THREE.ExtrudeGeometry(forme, { depth: largeur, bevelEnabled: true, bevelThickness: 0.06,
                                                       bevelSize: 0.06, bevelSegments: 2, curveSegments: 8 });
        geo.translate(0, 0, -largeur / 2);
        return new THREE.Mesh(geo, mat);
    };
    const caisse = new THREE.Shape();
    caisse.moveTo(-2.3, 0.3); caisse.lineTo(2.2, 0.3);
    caisse.quadraticCurveTo(2.36, 0.32, 2.36, 0.56);
    caisse.quadraticCurveTo(2.32, 0.8, 1.95, 0.86);
    caisse.lineTo(0.95, 0.95); caisse.lineTo(-1.9, 0.98); caisse.lineTo(-2.1, 0.95);
    caisse.quadraticCurveTo(-2.3, 0.92, -2.32, 0.7); caisse.lineTo(-2.3, 0.3);
    maquette.add(extruder(caisse, 1.74, MAT_CAISSE));
    // Une lunette arrière longue et couchée, en fastback : droite, elle
    // donnait à la voiture vue de derrière l'air d'une camionnette.
    const verriere = new THREE.Shape();
    verriere.moveTo(0.95, 0.94);
    verriere.quadraticCurveTo(0.35, 1.36, -0.15, 1.4);
    verriere.quadraticCurveTo(-1.1, 1.4, -1.9, 0.97);
    verriere.lineTo(0.95, 0.94);
    maquette.add(extruder(verriere, 1.42, MAT_VITRES));
    // Le pavillon, couleur de caisse, posé sur la verrière entre le pare-brise
    // et la lunette (les courbes de celle-ci passent par 1,356 m en x = 0,1
    // et par 1,331 m en x = −0,89) : vue d'en haut, une berline et non une
    // vitre d'un seul tenant.
    const pavillon = new THREE.Shape();
    pavillon.moveTo(0.1, 1.33); pavillon.lineTo(0.1, 1.372);
    pavillon.quadraticCurveTo(-0.2, 1.43, -0.89, 1.35); pavillon.lineTo(-0.89, 1.31);
    pavillon.lineTo(0.1, 1.33);
    maquette.add(extruder(pavillon, 1.28, MAT_CAISSE));
    const roue = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 18);
    roue.rotateX(Math.PI / 2);
    for (const [x, z] of [[1.42, 0.82], [1.42, -0.82], [-1.42, 0.82], [-1.42, -0.82]]) {
        const r = new THREE.Mesh(roue, MAT_PNEUS);
        r.position.set(x, 0.34, z);
        maquette.add(r);
    }
    const feu = new THREE.BoxGeometry(0.08, 0.1, 0.42);
    for (const z of [0.58, -0.58]) {
        const p = new THREE.Mesh(feu, MAT_PHARES); p.position.set(2.36, 0.66, z); maquette.add(p);
        const f = new THREE.Mesh(feu, MAT_FEUX); f.position.set(-2.36, 0.8, z); maquette.add(f);
    }
    // L'ombre : une tache douce sous la caisse, sans carte d'ombre.
    const toile = document.createElement('canvas');
    toile.width = toile.height = 64;
    const g = toile.getContext('2d'), grad = g.createRadialGradient(32, 32, 4, 32, 32, 32);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
    const ombre = new THREE.Mesh(new THREE.PlaneGeometry(5.6, 2.8),
        new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(toile), transparent: true, depthWrite: false }));
    ombre.rotation.x = -Math.PI / 2;
    ombre.position.y = 0.06;
    maquette.add(ombre);
})();
maquette.visible = false;
// Dessinée après le reste, profondeur effacée : toujours visible, comme le
// repère d'un GPS, avec ses propres lumières (une lumière n'est que dans
// une scène).
const sceneVoiture = new THREE.Scene();
export const ambianceVoiture = new THREE.HemisphereLight(0xdfe8f5, 0x5a5348, 1.5);
export const soleilVoiture = new THREE.DirectionalLight(0xfff2dd, 2.0);
// Et, de même, ce que le relief cache : le tunnel où la route prévue passe
// (interface/ruban).
export const parDessus = new THREE.Group();
sceneVoiture.add(maquette, parDessus, ambianceVoiture, soleilVoiture, soleilVoiture.target);
// Le halo de la précision du relevé, à plat, à l'échelle réelle.
const halo = new THREE.Mesh(new THREE.CircleGeometry(1, 48),
    new THREE.MeshBasicMaterial({ color: 0x3d8bff, transparent: true, opacity: 0.16, depthWrite: false }));
halo.rotation.x = -Math.PI / 2;
halo.visible = false;
scene.add(halo);

export function echelleMaquette() {
    return camVue.mode === '2d' ? Math.min(Math.max(camVue.hauteur / 40, 2), 12)
                                : Math.min(Math.max(camVue.recul / 60, 1), 7);
}
export function poserVoiture() {
    const v = voiture;
    maquette.visible = true;
    maquette.position.set(v.x - ORIGINE.x, v.alt + 0.05, ORIGINE.y - v.y);
    maquette.rotation.y = Math.PI / 2 - v.cap * RAD;
    maquette.scale.setScalar(echelleMaquette());
    uniformsBati.uVoiture.value.set(maquette.position.x, maquette.position.y + 1.5 * maquette.scale.x, maquette.position.z);
    uniformsBati.uRayon.value = camVue.mode === '3d' ? 9 + 3 * maquette.scale.x : 0;
    halo.visible = v.horsRoute || v.precision > 12;
    halo.position.set(v.fix.x - ORIGINE.x, v.alt + 0.2, ORIGINE.y - v.fix.y);
    halo.scale.setScalar(Math.max(v.precision, 3));
}

// La scène, puis la maquette par-dessus, sans le relief pour la cacher. La
// coupe de la caméra sous terre (interface/camera) ne vaut que pour la scène :
// la voûte et le ruban montent au-dessus d'elle quand le tunnel monte.
export function rendre() {
    renderer.info.reset();
    renderer.clear();
    renderer.render(scene, camera);
    if (maquette.visible) {
        renderer.clearDepth();
        const coupes = renderer.clippingPlanes;
        renderer.clippingPlanes = [];
        renderer.render(sceneVoiture, camera);
        renderer.clippingPlanes = coupes;
    }
}
