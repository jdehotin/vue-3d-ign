// Véhicules, piscines et bateaux lus sur l'orthophoto : une couche à part,
// optionnelle.

import * as THREE from 'three';
import { URL_PISCINES, urlVehicules, URL_NAVIRES } from '../socle/reseau.js';
import { requete } from '../socle/chargement.js';
import { toLocal, toLonLat } from '../socle/projection.js';
import { reliefRegle, ySol, ENFONCEMENT } from '../terrain/etat.js';
import { scene } from '../socle/rendu.js';
import { ajouterCiblesSurvol, majCiblesSurvol } from '../interface/survol.js';
import {
    ESSAIS_MONUMENTS, ATTENTE_MONUMENTS_S, RETARD_ETAT_MONUMENTS_MS, etatCouche,
} from '../interface/etat-couche.js';
import { poserSurLeRelief } from '../terrain/relief.js';
import { EAU_DECALAGE } from './eau.js';

// Une couche à part et optionnelle (/api/vehicules, vue3d/vehicules.py) : le
// serveur ne la calcule que s'il a été lancé avec un détecteur. Elle porte
// aussi les piscines, dessinées plus bas. Chaque véhicule
// est une boîte orientée lue sur l'orthophoto à 0,2 m — position, longueur,
// largeur, cap du grand axe, couleur. Tout le reste est convention : la
// hauteur (aucune source ne la donne, le LiDAR ne retient pas les véhicules),
// la forme, et le sens de marche, que la boîte ne dit pas.
// Même véhicule vu de deux détecteurs : centres à moins de 1,5 m
// (vehicules.DOUBLON_ENTRE_DETECTEURS_M). Le premier arrivé est gardé.
const VEHICULE_DOUBLON_M = 1.5;
// Gabarit d'après la longueur de la boîte. Sur Gordes et Carcassonne, 95 %
// des boîtes font moins de 5,3 à 5,5 m : en deçà de 5,6 m, une voiture.
// Hauteurs de convention.
export const GABARITS_VEHICULE = {
    voiture: { nom: 'Voiture', longueurMax: 5.6, hauteur: 1.5 },
    fourgon: { nom: 'Fourgon ou camionnette', longueurMax: 8, hauteur: 2.5 },
    car: { nom: 'Autocar ou poids lourd', longueurMax: Infinity, hauteur: 3.2 },
};
// La boîte déborde la carrosserie : largeur médiane de 2,0 à 2,2 m, longueur
// médiane de 4,3 à 4,6 m, pour des voitures de 1,8 m sur 4,3 m environ. Le
// volume est dessiné en retrait d'autant, sans quoi deux voitures garées côte
// à côte se touchent.
const VEHICULE_PART_LARGEUR = 0.86;
const VEHICULE_PART_LONGUEUR = 0.97;
const MAT_CARROSSERIE = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.25, flatShading: true });
const MAT_VITRES = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.2, flatShading: true });
const TEINTE_VITRE = [0.13, 0.17, 0.21], TEINTE_ROUE = [0.05, 0.05, 0.05];
// Réunis à mesure que les détecteurs répondent, du rapide au lent.
const VEHICULES = { mode: null, detecteurs: [], vehicules: [] };
let PISCINES = null;           // { mode, piscines }
const groupeVehicules = new THREE.Group();
scene.add(groupeVehicules);
ajouterCiblesSurvol(() => groupeVehicules.visible ? groupeVehicules.children : []);
poserSurLeRelief({ construire: construireVehicules,
                   placer: () => { if (vehiculesPoses && vehiculesPoses.length) placerVehicules(); } });
let vehiculesPoses = [];       // { maillages, liste } par gabarit

