// Le sol autour de la voiture et le long de la route, et son préchargement.

import * as THREE from 'three';
import { FONDS, ALTI_URL, ALTI_NIVEAU_MIN, ALTI_NIVEAU_MAX } from '../../commun/tuiles.js';
import { PARAMS, RAD } from '../socle/parametres.js';
import { versLambert93, depuisLambert93 } from '../socle/lambert93.js';
import { ORIGINE, ancres, ancrer } from '../socle/monde.js';
import { ANISOTROPIE, camera, courberSol } from '../socle/rendu.js';
import { voiture } from '../socle/etat.js';
import {
    SOL_ZOOM_MIN, SOL_ZOOM_MAX, SOL_MAILLES, SOL_RAYON, SOL_FINESSE, SOL_HORS_CHAMP,
    SOL_PARALLELE, SOL_CACHE, ANTICIPATION_S, tuilesSol, groupeSol, COULEUR_SOL, teinteSol,
    versTuile, versLonLat, DELAI_IMAGE_MS, DELAI_ALTI_MS, chargerImage, TuileAbsente,
} from './tuiles.js';
import {
    MANQUEES_PARALLELE, MANQUEES_ATTENTE_MS, MANQUEES_ATTENTE_MAX_MS, manquees, noterManquee,
    oublierManquee, sauverManquees,
} from './manquees.js';
import { ouvertureCache, lireEnCache, relireTuile } from './cache.js';
import { pasAlti, preparerAltitudes, altitude } from './altitudes.js';
import { pointDuChemin } from '../route/graphe.js';

// La page ne demande le sol que là où sont la caméra et, d'avance, la voiture
// dans 6 et 12 s : une zone sans réseau traversée pour la première fois
// gardait ses bâtiments, lus 2 à 6 km devant, sur une photo floue. Les photos
// fines (zooms 16 à 18) et les altitudes d'une bande de PRECHARGE_LARGEUR_M
// de part et d'autre de la route prévue, sur PRECHARGE_M devant, entrent au
// cache sans être dessinées, trois à la fois, à part du sol visible :
// n'avançant que quand celui-ci laissait une place, elles prenaient du retard
// dès que l'IGN ralentissait (aucune tuile nette au bout d'une minute de
// coupure à 110 km/h, une fois sur deux).
const PRECHARGE_M = 2000, PRECHARGE_PAS_M = 75, PRECHARGE_LARGEUR_M = 120, PRECHARGE_PARALLELE = 3;
const PRECHARGE_ZOOMS = [16, 17, 18];
const prechargees = new Set();
export const statsPrecharge = { demandees: 0, deja: 0 };
let prechargesEnVol = 0, dernierePrecharge = -Infinity;

export function majPrecharge(maintenant) {
    if (maintenant - dernierePrecharge < 300) return;
    dernierePrecharge = maintenant;
    const ch = voiture.chemin;
    let libres = PRECHARGE_PARALLELE - prechargesEnVol;
    if (!ch || !voiture.vue || libres <= 0) return;
    const lancer = url => {
        if (libres <= 0 || prechargees.has(url)) return;
        prechargees.add(url);
        libres--;
        prechargesEnVol++;
        precharger(url).finally(() => { prechargesEnVol--; });
    };
    // Du plus près au plus loin : la route d'abord, puis ses deux bords.
    const fin = Math.min(voiture.dChemin + PRECHARGE_M, ch.longueur);
    for (let d = voiture.dChemin; d <= fin && libres > 0; d += PRECHARGE_PAS_M) {
        const p = pointDuChemin(ch, d);
        const nx = Math.cos(p.cap * RAD) * PRECHARGE_LARGEUR_M, ny = -Math.sin(p.cap * RAD) * PRECHARGE_LARGEUR_M;
        for (const k of [0, -1, 1]) {
            const [lon, lat] = depuisLambert93(p.x + nx * k, p.y + ny * k);
            for (const z of PRECHARGE_ZOOMS) {
                const [tx, ty] = versTuile(lon, lat, z);
                lancer(FONDS[fond](z, tx, ty));
                const niveau = Math.min(Math.max(z - 5, ALTI_NIVEAU_MIN), ALTI_NIVEAU_MAX), q = pasAlti(niveau) * 256;
                lancer(ALTI_URL(niveau, Math.floor((90 - lat) / q), Math.floor((lon + 180) / q)));
            }
        }
    }
}

