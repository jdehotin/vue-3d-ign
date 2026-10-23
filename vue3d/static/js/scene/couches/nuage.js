// Le bâti du nuage de points LiDAR HD : une couche à part.

import * as THREE from 'three';
import { HAUTEUR_PAR_ETAGE } from '../../commun/regles.js';
import { ACCUEIL } from '../socle/point.js';
import { URL_NUAGE } from '../socle/reseau.js';
import { toLocal } from '../socle/projection.js';
import { terrain, relief, reliefRegle, ySol } from '../terrain/etat.js';
import { scene } from '../socle/rendu.js';
import { groupeBatiments, meshes, redessinerBatiments } from '../batiments/etat.js';
import { anneauVersShape, polygonesDe } from '../batiments/toits.js';
import { reconstruireVegetation } from '../vegetation/etat.js';
import {
    ESSAIS_MONUMENTS, ATTENTE_MONUMENTS_S, RETARD_ETAT_MONUMENTS_MS, etatCouche,
} from '../interface/etat-couche.js';
import { poserSurLeRelief } from '../terrain/relief.js';
import { verifierToits, majLegendeEcarts } from './ecarts-toits.js';

// Le bâti du nuage de points LiDAR HD (/api/nuage, vue3d/nuage.py), lu après la
// scène : ses dalles se lisent en 10 à 90 s. En deux temps sur une grande zone :
// d'abord un carré autour du point (proche=1), affiché dès qu'il est lu, puis la
// zone entière, qui le remplace. Un ouvrage ajouré — le LiDAR voit
// le sol à travers son emprise, et une structure dedans : la tour Eiffel, une
// verrière, une cour que la BD TOPO couvre — est dessiné en points à la place
// de son volume, plein dans la BD TOPO comme dans OSM. Le reste du bâti, allégé
// par le serveur, au bouton « Nuage LiDAR ». Chaque point est posé à sa hauteur
// au-dessus du relief : comme un bâtiment, il suit l'exagération par son pied.
// Diamètre d'un point, en mètres. Le nuage compte 16 points/m² au sol, un tous
// les 25 cm, mais bien moins sur un treillis vu de biais : à 0,7 m, essayé à la
// tour Eiffel, le treillis se lit de près et la silhouette reste pleine de loin.
const TAILLE_POINT_NUAGE = 0.7;
// Pierre claire, plus claire en hauteur : un relief se lit sans éclairage, que
// des points n'ont pas. Le sursol pérenne (antennes) en ocre, les tabliers en gris.
const COULEURS_NUAGE = { 64: 0xd9a066, 17: 0x9a9488 };
export let NUAGE = null;
export let ajouresNuage = new Set();
// { lon, lat, h, classe, pos, attributs } pour reposer ; col, base (couleurs
// d'origine) et couleurs pour les écarts aux toits (verifierToits).
export let pointsNuage = null;
const groupeNuage = new THREE.Group();
scene.add(groupeNuage);
poserSurLeRelief({ construire: construireNuage, placer: () => { if (pointsNuage) placerNuage(); } });
const MAT_NUAGE = new THREE.PointsMaterial({ size: TAILLE_POINT_NUAGE, vertexColors: true });

/** Tableau typé `Type` d'un base64 d'octets petit-boutistes. */
function depuisBase64(texte, Type) {
    const chaine = atob(texte), octets = new Uint8Array(chaine.length);
    for (let i = 0; i < chaine.length; i++) octets[i] = chaine.charCodeAt(i);
    return new Type(octets.buffer);
}