/**
 * Blocs d'un véhicule dans son repère unité : x de −0,5 (arrière) à 0,5
 * (avant), y de 0 (sol) à 1 (toit), z de −0,5 à 0,5 (largeur). Chaque bloc
 * est un tronc fermé — une base rectangulaire, un dessus rectangulaire plus
 * petit —, triangles tournés vers l'extérieur.
 *
 * Returns: [{ teinte: 'caisse' | 'vitre' | 'roue', tris: [[a, b, c], ...] }]
 */
function blocsVehicule(gabarit) {
    // Base à y0 : x de xa à xb, demi-largeur d ; dessus à y1 : x de xc à xd,
    // demi-largeur e.
    const tronc = (teinte, y0, y1, xa, xb, d, xc = xa, xd = xb, e = d) => {
        const b = [[xa, y0, -d], [xb, y0, -d], [xb, y0, d], [xa, y0, d]];
        const h = [[xc, y1, -e], [xd, y1, -e], [xd, y1, e], [xc, y1, e]];
        const tris = [];
        const quad = (p, q, r, t) => tris.push([p, q, r], [p, r, t]);
        quad(b[0], b[1], b[2], b[3]);                 // dessous
        quad(h[0], h[3], h[2], h[1]);                 // dessus
        for (let i = 0; i < 4; i++) {
            const j = (i + 1) % 4;
            quad(b[i], h[i], h[j], b[j]);             // flancs
        }
        return { teinte, tris };
    };
    const roues = (xs, rayon, epaisseur) => xs.flatMap(x => [-1, 1].map(cote => {
        const z = cote * (0.5 - epaisseur / 2) + cote * 0.01;       // à peine en saillie
        const r = tronc('roue', 0, 2 * rayon, x - rayon, x + rayon, epaisseur / 2);
        r.tris = r.tris.map(t => t.map(([px, py, pz]) => [px, py, pz + z]));
        return r;
    }));
    if (gabarit === 'voiture') return [
        tronc('caisse', 0.17, 0.58, -0.5, 0.5, 0.5, -0.49, 0.47, 0.48),
        tronc('vitre', 0.58, 0.96, -0.34, 0.22, 0.46, -0.25, 0.08, 0.4),     // habitacle, capot devant
        tronc('caisse', 0.96, 1, -0.25, 0.08, 0.4),                         // pavillon
        ...roues([-0.3, 0.31], 0.075, 0.12),
    ];
    if (gabarit === 'fourgon') return [
        tronc('caisse', 0.13, 1, -0.5, 0.2, 0.5),                           // caisse de chargement
        tronc('caisse', 0.13, 0.5, 0.2, 0.5, 0.48),                         // cabine, bas
        tronc('vitre', 0.5, 0.78, 0.2, 0.48, 0.47, 0.2, 0.38, 0.45),        // pare-brise et vitres
        tronc('caisse', 0.78, 0.81, 0.2, 0.38, 0.45),
        ...roues([-0.3, 0.33], 0.055, 0.12),
    ];
    return [
        tronc('caisse', 0.1, 0.42, -0.5, 0.5, 0.5),
        tronc('vitre', 0.42, 0.8, -0.5, 0.5, 0.49, -0.49, 0.48, 0.48),      // bandeau vitré
        tronc('caisse', 0.8, 1, -0.49, 0.48, 0.49, -0.47, 0.46, 0.46),
        ...roues([-0.32, 0.33], 0.04, 0.1),
    ];
}

/**
 * Repère d'un véhicule posé sur le sol : l'avant vers (est, nord), et la
 * hauteur du sol à l'avant, à l'arrière, à gauche et à droite de la boîte.
 * Le véhicule suit la pente au lieu de s'y enfoncer d'un bout.
 *
 * Returns: { X, Y, Z } unitaires dans le repère de la scène (x est, y haut,
 * z sud) : X vers l'avant, Y vers le haut, Z vers la droite.
 */
