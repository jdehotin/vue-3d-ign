// Les panneaux solaires du registre OpenPVMapper : une couche à part,
// optionnelle.

import * as THREE from 'three';
import { URL_PANNEAUX } from '../socle/reseau.js';
import { toLonLat } from '../socle/projection.js';
import { reliefRegle, ySol } from '../terrain/etat.js';
import { scene } from '../socle/rendu.js';
import { groupeBatiments } from '../batiments/etat.js';
import { ajouterCiblesSurvol, majCiblesSurvol } from '../interface/survol.js';
import { citerSource, majCredits } from '../interface/credits.js';
import { poserSurLeRelief } from '../terrain/relief.js';
import { subdiviser, trianglesPolygone } from './eau.js';
import { enMetres } from './constructions.js';
import { chargerCouche } from './detections.js';

// Une couche à part et optionnelle (/api/panneaux, vue3d/panneaux.py) : le
// registre national de Gabriel Kasmi, DeepPVMapper passé sur la BD ORTHO, lu
// tel quel — aucun réseau ne tourne ici. Chaque installation est un polygone
// avec sa surface, sa puissance estimée et l'année de la photo.
//
// Le registre ne dit pas la hauteur : le polygone est posé sur le toit tel
// que la vue le dessine, par un rayon vertical lancé sur les bâtiments à
// chacun de ses sommets — le panneau épouse les pans, mesurés ou résumés.
// Là où aucun toit n'est touché (bâtiment absent, registre décalé), il est
// posé sur le sol.
const PANNEAU_MAILLE = 1.5;            // sommets tous les 1,5 m : un pan de toit est plan à cette échelle
const PANNEAU_DECALAGE = 0.08;         // au-dessus du toit, sous les cheminées
const MAT_PANNEAU = new THREE.MeshStandardMaterial({
    color: 0x1c2b46, roughness: 0.25, metalness: 0.5, polygonOffset: true,
    polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
let PANNEAUX = null;           // { panneaux }
const groupePanneaux = new THREE.Group();
scene.add(groupePanneaux);
ajouterCiblesSurvol(() => groupePanneaux.visible ? groupePanneaux.children : []);
citerSource('panneaux', () => panneauxPoses.length > 0 && groupePanneaux.visible);
poserSurLeRelief({ construire: construirePanneaux, placer: placerPanneaux, apresBatiments: true });
export const panneauxPoses = [];        // { mesh, sommets: [[x, y]] } — y : nord, en mètres locaux
const rayonPanneau = new THREE.Raycaster();

/** Hauteur du toit (ou du sol) sous un point local, en unités de scène. */
function hauteurSousPanneau(x, y) {
    rayonPanneau.set(new THREE.Vector3(x, 1000, -y), new THREE.Vector3(0, -1, 0));
    const touche = rayonPanneau.intersectObjects(groupeBatiments.children, false)[0];
    return (touche ? touche.point.y : ySol(...toLonLat(x, y))) + PANNEAU_DECALAGE;
}

function construirePanneaux() {
    if (!PANNEAUX || !reliefRegle || panneauxPoses.length) return;
    for (const p of PANNEAUX.panneaux) {
        if (!p.contour || p.contour.length < 3) continue;
        const tris = subdiviser(trianglesPolygone([p.contour.concat([p.contour[0]])]), PANNEAU_MAILLE);
        if (!tris.length) continue;
        const sommets = tris.flat();
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(sommets.length * 3, 3));
        const mesh = new THREE.Mesh(geo, MAT_PANNEAU);
        mesh.receiveShadow = true;
        mesh.userData = { infobulle: '<b>Panneaux solaires</b>'
            + `<br>${p.surface != null ? enMetres(p.surface).replace(' m', ' m²') : 'surface inconnue'}`
            + (p.kwp != null ? ` · ≈ ${String(p.kwp).replace('.', ',')} kWc` : '')
            + (p.annee ? `<br>vus sur la photo aérienne de ${p.annee}` : '')
            + '<br><i>registre OpenPVMapper (G. Kasmi), posé sur le toit tel que dessiné</i>' };
        groupePanneaux.add(mesh);
        panneauxPoses.push({ mesh, sommets });
    }
    placerPanneaux();
    const bouton = document.getElementById('t-panneaux');
    bouton.hidden = !panneauxPoses.length;
    bouton.title = `${panneauxPoses.length} installation(s) du registre OpenPVMapper`;
    majCiblesSurvol();
    majCredits();
}

/** Repose chaque sommet sur le toit : après le relief, l'exagération, ou un
 * autre dessin des toits. */
export function placerPanneaux() {
    if (!panneauxPoses.length) return;
    groupeBatiments.updateMatrixWorld(true);
    for (const { mesh, sommets } of panneauxPoses) {
        const pos = mesh.geometry.attributes.position;
        sommets.forEach(([x, y], k) => pos.setXYZ(k, x, hauteurSousPanneau(x, y), -y));
        pos.needsUpdate = true;
        mesh.geometry.computeVertexNormals();
        mesh.geometry.computeBoundingSphere();
    }
}

export async function chargerPanneaux() {
    await chargerCouche('Panneaux solaires', URL_PANNEAUX, p => {
        if (!p || !p.actif && !(p.panneaux || []).length) return;   // service sans registre, ou rien ici
        PANNEAUX = p;
        construirePanneaux();
    });
}

document.getElementById('t-panneaux').addEventListener('click', e => {
    groupePanneaux.visible = !groupePanneaux.visible;
    e.currentTarget.classList.toggle('on', groupePanneaux.visible);
    majCiblesSurvol();
    majCredits();
});