function construireNuage() {
    if (!NUAGE || !reliefRegle || pointsNuage) return;
    const n = NUAGE.n, na = NUAGE.n_ajoures, [lon0, lat0] = NUAGE.origine;
    const dlon = depuisBase64(NUAGE.lon, Int32Array), dlat = depuisBase64(NUAGE.lat, Int32Array);
    const hcm = depuisBase64(NUAGE.h, Uint16Array), classe = depuisBase64(NUAGE.classe, Uint8Array);
    const lon = new Float64Array(n), lat = new Float64Array(n), h = new Float32Array(n);
    const pos = new Float32Array(3 * n), col = new Float32Array(3 * n), c = new THREE.Color();
    for (let i = 0; i < n; i++) {
        lon[i] = lon0 + dlon[i] * 1e-7;
        lat[i] = lat0 + dlat[i] * 1e-7;
        h[i] = hcm[i] / 100;
        if (COULEURS_NUAGE[classe[i]]) c.set(COULEURS_NUAGE[classe[i]]);
        else c.setHSL(0.08, 0.18, 0.42 + 0.25 * Math.min(h[i] / 60, 1));
        col[3 * i] = c.r; col[3 * i + 1] = c.g; col[3 * i + 2] = c.b;
    }
    // Deux nuages sur les mêmes tableaux : les ouvrages ajourés, toujours, et
    // le reste du bâti, au bouton.
    const attributs = [], couleurs = [];
    const nuage = (debut, fin, visible) => {
        const geo = new THREE.BufferGeometry();
        const p = new THREE.BufferAttribute(pos.subarray(3 * debut, 3 * fin), 3);
        const k = new THREE.BufferAttribute(col.subarray(3 * debut, 3 * fin), 3);
        geo.setAttribute('position', p);
        geo.setAttribute('color', k);
        attributs.push(p);
        couleurs.push(k);
        const points = new THREE.Points(geo, MAT_NUAGE);
        points.visible = visible;
        groupeNuage.add(points);
        return points;
    };
    nuage(0, na, true);
    const bati = nuage(na, n, document.getElementById('t-nuage').classList.contains('on'));
    pointsNuage = { lon, lat, h, classe, pos, attributs, bati, col, base: col.slice(), couleurs };
    placerNuage();
    for (const id of ['t-nuage', 'v-nuage']) document.getElementById(id).hidden = n === na;
    if (NUAGE.masses_expliquees.length || NUAGE.houppiers_expliques.length) reconstruireVegetation();
    verifierToits();
}

/** Les points d'une lecture, retirés avant ceux de la suivante. */
function retirerNuage() {
    for (const p of groupeNuage.children) p.geometry.dispose();
    groupeNuage.clear();
    pointsNuage = null;
}

/** Une lecture du nuage arrivée : ses ouvrages ajourés, puis ses points. */
function afficherNuage(nuage) {
    const avant = ajouresNuage;
    NUAGE = nuage;
    ajouresNuage = new Set(nuage.ajoures);
    retirerNuage();
    // Les ouvrages ajourés quittent les volumes, BD TOPO comme OSM. La zone
    // entière garde ceux du carré (vue3d/nuage.py) : les volumes ne se
    // refont que si elle en ajoute.
    if (ajouresNuage.size !== avant.size || [...ajouresNuage].some(c => !avant.has(c))) {
        redessinerBatiments();
    }
    construireNuage();
}

/**
 * Volume invisible d'un ouvrage ajouré : il ne se dessine pas et ne porte pas
 * d'ombre — ses points le montrent —, mais répond au survol et au clic, qui
 * ouvrent sa fiche. Sans lui, la tour Eiffel ne se désignait plus. Haut de sa
 * hauteur BD TOPO ; relevé sur le relief avec les bâtiments (rebaserBatiments).
 */
const MAT_PRISE = new THREE.MeshBasicMaterial({ visible: false });
export function ajouterPrise(f, p) {
    const h = p.hauteur > 0 ? p.hauteur : HAUTEUR_PAR_ETAGE;
    const nuage = (NUAGE && NUAGE.ajoures_detail && NUAGE.ajoures_detail[p.cleabs]) || {};
    for (const { anneau, trous } of polygonesDe(f.geometry)) {
        if (!anneau || anneau.length < 4) continue;
        const geo = new THREE.ExtrudeGeometry(anneauVersShape(anneau, trous), { depth: h, bevelEnabled: false });
        geo.rotateX(-Math.PI / 2);
        const prise = new THREE.Mesh(geo, MAT_PRISE);
        prise.userData = { p, anneau, hMur: h, denivele: 0, lidar: null, nuage };
        groupeBatiments.add(prise);
        meshes.push(prise);
    }
}

