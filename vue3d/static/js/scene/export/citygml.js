// L'export CityGML 2.0.

import { ENFONCEMENT } from '../terrain/etat.js';
import { idGml } from './ifc.js';

// Le même modèle que l'IFC (modeleExport), pour les SIG et les maquettes
// urbaines (FME, 3DCityDB, FZKViewer) : bâtiments en LOD2 — surfaces de toit,
// de mur et de sol —, arbres en objets de végétation, masses en objets
// génériques, relief en TIN. CityGML 2.0 plutôt que 3.0 : c'est celui que ces
// logiciels lisent tous. Coordonnées absolues en Lambert-93, altitudes NGF,
// au millimètre ; le système est dit une fois, sur l'enveloppe du modèle.
// Les volumes sont ceux de l'IFC, pied compris : enfoncé de 0,5 m sous le
// point le plus bas du terrain, le TIN, plus grossier, ne le laisse pas
// flotter.

// Deux triangles voisins sont du même polygone si leurs normales font moins
// de 5° et que tous leurs sommets sont à 2 mm au plus du plan du premier :
// les sommets sont arrondis au millimètre, et un mur à 1° du suivant s'en
// écarte déjà de 17 cm à 10 m.
const PLAN_COS = Math.cos(5 * Math.PI / 180);
const PLAN_ECART_M = 0.002;

/**
 * Polygones plans d'un maillage (facettesIfc) : ses triangles réunis par
 * région plane de même classe, de proche en proche par leurs arêtes, et
 * chaque région rendue par son contour. CityGML décrit des faces, pas des
 * triangles : un mur extrudé y est un rectangle, un toit-terrasse son
 * emprise, trouée de ses cours. `classer(nz)` : la classe d'un triangle
 * d'après la composante verticale de sa normale, null pour l'omettre.
 * Rend [{ classe, anneaux: [[i, …]] }], l'anneau extérieur d'abord.
 *
 * Un triangle plat — ses sommets presque alignés une fois arrondis au
 * millimètre : un sur 96 581 polygones à Gordes, un pan de toit d'aire nulle,
 * invalide en CityGML — n'a pas de normale sûre. Il rejoint la région plane
 * qui le borde, où ses arêtes s'annulent, et n'est jamais publié seul. Plat
 * sous 10 mm², dix fois le seuil des validateurs : un triangle de 1 sur 3 mm
 * à Strasbourg, à 1 mm² juste, passait d'un côté ou de l'autre selon
 * l'arrondi.
 */
function polygonesPlans(f, classer) {
    const P = f.points, F = f.faces, nT = F.length / 3, n = P.length / 3;
    const normales = new Float64Array(3 * nT), classes = new Array(nT), plats = new Uint8Array(nT);
    for (let t = 0; t < nT; t++) {
        const a = 3 * F[3 * t], b = 3 * F[3 * t + 1], c = 3 * F[3 * t + 2];
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
        const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        // Deux fois l'aire : sous 10 mm², le triangle est plat.
        const l = Math.hypot(nx, ny, nz);
        if (l < 2e-5) { plats[t] = 1; continue; }
        normales[3 * t] = nx / l; normales[3 * t + 1] = ny / l; normales[3 * t + 2] = nz / l;
        classes[t] = classer(nz / l);
    }
    const arete = (a, b) => Math.min(a, b) * n + Math.max(a, b);
    const voisins = new Map();
    for (let t = 0; t < nT; t++) {
        for (let k = 0; k < 3; k++) {
            const cle = arete(F[3 * t + k], F[3 * t + (k + 1) % 3]);
            const liste = voisins.get(cle);
            if (liste) liste.push(t); else voisins.set(cle, [t]);
        }
    }
    const pris = new Uint8Array(nT), sortie = [];
    for (let t0 = 0; t0 < nT; t0++) {
        if (pris[t0] || classes[t0] == null) continue;
        const nx = normales[3 * t0], ny = normales[3 * t0 + 1], nz = normales[3 * t0 + 2];
        const p0 = 3 * F[3 * t0], d = nx * P[p0] + ny * P[p0 + 1] + nz * P[p0 + 2];
        const tris = [t0];
        pris[t0] = 1;
        for (let q = 0; q < tris.length; q++) {
            for (let k = 0; k < 3; k++) {
                for (const u of voisins.get(arete(F[3 * tris[q] + k], F[3 * tris[q] + (k + 1) % 3]))) {
                    if (pris[u] || !plats[u] && (classes[u] !== classes[t0]
                        || nx * normales[3 * u] + ny * normales[3 * u + 1] + nz * normales[3 * u + 2] < PLAN_COS)) continue;
                    let plan = true;
                    for (let m = 0; m < 3 && plan; m++) {
                        const p = 3 * F[3 * u + m];
                        plan = Math.abs(nx * P[p] + ny * P[p + 1] + nz * P[p + 2] - d) <= PLAN_ECART_M;
                    }
                    if (!plan) continue;
                    pris[u] = 1;
                    tris.push(u);
                }
            }
        }
        sortie.push(...contoursRegion(F, P, tris, [nx, ny, nz], classes[t0], plats));
    }
    return sortie;
}

