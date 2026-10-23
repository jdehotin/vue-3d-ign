// Les bornes de recharge, lues au clic.

import * as THREE from 'three';
import { URL_BORNES } from '../socle/reseau.js';
import { echapper } from '../socle/chargement.js';
import { toLocal } from '../socle/projection.js';
import { reliefRegle, ySol } from '../terrain/etat.js';
import { scene } from '../socle/rendu.js';
import { meshes, meshesToits } from '../batiments/etat.js';
import { ajouterCiblesSurvol, majCiblesSurvol } from '../interface/survol.js';
import { citerSource, majCredits } from '../interface/credits.js';
import { poserSurLeRelief } from '../terrain/relief.js';
import { dateFr, dateLongue, lireALaDemande } from './foncier.js';

// La base nationale des IRVE (vue3d/bornes.py), lue au clic seulement, comme
// les DPE : une borne par station, posée au sol, et au-dessus d'elle un
// repère teint de sa puissance la plus haute, qui se voit de loin — la borne
// fait 1,6 m, à peine un pixel vue de 900 m : le repère est une pastille de
// taille constante à l'écran, que le doigt trouve. Une station sous un toit (un
// parking souterrain, une adresse prise au milieu d'un îlot : la première des
// sept autour de l'Opéra) a son repère BORNE_DEPASSE au-dessus du toit, sans
// quoi l'immeuble le cache.
const BORNES_CLASSES = [
    { max: 22, couleur: 0x34d399, nom: 'jusqu\'à 22 kW' },
    { max: 149, couleur: 0xf59e0b, nom: '23 à 149 kW' },
    { max: Infinity, couleur: 0xa855f7, nom: '150 kW et plus' },
];
const BORNE_SANS_PUISSANCE = 0x9ca3af;
const BORNE_HAUTEUR = 1.6, BORNE_MAT = 6, BORNE_DEPASSE = 4;
// Hauteur de la pastille, en part de la hauteur de la vue.
const BORNE_PASTILLE = 0.045;
let IRVE = null;                  // { lu_le, nombre_points, stations }
let bornesActif = false;
let bornesPosees = null;            // { maillages, pastilles, liste }
const groupeBornes = new THREE.Group();
groupeBornes.visible = false;
scene.add(groupeBornes);
ajouterCiblesSurvol(() => groupeBornes.visible ? groupeBornes.children : []);
citerSource('bornes', () => bornesActif);
poserSurLeRelief({ construire: construireBornes, placer: () => { if (bornesPosees) placerBornes(); } });
const MAT_BORNE = new THREE.MeshStandardMaterial({ color: 0xe5e7eb, roughness: 0.6 });
const materiauxPastille = new Map();
/** Une pastille ronde, un éclair blanc sur la couleur de la classe. */
function materiauPastille(couleur) {
    if (!materiauxPastille.has(couleur)) {
        const c = document.createElement('canvas');
        c.width = c.height = 64;
        const g = c.getContext('2d');
        g.beginPath();
        g.arc(32, 32, 29, 0, 2 * Math.PI);
        g.fillStyle = '#' + couleur.toString(16).padStart(6, '0');
        g.fill();
        g.lineWidth = 4;
        g.strokeStyle = '#ffffff';
        g.stroke();
        g.beginPath();
        for (const [x, y] of [[36, 10], [20, 36], [31, 36], [27, 54], [44, 27], [33, 27], [36, 10]]) g.lineTo(x, y);
        g.fillStyle = '#ffffff';
        g.fill();
        const texture = new THREE.CanvasTexture(c);
        texture.colorSpace = THREE.SRGBColorSpace;
        materiauxPastille.set(couleur, new THREE.SpriteMaterial({ map: texture, sizeAttenuation: false }));
    }
    return materiauxPastille.get(couleur);
}

const couleurBorne = s => (s.puissance_max == null ? BORNE_SANS_PUISSANCE
    : BORNES_CLASSES.find(c => s.puissance_max <= c.max).couleur);
const kW = v => `${v.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} kW`;

function construireBornes() {
    if (!IRVE || !reliefRegle || bornesPosees || !IRVE.stations.length) return;
    const liste = IRVE.stations;
    const corps = new THREE.BoxGeometry(0.5, BORNE_HAUTEUR, 0.35);
    corps.translate(0, BORNE_HAUTEUR / 2, 0);                       // pied à y = 0
    // Le mât fait 1 m, étiré par station jusqu'à la pastille (placerBornes).
    const poteau = new THREE.CylinderGeometry(0.06, 0.06, 1, 8);
    poteau.translate(0, 0.5, 0);
    const maillages = [new THREE.InstancedMesh(corps, MAT_BORNE, liste.length),
                       new THREE.InstancedMesh(poteau, MAT_BORNE, liste.length)];
    for (const m of maillages) {
        m.castShadow = true;
        m.userData = { bornes: liste };
        groupeBornes.add(m);
    }
    const pastilles = liste.map(s => {
        const p = new THREE.Sprite(materiauPastille(couleurBorne(s)));
        p.center.set(0.5, 0);                       // posée par le bas, en haut du mât
        p.scale.set(BORNE_PASTILLE, BORNE_PASTILLE, 1);
        p.userData = { borne: s };
        groupeBornes.add(p);
        return p;
    });
    bornesPosees = { maillages, pastilles, liste };
    placerBornes();
    majCiblesSurvol();
}

