// Les parties de monuments OpenStreetMap : une couche à part.

import * as THREE from 'three';
import { URL_MONUMENTS } from '../socle/reseau.js';
import { requete } from '../socle/chargement.js';
import { toLocal } from '../socle/projection.js';
import {
    MAT_CONTOUR_CIBLE, MAT_VOISIN, groupeBatiments, meshes, TOITS, TOITS_SOURCE, MONUMENTS,
    monumentsActifs, toitsEnPente, CIBLE, poserMonuments,
} from './etat.js';
import { rectangleMin } from '../geometrie/polygones.js';
import { geometrieToitDecoupe, poserToit, poserDessus, anneauVersShape } from './toits.js';
import {
    ESSAIS_MONUMENTS, ATTENTE_MONUMENTS_S, RETARD_ETAT_MONUMENTS_MS, etatCouche,
} from '../interface/etat-couche.js';
import { features } from './chargement.js';
import { majCredits } from '../interface/credits.js';
import { ajouresNuage } from '../couches/nuage.js';
import { afficherCible } from './cible.js';
import { stats, construire } from './construction.js';

/**
 * Parties de monuments OSM (`building:part`), pour les bâtiments que la BD
 * TOPO résume trop : sans LiDAR, La Merveille du Mont-Saint-Michel (20 m ×
 * 67 m, 16 m entre gouttière et faîtage BD TOPO) sortait en toblerone.
 *
 * Chaque partie est traitée comme un bâtiment ordinaire — mêmes matériaux,
 * même repose sur la pente, même fiche au clic (celle du bâtiment BD TOPO qui
 * la contient). Les murs partent du sol même quand la partie a un
 * `min_height` : le bas est caché par la partie du dessous, et un volume qui
 * part du sol suit rebaserBatiments comme les autres.
 */
// Monuments OSM : une couche à part (/api/monuments), demandée une fois la
// scène affichée. OpenStreetMap répond de 0,6 s à plus de 100 s et tombe
// parfois : la scène ne l'attend pas. À l'arrivée des parties, les bâtiments
// sont reconstruits comme le fait le bouton « Monuments OSM ».

const etatMonuments = (texte, enCours = false) => etatCouche('etat-monuments', texte, enCours);

export async function chargerMonuments(essai = 1) {
    // Au premier essai seulement : ensuite l'indicateur est déjà affiché.
    const retard = setTimeout(
        () => etatMonuments('Monuments OpenStreetMap : chargement…', true),
        essai === 1 ? RETARD_ETAT_MONUMENTS_MS : 0);
    try {
        const r = await requete(URL_MONUMENTS);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const m = await r.json();
        clearTimeout(retard);
        etatMonuments(null);
        if (!m || !m.parties || !m.parties.length) return;   // presque partout
        poserMonuments(m);
        // Des parties, mais aucune à dessiner : à Versailles, la seule de
        // l'emprise est dans un bâtiment que le LiDAR mesure. Ni bouton ni
        // crédit alors — ils annonçaient une couche que la vue ne montre pas.
        const remplaces = batimentsRemplaces();
        if (!m.parties.some(partie => partieDessinee(partie, remplaces))) { poserMonuments(null); return; }
        const b = document.getElementById('t-monuments');
        b.hidden = false;
        b.classList.toggle('on', monumentsActifs);
        construire(features, toitsEnPente);
        afficherCible();
        majCredits();
    } catch (e) {
        clearTimeout(retard);
        if (essai >= ESSAIS_MONUMENTS) {
            etatMonuments('Monuments OpenStreetMap indisponibles : recharger la page pour réessayer.');
            return;
        }
        // La roue reste : un nouvel essai est prévu, le chargement n'est pas fini.
        etatMonuments(`Monuments OpenStreetMap indisponibles : nouvel essai dans ${ATTENTE_MONUMENTS_S} s.`, true);
        setTimeout(() => chargerMonuments(essai + 1), ATTENTE_MONUMENTS_S * 1000);
    }
}