async function precharger(url) {
    const cache = await ouvertureCache;
    if (!cache) return;                                      // sans cache, rien à gagner
    try {
        if (await cache.match(url)) { statsPrecharge.deja++; return; }
        statsPrecharge.demandees++;
        await lireEnCache(url, url.startsWith('api/tuile') ? DELAI_IMAGE_MS : DELAI_ALTI_MS);
    } catch (e) { /* notée, redemandée plus tard */ }
}

/** L'image d'une tuile, du cache ou du réseau ; lève si elle ne vient pas. */
async function imageEnCache(url) {
    const r = await lireEnCache(url, DELAI_IMAGE_MS);
    if (!r.ok) throw new Error(`tuile ${r.status} : ${url}`);
    const lien = URL.createObjectURL(await r.blob());
    try { return await chargerImage(lien); } finally { URL.revokeObjectURL(lien); }
}

// Le fond montré (photo ou plan), sa génération (une tuile d'un autre fond est
// à refaire), les lectures en cours et la dernière sélection des tuiles.
export let fond = PARAMS.get('fond') === 'plan' ? 'plan' : 'ortho';
export let generationFond = 0;
export let solEnVol = 0;
let derniereSelectionSol = -Infinity;

const parentSol = t => t.z > SOL_ZOOM_MIN ? tuilesSol.get(`${t.z - 1}/${t.x >> 1}/${t.y >> 1}`) : undefined;

function tuileSol(z, x, y) {
    const cle = `${z}/${x}/${y}`;
    let t = tuilesSol.get(cle);
    if (t) return t;
    const [o, n] = versLonLat(x, y, z), [e, s] = versLonLat(x + 1, y + 1, z);
    const coins = [versLambert93(o, n), versLambert93(e, n), versLambert93(o, s), versLambert93(e, s)];
    const xs = coins.map(c => c[0]), ys = coins.map(c => c[1]);
    const p = parentSol({ z, x, y });
    t = { z, x, y, cle, o, e, s, n,
          minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys),
          image: null, sansImage: -1, fondGen: -1, mesh: null, enCours: false, reessai: 0, vue: 0,
          ymin: p ? p.ymin : 0, ymax: p ? p.ymax : 0 };
    t.cx = (t.minX + t.maxX) / 2; t.cy = (t.minY + t.maxY) / 2; t.largeur = t.maxX - t.minX;
    tuilesSol.set(cle, t);
    return t;
}

/**
 * L'image d'une tuile ; null si l'IGN n'en a pas (404 confirmé) ; une panne
 * (réseau coupé, serveur occupé, délai) lève, et la tuile sera redemandée.
 *
 * Seule l'absence confirmée vaut absence. La page classait « sans image » toute
 * tuile dont la relecture échouait, et ses descendantes ne demandaient plus
 * rien : une zone sans réseau, ou un épisode de 404 de l'IGN (une tuile du
 * zoom 15 au centre de Rousset, puis 200 cinq fois de suite) où le serveur,
 * qui relit deux tuiles à la fois, répondait 503, laissaient toute une zone
 * grise pour la vie de la page — 274 tuiles montrées sur 274 après 15 s de
 * coupure et 35 s de réseau. Sous un ancêtre sans image (la mer, l'étranger),
 * une descendante essaie encore l'IGN, sans relecture : l'image peut exister
 * plus fin.
 */
async function imageSol(t, gen) {
    let ancetreAbsent = false;
    for (let a = parentSol(t); a; a = parentSol(a)) if (a.sansImage === gen) { ancetreAbsent = true; break; }
    const url = FONDS[fond](t.z, t.x, t.y);
    try { return await imageEnCache(url); }
    catch (e) {
        if (ancetreAbsent) { t.sansImage = gen; return null; }
        try { return await relireTuile(url); }
        catch (e2) {
            if (e2 instanceof TuileAbsente) { t.sansImage = gen; oublierManquee(url); return null; }
            noterManquee(url);
            throw e2;
        }
    }
}

