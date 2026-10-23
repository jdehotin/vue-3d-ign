// Vérifie les exports IFC et CityGML de la page en exécutant son vrai code :
// les fonctions sont extraites des modules de la page (vue3d/static/js/scene/)
// et appelées sous Node, comme dans outils/verifier-geometrie.mjs.
//
//   npm install three@0.160.0          # ignoré par git, comme puppeteer-core
//   node outils/verifier-export.mjs [essai.ifc [essai.gml]]
//
// Les contrôles :
// - Lambert-93 (versLambert93) : au millimètre des coordonnées de pyproj,
//   les mêmes points que tests/test_nuage.py ;
// - GlobalId (guidIfc) : 22 caractères de l'alphabet IFC, le premier de 0 à 3,
//   stables, et sans collision sur 200 000 clés ;
// - chaînes STEP (chaineIfc), angles en degrés, minutes, secondes (angleIfc) ;
// - maillages (facettesIfc) : un cube fermé l'est, un cube percé ou dont un
//   triangle est retourné ne l'est pas ; le relief (trianglesRelief) garde
//   ses bords, couvre sa grille et regarde le ciel ; le tronc (trianglesTronc)
//   et le houppier simple (ajouterHouppierSimple), passés dans le repère IFC,
//   sont fermés et tournés vers l'extérieur, le houppier avec sa lisière même
//   sur un profil qui remonte vers le bord ;
// - fichier IFC (ecrireIfc) d'un petit modèle : chaque référence #n est
//   définie, chaque GlobalId unique. Écrit dans le premier fichier donné en
//   argument, il se valide ensuite avec ifcopenshell (outils/valider_ifc.py) ;
// - polygones plans du CityGML (polygonesPlans) : un cube en six
//   quadrilatères ; une emprise en L trouée d'une cour, extrudée par
//   three.js comme dans la page, en murs, sol et dessus troués de leur cour,
//   et son sol retrouvé quand il manque (solsOuverts) ;
//   un arbre en 30 faces de houppier et 9 de tronc ; chaque anneau extérieur
//   tourné comme ses triangles, chaque cour en sens inverse ;
// - fichier CityGML (ecrireCityGml) du même modèle : balises équilibrées,
//   gml:id uniques, anneaux fermés, surfaces de toit, de mur et de sol. Écrit
//   dans le second fichier donné, il se valide ensuite contre les schémas
//   (citygml-tools validate) et par outils/valider_citygml.py.
//
// Sort en erreur si un contrôle est manqué, après les avoir tous faits.
import * as THREE from 'three';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { sourceDesModules } from './source-page.mjs';

const src = sourceDesModules('scene');
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
const NOMS = ['versLambert93', 'hachage128', 'guidIfc', 'idGml', 'chaineIfc', 'angleIfc', 'facettesIfc',
              'trianglesRelief', 'trianglesTronc', 'ecrireIfc', 'alea', 'portDe', 'portMesure', 'aUnTronc',
              'gabaritTronc', 'gabaritHouppier', 'ajouterHouppierSimple', 'polygonesPlans', 'contoursRegion', 'solsOuverts',
              'ecrireCityGml'];
const CONSTS = ['L93', 'ALPHABET_IFC', 'ENTITES_IFC', 'reelIfc', 'STYLES_IFC', 'PORTS', 'EMPRISE_HOUPPIER', 'ENFONCEMENT',
                'HAUTEUR_MIN_TRONC', 'SEGMENTS_SIMPLE', 'PLAN_COS', 'PLAN_ECART_M', 'texteXml', 'ESPACES_CITYGML'];
const { versLambert93, guidIfc, idGml, chaineIfc, angleIfc, facettesIfc, trianglesRelief, trianglesTronc,
        ecrireIfc, aUnTronc, portDe, ajouterHouppierSimple, polygonesPlans, solsOuverts, ecrireCityGml,
        ALPHABET_IFC, STYLES_IFC, ENFONCEMENT } =
  new Function('THREE', CONSTS.map(extraireConst).join('\n') + '\n' + NOMS.map(extraire).join('\n')
    + `\nreturn { ${[...NOMS, ...CONSTS].join(', ')} };`)(THREE);

