// La construction des bâtiments : murs et toits, posés sur le relief, et les
// chiffres du panneau.

import * as THREE from 'three';
import { toLocal } from '../socle/projection.js';
import {
    MAT_CIBLE, MAT_CONTOUR_CIBLE, MAT_VOISIN, MAT_TOIT_VOISIN, MAT_TOIT_SURFACE, MAT_INCONNU,
    HAUTEUR_PAR_ETAGE, PENTE_TOIT_MAX, groupeBatiments, meshes, meshesToits, TOITS,
    TOITS_SOURCE, TOITS_GRILLE, toitsEnPente, toitsMesures, CIBLE, poserRedessinDesBatiments,
} from './etat.js';
import { rectangleSelonAxe, rectangleMin } from '../geometrie/polygones.js';
import {
    geometrieToitDecoupe, poserToit, poserDessus, rectangleDeCorps, anneauVersShape,
    geometriesMesurees, polygonesDe,
} from './toits.js';
import { majCiblesSurvol } from '../interface/survol.js';
import { features } from './chargement.js';
import { appliquerTextureToits } from '../terrain/fond.js';
import { rebaserBatiments } from '../terrain/relief.js';
import { toursRemplacees } from '../couches/constructions.js';
import { ajouresNuage, pointsNuage, ajouterPrise } from '../couches/nuage.js';
import { verifierToits } from '../couches/ecarts-toits.js';
import { panneauxPoses, placerPanneaux } from '../couches/panneaux.js';
import { afficherCible } from './cible.js';
import { construireMonuments, batimentsRemplaces } from './monuments.js';

// Le redessin que demandent les couches venues avant (batiments/etat).
poserRedessinDesBatiments(() => {
    construire(features, toitsEnPente);
    afficherCible();
});

