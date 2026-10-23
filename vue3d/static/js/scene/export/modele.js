// Le modèle commun aux exports, d'après la scène affichée.

import * as THREE from 'three';
import { LAT0, LON0, CENTER, ZONE } from '../socle/point.js';
import { toLocal, toLonLat } from '../socle/projection.js';
import {
    terrain, altitudeRef, relief, exagVert, reglerRelief, BORNES, ENFONCEMENT,
} from '../terrain/etat.js';
import { groupeBatiments, toitsEnPente } from '../batiments/etat.js';
import { vegPrete } from '../vegetation/etat.js';
import { rebaserBatiments, sourceRelief } from '../terrain/relief.js';
import { portDe, aUnTronc, gabaritHouppier, ajouterHouppierSimple } from '../vegetation/formes.js';
import { vegetationDessinee } from '../vegetation/couche.js';
import { versLambert93, facettesIfc, trianglesRelief, trianglesTronc } from './ifc.js';

// Couleurs des maillages exportés : un contexte en volumes clairs, comme une
// maquette blanche, les toits un ton plus sombre ; la végétation en vert.
const STYLES_IFC = {
    murs: [0.85, 0.84, 0.81], toit: [0.62, 0.58, 0.55], terrain: [0.76, 0.78, 0.68],
    feuillage: [0.49, 0.63, 0.36], masse: [0.55, 0.56, 0.50], tronc: [0.42, 0.32, 0.25],
};
// Mailles du relief exporté, par côté, au plus : 178 dans l'emprise par
// défaut, la maille de la vue (2 m) ; en zone de 1 000 m, 500 mailles
// ramenées à 250, soit 4 m et 125 000 triangles au lieu de 500 000, ce
// qu'un logiciel de conception manipule sans peine.
const RELIEF_IFC_MAILLES = 256;

/** Ce qu'est le toit d'un bâtiment dessiné, d'après le userData de ses maillages. */
function toitDessine(ud) {
    if (ud.monument) return 'parties OpenStreetMap';
    if (ud.inconnue) return 'aucun : hauteur inconnue sous les arbres, volume de repli';
    if (ud.surface) return ud.lidar && ud.lidar.pans ? 'en pans, mesurés au LiDAR HD' : 'surface mesurée au LiDAR HD';
    if (!toitsEnPente) return 'plat (toits plats demandés)';
    if (ud.lidar && ud.lidar.corps && ud.lidar.corps.length >= 2) return 'corps résumés, LiDAR HD';
    return ud.denivele > 0.5 ? 'deux pans résumés' : 'plat';
}

/**
 * Le modèle des exports (ecrireIfc, ecrireCityGml), d'après la scène affichée et sans
 * exagération du relief : les bâtiments tels que dessinés — toits en pente ou
 * plats, mesurés ou résumés, parties OSM — chacun en un élément ; les arbres
 * et les masses en forme simple, 36 faces et un tronc, au lieu des 180 faces
 * de la forme détaillée (11 000 éléments au Trocadéro en zone de 1 000 m) ;
 * le relief de l'emprise. `options` : { relief, batiments, arbres, masses }.
 */