function repereVehicule(est, nord, longueur, largeur, yAvant, yArriere, yGauche, yDroite) {
    const norme = v => { const l = Math.hypot(...v); return v.map(c => c / l); };
    const croix = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const X = norme([est * longueur, yAvant - yArriere, -nord * longueur]);
    // La droite d'un cap (est, nord) est (nord, −est).
    const versDroite = [nord * largeur, yDroite - yGauche, est * largeur];
    const Y = norme(croix(versDroite, X));
    return { X, Y, Z: croix(X, Y) };
}

/** Reconstruit tous les véhicules connus : rappelée à chaque détecteur reçu. */
function construireVehicules() {
    if (!VEHICULES.vehicules.length || !reliefRegle) return;
    for (const { maillages } of vehiculesPoses) {
        for (const m of maillages) { groupeVehicules.remove(m); m.geometry.dispose(); }
    }
    vehiculesPoses = [];
    const parGabarit = { voiture: [], fourgon: [], car: [] };
    for (const [lon, lat, longueur, largeur, cap, couleur] of VEHICULES.vehicules) {
        const gabarit = Object.keys(GABARITS_VEHICULE).find(g => longueur < GABARITS_VEHICULE[g].longueurMax);
        parGabarit[gabarit].push({ lon, lat, longueur, largeur, cap, couleur, gabarit });
    }
    for (const [gabarit, liste] of Object.entries(parGabarit)) {
        if (!liste.length) continue;
        const blocs = blocsVehicule(gabarit);
        const geometrie = (teintes, colorer) => {
            const pos = [], col = [];
            for (const b of blocs) {
                if (!teintes.includes(b.teinte)) continue;
                for (const t of b.tris) for (const p of t) {
                    pos.push(...p);
                    if (colorer) col.push(...(b.teinte === 'roue' ? TEINTE_ROUE : TEINTE_VITRE));
                }
            }
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            if (colorer) geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
            geo.computeVertexNormals();
            return geo;
        };
        // Deux maillages par gabarit, un appel de dessin chacun : la caisse,
        // teinte par véhicule, et ce qui reste sombre quelle que soit la teinte.
        const caisse = new THREE.InstancedMesh(geometrie(['caisse'], false), MAT_CARROSSERIE, liste.length);
        const sombre = new THREE.InstancedMesh(geometrie(['vitre', 'roue'], true), MAT_VITRES, liste.length);
        const teinte = new THREE.Color();
        liste.forEach((v, i) => caisse.setColorAt(i, teinte.setHex(v.couleur)));
        for (const m of [caisse, sombre]) {
            m.castShadow = true; m.receiveShadow = true;
            m.userData = { vehicules: liste };
            groupeVehicules.add(m);
        }
        vehiculesPoses.push({ maillages: [caisse, sombre], liste });
    }
    placerVehicules();
    const bouton = document.getElementById('t-vehicules');
    bouton.hidden = !vehiculesPoses.length;
    bouton.title = `${VEHICULES.vehicules.length} véhicule(s) vus sur l'orthophoto, le jour de la prise de vue `
        + `(détecteur${VEHICULES.detecteurs.length > 1 ? 's' : ''} : ${VEHICULES.detecteurs.join(', ')})`;
    majCiblesSurvol();
}

