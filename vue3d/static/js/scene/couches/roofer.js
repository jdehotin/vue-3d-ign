// Les bâtiments reconstruits par roofer (3DBAG), pour comparer : une couche à
// part, optionnelle.

import * as THREE from 'three';
import { URL_ROOFER } from '../socle/reseau.js';
import { toLocal } from '../socle/projection.js';
import { baseBatiment, reliefRegle } from '../terrain/etat.js';
import { scene, renderer } from '../socle/rendu.js';
import { CIBLE, MAT_CIBLE, MAT_TOIT_VOISIN, MAT_VOISIN, groupeBatiments } from '../batiments/etat.js';
import { ajouterCiblesSurvol, majCiblesSurvol } from '../interface/survol.js';
import { citerSource, majCredits } from '../interface/credits.js';
import { poserSurLeRelief } from '../terrain/relief.js';
import { apresLaPhotoDesToits, fondBornes, fondTexture } from '../terrain/fond.js';
import { ATTENTE_MONUMENTS_S, ESSAIS_MONUMENTS, RETARD_ETAT_MONUMENTS_MS, etatCouche } from '../interface/etat-couche.js';

// Une couche à part et optionnelle (/api/roofer, vue3d/roofer.py) : les
// bâtiments de la scène, sur les mêmes emprises, reconstruits par roofer à
// partir du nuage LiDAR HD classé. Le bouton les montre À LA PLACE de ceux de
// la vue : mêmes couleurs, même pose sur le relief (le point bas de
// l'emprise, comme les toits en pans), la photo aérienne sur les toits seuls
// (terrain/fond, appliquerTextureToits) : seule la géométrie change.
//
// Les hauteurs arrivent comptées depuis le sol que roofer a retenu ; elles
// sont réelles, seule la base suit l'exagération, comme pour les bâtiments
// de la vue (rebaserBatiments).
let ROOFER = null;             // { centre, batiments, sans_lod22 } ou { trop_grande }
const groupeRoofer = new THREE.Group();
groupeRoofer.visible = false;
scene.add(groupeRoofer);
ajouterCiblesSurvol(() => groupeRoofer.visible ? groupeRoofer.children : []);
citerSource('roofer', () => groupeRoofer.visible && groupeRoofer.children.length > 0);
poserSurLeRelief({ construire: construireRoofer, placer: placerRoofer });
apresLaPhotoDesToits(texturerToits);
const toitsRoofer = [];

const TYPES_TOIT = {
    'slanted': 'toit en pente', 'horizontal': 'toit plat',
    'multiple horizontal': 'toits plats étagés',
};
const bouton = document.getElementById('t-roofer');

function construireRoofer() {
    if (!ROOFER || !reliefRegle || groupeRoofer.children.length || !ROOFER.batiments) return;
    // Mètres locaux du serveur, autour du centre de son emprise, vers les
    // mètres locaux de la page, autour du point de l'URL.
    const [c0, c1] = ROOFER.centre;
    const mLon = 111320 * Math.cos(c1 * Math.PI / 180);
    const cible = CIBLE && CIBLE.p ? CIBLE.p.cleabs : null;
    for (const b of ROOFER.batiments) {
        const n = b.v.length / 3;
        const pos = new Float32Array(3 * n);
        for (let i = 0; i < n; i++) {
            const [x, y] = toLocal(c0 + b.v[3 * i] / mLon, c1 + b.v[3 * i + 1] / 111320);
            pos[3 * i] = x; pos[3 * i + 1] = b.v[3 * i + 2]; pos[3 * i + 2] = -y;
        }
        // Le toit et les murs à part, comme dans la vue : seul le toit reçoit
        // la photo aérienne.
        const sommets = new THREE.BufferAttribute(pos, 3);
        const infobulle = '<b>Bâtiment reconstruit par roofer</b> · LoD2.2'
            + `<br>${TYPES_TOIT[b.type] || 'toit'}`
            + (b.plans ? ` · ${b.plans} plan(s) de toit` : '')
            + (b.valide ? '' : '<br><i>volume jugé non valide par val3dity</i>')
            + '<br><i>roofer (3DBAG) sur le nuage LiDAR HD et l\'emprise BD TOPO</i>';
        for (const [index, materiau] of [[b.toit, MAT_TOIT_VOISIN],
                                         [b.murs, b.cleabs === cible ? MAT_CIBLE : MAT_VOISIN]]) {
            if (!index.length) continue;
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', sommets);
            geo.setIndex(index);
            geo.computeVertexNormals();
            const mesh = new THREE.Mesh(geo, materiau);
            mesh.castShadow = true; mesh.receiveShadow = true;
            mesh.userData = { anneauRoofer: b.anneau, infobulle };
            groupeRoofer.add(mesh);
            if (index === b.toit) toitsRoofer.push(mesh);
        }
    }
    placerRoofer();
    texturerToits();
    bouton.hidden = false;
    bouton.title = `${ROOFER.batiments.length} bâtiment(s) reconstruits par roofer (3DBAG) à partir du nuage`
        + ' LiDAR HD, à la place de ceux de la vue'
        + (ROOFER.sans_lod22 ? ` ; ${ROOFER.sans_lod22} sans reconstruction, absents` : '');
    // ?roofer=1 : la page s'ouvre sur eux, pour une capture ou un lien.
    if (new URLSearchParams(location.search).get('roofer') === '1') basculer(true);
}