/**
 * Les anneaux d'une région plane : ses arêtes de bord enchaînées, l'anneau
 * extérieur tournant comme ses triangles, les cours en sens inverse. Une
 * région dont le bord n'est pas fait d'anneaux simples — deux bords qui
 * partent d'un même sommet — est rendue triangle par triangle, sans ses
 * triangles plats.
 */
function contoursRegion(F, P, tris, normale, classe, plats) {
    const n = P.length / 3;
    const unParUn = () => tris.filter(t => !plats[t])
        .map(t => ({ classe, anneaux: [[F[3 * t], F[3 * t + 1], F[3 * t + 2]]] }));
    if (tris.length === 1) return unParUn();
    const orientees = new Set();
    for (const t of tris) for (let k = 0; k < 3; k++) orientees.add(F[3 * t + k] * n + F[3 * t + (k + 1) % 3]);
    const suivant = new Map();
    for (const t of tris) {
        for (let k = 0; k < 3; k++) {
            const a = F[3 * t + k], b = F[3 * t + (k + 1) % 3];
            if (orientees.has(b * n + a)) continue;           // arête intérieure
            if (suivant.has(a)) return unParUn();
            suivant.set(a, b);
        }
    }
    const anneaux = [], vus = new Set();
    for (const depart of suivant.keys()) {
        if (vus.has(depart)) continue;
        const anneau = [];
        let v = depart;
        while (v !== undefined && !vus.has(v)) { vus.add(v); anneau.push(v); v = suivant.get(v); }
        if (v !== depart) return unParUn();
        anneaux.push(anneau);
    }
    // Aire signée autour de la normale (Newell) : positive pour l'extérieur.
    const aire = anneau => {
        let x = 0, y = 0, z = 0;
        anneau.forEach((i, k) => {
            const j = anneau[(k + 1) % anneau.length];
            x += P[3 * i + 1] * P[3 * j + 2] - P[3 * i + 2] * P[3 * j + 1];
            y += P[3 * i + 2] * P[3 * j] - P[3 * i] * P[3 * j + 2];
            z += P[3 * i] * P[3 * j + 1] - P[3 * i + 1] * P[3 * j];
        });
        return (x * normale[0] + y * normale[1] + z * normale[2]) / 2;
    };
    const aires = anneaux.map(aire);
    if (aires.filter(a => a > 0).length !== 1) return unParUn();
    const ordre = aires.map((_, i) => i).sort((i, j) => aires[j] - aires[i]);
    return [{ classe, anneaux: ordre.map(i => anneaux[i]) }];
}

/**
 * Sols d'un maillage de murs ouvert en bas : ses anneaux de bord, au plus
 * bas, d'où les murs montent. Les toits en pans et les surfaces mesurées
 * n'ont pas de plancher (vue3d/pans.py ne le transmet pas) : 38 bâtiments sur
 * 247 à Gordes restaient sans sol. Au plus bas seulement : leurs murs
 * comptent aussi les marches entre pans, dont le bas, sur un pan plat, est
 * un bord horizontal d'où un mur monte. Rend [{ classe: 'GroundSurface',
 * anneaux }], tournés vers le bas, les cours en trous de leur sol ; rien si
 * le bord est pincé ou qu'une cour ne trouve pas son sol.
 */