/** Roues sur le sol exagéré, dimensions réelles : la règle des bâtiments. */
function placerVehicules() {
    const matrice = new THREE.Matrix4();
    const axe = new THREE.Vector3(), haut = new THREE.Vector3(), travers = new THREE.Vector3();
    for (const { maillages, liste } of vehiculesPoses) {
        liste.forEach((v, i) => {
            const longueur = v.longueur * VEHICULE_PART_LONGUEUR, largeur = v.largeur * VEHICULE_PART_LARGEUR;
            const cap = v.cap * Math.PI / 180, est = Math.sin(cap), nord = Math.cos(cap);
            const [x, y] = toLocal(v.lon, v.lat);
            const sol = (dx, dy) => ySol(...toLonLat(x + dx, y + dy));
            const yAv = sol(est * longueur / 2, nord * longueur / 2), yAr = sol(-est * longueur / 2, -nord * longueur / 2);
            const yD = sol(nord * largeur / 2, -est * largeur / 2), yG = sol(-nord * largeur / 2, est * largeur / 2);
            const { X, Y, Z } = repereVehicule(est, nord, longueur, largeur, yAv, yAr, yG, yD);
            matrice.makeBasis(axe.fromArray(X).multiplyScalar(longueur),
                              haut.fromArray(Y).multiplyScalar(GABARITS_VEHICULE[v.gabarit].hauteur),
                              travers.fromArray(Z).multiplyScalar(largeur));
            matrice.setPosition(x, (yAv + yAr + yG + yD) / 4, -y);
            for (const m of maillages) m.setMatrixAt(i, matrice);
        });
        for (const m of maillages) {
            m.instanceMatrix.needsUpdate = true;
            m.computeBoundingSphere();          // le lancer de rayon du survol s'y fie
        }
    }
}

/**
 * Une couche de l'orthophoto : demandée jusqu'à ESSAIS_MONUMENTS fois,
 * l'indicateur disant où on en est, puis remise à `recevoir`. Revalidée
 * auprès du serveur : à la même adresse, la couche dépend du détecteur avec
 * lequel il a été lancé, et de sa version.
 */
export async function chargerCouche(libelle, url, recevoir) {
    for (let essai = 1; ; essai++) {
        // Au premier essai seulement : ensuite l'indicateur est déjà affiché.
        const retard = setTimeout(
            () => etatCouche('etat-vehicules', `${libelle} : détection sur l'orthophoto…`, true),
            essai === 1 ? RETARD_ETAT_MONUMENTS_MS : 0);
        try {
            const r = await requete(url, { cache: 'no-cache' });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const couche = await r.json();
            clearTimeout(retard);
            etatCouche('etat-vehicules', null);
            recevoir(couche);
            return;
        } catch (e) {
            clearTimeout(retard);
            if (essai >= ESSAIS_MONUMENTS) {
                etatCouche('etat-vehicules', `${libelle} indisponibles : recharger la page pour réessayer.`);
                return;
            }
            etatCouche('etat-vehicules', `${libelle} indisponibles : nouvel essai dans ${ATTENTE_MONUMENTS_S} s.`, true);
            await new Promise(r => setTimeout(r, ATTENTE_MONUMENTS_S * 1000));
        }
    }
}

/** Les véhicules d'un détecteur rejoignent ceux déjà connus, sauf doublons. */
function ajouterVehicules(detecteur, couche) {
    const connus = VEHICULES.vehicules.map(v => toLocal(v[0], v[1]));
    for (const v of couche.vehicules || []) {
        const [x, y] = toLocal(v[0], v[1]);
        if (connus.some(([cx, cy]) => Math.hypot(cx - x, cy - y) < VEHICULE_DOUBLON_M)) continue;
        VEHICULES.vehicules.push(v);
        connus.push([x, y]);
    }
    VEHICULES.detecteurs.push(detecteur);
    construireVehicules();
}

/**
 * Les couches de l'orthophoto, l'une après l'autre : les piscines et les
 * bateaux (une demi-seconde de détection chacune), puis les véhicules de
 * chaque détecteur du service, du rapide au lent. Chacune s'affiche dès qu'elle est prête, sans
 * attendre la suivante ; le serveur les calcule dans le même ordre.
 */
export async function chargerDetections() {
    let sante = null;
    try {
        const r = await requete('api/sante', { cache: 'no-store' });
        sante = r.ok ? await r.json() : null;
    } catch (e) { /* le serveur ne répond plus : la scène reste telle quelle */ }
    const service = sante && sante.vehicules;
    if (!service || !service.detecteurs || !service.detecteurs.length) return;   // sans détecteur
    VEHICULES.mode = service.mode;
    await chargerCouche('Piscines', URL_PISCINES, p => { PISCINES = p; construirePiscines(); });
    await chargerCouche('Bateaux', URL_NAVIRES, n => { NAVIRES = n; construireNavires(); });
    for (const detecteur of service.detecteurs) {
        await chargerCouche(`Véhicules (${detecteur})`, urlVehicules(detecteur),
                            v => ajouterVehicules(detecteur, v));
    }
}