export function modeleExport(options) {
    const [lx, ly] = versLambert93(CENTER[0], CENTER[1]);
    const origine = { x: Math.round(lx), y: Math.round(ly), z: Math.round(altitudeRef) };
    const [nx, ny] = versLambert93(CENTER[0], CENTER[1] + 1e-4);
    const nord = Math.hypot(nx - lx, ny - ly);
    // Scène, exagération 1 : x vers l'est, y l'altitude moins altitudeRef, z vers le sud.
    const versIfc = (x, y, z) => {
        const [e, n] = versLambert93(...toLonLat(x, -z));
        return [e - origine.x, n - origine.y, y + altitudeRef - origine.z];
    };
    const elements = [];
    const compte = { batiments: 0, arbres: 0, masses: 0, maille: null, osm: false };

    if (options.batiments) {
        // Remis sans exagération le temps de la lecture : rebaserBatiments ne
        // touche qu'à leur position et à leur échelle verticale.
        const exag = exagVert, avecRelief = relief;
        reglerRelief(true, 1);
        const parBatiment = new Map();
        try {
            rebaserBatiments();
            // La vue enfonce la base d'ENFONCEMENT sous le terrain, et le haut
            // avec elle : seuls les toits mesurés le rattrapent
            // (geometriesPans, geometriesSurface). L'export rend aux autres
            // volumes leur hauteur, le pied toujours enfoncé. Mesuré au point
            // 43,4721 ; 5,4908, hauteur exportée moins hauteur LiDAR, sur 23
            // toits résumés ou plats : de −0,50 à −0,04 m sans ce relèvement,
            // de 0,00 à +0,85 m avec — la pente sous l'emprise, comptée depuis
            // son point bas comme pour les 5 toits mesurés (+0,10 à +1,90 m).
            for (const o of groupeBatiments.children) {
                const ud = o.userData;
                if (!ud.anneau || ud.surface) continue;
                if (o.name === 'toit') o.position.y += ENFONCEMENT;
                else if (ud.hMur > 0) o.scale.y += ENFONCEMENT / ud.hMur;
            }
            groupeBatiments.updateMatrixWorld(true);
            const v = new THREE.Vector3();
            for (const o of groupeBatiments.children) {
                const ud = o.userData;
                // Les volumes invisibles des ouvrages dessinés en points n'en sont pas.
                if (!o.isMesh || !ud.anneau || ud.nuage || o.material.visible === false) continue;
                // Un élément par bâtiment BD TOPO, ses polygones et ses parties
                // OSM ensemble ; une partie par emprise, ses murs et son toit.
                const cle = (ud.p && ud.p.cleabs) || ud.monument || ud.anneau;
                let b = parBatiment.get(cle);
                if (!b) parBatiment.set(cle, b = { ud, parties: new Map() });
                if (ud.monument) b.monument = true;
                let partie = b.parties.get(ud.anneau);
                if (!partie) b.parties.set(ud.anneau, partie = { nom: ud.monument && ud.monument.nom, murs: [], toit: [] });
                const tri = o.name === 'toit' ? partie.toit : partie.murs;
                const pos = o.geometry.attributes.position, idx = o.geometry.index;
                const nb = idx ? idx.count : pos.count;
                for (let i = 0; i < nb; i++) {
                    v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(o.matrixWorld);
                    tri.push(...versIfc(v.x, v.y, v.z));
                }
            }
        } finally {
            reglerRelief(avecRelief, exag);
            rebaserBatiments();
            groupeBatiments.updateMatrixWorld(true);
        }
        for (const b of parBatiment.values()) {
            const p = b.ud.p || {};
            const parties = [...b.parties.values()].map(({ nom, murs, toit }) =>
                ({ nom, murs: facettesIfc(murs), toit: facettesIfc(toit) }));
            let zMin = Infinity, zMax = -Infinity;
            for (const f of parties.flatMap(x => [x.murs, x.toit])) {
                for (let i = 2; i < f.points.length; i += 3) { zMin = Math.min(zMin, f.points[i]); zMax = Math.max(zMax, f.points[i]); }
            }
            if (!Number.isFinite(zMin)) continue;
            // Les murs partent ENFONCEMENT sous le point le plus bas du terrain (baseBatiment).
            const sol = zMin + ENFONCEMENT + origine.z;
            const source = b.monument ? 'OpenStreetMap' : b.ud.inconnue ? 'inconnue (sous les arbres)'
                : b.ud.lidar ? 'LiDAR HD' : 'BD TOPO';
            const toitTexte = b.monument ? toitDessine({ monument: true }) : toitDessine(b.ud);
            compte.batiments++;
            compte.osm = compte.osm || !!b.monument;
            elements.push({
                cle: 'batiment|' + (p.cleabs || `${elements.length}`),
                genre: 'batiment',
                nom: p.usage_1 || p.nature || (b.ud.monument && b.ud.monument.nom) || 'Bâtiment',
                description: `Hauteur ${source}, toit ${toitTexte}`, tag: p.cleabs,
                proprietes: { nom: 'VueIGN_Batiment', valeurs: [
                    ['IdentifiantBDTOPO', 'IFCIDENTIFIER', p.cleabs],
                    ['Nature', 'IFCLABEL', p.nature],
                    ['Usage', 'IFCLABEL', p.usage_1],
                    ['NombreEtages', 'IFCINTEGER', p.nombre_d_etages > 0 ? p.nombre_d_etages : null],
                    ['AltitudeSol', 'IFCLENGTHMEASURE', sol],
                    ['Hauteur', 'IFCLENGTHMEASURE', zMax + origine.z - sol],
                    ['SourceHauteur', 'IFCLABEL', source],
                    ['Toit', 'IFCLABEL', toitTexte],
                ] },
                // Les parties, que le CityGML écrit en bldg:BuildingPart : les
                // 428 parties OSM de la cathédrale de Strasbourg, fondues en un
                // maillage, s'y recoupaient, et ses sols en sortaient en 1 132
                // triangles.
                parties: parties.map(({ nom }) => ({ nom })),
                maillages: parties.flatMap(({ murs, toit }, partie) =>
                    [{ style: 'murs', facettes: murs, partie }, { style: 'toit', facettes: toit, partie }]),
            });
        }
    }

    if ((options.arbres || options.masses) && vegPrete) {
        for (const el of vegetationDessinee()) {
            const arbre = el.classe === 'vegetation';
            if (!(arbre ? options.arbres : options.masses)) continue;
            const a = terrain.alt(el.lon, el.lat);
            if (a == null) continue;
            // Posé sur le terrain, sans exagération : la vue l'enfonce
            // d'ENFONCEMENT (placerVegetation), sa cime avec ; seul le tronc
            // l'est ici (trianglesTronc).
            const sol = a - altitudeRef;
            const pts = [], feuillage = [];
            ajouterHouppierSimple({
                sommet: (x, y, z) => pts.push(versIfc(x, y, z)) - 1,
                face: (i, j, k) => { feuillage.push(...pts[i], ...pts[j], ...pts[k]); },
            }, el, sol, true);
            const maillages = [{ style: arbre ? 'feuillage' : 'masse', facettes: facettesIfc(feuillage) }];
            if (aUnTronc(el)) maillages.push({ style: 'tronc', facettes: facettesIfc(trianglesTronc(el, sol, versIfc)) });
            // La BD Forêt donne l'essence dominante d'un massif, pas celle de
            // l'arbre (portDe) : une propriété du massif, pas un nom.
            const essence = el.essence && !/^N[CR]$/.test(el.essence) ? el.essence : null;
            const { a: demiA, b: demiB } = gabaritHouppier(el);
            compte[arbre ? 'arbres' : 'masses']++;
            elements.push({
                cle: `${arbre ? 'arbre' : 'masse'}|${el.lon}|${el.lat}`,
                genre: arbre ? 'arbre' : 'masse',
                nom: arbre ? 'Arbre' : 'Sursol non bâti',
                description: arbre ? `Houppier mesuré au LiDAR HD, port ${portDe(el).nom}`
                                     + (el.nature ? `, ${el.nature} (BD TOPO)` : '')
                    : 'Sursol hors zone de végétation BD TOPO, pas vert à l\'orthophoto (mur, abri, véhicule…)',
                proprietes: { nom: arbre ? 'VueIGN_Arbre' : 'VueIGN_Sursol', valeurs: [
                    ['Hauteur', 'IFCLENGTHMEASURE', el.h],
                    // Celui du houppier dessiné, d'aire égale à son ellipse.
                    ['DiametreHouppier', 'IFCLENGTHMEASURE', 2 * Math.sqrt(demiA * demiB)],
                    ['AltitudeSol', 'IFCLENGTHMEASURE', a],
                    ['EssenceDominanteDuMassif', 'IFCLABEL', arbre ? essence : null],
                    ['Nature', 'IFCLABEL', el.nature],
                    ['Port', 'IFCLABEL', arbre ? portDe(el).nom : null],
                ] },
                maillages,
            });
        }
    }

    if (options.relief) {
        const geo = terrain.mesh.geometry, { widthSegments: sx, heightSegments: sz } = geo.parameters;
        const pas = Math.ceil(Math.max(sx, sz) / RELIEF_IFC_MAILLES);
        const pos = geo.attributes.position;
        const tri = trianglesRelief(sx, sz, (i, j) => {
            const k = j * (sx + 1) + i;
            return versIfc(pos.getX(k), terrain.hauteurs[k] - altitudeRef, pos.getZ(k));
        }, pas);
        const [ax, ay] = toLocal(BORNES.o, BORNES.n), [bx, by] = toLocal(BORNES.e, BORNES.s);
        compte.maille = Math.max(Math.abs(bx - ax) / sx, Math.abs(ay - by) / sz) * pas;
        elements.push({
            cle: 'terrain', genre: 'terrain',
            nom: 'Terrain naturel', description: `${sourceRelief}, maille de ${compte.maille.toFixed(1)} m`,
            proprietes: { nom: 'VueIGN_Terrain', valeurs: [
                ['Source', 'IFCLABEL', sourceRelief],
                ['Maille', 'IFCLENGTHMEASURE', compte.maille],
            ] },
            maillages: [{ style: 'terrain', facettes: facettesIfc(tri) }],
        });
    }

    const rgeAlti = /RGE ALTI/.test(sourceRelief || '');
    // Corse : le RGE ALTI y est en altitudes IGN78.
    const corse = CENTER[0] > 8 && CENTER[1] < 43.1;
    const datumVertical = rgeAlti ? (corse ? 'NGF-IGN78' : 'NGF-IGN69') : null;
    const epsgVertical = rgeAlti ? (corse ? 5721 : 5720) : null;
    const credits = ['Données IGN – Géoplateforme (BD TOPO, LiDAR HD, BD Forêt'
        + (rgeAlti ? ', RGE ALTI' : '') + '), Licence Ouverte 2.0'];
    if (!rgeAlti && sourceRelief) credits.push(`relief : ${sourceRelief} (Mapzen Terrain Tiles, EU-DEM © Copernicus)`);
    if (compte.osm) credits.push('parties de monuments © contributeurs OpenStreetMap, ODbL');
    return {
        base: `vue3d-${LAT0}-${LON0}-z${ZONE}`,
        horodatage: new Date().toISOString().slice(0, 19),
        cle: `${LAT0}|${LON0}|${ZONE}`,
        nom: `Vue 3D IGN ${LAT0.toFixed(5)}, ${LON0.toFixed(5)}`,
        description: 'Maquette de contexte, pas un relevé. ' + credits.join(' ; ') + '.',
        site: `Emprise de ${ZONE} m`, lon: CENTER[0], lat: CENTER[1], origine,
        nordVrai: [(nx - lx) / nord, (ny - ly) / nord],
        crs: { nom: 'EPSG:2154', description: 'RGF93 v1 / Lambert-93' + (datumVertical ? `, altitudes ${datumVertical}` : ''),
               datum: 'RGF93 v1', datumVertical, epsgVertical, projection: 'Lambert conique conforme' },
        styles: STYLES_IFC, elements, compte,
    };
}