let echecs = 0;
const verifier = (ok, message) => {
  if (!ok) echecs++;
  console.log(`${ok ? 'ok  ' : 'ÉCHEC'} ${message}`);
};

// --- Lambert-93 ---------------------------------------------------------------
// (lieu, lon, lat, x, y) : pyproj 3.8 (EPSG:4326 -> EPSG:2154), tests/test_nuage.py.
const REFERENCES = [
  ['tour Eiffel', 2.2945, 48.85826, 648237.1625, 6862256.1148],
  ['Gordes', 5.2003, 43.9116, 876728.5214, 6314973.0065],
  ['Brest', -4.486, 48.39, 146636.1395, 6836217.3647],
  ['Ajaccio', 8.7386, 41.9192, 1176667.5614, 6108273.2834],
  ['Dunkerque', 2.3768, 51.0343, 656187.4293, 7104461.7744],
  ['Strasbourg', 7.751, 48.5819, 1050224.8723, 6841837.9889],
];
for (const [lieu, lon, lat, x, y] of REFERENCES) {
  const [X, Y] = versLambert93(lon, lat);
  const ecart = Math.hypot(X - x, Y - y);
  verifier(ecart < 1e-3, `Lambert-93 à ${lieu} : ${(ecart * 1000).toFixed(3)} mm de pyproj`);
}

// --- GlobalId -------------------------------------------------------------------
{
  const g = guidIfc('batiment|BATIMENT0000000258323642');
  verifier(g.length === 22 && [...g].every(c => ALPHABET_IFC.includes(c)) && '0123'.includes(g[0]),
           `GlobalId bien formé (${g})`);
  verifier(guidIfc('batiment|BATIMENT0000000258323642') === g, 'GlobalId stable d\'un appel à l\'autre');
  const vus = new Set();
  let premiers = new Set();
  for (let i = 0; i < 200000; i++) {
    const h = guidIfc(`arbre|${5.2 + i * 1e-6}|${43.9 + (i % 997) * 1e-6}`);
    vus.add(h);
    premiers.add(h[0]);
  }
  verifier(vus.size === 200000, `aucune collision sur 200 000 clés voisines (${vus.size} distinctes)`);
  verifier([...premiers].sort().join('') === '0123', `premier caractère de 0 à 3, tous atteints (${[...premiers].sort().join('')})`);
}

// --- Chaînes et angles ------------------------------------------------------------
{
  const s = chaineIfc("Église d'Ève \\ €");
  const attendu = "'\\X2\\00C9\\X0\\glise d''\\X2\\00C8\\X0\\ve \\\\ \\X2\\20AC\\X0\\'";
  verifier(s === attendu, `chaîne STEP : ${s}`);
  verifier(angleIfc(43.9116) === '43,54,41,760000', `latitude de Gordes : ${angleIfc(43.9116)}`);
  verifier(angleIfc(-4.486) === '-4,-29,-9,-600000', `longitude de Brest : ${angleIfc(-4.486)}`);
  verifier(angleIfc(45.99999999999) === '46,0,0,0', `retenue jusqu'aux degrés : ${angleIfc(45.99999999999)}`);
}

