// Vérifie les sources de l'utilisateur (« Mes sources », fenêtre « Données »)
// en exécutant le vrai code de la page : les fonctions sont extraites de
// vue3d/static/index.html et appelées sous Node, avec le vrai three.js.
//
//   node outils/verifier-sources.mjs
//
// Les contrôles :
// - lecture (lireGeoJson, lireCsv) : collections, géométries groupées,
//   membre `crs` de l'ancienne norme, CSV à point-virgule et virgule
//   décimale, guillemets, colonne « lat, lon » d'OpenDataSoft, lignes sans
//   coordonnées comptées ;
// - projection (choisirProjection, reprojeterEntites) : degrés, degrés écrits
//   (lat, lon), Lambert-93, CC44 et Web Mercator reconnus d'après les
//   coordonnées, et l'aller-retour à 1e-7° près ;
// - découpage (regionDe, decouperTriangles, dansRegion) : l'aire gardée est
//   celle de l'intersection, sous une emprise carrée comme sous un contour
//   concave, et un triangle intérieur n'est pas touché ;
// - adresses (typeAdresse, urlMaSource) : WFS 2.0 en GeoJSON, boîte en
//   (lat, lon), paramètres propres gardés ; OGC API sur ses `items`.
// KML et GPX passent par DOMParser, absent de Node : la page les vérifie
// dans le navigateur.
//
// Sort en erreur si un contrôle est manqué, après les avoir tous faits.
import * as THREE from 'three';
import fs from 'fs';
import { fileURLToPath } from 'url';

const src = fs.readFileSync(fileURLToPath(new URL('../vue3d/static/index.html', import.meta.url)), 'utf8');
function extraire(nom) {
  const i = src.indexOf(`function ${nom}(`);
  if (i < 0) throw new Error('introuvable dans la page : ' + nom);
  let n = 0;
  for (let j = src.indexOf('{', src.indexOf(')', i)); j < src.length; j++) {
    if (src[j] === '{') n++;
    else if (src[j] === '}' && --n === 0) return src.slice(i, j + 1);
  }
}
function extraireConst(nom) {
  const i = src.indexOf(`const ${nom} =`);
  if (i < 0) throw new Error('introuvable dans la page : ' + nom);
  let n = 0;
  for (let j = i; j < src.length; j++) {
    if ('([{'.includes(src[j])) n++;
    else if (')]}'.includes(src[j])) n--;
    else if (src[j] === ';' && n === 0) return src.slice(i, j + 1);
  }
}
const NOMS = ['coniqueConforme', 'versLambert93', 'versUtm', 'versMercator', 'inverseProjection',
              'crsDeclare', 'lireGeoJson', 'lienSuivant', 'champsCsv', 'lireCsv', 'sommetsEchantillon',
              'choisirProjection', 'reprojeterEntites', 'boiteGeometrie', 'regionDe', 'couperDemiPlan',
              'dansTriangle', 'decouperTriangles', 'typeAdresse', 'urlMaSource'];
const CONSTS = ['GRS80', 'WGS84', 'PROJECTIONS', 'nomColonne', 'FRANCE_LARGE', 'ecartKm', 'dansFranceLarge',
                'medianeDe', 'aireSignee', 'dansRegion', 'MES_SOURCES_OBJETS_SERVICE'];
const f = new Function('THREE', CONSTS.map(extraireConst).join('\n') + '\n' + NOMS.map(extraire).join('\n')
  + `\nreturn { ${[...NOMS, ...CONSTS].join(', ')} };`)(THREE);

let echecs = 0;
const verifier = (ok, message) => {
  if (!ok) echecs++;
  console.log(`${ok ? 'ok  ' : 'ÉCHEC'} ${message}`);
};
const leve = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

// Le château de Gordes, la scène des essais.
const CENTRE = [5.2003, 43.9116];