document.getElementById('t-vehicules').addEventListener('click', e => {
    groupeVehicules.visible = !groupeVehicules.visible;
    e.currentTarget.classList.toggle('on', groupeVehicules.visible);
    majCiblesSurvol();
});

// --- Piscines de l'orthophoto -----------------------------------------------------
// Lues par les mêmes réseaux que les véhicules, dans la même couche : la BD
// TOPO n'a pas les piscines des particuliers. Une boîte orientée par bassin,
// et la couleur de l'eau ce jour-là. La boîte est dessinée telle quelle, même
// pour un bassin rond.
//
// L'eau d'un bassin est de niveau : celui du sol au centre de la boîte, et la
// cuve descend jusqu'au sol le plus bas sous ses coins. Trois poses essayées
// sur les pentes de Gordes, où un bassin tient sur une terrasse :
// - drapée sur le relief, comme l'eau de la BD TOPO : la boîte déborde la
//   terrasse et la nappe coule le long du mur de soutènement ;
// - de niveau au sol le plus haut : une cuve de plusieurs mètres de haut ;
// - de niveau au sol du centre : le mur de la terrasse côté aval, et côté
//   amont le terrain qui reprend au-dessus de l'eau. C'est la pose retenue.
const PISCINE_MARGELLE = 0.3;          // convention : le rebord, autour de la boîte
const PISCINE_REBORD = 0.12;           // de l'eau au-dessus du sol du centre
const MAT_MARGELLE = new THREE.MeshStandardMaterial({ color: 0xd9d2c3, roughness: 0.9 });
const MAT_PISCINE = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.1 });
const groupePiscines = new THREE.Group();
scene.add(groupePiscines);
ajouterCiblesSurvol(() => groupePiscines.visible ? groupePiscines.children : []);
poserSurLeRelief({ construire: construirePiscines, placer: () => { if (piscinesPosees) placerPiscines(); } });
let piscinesPosees = null;      // { cuves, eaux, liste }

function construirePiscines() {
    if (!PISCINES || !reliefRegle || piscinesPosees) return;
    const liste = (PISCINES.piscines || []).map(([lon, lat, longueur, largeur, cap, couleur]) =>
        ({ lon, lat, longueur, largeur, cap, couleur }));
    if (!liste.length) return;
    const cuve = new THREE.BoxGeometry(1, 1, 1);
    cuve.translate(0, 0.5, 0);                          // pied à y = 0
    const nappe = new THREE.PlaneGeometry(1, 1);
    nappe.rotateX(-Math.PI / 2);                        // à plat, tournée vers le ciel
    const cuves = new THREE.InstancedMesh(cuve, MAT_MARGELLE, liste.length);
    const eaux = new THREE.InstancedMesh(nappe, MAT_PISCINE, liste.length);
    const teinte = new THREE.Color();
    liste.forEach((p, i) => eaux.setColorAt(i, teinte.setHex(p.couleur)));
    cuves.castShadow = true; cuves.receiveShadow = true; eaux.receiveShadow = true;
    for (const m of [cuves, eaux]) {
        m.userData = { piscines: liste };
        groupePiscines.add(m);
    }
    piscinesPosees = { cuves, eaux, liste };
    placerPiscines();
    const bouton = document.getElementById('t-piscines');
    bouton.hidden = false;
    bouton.title = `${liste.length} piscine(s) vues sur l'orthophoto (détecteur : ${PISCINES.mode})`;
}