/** La photo aérienne sur les toits, projetée du zénith comme ceux de la vue. */
let MAT_TOIT_PHOTO = null;
function texturerToits() {
    if (!toitsRoofer.length) return;
    if (fondTexture && fondBornes && (!MAT_TOIT_PHOTO || MAT_TOIT_PHOTO.map !== fondTexture)) {
        MAT_TOIT_PHOTO = new THREE.MeshStandardMaterial({ map: fondTexture, roughness: 0.9, metalness: 0 });
    }
    for (const toit of toitsRoofer) {
        if (!fondTexture || !fondBornes) { toit.material = MAT_TOIT_VOISIN; continue; }
        const pos = toit.geometry.attributes.position;
        const uv = new Float32Array(pos.count * 2);
        for (let i = 0; i < pos.count; i++) {
            uv[2 * i] = (pos.getX(i) - fondBornes.minX) / (fondBornes.maxX - fondBornes.minX);
            uv[2 * i + 1] = 1 - (pos.getZ(i) - fondBornes.minZ) / (fondBornes.maxZ - fondBornes.minZ);
        }
        toit.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        toit.material = MAT_TOIT_PHOTO;
    }
}

/** Chaque bâtiment sur le point bas de son emprise : après le relief ou l'exagération. */
function placerRoofer() {
    for (const m of groupeRoofer.children) m.position.y = baseBatiment(m.userData.anneauRoofer);
}

/** Les bâtiments de roofer à la place de ceux de la vue, ou l'inverse. */
function basculer(on) {
    groupeRoofer.visible = on;
    groupeBatiments.visible = !on;
    bouton.classList.toggle('on', on);
    // L'ombre est figée pendant le mouvement (interface/boucle) : un autre
    // dessin des bâtiments la change.
    renderer.shadowMap.needsUpdate = true;
    majCiblesSurvol();
    majCredits();
}

export async function chargerRoofer(essai = 1) {
    const retard = setTimeout(
        () => etatCouche('etat-roofer', 'Toits roofer : lecture du nuage et reconstruction…', true),
        essai === 1 ? RETARD_ETAT_MONUMENTS_MS : 0);
    try {
        const r = await fetch(URL_ROOFER);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const couche = await r.json();
        clearTimeout(retard);
        etatCouche('etat-roofer', null);
        if (!couche || couche.actif === false) return;     // service sans roofer, ou hors LiDAR HD
        if (couche.trop_grande) {
            bouton.hidden = false;
            bouton.disabled = true;
            bouton.title = `Toits roofer : zones de ${couche.zone_max_m} m au plus`;
            return;
        }
        ROOFER = couche;
        construireRoofer();
    } catch (e) {
        clearTimeout(retard);
        if (essai >= ESSAIS_MONUMENTS) {
            etatCouche('etat-roofer', 'Toits roofer indisponibles : recharger la page pour réessayer.');
            return;
        }
        etatCouche('etat-roofer', `Toits roofer indisponibles : nouvel essai dans ${ATTENTE_MONUMENTS_S} s.`, true);
        setTimeout(() => chargerRoofer(essai + 1), ATTENTE_MONUMENTS_S * 1000);
    }
}

bouton.addEventListener('click', () => basculer(!groupeRoofer.visible));