// Ce que la dernière construction a compté, pour le panneau.
export let stats = { total: 0, avecToit: 0, pentes: [], lidar: 0, axes: 0, corps: 0 };
export function construire(features, toitsEnPente) {
    groupeBatiments.clear();
    meshes.length = 0;
    meshesToits.length = 0;
    stats = { total: 0, avecToit: 0, pentes: [], lidar: 0, axes: 0, corps: 0, inconnus: 0, surfaces: 0, pans: 0, osm: 0 };
    const remplaces = batimentsRemplaces();
    const tours = toursRemplacees();

    for (const f of features) {
        const p = f.properties || {};
        // Un ouvrage ajouré est dessiné en points (chargerNuage) : il ne garde
        // qu'un volume invisible, pour la fiche. Avant les parties OSM, qui ne
        // le dessinent pas non plus (partieDessinee).
        if (ajouresNuage.has(p.cleabs)) { ajouterPrise(f, p); continue; }
        if (remplaces && remplaces.has(p.cleabs)) continue;
        // Une tour de refroidissement est dessinée en coque, avec les
        // constructions : son emprise n'en est que le pied.
        if (tours.has(p.cleabs)) continue;
        const sol0 = p.altitude_minimale_sol;
        const hauteur = p.hauteur;
        // Le LiDAR est la référence quand sa mesure est fiable ; la BD TOPO
        // prend le relais sinon. Pour la FORME du toit il n'y a pas de choix :
        // la BD TOPO ne fournit que deux altitudes par emprise, jamais un
        // faîtage ni un pan — le toit à deux pans sur le rectangle englobant
        // était notre invention, fausse sur 63 % des emprises de plus de
        // 120 m². Pour les hauteurs, ses valeurs sont bruitées dans les deux
        // sens (0,9 m annoncés pour 3,7 mesurés ; 3,5 pour 0,7).
        // `fiable` est posé côté serveur : faux quand le haut du profil n'est
        // pas un toit (arbre qui surplombe, écart p85–p95 > 2 m). Les altitudes
        // BD TOPO sont absolues, les hauteurs LiDAR relatives au sol : les deux
        // chemins restent séparés.
        const bdGout = p.altitude_minimale_toit, bdFait = p.altitude_maximale_toit;
        const mesure = TOITS[p.cleabs] || null;
        const lidar = mesure && mesure.fiable !== false ? mesure : null;
        const gout = lidar ? lidar.gouttiere : bdGout;
        const fait = lidar ? lidar.faitage : bdFait;
        // Sous les arbres, ni le LiDAR (il lit la canopée) ni la BD TOPO (ses
        // altitudes viennent d'un MNS contaminé par les mêmes arbres) ne sont
        // crédibles : le serveur le dit (`hauteur_inconnue`), on ne dessine
        // qu'un volume de repli, sans toit, et l'infobulle l'explique.
        const inconnue = !!(mesure && mesure.hauteur_inconnue);

        for (const { anneau, trous } of polygonesDe(f.geometry)) {
            if (!anneau || anneau.length < 4) continue;
            stats.total++;

            if (inconnue) {
                stats.inconnus++;
                const etages = p.nombre_d_etages > 0 ? p.nombre_d_etages : 1;
                const hRepli = HAUTEUR_PAR_ETAGE * etages;
                const geo = new THREE.ExtrudeGeometry(anneauVersShape(anneau, trous), { depth: hRepli, bevelEnabled: false });
                geo.rotateX(-Math.PI / 2);
                const mur = new THREE.Mesh(geo, MAT_INCONNU);
                habillerCible(mur, anneau);
                mur.castShadow = false; mur.receiveShadow = true;
                mur.userData = { p, denivele: 0, hMur: hRepli, anneau, lidar: null, inconnue: mesure };
                groupeBatiments.add(mur);
                meshes.push(mur);
                continue;
            }

            const aDesAltitudes = lidar ? true : (sol0 != null && gout != null && fait != null);
            const denivele = aDesAltitudes ? Math.max(fait - gout, 0) : 0;
            const pente = toitsEnPente && aDesAltitudes && denivele > 0.5;
            if (aDesAltitudes && denivele > 0.5) { stats.avecToit++; stats.pentes.push(denivele); }
            if (lidar) stats.lidar++;

            // Hauteur des murs : gouttière LiDAR directement, sinon gouttière
            // moins sol BD TOPO ; sans rien, la hauteur unique — le cas MapLibre.
            const hMur = pente ? Math.max(lidar ? gout : gout - sol0, 0.5)
                               : (lidar ? Math.max(gout, 0.5)
                                        : (hauteur != null && hauteur > 0 ? hauteur : 6));

            // Les hauteurs BD TOPO — altitudes comme attribut `hauteur`, qui
            // vaut altitude_minimale_toit − altitude_minimale_sol — se
            // comptent depuis le Z le plus bas du pourtour au sol, le même
            // point que la base posée par rebaserBatiments() : les relever du
            // terrain médian compterait la pente deux fois (mesuré : +2,3 m
            // sur une cabane aux murs déjà annoncés à 8,1 m). Le MNH (hauteur
            // au-dessus du sol local) et le repli notionnel de 6 m partent du
            // sol du bâtiment : eux seuls restent relevés.
            const releve = lidar ? true : !(pente || (hauteur != null && hauteur > 0));

            // L'emprise est conservée : c'est elle, et non un point, qui sert à
            // reposer le bâtiment. Le placement vertical lui-même est délégué à
            // rebaserBatiments(), appelé en fin de construction — une seule
            // écriture de cette règle, partagée avec le curseur d'exagération.
            const forme = anneauVersShape(anneau, trous);
            const geo = new THREE.ExtrudeGeometry(forme, { depth: hMur, bevelEnabled: false });
            geo.rotateX(-Math.PI / 2);   // le plan XY de la Shape devient le sol
            const mur = new THREE.Mesh(geo, materiauMurs(anneau));
            habillerCible(mur, anneau);
            mur.castShadow = true; mur.receiveShadow = true;
            mur.userData = { p, denivele, hMur, anneau, lidar, releve };
            groupeBatiments.add(mur);
            meshes.push(mur);

            // Forme mesurée, là où le toit résumé s'écarte du LiDAR : en pans
            // (vue3d/pans.py), quelques plans fermés par leurs murs, sinon la
            // surface, qui suit le MNH cellule par cellule. Elle remplace le
            // toit à deux pans et les corps, qui n'en sont que des résumés —
            // sur demande seulement : le toit résumé se lit mieux dans une vue
            // d'ensemble.
            const surface = !(toitsEnPente && toitsMesures && lidar && TOITS_GRILLE) ? null
                : lidar.pans || lidar.surface ? geometriesMesurees(anneau, lidar, trous) : null;
            if (surface) {
                const provisoire = meshes.pop();
                groupeBatiments.remove(provisoire);
                provisoire.geometry.dispose();
                if (!(aDesAltitudes && denivele > 0.5)) { stats.avecToit++; stats.pentes.push(denivele); }
                if (lidar.pans) stats.pans++; else stats.surfaces++;
                // Surface déjà rapportée au point bas du contour par le serveur :
                // rebaserBatiments() ne la relève pas.
                const ud = { p, denivele, hMur, anneau, lidar, surface: true };
                const murs = new THREE.Mesh(surface.murs, materiauMurs(anneau));
                habillerCible(murs, anneau);
                const toit = new THREE.Mesh(surface.toit, lidar.pans ? MAT_TOIT_VOISIN : MAT_TOIT_SURFACE);
                const marches = surface.marches ? new THREE.Mesh(surface.marches, MAT_TOIT_VOISIN) : null;
                for (const m of [murs, toit, marches]) {
                    if (!m) continue;
                    m.castShadow = true; m.receiveShadow = true; m.userData = ud;
                    groupeBatiments.add(m);
                    meshes.push(m);
                }
                // Sans fond, appliquerTextureToits() rendra à la surface son
                // matériau lissé ; les pans, plans, gardent celui à facettes
                // des toits résumés.
                toit.userData = { ...ud, lisse: !lidar.pans };
                meshesToits.push(toit);
                toit.name = 'toit';
                continue;
            }

            // Plusieurs faîtages mesurés (maison en ailes) : un toit par corps,
            // chacun sur son axe, en pyramide s'il n'a pas de faîtage net. Les
            // murs restent l'extrusion de l'emprise entière, à la gouttière la
            // plus basse. Les boîtes de corps voisins se recouvrent légèrement
            // en leur jonction : deux pans inclinés qui se coupent, sans
            // scintillement, et une noue plutôt qu'un trou.
            if (toitsEnPente && lidar && lidar.corps && lidar.corps.length >= 2) {
                // Les murs posés ci-dessus sont remplacés par ceux des corps, à
                // la gouttière la plus basse : sans ce retrait, deux extrusions
                // se superposaient, et le bâtiment comptait deux fois.
                const provisoire = meshes.pop();
                groupeBatiments.remove(provisoire);
                provisoire.geometry.dispose();
                if (aDesAltitudes && denivele > 0.5) stats.pentes.pop(); else stats.avecToit++;
                stats.corps += lidar.corps.length;
                stats.pentes.push(Math.max(...lidar.corps.map(c => c.denivele)));
                const hMurs = Math.max(Math.min(...lidar.corps.map(c => c.gouttiere)), 0.5);
                const forme = anneauVersShape(anneau, trous);
                const geo = new THREE.ExtrudeGeometry(forme, { depth: hMurs, bevelEnabled: false });
                geo.rotateX(-Math.PI / 2);
                const mur = new THREE.Mesh(geo, materiauMurs(anneau));
                habillerCible(mur, anneau);
                mur.castShadow = true; mur.receiveShadow = true;
                mur.userData = { p, denivele: stats.pentes[stats.pentes.length - 1], hMur: hMurs, anneau, lidar };
                groupeBatiments.add(mur);
                meshes.push(mur);
                // Les boîtes des corps ne couvrent pas toute l'emprise.
                poserDessus(anneau, trous, hMurs, mur.userData);
                const geoToit = geometrieToitDecoupe(anneau, trous, lidar.corps.map(c => {
                    const g = Math.max(c.gouttiere, 0.5);
                    return { rect: rectangleDeCorps(c), g, f: Math.max(c.faitage, g + 0.3),
                             pyramide: c.axe_deg == null, suivantX: true };
                }), hMurs);
                if (geoToit) poserToit(geoToit, mur.userData);
                continue;
            }

            if (pente) {
                const pts = anneau.map(([lo, la]) => toLocal(lo, la));
                // Axe du faîtage : celui mesuré au LiDAR s'il est net, sinon le
                // grand côté de l'emprise. axe_deg est compté depuis l'est vers
                // le nord, comme l'angle de rectangleMin() sur ces mêmes points.
                const axeLidar = lidar && lidar.axe_deg != null ? lidar.axe_deg * Math.PI / 180 : null;
                const rect = axeLidar !== null ? rectangleSelonAxe(pts, axeLidar) : rectangleMin(pts);
                if (rect) {
                    if (axeLidar !== null) stats.axes++;
                    // Même garde-fou que le serveur pour le LiDAR : la BD TOPO
                    // annonçait 14,5 m de dénivelé sur un bâtiment de 12 m de
                    // large au Mont-Saint-Michel, un toit à 67°.
                    const den = lidar ? denivele : Math.min(denivele,
                        PENTE_TOIT_MAX * Math.min(rect.x1 - rect.x0, rect.y1 - rect.y0));
                    mur.userData.denivele = den;
                    const geoToit = geometrieToitDecoupe(anneau, trous, [{
                        rect, g: hMur, f: hMur + den, suivantX: axeLidar !== null ? true : null }], hMur);
                    if (geoToit) poserToit(geoToit, mur.userData);
                }
            } else {
                poserDessus(anneau, trous, hMur, mur.userData);
            }
        }
    }

    construireMonuments(features, toitsEnPente, remplaces);

    document.getElementById('s-total').textContent =
        stats.total + (stats.osm ? ` (+ ${stats.osm} parties OSM)` : '');
    document.getElementById('s-roof').textContent =
        stats.total ? `${stats.avecToit} (${Math.round(100*stats.avecToit/stats.total)} %)` : '—';
    document.getElementById('s-lidar').textContent =
        stats.total ? `${stats.lidar} (${Math.round(100*stats.lidar/stats.total)} %)`
                      + (stats.axes ? `, faîtage orienté sur ${stats.axes}` : '')
                      + (stats.corps ? `, ${stats.corps} corps de toit` : '')
                      + (stats.pans ? `, en pans sur ${stats.pans}` : '')
                      + (stats.surfaces ? `, surface mesurée sur ${stats.surfaces}` : '')
                      + (stats.inconnus ? `, ${stats.inconnus} sous les arbres (hauteur inconnue)` : '')
                      + (TOITS_SOURCE === 'mns_mnt' ? ' · photogrammétrie' : '') : '—';
    const s = stats.pentes.slice().sort((a, b) => a - b);
    document.getElementById('s-slope').textContent =
        s.length ? `${s[Math.floor(s.length/2)].toFixed(1)} m` : '—';

    rebaserBatiments();
    // Le fond peut être arrivé avant les bâtiments, ou l'inverse : on replaque
    // à chaque reconstruction.
    appliquerTextureToits();
    majCiblesSurvol();
    // Les toits viennent d'être redessinés : les panneaux solaires les suivent,
    // et leur écart au nuage se refait.
    if (panneauxPoses && panneauxPoses.length) placerPanneaux();
    if (pointsNuage) verifierToits();
}

/**
 * Murs du bâtiment visé : en orange, pour qu'on sache d'un coup d'œil de quel
 * bâtiment parlent la fiche, l'ombrage et le masque solaire.
 */
function materiauMurs(anneau) {
    return CIBLE && anneau === CIBLE.anneau ? MAT_CIBLE : MAT_VOISIN;
}

/**
 * Contour orange des arêtes du bâtiment visé. Peint en entier, un grand volume
 * — l'abbaye du Mont-Saint-Michel, 74 m et 182 sommets — n'était plus qu'une
 * masse orange ; ses murs gardent un ton à peine réchauffé, le contour dit
 * lequel c'est. Enfant du mur : il suit son relèvement (rebaserBatiments).
 *
 * `geometrie` : celle dont on tire les arêtes, quand ce n'est pas tout le mur.
 * Les murs d'une surface mesurée comptent les marches de son toit : au château
 * de Versailles, 20 587 arêtes, un gribouillis orange sur tout le toit, contre
 * 7 401 pour son seul pourtour.
 */
function habillerCible(mur, anneau, geometrie = mur.geometry) {
    if (!CIBLE || anneau !== CIBLE.anneau) return;
    mur.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometrie, 40), MAT_CONTOUR_CIBLE));
}