/** Pourquoi un bâtiment est dessiné en points, pour sa fiche (vue3d/nuage.py). */
export function noteNuage(n) {
    const pct = v => v == null ? '—' : `${Math.round(100 * v)} %`;
    const debut = '<div class="note">Dessiné en points du nuage LiDAR HD. ';
    if (n.chevauche) {
        return debut + `Son emprise chevauche celle d'un ouvrage ajouré (<code>${n.chevauche}</code>) : la `
            + 'BD TOPO n\'empile des bâtiments que pour dire les étages d\'une même structure. '
            + `Sous la sienne, le LiDAR voit le sol sous une structure à ${pct(n.sous_structure)}.</div>`;
    }
    return debut + `Le LiDAR voit le sol sous une structure — dans la même maille d'un mètre — sur `
        + `${pct(n.sous_structure)} de son emprise : un volume plein ne laisse jamais voir le sol dessous, `
        + 'une cour le laisse voir à ciel ouvert. Au-delà de 20 %, le bâtiment est ajouré — treillis, '
        + 'verrière, arche.</div>';
}

/** Pied de chaque point sur le relief (exagéré), hauteur réelle au-dessus. */
function placerNuage() {
    const { lon, lat, h, pos, attributs } = pointsNuage;
    const sol = relief && terrain;
    for (let i = 0; i < lon.length; i++) {
        const [x, y] = toLocal(lon[i], lat[i]);
        pos[3 * i] = x;
        pos[3 * i + 1] = (sol ? ySol(lon[i], lat[i]) : 0) + h[i];
        pos[3 * i + 2] = -y;
    }
    for (const a of attributs) a.needsUpdate = true;
    for (const p of groupeNuage.children) p.geometry.computeBoundingSphere();
}

/**
 * Lit le nuage en deux temps : `proche`, le carré autour du point, puis la zone
 * entière. Le serveur répond au carré par la zone entière quand elle est déjà
 * lue, ou que la zone est trop petite pour deux lectures : sa réponse ne porte
 * alors pas `proche`, et il n'y a rien de plus à demander.
 */
export async function chargerNuage(essai = 1, proche = true) {
    const quoi = proche ? 'Nuage LiDAR HD' : 'Nuage LiDAR HD, reste de la zone';
    const retard = setTimeout(
        () => etatCouche('etat-nuage', proche ? 'Nuage LiDAR HD : lecture des dalles…'
                                              : 'Nuage LiDAR HD : lecture du reste de la zone…', true),
        essai === 1 && proche ? RETARD_ETAT_MONUMENTS_MS : 0);
    try {
        const r = await fetch(proche ? `${URL_NUAGE}&proche=1` : URL_NUAGE);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const nuage = await r.json();
        clearTimeout(retard);
        // Entre les deux lectures, l'indicateur ne s'éteint pas :
        // outils/demo-video.mjs attend qu'aucune couche ne soit en cours.
        etatCouche('etat-nuage', nuage && nuage.proche
            ? 'Nuage LiDAR HD : lecture du reste de la zone…' : null, true);
        if (!nuage) return;                   // hors couverture LiDAR HD
        afficherNuage(nuage);
        if (nuage.proche) chargerNuage(1, false);
    } catch (e) {
        clearTimeout(retard);
        if (essai >= ESSAIS_MONUMENTS) {
            etatCouche('etat-nuage', `${quoi} indisponible : recharger la page pour réessayer.`);
            return;
        }
        etatCouche('etat-nuage', `${quoi} indisponible : nouvel essai dans ${ATTENTE_MONUMENTS_S} s.`, true);
        setTimeout(() => chargerNuage(essai + 1, proche), ATTENTE_MONUMENTS_S * 1000);
    }
}

// Le même interrupteur au panneau et sur la vue, au-dessus du drone.
const boutonsNuage = [document.getElementById('t-nuage'), document.getElementById('v-nuage')];
// L'accueil s'ouvre nuage allumé : autour de la tour, tout le bâti en points.
if (ACCUEIL) for (const b of boutonsNuage) b.classList.add('on');
for (const b of boutonsNuage) b.addEventListener('click', () => {
    const on = !b.classList.contains('on');
    for (const c of boutonsNuage) c.classList.toggle('on', on);
    if (pointsNuage) pointsNuage.bati.visible = on;
    majLegendeEcarts();
});