// --- Maillages ----------------------------------------------------------------------
/** Volume signé d'un maillage fermé : positif si ses faces regardent dehors. */
function volume({ points: P, faces: F }) {
  let v = 0;
  for (let f = 0; f < F.length; f += 3) {
    const [a, b, c] = [F[f], F[f + 1], F[f + 2]].map(i => [P[3 * i], P[3 * i + 1], P[3 * i + 2]]);
    v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return v;
}
{
  // Cube de 2 × 3 × 4 m, faces tournées vers l'extérieur, en triangles non indexés.
  const s = [[0, 0, 0], [2, 0, 0], [2, 3, 0], [0, 3, 0], [0, 0, 4], [2, 0, 4], [2, 3, 4], [0, 3, 4]];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const tris = quads.flatMap(([a, b, c, d]) => [[a, b, c], [a, c, d]]);
  const plat = t => t.flatMap(tri => tri.flatMap(i => s[i]));
  const cube = facettesIfc(plat(tris));
  verifier(cube.points.length === 24 && cube.faces.length === 36 && cube.ferme,
           `cube : 8 sommets, 12 triangles, fermé (${cube.points.length / 3}, ${cube.faces.length / 3}, ${cube.ferme})`);
  verifier(Math.abs(volume(cube) - 24) < 1e-9, `cube : volume ${volume(cube)} m³ (24 attendus)`);
  verifier(!facettesIfc(plat(tris.slice(1))).ferme, 'cube percé : pas fermé');
  verifier(!facettesIfc(plat([[...tris[0]].reverse(), ...tris.slice(1)])).ferme, 'cube à un triangle retourné : pas fermé');
  // Sommets confondus au millimètre, triangle dégénéré retiré.
  const presque = facettesIfc([0, 0, 0, 1, 0, 0, 0, 1, 0, 0.0002, 0, 0, 1.0003, 0, 0, 1, 0, 0]);
  verifier(presque.points.length === 9 && presque.faces.length === 3,
           `sommets confondus au millimètre, dégénéré retiré (${presque.points.length / 3} sommets, ${presque.faces.length / 3} triangle)`);
}
{
  // Relief : 10 × 6 mailles d'un mètre, un sommet sur trois ; ligne j vers le sud.
  const point = (i, j) => [i, -j, 100 + 0.1 * i * j];
  const tri = trianglesRelief(10, 6, point, 3);
  let aire = 0, versLeHaut = true;
  const xs = new Set(), ys = new Set();
  for (let t = 0; t < tri.length; t += 9) {
    const [ax, ay, , bx, by, , cx, cy] = tri.slice(t, t + 8);
    const z = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (z <= 0) versLeHaut = false;
    aire += z / 2;
    for (const k of [0, 3, 6]) { xs.add(tri[t + k]); ys.add(tri[t + k + 1]); }
  }
  verifier(versLeHaut, 'relief : tous les triangles regardent le ciel');
  verifier(Math.abs(aire - 60) < 1e-9, `relief : aire couverte ${aire} m² (60 attendus)`);
  verifier([...xs].sort((a, b) => a - b).join() === '0,3,6,9,10' && [...ys].sort((a, b) => a - b).join() === '-6,-3,0',
           `relief : un sommet sur trois, bords gardés (x ${[...xs].sort((a, b) => a - b)}, y ${[...ys].sort((a, b) => a - b)})`);
}
{
  // Arbres posés dans le repère IFC par la même conversion que la page :
  // x vers l'est, z de la scène vers le sud, y vers le haut.
  const versIfc = (x, y, z) => [x, -z, y];
  const els = [
    { lon: 5.2, lat: 43.9, x: 12, y: -7, h: 14, r: 3.1, profil: [0.98, 0.93, 0.86, 0.78, 0.7, 0.62], allongement: 1.4, axe_deg: 30, classe: 'vegetation', essence: 'Chênes décidus' },
    { lon: 5.21, lat: 43.91, x: -40, y: 25, h: 18, r: 2.4, profil: [0.97, 0.95, 0.92, 0.9, 0.86, 0.8], allongement: 1.1, axe_deg: 0, classe: 'vegetation', essence: 'Pin maritime' },
    { lon: 5.22, lat: 43.92, x: 3, y: 3, h: 2.5, r: 1.6, profil: [0.9, 0.8], allongement: 2.6, axe_deg: 120, classe: 'sursol' },
  ];
  for (const el of els) {
    const pts = [], tri = [];
    ajouterHouppierSimple({ sommet: (x, y, z) => pts.push(versIfc(x, y, z)) - 1,
                            face: (i, j, k) => { tri.push(...pts[i], ...pts[j], ...pts[k]); } }, el, 312.4, true);
    const f = facettesIfc(tri);
    verifier(f.ferme && volume(f) > 0, `houppier simple à lisière (${el.classe}, ${el.h} m) : fermé, tourné dehors, ${volume(f).toFixed(1)} m³`);
    if (aUnTronc(el)) {
      const t = facettesIfc(trianglesTronc(el, 312.4, versIfc));
      const zs = t.points.filter((_, i) => i % 3 === 2);
      const hT = el.h * portDe(el).tronc + Math.min(1, el.h * 0.1);
      verifier(t.ferme && volume(t) > 0 && t.faces.length / 3 === 28
               && Math.abs(Math.min(...zs) - (312.4 - ENFONCEMENT)) < 1e-3 && Math.abs(Math.max(...zs) - (312.4 + hT)) < 1e-3,
               `tronc (${el.h} m) : fermé, tourné dehors, ${t.faces.length / 3} triangles, ${volume(t).toFixed(2)} m³, `
               + `de ${Math.min(...zs).toFixed(2)} à ${Math.max(...zs).toFixed(2)} m`);
    }
  }
  verifier(!aUnTronc(els[2]), 'masse de sursol : pas de tronc');
  // Un profil mesuré qui remonte vers le bord (un feuillu de 10,4 m à
  // 43,4721 ; 5,4908) : sans lisière, le dessous traverse la cuvette du dessus.
  const cuvette = { lon: 5.49, lat: 43.47, x: 0, y: 0, h: 10.4, r: 1.52, profil: [0.19, 0.21, 0.21, 0.41, 0.56, 0.85],
                    allongement: 1.44, axe_deg: 74.9, classe: 'vegetation', essence: 'Feuillus' };
  for (const lisiere of [false, true]) {
    const pts = [], tri = [];
    const faces = ajouterHouppierSimple({ sommet: (x, y, z) => pts.push(versIfc(x, y, z)) - 1,
                                          face: (i, j, k) => { tri.push(...pts[i], ...pts[j], ...pts[k]); } }, cuvette, 0, lisiere);
    const f = facettesIfc(tri);
    verifier(lisiere ? f.ferme && volume(f) > 0 && faces === 48 : volume(f) < 0,
             `houppier en cuvette ${lisiere ? 'avec' : 'sans'} lisière : ${faces} faces, ${volume(f).toFixed(2)} m³`
             + (lisiere ? ', fermé, tourné dehors' : ', retourné comme attendu'));
  }
}

// --- Polygones plans (CityGML) -----------------------------------------------------
/** Aire vectorielle d'un anneau (Newell). */
function aireVecteur(P, anneau) {
  const a = [0, 0, 0];
  anneau.forEach((i, k) => {
    const j = anneau[(k + 1) % anneau.length];
    a[0] += (P[3 * i + 1] * P[3 * j + 2] - P[3 * i + 2] * P[3 * j + 1]) / 2;
    a[1] += (P[3 * i + 2] * P[3 * j] - P[3 * i] * P[3 * j + 2]) / 2;
    a[2] += (P[3 * i] * P[3 * j + 1] - P[3 * i + 1] * P[3 * j]) / 2;
  });
  return a;
}
/** Volume enfermé par des polygones (théorème de flux), cours comprises. */
function volumePolygones(P, polys) {
  let v = 0;
  for (const { anneaux } of polys) {
    for (const a of anneaux) {
      const s = aireVecteur(P, a), p = a[0];
      v += (P[3 * p] * s[0] + P[3 * p + 1] * s[1] + P[3 * p + 2] * s[2]) / 3;
    }
  }
  return v;
}
/** Chaque cour tourne à l'inverse de son anneau extérieur. */
const coursInversees = (P, polys) => polys.every(({ anneaux: [ext, ...cours] }) => {
  const e = aireVecteur(P, ext);
  return cours.every(c => { const a = aireVecteur(P, c); return a[0] * e[0] + a[1] * e[1] + a[2] * e[2] < 0; });
});
const classerMurs = nz => nz < -0.5 ? 'GroundSurface' : nz <= 0.5 ? 'WallSurface' : 'RoofSurface';
{
  const s = [[0, 0, 0], [2, 0, 0], [2, 3, 0], [0, 3, 0], [0, 0, 4], [2, 0, 4], [2, 3, 4], [0, 3, 4]];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const cube = facettesIfc(quads.flatMap(([a, b, c, d]) => [[a, b, c], [a, c, d]]).flatMap(t => t.flatMap(i => s[i])));
  const polys = polygonesPlans(cube, classerMurs);
  verifier(polys.length === 6 && polys.every(p => p.anneaux.length === 1 && p.anneaux[0].length === 4)
           && Math.abs(volumePolygones(cube.points, polys) - 24) < 1e-9,
           `cube : ${polys.length} quadrilatères, ${volumePolygones(cube.points, polys)} m³ enfermés`);
}
{
  // Carré de 2 m dont un côté porte un sommet de plus, et un triangle plat
  // le long de ce côté : il rejoint le carré, qui reste un quadrilatère.
  const [A, B, C, D, E] = [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0], [1, 0, 0]];
  const f = facettesIfc([A, E, D, E, B, C, E, C, D, A, B, E].flat());
  const polys = polygonesPlans(f, () => 'RoofSurface');
  const aire = polys.length === 1 ? aireVecteur(f.points, polys[0].anneaux[0])[2] : 0;
  verifier(f.faces.length === 12 && polys.length === 1 && polys[0].anneaux.length === 1
           && polys[0].anneaux[0].length === 4 && Math.abs(aire - 4) < 1e-9,
           `triangle plat : absorbé, un quadrilatère de ${aire} m²`);
}
{
  // Emprise en L de 20 × 15 m, trouée d'une cour de 4 × 3 m, extrudée sur 6 m
  // comme dans la page (anneauVersShape, ExtrudeGeometry couchée), puis passée
  // dans le repère IFC.
  const forme = new THREE.Shape([[0, 0], [20, 0], [20, 6], [8, 6], [8, 15], [0, 15]].map(([x, y]) => new THREE.Vector2(x, y)));
  forme.holes.push(new THREE.Path([[2, 2], [2, 5], [6, 5], [6, 2]].map(([x, y]) => new THREE.Vector2(x, y))));
  const geo = new THREE.ExtrudeGeometry(forme, { depth: 6, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position, tri = [];
  for (let i = 0; i < pos.count; i++) tri.push(pos.getX(i), -pos.getZ(i), pos.getY(i));
  const f = facettesIfc(tri);
  const polys = polygonesPlans(f, classerMurs);
  const parClasse = c => polys.filter(p => p.classe === c);
  const [sols, toits, murs] = ['GroundSurface', 'RoofSurface', 'WallSurface'].map(parClasse);
  const attendu = (20 * 6 + 8 * 9 - 4 * 3) * 6;
  verifier(sols.length === 1 && sols[0].anneaux.length === 2 && toits.length === 1 && toits[0].anneaux.length === 2
           && murs.length === 10 && murs.every(p => p.anneaux.length === 1 && p.anneaux[0].length === 4),
           `L troué : ${sols.length} sol et ${toits.length} dessus à ${sols[0]?.anneaux.length - 1} cour, ${murs.length} murs rectangulaires`);
  verifier(Math.abs(volumePolygones(f.points, polys) - attendu) < 1e-6 && coursInversees(f.points, polys),
           `L troué : ${volumePolygones(f.points, polys).toFixed(3)} m³ enfermés (${attendu} attendus), cours en sens inverse`);
  // Sans plancher, comme un toit en pans : le sol se retrouve au pied des murs.
  // Relevé de 10 m, pour que le sol compte dans le volume.
  const sansSol = [];
  for (let t = 0; t < tri.length; t += 9) {
    const triangle = tri.slice(t, t + 9).map((v, k) => k % 3 === 2 ? v + 10 : v);
    if (![2, 5, 8].every(k => Math.abs(triangle[k] - 10) < 1e-9)) sansSol.push(...triangle);
  }
  const g = facettesIfc(sansSol);
  const retrouves = solsOuverts(g), reste = polygonesPlans(g, classerMurs);
  verifier(retrouves.length === 1 && retrouves[0].anneaux.length === 2 && !reste.some(p => p.classe === 'GroundSurface')
           && Math.abs(volumePolygones(g.points, [...reste, ...retrouves]) - attendu) < 1e-6 && coursInversees(g.points, retrouves),
           `L troué sans plancher : sol retrouvé, à ${retrouves[0]?.anneaux.length - 1} cour, `
           + `${volumePolygones(g.points, [...reste, ...retrouves]).toFixed(3)} m³ enfermés`);
  verifier(!solsOuverts(f).length, 'L troué avec plancher : aucun sol de plus');
}
{
  const versIfc = (x, y, z) => [x, -z, y];
  const el = { lon: 5.2, lat: 43.9, x: 12, y: -7, h: 14, r: 3.1, profil: [0.98, 0.93, 0.86, 0.78, 0.7, 0.62],
               allongement: 1.4, axe_deg: 30, classe: 'vegetation', essence: 'Chênes décidus' };
  const pts = [], tri = [];
  ajouterHouppierSimple({ sommet: (x, y, z) => pts.push(versIfc(x, y, z)) - 1,
                          face: (i, j, k) => { tri.push(...pts[i], ...pts[j], ...pts[k]); } }, el, 312.4, true);
  const houppier = facettesIfc(tri), tronc = facettesIfc(trianglesTronc(el, 312.4, versIfc));
  const ph = polygonesPlans(houppier, () => 'surface'), pt = polygonesPlans(tronc, () => 'surface');
  verifier(ph.length === 30 && Math.abs(volumePolygones(houppier.points, ph) - volume(houppier)) < 1e-6,
           `houppier : ${ph.length} faces (30 attendues), même volume que ses triangles`);
  verifier(pt.length === 9 && pt.filter(p => p.anneaux[0].length === 7).length === 2
           && Math.abs(volumePolygones(tronc.points, pt) - volume(tronc)) < 1e-6,
           `tronc : ${pt.length} faces dont ${pt.filter(p => p.anneaux[0].length === 7).length} heptagones, même volume que ses triangles`);
}

// --- Fichiers -----------------------------------------------------------------------
{
  const s = [[0, 0, 0], [8, 0, 0], [8, 5, 0], [0, 5, 0], [0, 0, 6], [8, 0, 6], [8, 5, 6], [0, 5, 6]];
  const quads = [[0, 3, 2, 1], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [4, 5, 6, 7]];
  const murs = facettesIfc(quads.flatMap(([a, b, c, d]) => [[a, b, c], [a, c, d]]).flatMap(t => t.flatMap(i => s[i])));
  // Deux pans et leurs deux pignons, sur le dessus des murs.
  const toit = facettesIfc([0, 0, 6, 8, 0, 6, 8, 2.5, 8.5, 0, 0, 6, 8, 2.5, 8.5, 0, 2.5, 8.5,
                            0, 5, 6, 0, 2.5, 8.5, 8, 2.5, 8.5, 0, 5, 6, 8, 2.5, 8.5, 8, 5, 6,
                            0, 0, 6, 0, 2.5, 8.5, 0, 5, 6, 8, 0, 6, 8, 5, 6, 8, 2.5, 8.5]);
  const terrain = facettesIfc(trianglesRelief(4, 4, (i, j) => [-20 + 10 * i, 20 - 10 * j, -0.3 + 0.05 * i], 1));
  const versIfc = (x, y, z) => [x, -z, y];
  const arbre = { lon: 5.2003, lat: 43.9117, x: -12, y: 9, h: 9.5, r: 2.2, profil: [0.97, 0.9, 0.82, 0.74, 0.66, 0.6],
                  allongement: 1.2, axe_deg: 10, classe: 'vegetation' };
  const masse = { lon: 5.2004, lat: 43.9115, x: 14, y: -11, h: 2.4, r: 1.1, profil: [0.95, 0.9], allongement: 2.2,
                  axe_deg: 60, classe: 'sursol' };
  const vegetal = el => {
    const pts = [], tri = [];
    ajouterHouppierSimple({ sommet: (x, y, z) => pts.push(versIfc(x, y, z)) - 1,
                            face: (i, j, k) => { tri.push(...pts[i], ...pts[j], ...pts[k]); } }, el, 0, true);
    const maillages = [{ style: el.classe === 'vegetation' ? 'feuillage' : 'masse', facettes: facettesIfc(tri) }];
    if (aUnTronc(el)) maillages.push({ style: 'tronc', facettes: facettesIfc(trianglesTronc(el, 0, versIfc)) });
    return maillages;
  };
  const modele = {
    base: 'essai', horodatage: '2026-10-15T12:00:00', cle: 'essai',
    nom: 'Essai d\'export', description: 'Données IGN, Licence Ouverte 2.0 & « tests ».', site: 'Emprise de 50 m',
    lon: 5.2003, lat: 43.9116, origine: { x: 876729, y: 6314973, z: 312 },
    nordVrai: [-0.027868, 0.999612],
    crs: { nom: 'EPSG:2154', description: 'RGF93 v1 / Lambert-93, altitudes NGF-IGN69', datum: 'RGF93 v1',
           datumVertical: 'NGF-IGN69', epsgVertical: 5720, projection: 'Lambert conique conforme' },
    styles: STYLES_IFC,
    elements: [
      { cle: 'batiment|ESSAI', genre: 'batiment', nom: 'Résidentiel', description: 'Hauteur LiDAR HD, toit deux pans résumés',
        tag: 'ESSAI',
        proprietes: { nom: 'VueIGN_Batiment', valeurs: [['IdentifiantBDTOPO', 'IFCIDENTIFIER', 'ESSAI'],
                                                        ['NombreEtages', 'IFCINTEGER', 2],
                                                        ['Hauteur', 'IFCLENGTHMEASURE', 8.5],
                                                        ['Usage', 'IFCLABEL', null]] },
        maillages: [{ style: 'murs', facettes: murs }, { style: 'toit', facettes: toit }] },
      { cle: 'vide', genre: 'batiment', nom: 'Vide', maillages: [{ style: 'murs', facettes: facettesIfc([]) }] },
      // Deux parties OSM accolées, de 4 × 4 m sur 3 et 5 m, sans toit dessiné.
      { cle: 'batiment|PARTIES', genre: 'batiment', nom: 'Religieux', tag: 'PARTIES',
        proprietes: { nom: 'VueIGN_Batiment', valeurs: [['Hauteur', 'IFCLENGTHMEASURE', 4.5]] },
        parties: [{ nom: 'Nef' }, { nom: 'Tour' }],
        maillages: [[10, 3], [14, 5]].map(([x0, hz], partie) => {
          const b = [[x0, 0, -0.5], [x0 + 4, 0, -0.5], [x0 + 4, 4, -0.5], [x0, 4, -0.5]];
          const sb = [...b, ...b.map(([x, y]) => [x, y, hz])];
          return { style: 'murs', partie,
                   facettes: facettesIfc(quads.flatMap(([a, q, c, d]) => [[a, q, c], [a, c, d]]).flatMap(t => t.flatMap(i => sb[i]))) };
        }) },
      { cle: 'arbre|5.2003|43.9117', genre: 'arbre', nom: 'Arbre',
        proprietes: { nom: 'VueIGN_Arbre', valeurs: [['Hauteur', 'IFCLENGTHMEASURE', 9.5],
                                                     ['DiametreHouppier', 'IFCLENGTHMEASURE', 3.5],
                                                     ['Port', 'IFCLABEL', 'feuillu']] },
        maillages: vegetal(arbre) },
      { cle: 'masse|5.2004|43.9115', genre: 'masse', nom: 'Sursol non bâti',
        proprietes: { nom: 'VueIGN_Sursol', valeurs: [['Hauteur', 'IFCLENGTHMEASURE', 2.4]] },
        maillages: vegetal(masse) },
      { cle: 'terrain', genre: 'terrain', nom: 'Terrain naturel',
        proprietes: { nom: 'VueIGN_Terrain', valeurs: [['Source', 'IFCLABEL', 'RGE ALTI (IGN)']] },
        maillages: [{ style: 'terrain', facettes: terrain }] },
    ],
  };

  const texte = ecrireIfc(modele);
  const definis = new Set([...texte.matchAll(/^#(\d+)=/gm)].map(m => m[1]));
  const references = new Set([...texte.matchAll(/#(\d+)(?!\d|=)/g)].map(m => m[1]));
  const manquants = [...references].filter(r => !definis.has(r));
  verifier(!manquants.length, `IFC : ${definis.size} entités, toute référence définie${manquants.length ? ' — manquent ' + manquants.join(', ') : ''}`);
  const guids = [...texte.matchAll(/^#\d+=IFC\w+\('([0-9A-Za-z_$]{22})'/gm)].map(m => m[1]);
  verifier(guids.length === 19 && new Set(guids).size === guids.length, `IFC : ${guids.length} GlobalId, tous distincts`);
  verifier(!/Vide/.test(texte), 'IFC : un élément sans triangle est omis');
  verifier(texte.startsWith('ISO-10303-21;\nHEADER;') && texte.endsWith('END-ISO-10303-21;\n'), 'IFC : en-tête et fin ISO 10303-21');
  verifier(/IFCTRIANGULATEDFACESET\(#\d+,\$,\.T\./.test(texte) && /IFCTRIANGULATEDFACESET\(#\d+,\$,\.F\./.test(texte),
           'IFC : murs fermés, toit et terrain ouverts');
  verifier(/IFCGEOGRAPHICELEMENT\('[^']+',\$,'Arbre',\$,'Arbre',.*\.USERDEFINED\.\)/.test(texte)
           && /IFCGEOGRAPHICELEMENT\([^;]*\.TERRAIN\.\)/.test(texte), 'IFC : arbre et terrain en éléments géographiques');
  if (process.argv[2]) {
    fs.writeFileSync(process.argv[2], texte);
    console.log(`écrit : ${process.argv[2]} (${texte.length} octets)`);
  }

  const gml = ecrireCityGml(modele).join('');
  // Balises équilibrées, sans analyseur XML sous Node.
  const pile = [];
  let equilibre = true;
  for (const [, fin, nom, , vide] of gml.matchAll(/<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|[^>"])*?)(\/?)>/g)) {
    if (vide) continue;
    if (!fin) pile.push(nom);
    else if (pile.pop() !== nom) { equilibre = false; break; }
  }
  verifier(equilibre && !pile.length && gml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'),
           `CityGML : balises équilibrées (${gml.length} octets)`);
  const ids = [...gml.matchAll(/gml:id="([^"]+)"/g)].map(m => m[1]);
  verifier(new Set(ids).size === ids.length && ids.includes('ESSAI'), `CityGML : ${ids.length} gml:id, tous distincts, le bâtiment sous son identifiant BD TOPO`);
  const anneaux = [...gml.matchAll(/<gml:posList srsDimension="3">([^<]*)<\/gml:posList>/g)].map(m => m[1].split(' '));
  verifier(anneaux.every(c => c.length % 3 === 0 && c.length >= 12 && c.slice(0, 3).join() === c.slice(-3).join()),
           `CityGML : ${anneaux.length} anneaux, tous fermés, quatre points au moins`);
  const compte = nom => (gml.match(new RegExp(`<${nom}[ >]`, 'g')) || []).length;
  verifier(compte('bldg:Building') === 2 && compte('bldg:RoofSurface') === 4 && compte('bldg:WallSurface') === 14
           && compte('bldg:GroundSurface') === 3 && compte('veg:SolitaryVegetationObject') === 1
           && compte('gen:GenericCityObject') === 1 && compte('gml:Triangle') === 32,
           `CityGML : 2 bâtiments (${compte('bldg:RoofSurface')} toits, ${compte('bldg:WallSurface')} murs dont 2 pignons, `
           + `${compte('bldg:GroundSurface')} sols, dessus des murs omis sous un toit), 1 arbre, 1 masse, `
           + `${compte('gml:Triangle')} triangles de relief`);
  verifier(compte('bldg:BuildingPart') === 2 && /<bldg:BuildingPart gml:id="PARTIES_p1"><gml:name>Nef<\/gml:name><bldg:measuredHeight uom="m">3\.000</.test(gml)
           && /<bldg:BuildingPart gml:id="PARTIES_p2"><gml:name>Tour<\/gml:name><bldg:measuredHeight uom="m">5\.000</.test(gml),
           'CityGML : deux parties nommées, chacune à sa hauteur');
  verifier(/srsName="urn:ogc:def:crs,crs:EPSG::2154,crs:EPSG::5720"/.test(gml)
           && /<gml:lowerCorner>876709\.000 6314953\.000 /.test(gml)
           && /&amp; « tests »/.test(gml) && /<bldg:measuredHeight uom="m">8\.500<\/bldg:measuredHeight><bldg:storeysAboveGround>2</.test(gml),
           'CityGML : système, enveloppe absolue, texte échappé, hauteur et étages en attributs CityGML');
  if (process.argv[3]) {
    fs.writeFileSync(process.argv[3], gml);
    console.log(`écrit : ${process.argv[3]} (${gml.length} octets)`);
  }
}

console.log(echecs ? `${echecs} contrôle(s) manqué(s)` : 'tous les contrôles passent');
process.exit(echecs ? 1 : 0);