/** L'eau de niveau sur le sol exagéré du centre, la cuve jusqu'au plus bas. */
function placerPiscines() {
    const matrice = new THREE.Matrix4();
    const axe = new THREE.Vector3(), haut = new THREE.Vector3(), travers = new THREE.Vector3();
    const { cuves, eaux, liste } = piscinesPosees;
    liste.forEach((p, i) => {
        const cap = p.cap * Math.PI / 180, est = Math.sin(cap), nord = Math.cos(cap);
        const [x, y] = toLocal(p.lon, p.lat);
        // Le sol au centre et aux quatre coins de la boîte.
        const sols = [[0, 0], [1, 1], [1, -1], [-1, -1], [-1, 1]].map(([u, v]) => ySol(...toLonLat(
            x + u * est * p.longueur / 2 + v * nord * p.largeur / 2,
            y + u * nord * p.longueur / 2 - v * est * p.largeur / 2)));
        const niveau = sols[0] + PISCINE_REBORD, pied = Math.min(...sols) - ENFONCEMENT;
        const { X, Y, Z } = repereVehicule(est, nord, 1, 1, 0, 0, 0, 0);       // à plat
        matrice.makeBasis(axe.fromArray(X).multiplyScalar(p.longueur + 2 * PISCINE_MARGELLE),
                          haut.fromArray(Y).multiplyScalar(niveau - pied),
                          travers.fromArray(Z).multiplyScalar(p.largeur + 2 * PISCINE_MARGELLE));
        matrice.setPosition(x, pied, -y);
        cuves.setMatrixAt(i, matrice);
        // L'eau affleure, deux centimètres au-dessus de la margelle.
        matrice.makeBasis(axe.fromArray(X).multiplyScalar(p.longueur), haut.fromArray(Y),
                          travers.fromArray(Z).multiplyScalar(p.largeur));
        matrice.setPosition(x, niveau + 0.02, -y);
        eaux.setMatrixAt(i, matrice);
    });
    for (const m of [cuves, eaux]) {
        m.instanceMatrix.needsUpdate = true;
        m.computeBoundingSphere();
    }
}

document.getElementById('t-piscines').addEventListener('click', e => {
    groupePiscines.visible = !groupePiscines.visible;
    e.currentTarget.classList.toggle('on', groupePiscines.visible);
    majCiblesSurvol();
});

// --- Bateaux de l'orthophoto -------------------------------------------------------
// Lus par les mêmes réseaux, classe « ship » (/api/navires), et gardés par le
// serveur sur l'eau seulement : bassins des ports, lacs, rivières, mer. La
// boîte donne la place, la longueur, la largeur et l'axe ; ni la hauteur, ni
// le type, ni le sens : trois façons de deviner l'étrave, jugées sur 112
// bateaux, en donnaient le bon sens deux fois sur trois (vue3d/vehicules.py,
// NAVIRES). La coque est donc effilée aux deux bouts, la superstructure au
// milieu. Gabarits et hauteurs de convention, d'après la longueur.
export const GABARITS_NAVIRE = {
    // tirant : sous la flottaison ; franc : de la flottaison au pont ;
    // roufs : [part de la longueur, part de la largeur, hauteur], de bas en haut.
    annexe: { nom: 'Barque ou annexe', longueurMax: 7, tirant: 0.3, franc: 0.5, roufs: [] },
    vedette: { nom: 'Vedette ou voilier', longueurMax: 15, tirant: 0.6, franc: 1.0, roufs: [[0.4, 0.62, 0.9]] },
    yacht: { nom: 'Yacht', longueurMax: 35, tirant: 1.4, franc: 1.8, roufs: [[0.55, 0.8, 2.4], [0.32, 0.66, 2.2]] },
    grand: { nom: 'Grand yacht ou navire', longueurMax: Infinity, tirant: 2.4, franc: 2.8,
             roufs: [[0.62, 0.84, 2.8], [0.46, 0.74, 2.6], [0.26, 0.6, 2.4]] },
};
// Deux bateaux voisins d'un ponton ont des boîtes qui se touchent : la coque
// est dessinée en retrait, comme les véhicules.
const NAVIRE_PART_LONGUEUR = 0.96;
const NAVIRE_PART_LARGEUR = 0.88;
let NAVIRES = null;            // { mode, navires }
const groupeNavires = new THREE.Group();
scene.add(groupeNavires);
ajouterCiblesSurvol(() => groupeNavires.visible ? groupeNavires.children : []);
poserSurLeRelief({ construire: construireNavires,
                   placer: () => { if (naviresPoses.length) placerNavires(); } });