// --- Lecture ------------------------------------------------------------------
const gj = f.lireGeoJson(JSON.stringify({
  type: 'FeatureCollection',
  crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::2154' } },
  features: [
    { type: 'Feature', properties: { nom: 'A' }, geometry: { type: 'Point', coordinates: [1, 2] } },
    { type: 'Feature', properties: { nom: 'B' }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
    { type: 'Feature', properties: null, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
    { type: 'Feature', properties: { nom: 'G' }, geometry: { type: 'GeometryCollection', geometries: [
      { type: 'Point', coordinates: [3, 4] }, { type: 'LineString', coordinates: [[3, 4], [5, 6]] }] } },
    { type: 'Feature', properties: { nom: 'sans géométrie' }, geometry: null },
  ] }));
verifier(gj.entites.length === 5 && gj.entites[4].proprietes.nom === 'G' && gj.entites[2].proprietes
         && gj.entites.map(e => e.geometrie.type).join() === 'Point,LineString,Polygon,Point,LineString',
         `GeoJSON : ${gj.entites.length} entités, collection éclatée, entité sans géométrie omise`);
verifier(gj.crs === 2154 && f.crsDeclare({ properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } }) === 4326
         && f.crsDeclare({ properties: { name: 'EPSG:3944' } }) === 3944 && f.crsDeclare(undefined) === null,
         'GeoJSON : membre crs lu (EPSG::2154, CRS84, EPSG:3944, absent)');
verifier(f.lireGeoJson('{"type":"Point","coordinates":[5,43]}').entites.length === 1,
         'GeoJSON : une géométrie seule est une entité');
verifier(leve(() => f.lireGeoJson('{"a":1}'), /pas du GeoJSON/) && leve(() => f.lireGeoJson('{'), /JSON illisible/),
         'GeoJSON : un JSON quelconque ou tronqué est refusé, avec la raison');

const csv = f.lireCsv('﻿Nom;Latitude;Longitude;Remarque\r\n'
  + 'Château;43,9116;5,2003;"tour; donjon"\r\n'
  + 'Abbaye de Sénanque;43,9280;5,1873;"dit ""Sénanque"""\r\n'
  + 'sans position;;;\r\n');
verifier(csv.entites.length === 2 && csv.ignorees === 1 && csv.crs === 4326
         && csv.entites[0].geometrie.coordinates.join() === '5.2003,43.9116'
         && csv.entites[0].proprietes.Remarque === 'tour; donjon'
         && csv.entites[1].proprietes.Remarque === 'dit "Sénanque"',
         'CSV : point-virgule, virgule décimale, guillemets, une ligne sans coordonnées comptée');
const ods = f.lireCsv('nom,geo_point_2d\nChâteau,"43.9116, 5.2003"\n');
verifier(ods.entites[0].geometrie.coordinates.join() === '5.2003,43.9116', 'CSV : colonne geo_point_2d lue (lat, lon)');
const [xL93, yL93] = f.versLambert93(...CENTRE);
const csvL93 = f.lireCsv(`id,X,Y\n1,${xL93.toFixed(2)},${yL93.toFixed(2)}\n`);
verifier(csvL93.crs === null && csvL93.entites.length === 1, 'CSV : colonnes X et Y lues, projection à reconnaître');
verifier(leve(() => f.lireCsv('a,b\n1,2\n'), /aucune colonne de coordonnées/), 'CSV : sans coordonnées, refusé');

// --- Projection -----------------------------------------------------------------
const point = c => [{ geometrie: { type: 'Point', coordinates: c }, proprietes: {} }];
const autour = (vers, pas = 0.002) => [[0, 0], [pas, 0], [0, pas], [-pas, pas]]
  .map(([dl, dp]) => ({ geometrie: { type: 'Point', coordinates: vers(CENTRE[0] + dl, CENTRE[1] + dp) }, proprietes: {} }));
const allerRetour = (entites, proj) => {
  const lu = f.reprojeterEntites(entites, proj.versLonLat || (c => c));
  return Math.max(...lu.map((e, k) => {
    const attendu = [CENTRE[0] + [0, 0.002, 0, -0.002][k], CENTRE[1] + [0, 0, 0.002, 0.002][k]];
    return Math.hypot(e.geometrie.coordinates[0] - attendu[0], e.geometrie.coordinates[1] - attendu[1]);
  }));
};
for (const [epsg, vers] of [[2154, f.versLambert93],
                            [3944, f.PROJECTIONS.find(p => p.epsg === 3944).vers],
                            [3857, f.versMercator],
                            [32631, (lo, la) => f.versUtm(lo, la, 31)]]) {
  const ent = autour(vers);
  const proj = f.choisirProjection(ent, null, CENTRE, f.PROJECTIONS);
  const ecart = allerRetour(ent, proj);
  verifier(proj.epsg === epsg && proj.detectee && ecart < 1e-7,
           `projection : EPSG:${epsg} reconnue (${proj.epsg}), aller-retour à ${ecart.toExponential(1)}°`);
}
const deg = f.choisirProjection(autour((lo, la) => [lo, la]), null, CENTRE, f.PROJECTIONS);
verifier(deg.epsg === 4326 && deg.versLonLat === null, 'projection : degrés (lon, lat) reconnus');
const inv = f.choisirProjection(autour((lo, la) => [la, lo]), null, CENTRE, f.PROJECTIONS);
verifier(inv.epsg === 4326 && inv.versLonLat && allerRetour(autour((lo, la) => [la, lo]), inv) < 1e-12,
         'projection : degrés écrits (lat, lon) remis dans l’ordre');
// Strasbourg, ouvert sur la scène de Gordes : loin, mais dans le bon ordre.
const loin = f.choisirProjection(point([7.7521, 48.5734]), null, CENTRE, f.PROJECTIONS);
verifier(loin.versLonLat === null, 'projection : un jeu en degrés loin de la scène n’est pas retourné');
const voulue = f.choisirProjection(point([xL93, yL93]), 2154, CENTRE, f.PROJECTIONS);
verifier(voulue.epsg === 2154 && !voulue.detectee, 'projection : choisie dans la fenêtre, prise telle quelle');
verifier(leve(() => f.choisirProjection(point([12345678, 98765432]), null, CENTRE, f.PROJECTIONS), /non reconnue/)
         && leve(() => f.choisirProjection(point([1, 2]), 27572, CENTRE, f.PROJECTIONS), /non prise en charge/),
         'projection : coordonnées hors de toute projection, ou EPSG inconnu, refusés avec la raison');

// --- Découpage -------------------------------------------------------------------
const aire = tris => tris.reduce((s, t) => s + Math.abs(f.aireSignee(t)), 0);
const carre = (x0, y0, x1, y1) => [[[x0, y0], [x1, y0], [x1, y1]], [[x0, y0], [x1, y1], [x0, y1]]];
const emprise = f.regionDe([[-30, -30], [30, -30], [30, 30], [-30, 30]]);
const coupe = f.decouperTriangles(carre(0, -50, 100, 50), emprise);
verifier(emprise.length === 2 && Math.abs(aire(coupe) - 1800) < 1e-6,
         `découpe : carré à cheval sur l'emprise, ${aire(coupe).toFixed(3)} m² gardés (1 800 attendus)`);
// Un contour en L, concave : 60 × 60 moins le quart nord-est.
const enL = f.regionDe([[0, 0], [60, 0], [60, 30], [30, 30], [30, 60], [0, 60], [0, 0]]);
const coupeL = f.decouperTriangles(carre(-10, -10, 70, 70), enL);
verifier(Math.abs(aire(coupeL) - 2700) < 1e-6
         && coupeL.every(t => [0, 1, 2].every(k => f.dansRegion(t.map(p => p)[k], enL)
                                                   || f.dansRegion([(t[0][0] + t[1][0] + t[2][0]) / 3, (t[0][1] + t[1][1] + t[2][1]) / 3], enL))),
         `découpe : contour concave, ${aire(coupeL).toFixed(3)} m² gardés (2 700 attendus), rien hors du L`);
const interieur = [[1, 1], [5, 1], [1, 5]];
const garde = f.decouperTriangles([interieur], emprise);
verifier(garde.length === 1 && garde[0] === interieur, 'découpe : un triangle intérieur est gardé tel quel');
verifier(f.decouperTriangles(carre(100, 100, 120, 120), emprise).length === 0, 'découpe : un triangle dehors disparaît');
const sens = f.decouperTriangles([[[0, -50], [100, 50], [0, 50]]], emprise);
verifier(sens.every(t => f.aireSignee(t) > 0), 'découpe : le sens trigonométrique des triangles est gardé');
verifier(f.dansRegion([45, 15], enL) && !f.dansRegion([45, 45], enL) && f.dansRegion([0, 0], enL),
         'découpe : point dans le L, dans le creux, au sommet');

// --- Adresses ----------------------------------------------------------------------
const b = { o: 5.19, s: 43.90, e: 5.21, n: 43.92 };
verifier(f.typeAdresse('https://data.geopf.fr/wfs/ows') === 'wfs'
         && f.typeAdresse('https://exemple.fr/ogc/collections/arbres') === 'ogcapi'
         && f.typeAdresse('https://exemple.fr/donnees.geojson') === 'geojson'
         && f.typeAdresse('https://exemple.fr/carte?SERVICE=WFS&request=GetCapabilities') === 'wfs',
         'adresse : WFS, OGC API et GeoJSON reconnus');
const wfs = new URL(f.urlMaSource({ url: 'https://exemple.fr/wfs?apikey=cle&request=GetCapabilities&service=wfs',
                                    type: 'auto', couche: 'BDTOPO_V3:batiment' }, b).url);
verifier(wfs.searchParams.get('apikey') === 'cle' && wfs.searchParams.get('REQUEST') === 'GetFeature'
         && !wfs.searchParams.has('request') && wfs.searchParams.get('TYPENAMES') === 'BDTOPO_V3:batiment'
         && wfs.searchParams.get('BBOX') === '43.9,5.19,43.92,5.21,urn:ogc:def:crs:EPSG::4326'
         && wfs.searchParams.get('OUTPUTFORMAT') === 'application/json',
         'adresse : WFS 2.0 en GeoJSON, boîte en (lat, lon), clé gardée, requête remplacée');
verifier(leve(() => f.urlMaSource({ url: 'https://data.geopf.fr/wfs/ows', type: 'wfs' }, b), /typeName/),
         'adresse : un WFS sans couche est refusé');
const ogc = new URL(f.urlMaSource({ url: 'https://exemple.fr/ogc/collections/arbres?f=json', type: 'auto' }, b).url);
verifier(ogc.pathname === '/ogc/collections/arbres/items' && ogc.searchParams.get('bbox') === '5.19,43.9,5.21,43.92'
         && ogc.searchParams.get('f') === 'json',
         'adresse : OGC API sur ses items, boîte en (lon, lat)');

if (echecs) {
  console.log(`\n${echecs} contrôle(s) manqué(s)`);
  process.exit(1);
}
console.log('\ntous les contrôles passent');