function solsOuverts(f) {
    const P = f.points, F = f.faces, n = P.length / 3;
    const z = i => P[3 * i + 2];
    let zMin = Infinity;
    for (let i = 2; i < P.length; i += 3) zMin = Math.min(zMin, P[i]);
    const orientees = new Set();
    for (let t = 0; t < F.length; t += 3) for (let k = 0; k < 3; k++) orientees.add(F[t + k] * n + F[t + (k + 1) % 3]);
    const suivant = new Map();
    for (let t = 0; t < F.length; t += 3) {
        for (let k = 0; k < 3; k++) {
            const a = F[t + k], b = F[t + (k + 1) % 3], c = F[t + (k + 2) % 3];
            if (orientees.has(b * n + a) || z(a) > zMin + 0.001 || z(b) > zMin + 0.001 || z(c) <= zMin + 0.001) continue;
            if (suivant.has(b)) return [];
            suivant.set(b, a);          // à rebours du mur : le sol regarde vers le bas
        }
    }
    const anneaux = [], vus = new Set();
    for (const depart of suivant.keys()) {
        if (vus.has(depart)) continue;
        const anneau = [];
        let v = depart;
        while (v !== undefined && !vus.has(v)) { vus.add(v); anneau.push(v); v = suivant.get(v); }
        if (v !== depart || anneau.length < 3) return [];
        anneaux.push(anneau);
    }
    const aire = a => a.reduce((s, i, k) => {
        const j = a[(k + 1) % a.length];
        return s + (P[3 * i] * P[3 * j + 1] - P[3 * j] * P[3 * i + 1]) / 2;
    }, 0);
    const dedans = ([x, y], a) => {
        let c = false;
        a.forEach((i, k) => {
            const j = a[(k + 1) % a.length], [xi, yi, xj, yj] = [P[3 * i], P[3 * i + 1], P[3 * j], P[3 * j + 1]];
            if ((yi > y) !== (yj > y) && x < xi + (y - yi) * (xj - xi) / (yj - yi)) c = !c;
        });
        return c;
    };
    const sols = anneaux.filter(a => aire(a) < 0).map(a => ({ classe: 'GroundSurface', anneaux: [a] }));
    for (const cour of anneaux.filter(a => aire(a) > 0)) {
        const pt = [P[3 * cour[0]], P[3 * cour[0] + 1]];
        const sol = sols.find(s => Math.abs(z(s.anneaux[0][0]) - z(cour[0])) <= 0.001 && dedans(pt, s.anneaux[0]));
        if (!sol) return [];
        sol.anneaux.push(cour);
    }
    return sols;
}

/** Texte XML : &, <, >, " et ' échappés. */
const texteXml = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

const ESPACES_CITYGML = [
    'xmlns:core="http://www.opengis.net/citygml/2.0"',
    'xmlns:bldg="http://www.opengis.net/citygml/building/2.0"',
    'xmlns:veg="http://www.opengis.net/citygml/vegetation/2.0"',
    'xmlns:dem="http://www.opengis.net/citygml/relief/2.0"',
    'xmlns:gen="http://www.opengis.net/citygml/generics/2.0"',
    'xmlns:gml="http://www.opengis.net/gml"',
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    'xsi:schemaLocation="' + ['building', 'vegetation', 'relief', 'generics'].map(m =>
        `http://www.opengis.net/citygml/${m}/2.0 http://schemas.opengis.net/citygml/${m}/2.0/${m}.xsd`).join(' ') + '"',
].join(' ');

/**
 * Fichier CityGML 2.0 d'un modèle (modeleExport), en morceaux de texte à
 * joindre — ou à donner tels quels à un Blob : un relief de 125 000
 * triangles n'a pas à tenir dans une seule chaîne. Un bâtiment est un
 * bldg:Building en LOD2, une surface thématique par polygone plan, et une
 * bldg:BuildingPart par emprise quand il en a plusieurs (polygones BD TOPO,
 * parties OSM). Hauteur et étages vont aux attributs CityGML, le reste aux
 * attributs génériques.
 */