const naviresPoses = [];         // { maillages, liste } par gabarit

/**
 * Blocs d'un bateau : x de −0,5 à 0,5 (longueur), z de −0,5 à 0,5 (largeur),
 * y en mètres, de 0 (quille) au toit du dernier rouf. Chaque bloc est un solide fermé
 * entre deux polygones convexes horizontaux de même nombre de sommets,
 * triangles tournés vers l'extérieur.
 *
 * Returns: [{ teinte: 'caisse' | 'vitre', tris: [[a, b, c], ...] }]
 */
function blocsNavire(gabarit) {
    const g = GABARITS_NAVIRE[gabarit];
    // Polygones parcourus comme la base de blocsVehicule : du bout x < 0, le
    // long du flanc z < 0, puis retour par z > 0.
    const prisme = (teinte, y0, y1, bas, haut) => {
        const b = bas.map(([x, z]) => [x, y0, z]), h = haut.map(([x, z]) => [x, y1, z]);
        const tris = [];
        for (let i = 1; i + 1 < b.length; i++) {
            tris.push([b[0], b[i], b[i + 1]]);                  // dessous
            tris.push([h[0], h[i + 1], h[i]]);                  // dessus
        }
        for (let i = 0; i < b.length; i++) {
            const j = (i + 1) % b.length;
            tris.push([b[i], h[i], h[j]], [b[i], h[j], b[j]]);  // flancs
        }
        return { teinte, tris };
    };
    // La coque vue de dessus, effilée aux deux bouts.
    const coque = (sx, sz) => [[-0.5, 0], [-0.42, -0.32], [-0.25, -0.5], [0.25, -0.5], [0.42, -0.32],
                               [0.5, 0], [0.42, 0.32], [0.25, 0.5], [-0.25, 0.5], [-0.42, 0.32]]
        .map(([x, z]) => [x * sx, z * sz]);
    const rect = (l, b) => [[-l / 2, -b / 2], [l / 2, -b / 2], [l / 2, b / 2], [-l / 2, b / 2]];
    const flottaison = g.tirant, pont = g.tirant + g.franc;
    const blocs = [
        prisme('caisse', 0, flottaison, coque(0.8, 0.35), coque(0.95, 0.9)),       // œuvres vives, en V
        prisme('caisse', flottaison, pont, coque(0.95, 0.9), coque(1, 1)),          // œuvres mortes
    ];
    let y = pont;
    for (const [l, b, h] of g.roufs) {
        blocs.push(prisme('caisse', y, y + 0.3 * h, rect(l, b), rect(l, b)));
        blocs.push(prisme('vitre', y + 0.3 * h, y + 0.85 * h, rect(l * 0.97, b * 0.97), rect(l * 0.94, b * 0.94)));
        blocs.push(prisme('caisse', y + 0.85 * h, y + h, rect(l * 0.94, b * 0.94), rect(l * 0.94, b * 0.94)));
        y += h;
    }
    return blocs;
}