export function construireMonuments(features, toitsEnPente, remplaces) {
    if (!monumentsActifs || !MONUMENTS) return;
    const parCleabs = new Map();
    for (const f of features) {
        if (f.properties && f.properties.cleabs) parCleabs.set(f.properties.cleabs, f.properties);
    }
    for (const partie of MONUMENTS.parties) {
        if (!partieDessinee(partie, remplaces)) continue;
        const anneau = partie.contour;
        stats.osm++;
        const p = (partie.bat && parCleabs.get(partie.bat)) || {};
        const toitH = toitsEnPente && partie.toit ? Math.min(partie.toit.h, partie.h - 0.5) : 0;
        const hMur = Math.max(partie.h - toitH, 0.5);
        const geo = new THREE.ExtrudeGeometry(anneauVersShape(anneau), { depth: hMur, bevelEnabled: false });
        geo.rotateX(-Math.PI / 2);
        const mur = new THREE.Mesh(geo, MAT_VOISIN);
        mur.castShadow = true; mur.receiveShadow = true;
        const ud = { p, anneau, hMur, denivele: toitH, lidar: null, monument: partie };
        mur.userData = ud;
        // Le bâtiment visé peut être remplacé par ses parties : le contour
        // orange passe alors sur chacune d'elles.
        if (CIBLE && p.cleabs && CIBLE.p && p.cleabs === CIBLE.p.cleabs) {
            mur.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 40), MAT_CONTOUR_CIBLE));
        }
        groupeBatiments.add(mur);
        meshes.push(mur);
        if (!(toitH > 0)) poserDessus(anneau, [], hMur, ud);
        if (toitH > 0) {
            const pts = anneau.map(([lo, la]) => toLocal(lo, la));
            const rect = rectangleMin(pts);
            if (rect) {
                // `roof:orientation=across` : faîtage sur le petit côté, donc
                // l'inverse du choix par défaut de geometrieToit.
                const forcerX = partie.toit.orientation === 'across'
                    ? (rect.x1 - rect.x0) < (rect.y1 - rect.y0) : null;
                // Découpé sur la partie : une tour ronde porte un toit rond.
                const geoT = geometrieToitDecoupe(anneau, [], [{
                    rect, g: hMur, f: partie.h, pyramide: partie.toit.forme === 'pyramide',
                    suivantX: forcerX }], hMur);
                if (geoT) poserToit(geoT, ud);
            }
        }
    }
}

/**
 * Bâtiments que les parties OSM remplacent, ou null sans couche : OSM et la BD
 * TOPO ne découpent pas le bâti pareil, dessiner les deux superposerait deux
 * modèles.
 *
 * Là où le LiDAR HD mesure, il fait foi : OSM ne prend que les bâtiments dont
 * le LiDAR ne sait rien — sous les arbres, ou profil non fiable. À Strasbourg,
 * la couche entière remplaçait des toits mesurés par des hauteurs estimées ; ce
 * filtre lui laisse l'église Saint-Thomas, que le LiDAR dessinait à 3 m (« sous
 * les arbres »), et rien d'autre. Sans LiDAR (photogrammétrie), la couche est
 * entière : c'est le cas qui l'a motivée, l'abbaye du Mont-Saint-Michel.
 */
export function batimentsRemplaces() {
    const remplaces = monumentsActifs && MONUMENTS ? new Set(MONUMENTS.remplaces) : null;
    if (!remplaces || TOITS_SOURCE !== 'lidar_hd') return remplaces;
    return new Set([...remplaces].filter(c => {
        const t = TOITS[c];
        return !t || t.hauteur_inconnue || t.fiable === false;
    }));
}

/** Une partie OSM est-elle dessinée ? Avec LiDAR, celles des seuls bâtiments repris à OSM. */
function partieDessinee(partie, remplaces) {
    if (!partie.contour || partie.contour.length < 4) return false;
    if (partie.bat && ajouresNuage.has(partie.bat)) return false;     // en points (chargerNuage)
    return TOITS_SOURCE !== 'lidar_hd' || !!(partie.bat && remplaces && remplaces.has(partie.bat));
}