export function ecrireCityGml(m) {
    const O = m.origine;
    const pos = (P, i) => `${(P[3 * i] + O.x).toFixed(3)} ${(P[3 * i + 1] + O.y).toFixed(3)} ${(P[3 * i + 2] + O.z).toFixed(3)}`;
    const anneau = (P, a) => '<gml:LinearRing><gml:posList srsDimension="3">'
        + [...a, a[0]].map(i => pos(P, i)).join(' ') + '</gml:posList></gml:LinearRing>';
    const surfaces = polys => '<gml:MultiSurface>' + polys.map(({ P, anneaux: [ext, ...cours] }) =>
        `<gml:surfaceMember><gml:Polygon><gml:exterior>${anneau(P, ext)}</gml:exterior>`
        + cours.map(a => `<gml:interior>${anneau(P, a)}</gml:interior>`).join('')
        + '</gml:Polygon></gml:surfaceMember>').join('') + '</gml:MultiSurface>';
    const valeurs = el => ((el.proprietes && el.proprietes.valeurs) || []).filter(([, , v]) => v != null && v !== '');
    const valeur = (el, nom) => (valeurs(el).find(([n]) => n === nom) || [])[2];
    const attributs = (el, sauf = []) => valeurs(el).filter(([nom]) => !sauf.includes(nom)).map(([nom, type, v]) =>
        type === 'IFCINTEGER' ? `<gen:intAttribute name="${texteXml(nom)}"><gen:value>${Math.round(v)}</gen:value></gen:intAttribute>`
        : /MEASURE$/.test(type) ? `<gen:measureAttribute name="${texteXml(nom)}"><gen:value uom="m">${v.toFixed(3)}</gen:value></gen:measureAttribute>`
        : `<gen:stringAttribute name="${texteXml(nom)}"><gen:value>${texteXml(v)}</gen:value></gen:stringAttribute>`).join('');
    const nomme = el => (el.description ? `<gml:description>${texteXml(el.description)}</gml:description>` : '')
        + (el.nom ? `<gml:name>${texteXml(el.nom)}</gml:name>` : '');
    // Les surfaces thématiques d'un bâtiment ou d'une de ses parties : toit
    // sous 80° de pente, mur, sol ; le dessus des murs, sous un toit, et le
    // dessous d'un toit, à l'intérieur du volume, sont omis.
    const bordsBatiment = (maillages, base) => {
        const aToit = maillages.some(x => x.style === 'toit' && x.facettes.faces.length);
        const classerToit = nz => nz >= 0.17 ? 'RoofSurface' : nz > -0.17 ? 'WallSurface' : null;
        const classerMurs = nz => nz < -0.5 ? 'GroundSurface' : nz <= 0.5 ? 'WallSurface'
            : aToit ? null : 'RoofSurface';
        return maillages.flatMap(({ style, facettes: f }) =>
            [...polygonesPlans(f, style === 'toit' ? classerToit : classerMurs), ...(style === 'murs' ? solsOuverts(f) : [])]
                .map(p => ({ ...p, P: f.points })))
            .map((p, k) => `<bldg:boundedBy><bldg:${p.classe} gml:id="${base}_${k + 1}"><bldg:lod2MultiSurface>`
                + surfaces([p]) + `</bldg:lod2MultiSurface></bldg:${p.classe}></bldg:boundedBy>`).join('');
    };
    const ids = new Set();
    const id = (cle, propre) => {
        let i = propre && /^[A-Za-z_][\w.-]*$/.test(propre) && !ids.has(propre) ? propre : idGml(cle);
        for (let k = 1; ids.has(i); k++) i = idGml(`${cle}#${k}`);
        ids.add(i);
        return i;
    };
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const membres = [];
    for (const el of m.elements) {
        const maillages = el.maillages.filter(({ facettes: f }) => f.faces.length);
        if (!maillages.length) continue;
        for (const { facettes: { points: P } } of maillages) {
            for (let i = 0; i < P.length; i += 3) {
                for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], P[i + k]); max[k] = Math.max(max[k], P[i + k]); }
            }
        }
        if (el.genre === 'batiment') {
            const gid = id(el.cle, el.tag);
            const h = valeur(el, 'Hauteur'), etages = valeur(el, 'NombreEtages');
            const parties = el.parties && el.parties.length > 1 ? el.parties : null;
            membres.push(`<core:cityObjectMember><bldg:Building gml:id="${gid}">${nomme(el)}`
                + attributs(el, ['Hauteur', 'NombreEtages'])
                + (h != null ? `<bldg:measuredHeight uom="m">${h.toFixed(3)}</bldg:measuredHeight>` : '')
                + (etages != null ? `<bldg:storeysAboveGround>${Math.round(etages)}</bldg:storeysAboveGround>` : '')
                + (!parties ? bordsBatiment(maillages, gid) : parties.map(({ nom }, k) => {
                    const siens = maillages.filter(x => x.partie === k);
                    if (!siens.length) return '';
                    const pid = `${gid}_p${k + 1}`;
                    let zMin = Infinity, zMax = -Infinity;
                    for (const { facettes: { points: P } } of siens) {
                        for (let i = 2; i < P.length; i += 3) { zMin = Math.min(zMin, P[i]); zMax = Math.max(zMax, P[i]); }
                    }
                    // Comme le bâtiment : depuis le point bas du terrain, le pied étant enfoncé.
                    return `<bldg:consistsOfBuildingPart><bldg:BuildingPart gml:id="${pid}">`
                        + (nom ? `<gml:name>${texteXml(nom)}</gml:name>` : '')
                        + `<bldg:measuredHeight uom="m">${(zMax - zMin - ENFONCEMENT).toFixed(3)}</bldg:measuredHeight>`
                        + bordsBatiment(siens, pid) + '</bldg:BuildingPart></bldg:consistsOfBuildingPart>';
                }).join(''))
                + '</bldg:Building></core:cityObjectMember>\n');
        } else if (el.genre === 'terrain') {
            const gid = id(el.cle);
            membres.push(`<core:cityObjectMember><dem:ReliefFeature gml:id="${gid}">${nomme(el)}${attributs(el)}`
                + `<dem:lod>2</dem:lod><dem:reliefComponent><dem:TINRelief gml:id="${gid}_tin"><dem:lod>2</dem:lod>`
                + '<dem:tin><gml:TriangulatedSurface><gml:trianglePatches>');
            for (const { facettes: { points: P, faces: F } } of maillages) {
                for (let t = 0; t < F.length; t += 3) {
                    membres.push(`<gml:Triangle><gml:exterior>${anneau(P, [F[t], F[t + 1], F[t + 2]])}</gml:exterior></gml:Triangle>`);
                }
            }
            membres.push('</gml:trianglePatches></gml:TriangulatedSurface></dem:tin></dem:TINRelief>'
                + '</dem:reliefComponent></dem:ReliefFeature></core:cityObjectMember>\n');
        } else {
            const geometrie = surfaces(maillages.flatMap(({ facettes: f }) =>
                polygonesPlans(f, () => 'surface').map(p => ({ ...p, P: f.points }))));
            if (el.genre === 'arbre') {
                const h = valeur(el, 'Hauteur'), d = valeur(el, 'DiametreHouppier');
                membres.push(`<core:cityObjectMember><veg:SolitaryVegetationObject gml:id="${id(el.cle)}">${nomme(el)}`
                    + attributs(el, ['Hauteur', 'DiametreHouppier'])
                    + (h != null ? `<veg:height uom="m">${h.toFixed(3)}</veg:height>` : '')
                    + (d != null ? `<veg:crownDiameter uom="m">${d.toFixed(3)}</veg:crownDiameter>` : '')
                    + `<veg:lod2Geometry>${geometrie}</veg:lod2Geometry></veg:SolitaryVegetationObject></core:cityObjectMember>\n`);
            } else {
                membres.push(`<core:cityObjectMember><gen:GenericCityObject gml:id="${id(el.cle)}">${nomme(el)}${attributs(el)}`
                    + `<gen:lod2Geometry>${geometrie}</gen:lod2Geometry></gen:GenericCityObject></core:cityObjectMember>\n`);
            }
        }
    }
    const srs = m.crs.epsgVertical ? `urn:ogc:def:crs,crs:EPSG::2154,crs:EPSG::${m.crs.epsgVertical}`
                                   : 'urn:ogc:def:crs:EPSG::2154';
    const coin = c => c.map((v, k) => ((Number.isFinite(v) ? v : 0) + [O.x, O.y, O.z][k]).toFixed(3)).join(' ');
    return [`<?xml version="1.0" encoding="UTF-8"?>\n<core:CityModel ${ESPACES_CITYGML}>\n`
            + `<gml:description>${texteXml(m.description)}</gml:description><gml:name>${texteXml(m.nom)}</gml:name>\n`
            + `<gml:boundedBy><gml:Envelope srsName="${srs}" srsDimension="3"><gml:lowerCorner>${coin(min)}</gml:lowerCorner>`
            + `<gml:upperCorner>${coin(max)}</gml:upperCorner></gml:Envelope></gml:boundedBy>\n`,
            ...membres, '</core:CityModel>\n'];
}