function habillerTuile(t) {
    const m = t.mesh.material;
    if (m.map) { m.map.dispose(); m.map = null; }
    let a = t;
    while (a && !(a.fondGen === generationFond && a.image)) a = parentSol(a);
    t.habit = a;                        // la tuile dont l'image l'habille, pour les signalements
    if (a) {
        const tex = new THREE.Texture(a.image);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = ANISOTROPIE;
        if (a !== t) {
            const k = 2 ** (t.z - a.z), ix = t.x - a.x * k, iy = t.y - a.y * k;
            tex.repeat.set(1 / k, 1 / k);
            tex.offset.set(ix / k, (k - iy - 1) / k);
        }
        tex.needsUpdate = true;
        m.map = tex;
        m.color.copy(teinteSol);
    } else {
        m.color.copy(COULEUR_SOL);
    }
    m.needsUpdate = true;
}

/**
 * Le maillage d'une tuile, sommets relatifs à son centre : altitudes au
 * niveau z − 5 de la pyramide, normales par différences centrées d'une
 * maille (deux voisines ont la même au bord), et une jupe pendue sous chaque
 * bord, qui bouche la fente avec une voisine d'un autre zoom.
 */
function construireTuile(t, niveau) {
    const N = SOL_MAILLES, L = N + 1, nb = L * L;
    const dLon = (t.e - t.o) / N;
    const pos = new Float32Array((nb + 4 * L) * 3), nor = new Float32Array((nb + 4 * L) * 3);
    const uv = new Float32Array((nb + 4 * L) * 2);
    let ymin = Infinity, ymax = -Infinity;
    // Une altitude illisible ici (sa tuile du RGE ALTI évincée entre sa
    // lecture et cette construction) pose le sommet à 0 m, pour la vie de la
    // tuile : comptée, pour le bandeau et les signalements.
    let manquantes = 0;
    for (let j = 0; j < L; j++) {
        for (let i = 0; i < L; i++) {
            const k = j * L + i;
            const [lon, lat] = versLonLat(t.x + i / N, t.y + j / N, t.z);
            const [x, y] = versLambert93(lon, lat);
            const brute = altitude(lon, lat, niveau);
            if (Number.isNaN(brute)) manquantes++;
            const a = brute || 0;
            const dLat = dLon * Math.cos(lat * RAD);
            const mx = 2 * dLon * 111320 * Math.cos(lat * RAD), my = 2 * dLat * 111320;
            const gE = ((altitude(lon + dLon, lat, niveau) || 0) - (altitude(lon - dLon, lat, niveau) || 0)) / mx;
            const gN = ((altitude(lon, lat + dLat, niveau) || 0) - (altitude(lon, lat - dLat, niveau) || 0)) / my;
            const l = Math.hypot(gE, 1, gN);
            pos[3 * k] = x - t.cx; pos[3 * k + 1] = a; pos[3 * k + 2] = t.cy - y;
            nor[3 * k] = -gE / l; nor[3 * k + 1] = 1 / l; nor[3 * k + 2] = gN / l;
            uv[2 * k] = i / N; uv[2 * k + 1] = 1 - j / N;
            ymin = Math.min(ymin, a); ymax = Math.max(ymax, a);
        }
    }
    const bords = [];
    for (let i = 0; i < L; i++) bords.push(i);
    for (let j = 0; j < L; j++) bords.push(j * L + N);
    for (let i = N; i >= 0; i--) bords.push(N * L + i);
    for (let j = N; j >= 0; j--) bords.push(j * L);
    const jupe = 5 + 0.5 * t.largeur / N;
    for (let b = 0; b < bords.length; b++) {
        const k = bords[b], q = nb + b;
        pos[3 * q] = pos[3 * k]; pos[3 * q + 1] = pos[3 * k + 1] - jupe; pos[3 * q + 2] = pos[3 * k + 2];
        nor[3 * q] = nor[3 * k]; nor[3 * q + 1] = nor[3 * k + 1]; nor[3 * q + 2] = nor[3 * k + 2];
        uv[2 * q] = uv[2 * k]; uv[2 * q + 1] = uv[2 * k + 1];
    }
    const index = [];
    for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
            const a = j * L + i, c = a + L;
            index.push(a, c, a + 1, c, c + 1, a + 1);
        }
    }
    for (let c = 0; c < 4; c++) {
        for (let k = 0; k < N; k++) {
            const b = c * L + k, e0 = bords[b], e1 = bords[b + 1], s0 = nb + b, s1 = s0 + 1;
            index.push(e0, e1, s0, s0, e1, s1);
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(index);
    geo.computeBoundingSphere();
    t.mesh = new THREE.Mesh(geo, courberSol(new THREE.MeshLambertMaterial({ color: COULEUR_SOL })));
    t.mesh.visible = false;
    t.ymin = ymin; t.ymax = ymax;
    t.altiManquantes = manquantes;
    t.niveau = niveau;
    ancrer(t.mesh, t.cx, t.cy);
    habillerTuile(t);
    groupeSol.add(t.mesh);
}

// Une tuile sans altitudes ne se construit pas, et ses descendantes ne la
// remplacent qu'au complet : sa mère reste affichée dès qu'une seule manque.
// Après un échec de ses altitudes (trois essais : sol/altitudes), elle se pose
// tout de suite sur le niveau du RGE ALTI de sa mère, déjà lu : un relief un
// peu plus lisse, plutôt qu'une tuile de zoom 12 (10 km) sous la voiture
// tant que la sienne ne vient pas. Au deuxième échec, 4 s plus tard, comme
// avant, le sol restait flou : l'IGN refusant toujours (400) la tuile
// 8/66/263 à Aix, réseau bridé à 4 Mbit/s et 100 ms, le zoom 16 venait sous
// la voiture en 21,7 s (19 requêtes de la tuile) ; ainsi en 12,1 s (7),
// autant que sans refus (13,1 et 13,6 s).
const ECHECS_ALTI_AVANT_REPLI = 1;
const niveauSol = t => Math.min(Math.max(t.z - 5 - ((t.echecsAlti || 0) >= ECHECS_ALTI_AVANT_REPLI ? 1 : 0),
                                         ALTI_NIVEAU_MIN), ALTI_NIVEAU_MAX);

async function chargerTuileSol(t) {
    t.enCours = true;
    solEnVol++;
    const gen = generationFond;
    const niveau = niveauSol(t);
    let repli = false;
    try {
        const marge = (t.e - t.o) / SOL_MAILLES * 1.5;
        const [alti, image] = await Promise.allSettled([
            t.mesh ? null : preparerAltitudes(t.o - marge, t.s - marge, t.e + marge, t.n + marge, niveau),
            t.fondGen === gen ? t.image : imageSol(t, gen)]);
        if (image.status === 'fulfilled' && gen === generationFond) { t.image = image.value; t.fondGen = gen; }
        if (alti.status === 'rejected') {
            t.echecsAlti = (t.echecsAlti || 0) + 1;
            repli = t.echecsAlti === ECHECS_ALTI_AVANT_REPLI;
            throw alti.reason;
        }
        if (image.status === 'rejected') throw image.reason;
        if (!tuilesSol.has(t.cle)) return;
        if (!t.mesh) construireTuile(t, niveau);
        else habillerTuile(t);
        t.echecs = 0;
        t.erreur = null;
    } catch (e) {
        // Altitudes ou image en panne : redemandée de plus en plus tard, de
        // 4 à 20 s, pas plus : le réseau revenu, le sol doit suivre ; d'ici
        // là, sa mère la couvre. Sur le relief de sa mère, tout de suite.
        t.echecs = (t.echecs || 0) + 1;
        t.erreur = String(e?.message || e).slice(0, 160);
        t.reessai = repli ? 0 : performance.now() + Math.min(4000 * 2 ** (t.echecs - 1), 20000);
    } finally {
        t.enCours = false;
        solEnVol--;
    }
}

const champ = new THREE.Frustum(), boite = new THREE.Box3(), matriceChamp = new THREE.Matrix4();

/**
 * Parcourt l'arbre des tuiles depuis `t` pour un point de vue `pv` ({x, y}
 * Lambert-93, h altitude, regard(t) → 1 dans le champ, SOL_HORS_CHAMP
 * hors). Rend vrai si la tuile est couverte ; `liste` reçoit les tuiles à
 * montrer (null pour la caméra fantôme), `voulues` celles à charger.
 */
function couvrirSol(t, pv, liste, voulues, maintenant, dMere = 0) {
    if (liste) t.vue = maintenant;
    const dx = Math.max(t.minX - pv.x, 0, pv.x - t.maxX);
    const dy = Math.max(t.minY - pv.y, 0, pv.y - t.maxY);
    if (Math.hypot(dx, dy) > SOL_RAYON) return true;
    const dh = Math.max(t.ymin - pv.h, 0, pv.h - t.ymax);
    const d = Math.hypot(dx, dy, dh), facteur = pv.regard(t);
    if (t.z < SOL_ZOOM_MAX && facteur * d < SOL_FINESSE * t.largeur) {
        const sous = [];
        let pretes = true;
        for (let k = 0; k < 4; k++) {
            const enfant = tuileSol(t.z + 1, 2 * t.x + (k & 1), 2 * t.y + (k >> 1));
            if (!couvrirSol(enfant, pv, liste && sous, voulues, maintenant, facteur * d)) pretes = false;
        }
        if (pretes) { if (liste) liste.push(...sous); return true; }
    }
    // Priorité : la distance de la mère, rapportée à la taille de la tuile.
    // Les quatre sœurs, qui ne remplacent leur mère qu'ensemble, l'ont la
    // même ; les découpes près de la caméra passent avant celles de
    // l'horizon, les racines avant tout. Dans l'ordre du zoom, comme
    // l'horizon de la page, les tuiles du zoom 18 sous la voiture attendaient
    // derrière toutes celles de l'horizon : aucune après 15 s à 130 km/h sur
    // l'A7, le sol gris, quand la caméra basse a regardé plus loin.
    if (!t.enCours && (!t.mesh || t.fondGen !== generationFond) && maintenant >= t.reessai) {
        voulues.push({ t, d, p: dMere / t.largeur });
    }
    if (t.mesh) { if (liste) liste.push(t); return true; }
    return false;
}

function racinesSol(x, y) {
    const [lon, lat] = depuisLambert93(x, y);
    const dLat = SOL_RAYON / 111320, dLon = dLat / Math.cos(lat * RAD);
    const [x0, y0] = versTuile(lon - dLon, lat + dLat, SOL_ZOOM_MIN);
    const [x1, y1] = versTuile(lon + dLon, lat - dLat, SOL_ZOOM_MIN);
    const r = [];
    for (let tx = x0; tx <= x1; tx++) for (let ty = y0; ty <= y1; ty++) r.push(tuileSol(SOL_ZOOM_MIN, tx, ty));
    return r;
}

export function majSol(maintenant) {
    groupeSol.visible = !voiture.attendu?.provisoire || voiture.vue;
    if (!groupeSol.visible || maintenant - derniereSelectionSol < 100) return;
    derniereSelectionSol = maintenant;
    camera.updateMatrixWorld();
    champ.setFromProjectionMatrix(matriceChamp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const cam = { x: camera.position.x + ORIGINE.x, y: ORIGINE.y - camera.position.z, h: camera.position.y,
        regard: t => {
            const m = t.largeur / 2;
            boite.min.set(t.minX - ORIGINE.x - m, t.ymin - m, ORIGINE.y - t.maxY - m);
            boite.max.set(t.maxX - ORIGINE.x + m, t.ymax + m, ORIGINE.y - t.minY + m);
            return champ.intersectsBox(boite) ? 1 : SOL_HORS_CHAMP;
        } };
    const liste = [], voulues = [];
    for (const r of racinesSol(cam.x, cam.y)) couvrirSol(r, cam, liste, voulues, maintenant);
    const montrees = new Set(liste);
    for (const t of tuilesSol.values()) if (t.mesh) t.mesh.visible = montrees.has(t);
    voulues.sort((a, b) => a.p - b.p);

    // La caméra fantôme : là où la voiture sera, regardant devant elle.
    const devant = [];
    if (voiture.vue && voiture.v > 3 && voiture.chemin) {
        for (const s of ANTICIPATION_S) {
            const p = pointDuChemin(voiture.chemin, voiture.dChemin + voiture.v * s);
            if (!p) continue;
            const ux = Math.sin(p.cap * RAD), uy = Math.cos(p.cap * RAD);
            const pv = { x: p.x, y: p.y, h: voiture.alt + 40,
                regard: t => ((t.cx - p.x) * ux + (t.cy - p.y) * uy > -t.largeur ? 1 : SOL_HORS_CHAMP) };
            for (const r of racinesSol(p.x, p.y)) couvrirSol(r, pv, null, devant, maintenant);
        }
        devant.sort((a, b) => a.p - b.p);
    }
    for (const { t } of [...voulues, ...devant]) {
        if (solEnVol >= SOL_PARALLELE) break;
        if (!t.enCours) chargerTuileSol(t);
    }

    if (tuilesSol.size > SOL_CACHE) {
        // Jamais les ancêtres d'une tuile montrée : leur image habille celles
        // qui n'ont pas encore la leur. Évincés, ils laissaient le sol gris.
        const ancetres = new Set();
        for (const t of montrees) for (let a = parentSol(t); a && !ancetres.has(a); a = parentSol(a)) ancetres.add(a);
        const vieilles = [...tuilesSol.values()]
            .filter(t => !montrees.has(t) && !ancetres.has(t) && !t.enCours && t.vue < maintenant)
            .sort((a, b) => a.vue - b.vue)
            .slice(0, tuilesSol.size - SOL_CACHE);
        for (const t of vieilles) {
            if (t.mesh) {
                groupeSol.remove(t.mesh);
                ancres.delete(t.mesh);
                t.mesh.geometry.dispose();
                t.mesh.material.map?.dispose();
                t.mesh.material.dispose();
            }
            tuilesSol.delete(t.cle);
        }
    }
}

export function changerFond(nom) {
    fond = nom;
    generationFond++;
    for (const t of tuilesSol.values()) { t.image = null; t.fondGen = -1; }
    derniereSelectionSol = -Infinity;
    document.getElementById('b-fond').textContent = fond === 'ortho' ? 'Plan' : 'Photo';
}

// Les tuiles manquées, reprises quand le sol visible laisse de la place.
let manqueesEnVol = 0, dernierManquees = -Infinity, derniereSauvegarde = -Infinity;
async function reessayerManquee(url, m) {
    try {
        let r = await lireEnCache(url, url.startsWith('api/tuile') ? DELAI_IMAGE_MS : DELAI_ALTI_MS, false);
        if (r.ok) return;                                   // gardée, oubliée par lireEnCache
        if (r.status === 404) {
            // Une photo refusée à l'IGN : le serveur la relit, ou confirme
            // qu'elle n'existe pas ; une altitude absente, c'est la mer.
            if (url.startsWith('api/tuile')) await relireTuile(url);
            oublierManquee(url);
            return;
        }
        throw new Error(`HTTP ${r.status}`);
    } catch (e) {
        if (e instanceof TuileAbsente) { oublierManquee(url); return; }
        m.essais++;
        m.prochain = performance.now() + Math.min(MANQUEES_ATTENTE_MS * 2 ** m.essais, MANQUEES_ATTENTE_MAX_MS);
    }
}

export function majManquees(maintenant) {
    if (maintenant - derniereSauvegarde > 15000) { derniereSauvegarde = maintenant; sauverManquees(); }
    if (maintenant - dernierManquees < 2000 || !manquees.size) return;
    dernierManquees = maintenant;
    // Le sol visible d'abord.
    if (solEnVol >= SOL_PARALLELE / 2) return;
    const pretes = [...manquees].filter(([, m]) => m.prochain <= maintenant).sort((a, b) => b[1].n - a[1].n);
    for (const [url, m] of pretes) {
        if (manqueesEnVol >= MANQUEES_PARALLELE) break;
        manqueesEnVol++;
        m.prochain = Infinity;                              // en cours
        reessayerManquee(url, m).finally(() => {
            manqueesEnVol--;
            if (m.prochain === Infinity) m.prochain = performance.now() + MANQUEES_ATTENTE_MS;
        });
    }
}