/** Au sol de chaque station, selon le relief et son exagération ; la pastille au-dessus du toit qui la couvre. */
function placerBornes() {
    const { maillages: [corps, poteau], pastilles, liste } = bornesPosees;
    const matrice = new THREE.Matrix4(), rotation = new THREE.Quaternion();
    const position = new THREE.Vector3(), echelle = new THREE.Vector3(), bas = new THREE.Vector3(0, -1, 0);
    const rayon = new THREE.Raycaster();
    const batis = [...new Set([...meshes, ...meshesToits])];
    scene.updateMatrixWorld(true);
    liste.forEach((s, i) => {
        const [x, y] = toLocal(s.lon, s.lat);
        const sol = ySol(s.lon, s.lat) - 0.1;
        rayon.set(position.set(x, 1e4, -y), bas);
        const toit = rayon.intersectObjects(batis, false)[0];
        const haut = Math.max(sol + BORNE_MAT, toit ? toit.point.y + BORNE_DEPASSE : -Infinity);
        corps.setMatrixAt(i, matrice.makeTranslation(x, sol, -y));
        poteau.setMatrixAt(i, matrice.compose(position.set(x, sol + BORNE_HAUTEUR, -y), rotation,
                                              echelle.set(1, haut - sol - BORNE_HAUTEUR, 1)));
        pastilles[i].position.set(x, haut, -y);
    });
    for (const m of [corps, poteau]) {
        m.instanceMatrix.needsUpdate = true;
        m.computeBoundingSphere();
    }
}

/** L'infobulle d'une station : qui l'exploite, combien de points, quelles prises, quel accès. */
export function infobulleBorne(s) {
    const puissance = s.puissance_max == null ? 'puissance non déclarée'
        : s.puissance_min != null && s.puissance_min !== s.puissance_max
            ? `${kW(s.puissance_min)} à ${kW(s.puissance_max)}` : kW(s.puissance_max);
    const qui = [s.operateur, s.enseigne && s.enseigne !== s.operateur ? s.enseigne : null].filter(Boolean);
    const acces = [s.acces, s.horaires === '24/7' ? '24 h/24, 7 j/7' : s.horaires,
                   s.gratuit ? 'gratuite' : null].filter(Boolean);
    const pied = [s.implantation, s.maj ? `mise à jour le ${dateFr(s.maj)}` : null].filter(Boolean);
    return `<b>${echapper(s.nom)}</b>`
        + `<br>${qui.length ? qui.map(echapper).join(' · ') : 'opérateur non déclaré'}`
        + `<br>${s.points} point${s.points > 1 ? 's' : ''} de charge · ${puissance}`
        + (s.prises.length ? `<br>prises : ${s.prises.map(echapper).join(', ')}` : '')
        + (acces.length ? `<br>${acces.map(echapper).join(' · ')}` : '')
        + (pied.length ? `<br><i>${pied.map(echapper).join(' · ')}</i>` : '');
}

function resumerBornes() {
    const stations = IRVE.stations;
    const classes = BORNES_CLASSES.map(c => ({ ...c, n: 0 }));
    let sansPuissance = 0;
    for (const s of stations) {
        if (s.puissance_max == null) sansPuissance++;
        else classes.find(c => s.puissance_max <= c.max).n++;
    }
    const pastille = c => `<i class="pastille-borne" style="background:#${c.toString(16).padStart(6, '0')}"></i>`;
    const stat = (libelle, valeur) => `<div class="stat"><span>${libelle}</span><b>${valeur}</b></div>`;
    document.getElementById('bornes-resume').innerHTML = stations.length
        ? stat('stations', stations.length.toLocaleString('fr-FR'))
          + stat('points de charge', IRVE.nombre_points.toLocaleString('fr-FR'))
          + classes.filter(c => c.n).map(c => stat(pastille(c.couleur) + c.nom, c.n)).join('')
          + (sansPuissance ? stat(pastille(BORNE_SANS_PUISSANCE) + 'puissance non déclarée', sansPuissance) : '')
        : '<div class="note">Aucune borne de recharge dans l\'emprise.</div>';
    document.getElementById('bornes-note').innerHTML =
        `Base nationale des bornes de recharge (IRVE), consolidée chaque jour par data.gouv.fr, lue le ${dateLongue(IRVE.lu_le)} ; `
        + '« Reconstruire la scène » la relit. Une borne par station de l\'emprise, son repère teint de sa puissance la plus haute ; '
        + 'survol ou toucher : opérateur, prises, accès. '
        + '<a href="https://www.data.gouv.fr/fr/datasets/5448d3e0c751df01f85d0572/" target="_blank" rel="noopener">data.gouv.fr</a>, Licence Ouverte 2.0.';
}

document.getElementById('t-bornes').addEventListener('click', async e => {
    const bouton = e.currentTarget;
    if (!IRVE) {
        if (bouton.dataset.lecture) return;
        bouton.dataset.lecture = '1';
        const couche = await lireALaDemande('Bornes de recharge', 'de data.gouv.fr', URL_BORNES);
        delete bouton.dataset.lecture;
        if (!couche) return;
        IRVE = couche;
        construireBornes();
        resumerBornes();
    }
    bornesActif = !bornesActif;
    bouton.classList.toggle('on', bornesActif);
    groupeBornes.visible = bornesActif;
    document.getElementById('sec-bornes').hidden = !bornesActif;
    majCiblesSurvol();
    majCredits();
});