function construireNavires() {
    if (!NAVIRES || !reliefRegle || naviresPoses.length) return;
    const parGabarit = Object.fromEntries(Object.keys(GABARITS_NAVIRE).map(g => [g, []]));
    for (const [lon, lat, longueur, largeur, cap, couleur] of NAVIRES.navires || []) {
        const gabarit = Object.keys(GABARITS_NAVIRE).find(g => longueur < GABARITS_NAVIRE[g].longueurMax);
        parGabarit[gabarit].push({ lon, lat, longueur, largeur, cap, couleur, gabarit });
    }
    for (const [gabarit, liste] of Object.entries(parGabarit)) {
        if (!liste.length) continue;
        const blocs = blocsNavire(gabarit);
        const geometrie = (teinte, colorer) => {
            const pos = [], col = [];
            for (const b of blocs) {
                if (b.teinte !== teinte) continue;
                for (const t of b.tris) for (const p of t) {
                    pos.push(...p);
                    if (colorer) col.push(...TEINTE_VITRE);
                }
            }
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            if (colorer) geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
            geo.computeVertexNormals();
            return geo;
        };
        // La coque et les roufs teints du pont lu sur l'orthophoto ; les
        // vitrages, sombres.
        const maillages = [new THREE.InstancedMesh(geometrie('caisse', false), MAT_CARROSSERIE, liste.length)];
        if (blocs.some(b => b.teinte === 'vitre')) {
            maillages.push(new THREE.InstancedMesh(geometrie('vitre', true), MAT_VITRES, liste.length));
        }
        const teinte = new THREE.Color();
        liste.forEach((n, i) => maillages[0].setColorAt(i, teinte.setHex(n.couleur)));
        for (const m of maillages) {
            m.castShadow = true; m.receiveShadow = true;
            m.userData = { navires: liste };
            groupeNavires.add(m);
        }
        naviresPoses.push({ maillages, liste });
    }
    if (!naviresPoses.length) return;
    placerNavires();
    const bouton = document.getElementById('t-navires');
    bouton.hidden = false;
    bouton.title = `${NAVIRES.navires.length} bateau(x) vus sur l'orthophoto, sur l'eau, le jour de la prise de vue `
        + `(détecteur : ${NAVIRES.mode})`;
    majCiblesSurvol();
}

/**
 * De niveau, la flottaison sur l'eau dessinée (le sol exagéré du centre,
 * EAU_DECALAGE au-dessus) ; dimensions réelles, comme les bâtiments. Hors
 * relief, en mer le plus souvent, le sol est à 0.
 */
function placerNavires() {
    const matrice = new THREE.Matrix4();
    const axe = new THREE.Vector3(), haut = new THREE.Vector3(), travers = new THREE.Vector3();
    for (const { maillages, liste } of naviresPoses) {
        liste.forEach((n, i) => {
            const cap = n.cap * Math.PI / 180, est = Math.sin(cap), nord = Math.cos(cap);
            const [x, y] = toLocal(n.lon, n.lat);
            const { X, Y, Z } = repereVehicule(est, nord, 1, 1, 0, 0, 0, 0);       // à plat
            matrice.makeBasis(axe.fromArray(X).multiplyScalar(n.longueur * NAVIRE_PART_LONGUEUR),
                              haut.fromArray(Y),
                              travers.fromArray(Z).multiplyScalar(n.largeur * NAVIRE_PART_LARGEUR));
            const flottaison = ySol(n.lon, n.lat) + EAU_DECALAGE;
            matrice.setPosition(x, flottaison - GABARITS_NAVIRE[n.gabarit].tirant, -y);
            for (const m of maillages) m.setMatrixAt(i, matrice);
        });
        for (const m of maillages) {
            m.instanceMatrix.needsUpdate = true;
            m.computeBoundingSphere();          // le lancer de rayon du survol s'y fie
        }
    }
}

document.getElementById('t-navires').addEventListener('click', e => {
    groupeNavires.visible = !groupeNavires.visible;
    e.currentTarget.classList.toggle('on', groupeNavires.visible);
    majCiblesSurvol();
});
