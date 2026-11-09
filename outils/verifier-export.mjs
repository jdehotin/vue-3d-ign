// Vérifie les exports IFC et CityGML de la page en exécutant son vrai code :
// les fonctions sont extraites de vue3d/static/index.html et appelées sous
// Node, comme dans outils/verifier-geometrie.mjs.
//
//   npm install three@0.160.0          # ignoré par git, comme puppeteer-core
//   node outils/verifier-export.mjs [essai.ifc [essai.gml]]
//
// Les contrôles :
// - projections (coniqueConforme, versLambert93, versUtm, versMercator) : les
//   sept systèmes proposés à l'export — Lambert-93, CC42, CC50, UTM 30 à 32,
//   Web Mercator — au dixième de millimètre des coordonnées de pyproj, sur les
//   points de tests/test_nuage.py et sur Brest et Gordes, loin de leur
//   méridien ; les neuf CC placent la France dans leur fuseau ;
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
//   définie, chaque GlobalId unique, un objet géographique par genre (route,
//   cours d'eau, pylône, ligne) sous son type d'objet. Écrit dans le premier
//   fichier donné en argument, il se valide ensuite avec ifcopenshell
//   (outils/valider_ifc.py) ;
// - tube des conducteurs (tubeCable) : quatre pans par segment, ouvert aux deux
//   bouts, 20 cm de rayon, un segment nul ignoré et un segment vertical sans
//   coordonnée non finie ;
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
// - orthophoto exportée (planOrtho, reechantillonnerOrtho, fichierJgw,
//   wktProjection, archiveZip) : l'inverse des projections, le maillage
//   source → sortie à moins de 0,01 px de l'inverse exact, un dégradé de
//   position retrouvé après rééchantillonnage, le world file qui replace le
//   pixel (0, 0) au bon point, la projection .prj relue par pyproj (pip
//   install pyproj, hors requirements) et l'archive zip relue par zipfile ;
//
// Sort en erreur si un contrôle est manqué, après les avoir tous faits.
import * as THREE from 'three';
import fs from 'fs';
import { fileURLToPath } from 'url';

const page = fileURLToPath(new URL('../vue3d/static/index.html', import.meta.url));
const src = fs.readFileSync(page, 'utf8');
function extraire(nom) {
  const i = src.indexOf(`function ${nom}(`);
  if (i < 0) throw new Error('introuvable dans la page : ' + nom);
  let n = 0;
  for (let j = src.indexOf('{', src.indexOf(')', i)); j < src.length; j++) {
    if (src[j] === '{') n++;
    else if (src[j] === '}' && --n === 0) return (src.slice(i - 6, i) === 'async ' ? 'async ' : '') + src.slice(i, j + 1);
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
const NOMS = ['etendre', 'coniqueConforme', 'versLambert93', 'versUtm', 'versMercator',
              'hachage128', 'guidIfc', 'idGml', 'chaineIfc', 'angleIfc', 'facettesIfc',
              'trianglesRelief', 'trianglesTronc', 'tubeCable', 'ecrireIfc', 'alea', 'portDe', 'portMesure',
              'aUnTronc', 'gabaritTronc', 'gabaritHouppier', 'ajouterHouppierSimple', 'polygonesPlans',
              'contoursRegion', 'solsOuverts', 'ecrireCityGml', 'inverseProjection', 'planOrtho',
              'reechantillonnerOrtho', 'fichierJgw', 'wktProjection', 'crc32', 'archiveZip', 'compresserDeflate'];
const CONSTS = ['GRS80', 'WGS84', 'PROJECTIONS', 'ALPHABET_IFC', 'ENTITES_IFC', 'reelIfc', 'STYLES_IFC', 'PORTS', 'EMPRISE_HOUPPIER', 'ENFONCEMENT',
                'HAUTEUR_MIN_TRONC', 'SEGMENTS_SIMPLE', 'PLAN_COS', 'PLAN_ECART_M', 'texteXml', 'ESPACES_CITYGML', 'ORTHO_NOEUDS', 'TABLE_CRC32'];
const { etendre, versLambert93, PROJECTIONS, guidIfc, idGml, chaineIfc, angleIfc, facettesIfc, trianglesRelief, trianglesTronc,
        tubeCable, ecrireIfc, aUnTronc, portDe, ajouterHouppierSimple, polygonesPlans, solsOuverts, ecrireCityGml,
        ALPHABET_IFC, STYLES_IFC, ENFONCEMENT, inverseProjection, planOrtho, reechantillonnerOrtho,
        fichierJgw, wktProjection, crc32, archiveZip, compresserDeflate } =
  new Function('THREE', CONSTS.map(extraireConst).join('\n') + '\n' + NOMS.map(extraire).join('\n')
    + `\nreturn { ${[...NOMS, ...CONSTS].join(', ')} };`)(THREE);

let echecs = 0;
const verifier = (ok, message) => {
  if (!ok) echecs++;
  console.log(`${ok ? 'ok  ' : 'ÉCHEC'} ${message}`);
};

// Repère d'écriture des essais : les fonctions de maillage reçoivent un
// `versIfc`, comme dans la page, et celui-ci laisse les coordonnées en place.
const IFC = (x, y, z) => [x, y, z];

// --- Projections ---------------------------------------------------------------
// (lieu, lon, lat, x, y) : pyproj 3.8 (EPSG:4326 -> EPSG, toujours_xy). Les six
// premiers points sont ceux de tests/test_nuage.py ; les suivants couvrent la
// France d'ouest en est, et les zones UTM qu'on peut demander à l'export.
const REFERENCES = {
  2154: [
    ['tour Eiffel', 2.2945, 48.85826, 648237.1625, 6862256.1148],
    ['Gordes', 5.2003, 43.9116, 876728.5214, 6314973.0065],
    ['Brest', -4.486, 48.39, 146636.1395, 6836217.3647],
    ['Ajaccio', 8.7386, 41.9192, 1176667.5614, 6108273.2834],
    ['Dunkerque', 2.3768, 51.0343, 656187.4293, 7104461.7744],
    ['Strasbourg', 7.751, 48.5819, 1050224.8723, 6841837.9889],
  ],
  3942: [
    ['tour Eiffel', 2.2945, 48.85826, 1647849.5958, 1964250.5535],
    ['Gordes', 5.2003, 43.9116, 1876803.8599, 1414656.3837],
    ['Brest', -4.486, 48.39, 1142757.0138, 1935981.2922],
    ['Ajaccio', 8.7386, 41.9192, 2175651.9620, 1206971.2585],
    ['Dunkerque', 2.3768, 51.0343, 1655712.4598, 2208677.4780],
    ['Strasbourg', 7.751, 48.5819, 2052733.0759, 1942874.3285],
  ],
  3950: [
    ['tour Eiffel', 2.2945, 48.85826, 1648225.9611, 9073264.5812],
    ['Gordes', 5.2003, 43.9116, 1877659.7964, 8524587.8857],
    ['Brest', -4.486, 48.39, 1146334.5521, 9048669.7014],
    ['Ajaccio', 8.7386, 41.9192, 2180056.2600, 8317448.9330],
    ['Dunkerque', 2.3768, 51.0343, 1656282.1825, 9315233.0471],
    ['Strasbourg', 7.751, 48.5819, 2050380.2852, 9053415.2551],
  ],
  // Les trois zones UTM de la France métropolitaine. Brest est à 13° du
  // méridien de la 32, Gordes à 8° de celui de la 30 : les cas qui écartent
  // une série ordinaire.
  32630: [
    ['tour Eiffel', 2.2945, 48.85826, 888276.4969, 5425227.5084],
    ['Brest', -4.486, 48.39, 389990.5690, 5360715.3241],
    ['Gordes', 5.2003, 43.9116, 1158509.7530, 4894851.8649],
  ],
  32631: [
    ['tour Eiffel', 2.2945, 48.85826, 448251.8571, 5411939.3474],
    ['Gordes', 5.2003, 43.9116, 676670.5244, 4864407.8339],
    ['Brest', -4.486, 48.39, -54011.7425, 5386781.9050],
    ['Ajaccio', 8.7386, 41.9192, 975943.8924, 4656756.9636],
    ['Dunkerque', 2.3768, 51.0343, 456302.7353, 5653823.9669],
    ['Strasbourg', 7.751, 48.5819, 850349.4299, 5391883.8268],
  ],
  32632: [
    ['tour Eiffel', 2.2945, 48.85826, 8304.4045, 5433413.8486],
    ['Gordes', 5.2003, 43.9116, 194901.7299, 4869076.1756],
    ['Brest', -4.486, 48.39, -497230.9862, 5448170.3024],
    ['Ajaccio', 8.7386, 41.9192, 478324.1004, 4640838.1908],
    ['Dunkerque', 2.3768, 51.0343, 35812.8217, 5674541.3783],
    ['Strasbourg', 7.751, 48.5819, 407883.6866, 5381732.2621],
  ],
  3857: [
    ['tour Eiffel', 2.2945, 48.85826, 255422.5716, 6250845.2137],
    ['Gordes', 5.2003, 43.9116, 578894.7480, 5451772.2554],
    ['Brest', -4.486, 48.39, -499379.2357, 6171983.9321],
    ['Ajaccio', 8.7386, 41.9192, 972776.5022, 5148883.6697],
    ['Dunkerque', 2.3768, 51.0343, 264584.1657, 6627363.2397],
    ['Strasbourg', 7.751, 48.5819, 862837.3731, 6204214.0572],
  ],
};
verifier(PROJECTIONS.length === 14, `${PROJECTIONS.length} projections proposées à l'export`);
let pire = 0;
for (const [epsg, points] of Object.entries(REFERENCES)) {
  const projection = PROJECTIONS.find(p => p.epsg === Number(epsg));
  if (!projection) { verifier(false, `projection ${epsg} absente de PROJECTIONS`); continue; }
  for (const [lieu, lon, lat, x, y] of points) {
    const [X, Y] = projection.vers(lon, lat);
    pire = Math.max(pire, Math.hypot(X - x, Y - y));
  }
}
verifier(pire < 1e-3, `projections (${Object.keys(REFERENCES).length} systèmes, `
  + `${Object.values(REFERENCES).flat().length} points) : ${(pire * 1000).toFixed(3)} mm de pyproj`);
// Les sept zones CC intermédiaires n'ont pas de référence ici : elles doivent
// au moins poser la France dans leur fuseau, x entre 1,1 et 2,2 millions.
const cc = PROJECTIONS.filter(p => p.epsg >= 3942 && p.epsg <= 3950);
verifier(cc.length === 9 && cc.every(p => {
  const [X, Y] = p.vers(2.2945, 48.85826);
  return X > 1.1e6 && X < 2.2e6 && Y > 0.8e6 && Y < 9.4e6;
}), `CC42 à CC50 : ${cc.length} zones, la France dans chacune`);
verifier(versLambert93(2.2945, 48.85826).every(Number.isFinite),
         'Lambert-93 reste la projection par défaut');
// Le tube d'un conducteur HT fait 62 208 valeurs d'un coup — `push(...)` y
// dépasse la pile, ce qui perdait l'export d'une scène avec lignes HT.
const tube = Array.from({ length: 62208 }, (_, i) => i);
const ajoute = [];
etendre(ajoute, tube);
verifier(ajoute.length === tube.length && ajoute[0] === 0 && ajoute[62207] === 62207,
         'etendre : 62 208 valeurs ajoutées sans dépasser la pile');

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

// --- Câbles haute tension ------------------------------------------------------------
{
  // Une portée horizontale de 10 m, trois phases à ±5 m de la traverse : chacune
  // un tube de 20 cm, la même suite de couples de points que les LineSegments
  // de la page.
  const portee = (y, z) => [0, y, z, 10, y, z];
  const f = facettesIfc(tubeCable([...portee(30, -5), ...portee(30, 0), ...portee(30, 5)], 0.2, IFC));
  const ecart = k => Math.max(...Array.from({ length: f.points.length / 3 }, (_, i) => Math.abs(f.points[3 * i + k])));
  verifier(f.points.length === 72 && f.faces.length === 72 && !f.ferme,
           `tube de câble : ${f.points.length / 3} sommets, ${f.faces.length / 3} triangles, ouvert aux deux bouts`);
  verifier(ecart(0) === 10 && Math.abs(ecart(1) - 30.2) < 1e-6 && Math.abs(ecart(2) - 5.2) < 1e-6,
           `tube de câble : 10 m de long, 20 cm de rayon, trois phases à ±5 m`);
  // Un segment nul ne donne rien, un segment vertical sort des coordonnées
  // finies (le repère du pan ne s'y déduit pas de l'horizontale).
  verifier(!facettesIfc(tubeCable([1, 2, 3, 1, 2, 3], 0.2, IFC)).faces.length, 'tube de câble : segment nul ignoré');
  const vertical = tubeCable([0, 0, 0, 0, 10, 0], 0.2, IFC);
  verifier(vertical.length === 72 && vertical.every(Number.isFinite), 'tube de câble vertical : coordonnées finies');
  // Le tube sort dans le repère qu'on lui passe, comme les autres maillages :
  // sans `versIfc`, le sud de la scène partait à l'altitude et le câble
  // traversait le modèle à 7 km — l'IFC semblait vide dans un lecteur.
  const transpose = tubeCable([0, 0, 0, 0, 10, 0], 0.2, (x, y, z) => [x + 1000, z - 7, y]);
  verifier(transpose.length === 72
           && transpose.filter((_, i) => i % 3 === 0).every(v => Math.abs(v - 1000) < 0.21)
           && transpose.filter((_, i) => i % 3 === 1).every(v => Math.abs(v + 7) < 0.21),
           'tube de câble : le repère d’écriture est appliqué (le sud ne part pas en altitude)');
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
  // Le fût d'un pylône, tel que la scène le pose : un volume fermé de
  // 2 × 35,2 × 2 m, tourné vers l'extérieur (la page y met un cylindre de
  // quatre pans et sa traverse).
  const pavePylone = (() => {
    const anneau = h => [[0, 0], [2, 0], [2, 2], [0, 2]].map(([x, z]) => [x, h, z]);
    const [bas, haut] = [anneau(0), anneau(35.2)];
    const tri = [], face = q => tri.push(...q[0], ...q[1], ...q[2], ...q[0], ...q[2], ...q[3]);
    face([bas[0], bas[1], bas[2], bas[3]]);                     // dessous, vers la terre
    face([haut[3], haut[2], haut[1], haut[0]]);                 // dessus, vers le ciel
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      face([bas[i], haut[i], haut[j], bas[j]]);
    }
    return facettesIfc(tri);
  })();
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
    crs: { nom: 'EPSG:2154', epsg: 2154, description: 'RGF93 v1 / Lambert-93', datum: 'RGF93 v1',
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
      // Un tronçon de route, une étendue d'eau, un pylône et une ligne à haute
      // tension : les rubans et tubes de la page, dans le repère IFC.
      { cle: 'route|ESSAI', genre: 'route', nom: 'Route à 1 chaussée', tag: 'ESSAI',
        description: '4 m de large (BD TOPO), R DE BENFELD',
        proprietes: { nom: 'VueIGN_Route', valeurs: [['IdentifiantBDTOPO', 'IFCIDENTIFIER', 'ESSAI'],
                                                     ['Nature', 'IFCLABEL', 'Route à 1 chaussée'],
                                                     ['Largeur', 'IFCLENGTHMEASURE', 4],
                                                     ['SourceLargeur', 'IFCLABEL', 'BD TOPO']] },
        maillages: [{ style: 'route', facettes: facettesIfc([-6, 0, -2, -2, 0, -2, -2, 0, 2,
                                                            -6, 0, -2, -2, 0, 2, -6, 0, 2]) }] },
      { cle: 'cours_d_eau|Canal', genre: 'cours_d_eau', nom: 'Canal',
        description: 'Canal (BD TOPO, permanent), 2.5 m de large (convention)',
        proprietes: { nom: 'VueIGN_CoursDEau', valeurs: [['Nature', 'IFCLABEL', 'Canal'],
                                                         ['Largeur', 'IFCLENGTHMEASURE', 2.5],
                                                         ['SourceLargeur', 'IFCLABEL', 'convention']] },
        maillages: [{ style: 'eau', facettes: facettesIfc([4, 0.15, -4, 8, 0.15, -4, 8, 0.15, 4,
                                                          4, 0.15, -4, 8, 0.15, 4, 4, 0.15, 4]) }] },
      { cle: 'pylone|225 kV', genre: 'pylone', nom: 'Pylône 225 kV',
        description: '35,2 m de haut (BD TOPO)',
        proprietes: { nom: 'VueIGN_Pylone', valeurs: [['Tension', 'IFCLABEL', '225 kV'],
                                                      ['Hauteur', 'IFCLENGTHMEASURE', 35.2]] },
        // Le fût et sa traverse, lus dans la scène : ici le pavé fermé ci-dessus.
        maillages: [{ style: 'pylone', facettes: pavePylone }] },
      { cle: 'ligne_ht|225 kV', genre: 'ligne_ht', nom: 'Ligne 225 kV',
        description: 'Trois phases sur 4 support(s), flèche de 3 % de la portée (convention)',
        proprietes: { nom: 'VueIGN_LigneHT', valeurs: [['Tension', 'IFCLABEL', '225 kV'],
                                                       ['NombreDeSupports', 'IFCINTEGER', 4]] },
        maillages: [{ style: 'cable', facettes: facettesIfc(tubeCable([-20, 30, -5, 20, 28, -5], 0.2, IFC)) }] },
      // Les ouvrages BD TOPO : un mur et un pont, volumes fermés, un terrain de
      // sport drapé, les voies ferrées en ballast et files de rail.
      { cle: 'mur|Mur', genre: 'mur', nom: 'Mur',
        description: 'Mur, haut de 2.0 m (BD TOPO)',
        proprietes: { nom: 'VueIGN_Mur', valeurs: [['Nature', 'IFCLABEL', 'Mur'],
                                                   ['Hauteur', 'IFCLENGTHMEASURE', 2],
                                                   ['SourceEpaisseur', 'IFCLABEL', 'convention']] },
        maillages: [{ style: 'mur', facettes: pavePylone }] },
      { cle: 'pont|Pont', genre: 'pont', nom: 'Pont',
        description: "Pont, tablier jusqu'à 6.0 m (BD TOPO), piles et arches non décrites",
        proprietes: { nom: 'VueIGN_Pont', valeurs: [['Nature', 'IFCLABEL', 'Pont'],
                                                    ['HauteurTablier', 'IFCLENGTHMEASURE', 6]] },
        maillages: [{ style: 'pont', facettes: pavePylone }] },
      { cle: 'terrain_sport|Terrain de tennis', genre: 'terrain_sport', nom: 'Terrain de tennis',
        description: 'Terrain de tennis (BD TOPO)',
        proprietes: { nom: 'VueIGN_TerrainSport', valeurs: [['Nature', 'IFCLABEL', 'Terrain de tennis']] },
        maillages: [{ style: 'tennis', facettes: facettesIfc([0, 0.1, 6, 4, 0.1, 6, 4, 0.1, 10,
                                                            0, 0.1, 6, 4, 0.1, 10, 0, 0.1, 10]) }] },
      { cle: 'voie_ferree|scene', genre: 'voie_ferree', nom: 'Voies ferrées',
        description: 'Ballast et files de rail de 1 tronçon(s) (BD TOPO)',
        proprietes: { nom: 'VueIGN_VoieFerree', valeurs: [['NombreDeTroncons', 'IFCINTEGER', 1]] },
        maillages: [{ style: 'ballast', facettes: facettesIfc([-6, 0.1, 6, -2, 0.1, 6, -2, 0.1, 10,
                                                              -6, 0.1, 6, -2, 0.1, 10, -6, 0.1, 10]) },
                    { style: 'rail', facettes: facettesIfc([-5, 0.15, 6, -4.9, 0.15, 6, -4.9, 0.15, 10,
                                                           -5, 0.15, 6, -4.9, 0.15, 10, -5, 0.15, 10]) }] },
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
  verifier(guids.length === 43 && new Set(guids).size === guids.length, `IFC : ${guids.length} GlobalId, tous distincts`);
  verifier(!/Vide/.test(texte), 'IFC : un élément sans triangle est omis');
  verifier(texte.startsWith('ISO-10303-21;\nHEADER;') && texte.endsWith('END-ISO-10303-21;\n'), 'IFC : en-tête et fin ISO 10303-21');
  verifier(/IFCTRIANGULATEDFACESET\(#\d+,\$,\.T\./.test(texte) && /IFCTRIANGULATEDFACESET\(#\d+,\$,\.F\./.test(texte),
           'IFC : murs fermés, toit et terrain ouverts');
  verifier(/IFCGEOGRAPHICELEMENT\('[^']+',\$,'Arbre',\$,'Arbre',.*\.USERDEFINED\.\)/.test(texte)
           && /IFCGEOGRAPHICELEMENT\([^;]*\.TERRAIN\.\)/.test(texte), 'IFC : arbre et terrain en éléments géographiques');
  for (const type of ['Tronçon de route', "Cours d'eau", 'Pylône électrique', 'Ligne à haute tension',
                      'Mur', 'Pont', 'Voie ferrée', 'Terrain de sport']) {
    // Le type d'objet, échappé comme l'écrit le fichier (accents à part).
    verifier(texte.includes(`,${chaineIfc(type)},#`), `IFC : « ${type} » en élément géographique`);
  }
  verifier(['route', 'chemin', 'eau', 'eauIntermittente', 'pylone', 'cable',
    'mur', 'pont', 'ballast', 'rail', 'tennis', 'terrainSport', 'petitTerrain', 'pisteSport', 'bassin']
    .every(s => (STYLES_IFC[s] || []).length === 3), 'IFC : chaque style des réseaux a sa teinte');
  // Le CRS écrit est celui du modèle : une autre projection se lit dans
  // IFCPROJECTEDCRS et dans l'IFCMAPCONVERSION, sans altitude NGF déclarée
  // (EPSG:5720 est un composé RGF93, pas WGS 84).
  const utm = { ...modele, crs: { nom: 'EPSG:32631', epsg: 32631, description: 'WGS 84 / UTM 31N',
                                  datum: 'WGS 84', datumVertical: null, epsgVertical: null,
                                  projection: 'Transverse Mercator' } };
  const texteUtm = ecrireIfc(utm);
  verifier(/IFCPROJECTEDCRS\('EPSG:32631','WGS 84 \/ UTM 31N','WGS 84',\$,'Transverse Mercator',\$,#\d+\)/.test(texteUtm)
           && /IFCMAPCONVERSION\(#\d+,#\d+,876729\.000,6314973\.000,312\.000,1\.,0\.,\$\)/.test(texteUtm),
           'IFC : autre projection déclarée (EPSG:32631) et conversion depuis son origine');
  // L'ancrage : en origine locale, le site reste à zéro et porte les
  // coordonnées par l'IfcMapConversion seule ; en absolu, il est posé à ses
  // coordonnées et la conversion part de zéro. Le décalage n'est jamais porté
  // deux fois — c'est ce que vérifie aussi outils/valider_ifc.py.
  verifier(!/IFCCARTESIANPOINT\(\(876729/.test(texte),
           'IFC : ancrage local — le site reste à l’origine, aucune coordonnée absolue dans le fichier');
  const texteSite = ecrireIfc({ ...modele, ancrage: 'site' });
  verifier(texteSite.includes('IFCCARTESIANPOINT((876729.000,6314973.000,312.000))')
           && /IFCLOCALPLACEMENT\(\$,#\d+\)/.test(texteSite)
           && /IFCMAPCONVERSION\(#\d+,#\d+,0\.000,0\.000,0\.000,1\.,0\.,\$\)/.test(texteSite)
           && /IFCSITE\([^;]*,#\d+,\$,\$,\.ELEMENT\.,\(43,54,41,760000\),\(5,12,1,80000\),312\.000,\$,\$\)/.test(texteSite),
           'IFC : ancrage absolu — site posé à ses coordonnées, conversion à zéro, réf. géographique inchangée');
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
           && compte('gen:GenericCityObject') === 9 && compte('gml:Triangle') === 32,
           `CityGML : 2 bâtiments (${compte('bldg:RoofSurface')} toits, ${compte('bldg:WallSurface')} murs dont 2 pignons, `
           + `${compte('bldg:GroundSurface')} sols, dessus des murs omis sous un toit), 1 arbre, `
           + `${compte('gen:GenericCityObject')} objets génériques (masse, route, cours d'eau, pylône, ligne, mur, pont, terrain, voies), `
           + `${compte('gml:Triangle')} triangles de relief`);
  verifier(compte('bldg:BuildingPart') === 2 && /<bldg:BuildingPart gml:id="PARTIES_p1"><gml:name>Nef<\/gml:name><bldg:measuredHeight uom="m">3\.000</.test(gml)
           && /<bldg:BuildingPart gml:id="PARTIES_p2"><gml:name>Tour<\/gml:name><bldg:measuredHeight uom="m">5\.000</.test(gml),
           'CityGML : deux parties nommées, chacune à sa hauteur');
  verifier(/srsName="urn:ogc:def:crs,crs:EPSG::2154,crs:EPSG::5720"/.test(gml)
           && /<gml:lowerCorner>876708\.990 6314953\.000 /.test(gml)
           && /&amp; « tests »/.test(gml) && /<bldg:measuredHeight uom="m">8\.500<\/bldg:measuredHeight><bldg:storeysAboveGround>2</.test(gml),
           'CityGML : système, enveloppe absolue, texte échappé, hauteur et étages en attributs CityGML');
  // Même choix de projection que l'IFC : le srsName suit, sans composé vertical
  // quand le CRS n'en a pas.
  const gmlUtm = ecrireCityGml(utm).join('');
  verifier(/srsName="urn:ogc:def:crs:EPSG::32631"/.test(gmlUtm)
           && !/crs:EPSG::5720/.test(gmlUtm),
           'CityGML : autre projection déclarée (EPSG:32631), pas d’altitude NGF composée');
  // Le relief texturé : chaque triangle porte un anneau identifié, désigné par
  // une liste (s, t) de quatre paires, et `app:target` désigne la surface.
  verifier(!/app:Appearance|app:textureCoordinates/.test(gml) && !/<gml:TriangulatedSurface gml:id/.test(gml),
           'CityGML : sans texture demandée, ni Appearance ni identifiant de surface');
  const tex = { image: 'essai.jpg', minX: 876729 - 20, minY: 6314973 - 20, largeurM: 40, hauteurM: 40 };
  const gmlTex = ecrireCityGml({ ...modele, texture: tex }).join('');
  const surface = (gmlTex.match(/<gml:TriangulatedSurface gml:id="([^"]+)"/) || [])[1];
  const anneauxTex = new Map([...gmlTex.matchAll(/<gml:LinearRing gml:id="([^"]+)"><gml:posList srsDimension="3">([^<]*)</g)]
    .map(([, rid, pos]) => [rid, pos.split(' ').map(Number)]));
  const listes = new Map([...gmlTex.matchAll(/<app:textureCoordinates ring="#([^"]+)">([^<]*)</g)]
    .map(([, rid, st]) => [rid, st.split(' ').map(Number)]));
  let pireTex = 0, completes = listes.size === 32 && anneauxTex.size === 32;
  for (const [rid, st] of listes) {
    const pos = anneauxTex.get(rid);
    if (!pos || st.length !== 8) { completes = false; continue; }
    for (let k = 0; k < 4; k++) {
      const s = (pos[3 * k] - tex.minX) / tex.largeurM, t = (pos[3 * k + 1] - tex.minY) / tex.hauteurM;
      pireTex = Math.max(pireTex, Math.abs(st[2 * k] - s), Math.abs(st[2 * k + 1] - t));
    }
  }
  verifier(completes && pireTex < 1e-6, `CityGML texturé : 32 anneaux, chacun avec ses 4 paires (s, t), à ${pireTex.toExponential(1)} de la position`);
  verifier(surface && gmlTex.includes(`<app:target uri="#${surface}">`) && gmlTex.includes('<app:imageURI>essai.jpg</app:imageURI>')
           && gmlTex.includes('<app:mimeType>image/jpeg</app:mimeType>') && /xmlns:app="http:\/\/www\.opengis\.net\/citygml\/appearance\/2\.0"/.test(gmlTex)
           && gmlTex.lastIndexOf('</core:cityObjectMember>') < gmlTex.indexOf('<app:appearanceMember>'),
           'CityGML texturé : la cible est la surface, image et type MIME déclarés, apparence après les objets');
  const idsTex = [...gmlTex.matchAll(/gml:id="([^"]+)"/g)].map(m => m[1]);
  const pilesTex = []; let okTex = true;
  for (const [, fin, nom, , vide] of gmlTex.matchAll(/<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|[^>"])*?)(\/?)>/g)) {
    if (vide) continue;
    if (!fin) pilesTex.push(nom); else if (pilesTex.pop() !== nom) { okTex = false; break; }
  }
  verifier(okTex && !pilesTex.length && new Set(idsTex).size === idsTex.length,
           `CityGML texturé : balises équilibrées, ${idsTex.length} gml:id distincts`);
  // Le CityGML texturé du modèle d'essai, à valider avec les schémas comme le
  // précédent (troisième fichier donné).
  if (process.argv[4]) fs.writeFileSync(process.argv[4], gmlTex);
  // Une coordonnée hors de l'image (le plan d'orthophoto un peu plus petit que le relief) est ramenée au bord.
  const gmlBord = ecrireCityGml({ ...modele, texture: { ...tex, minX: tex.minX + 15, largeurM: 10 } }).join('');
  const hors = [...gmlBord.matchAll(/<app:textureCoordinates ring="[^"]*">([^<]*)</g)].flatMap(m => m[1].split(' ').map(Number));
  verifier(hors.length > 0 && hors.every(v => v >= 0 && v <= 1), 'CityGML texturé : (s, t) bornées à [0, 1] hors de l’image');
  if (process.argv[3]) {
    fs.writeFileSync(process.argv[3], gml);
    console.log(`écrit : ${process.argv[3]} (${gml.length} octets)`);
  }
}

// --- Orthophoto exportée ------------------------------------------------------------------
{
  const { spawnSync } = await import('child_process');
  const os = await import('os');
  const path = await import('path');
  // 1) L'inverse des projections, depuis un départ à 0,01° du but.
  let pireInverse = 0;
  for (const proj of PROJECTIONS) {
    for (const [lon, lat] of [[5.2003, 43.9116], [-4.486, 48.39], [2.2945, 48.85826]]) {
      const [x, y] = proj.vers(lon, lat);
      const [lo, la] = inverseProjection(proj.vers, x, y, lon + 0.01, lat - 0.01);
      pireInverse = Math.max(pireInverse, Math.abs(lo - lon), Math.abs(la - lat));
    }
  }
  verifier(pireInverse < 1e-9, `orthophoto : inverse des ${PROJECTIONS.length} projections à ${pireInverse.toExponential(1)}° (< 1e-9)`);

  // 2) Le maillage et le world file : le pixel (px, py) est ramené par le world
  // file en (x, y), par l'inverse exact en (lon, lat), puis dans la source ;
  // le maillage interpolé doit y tomber à moins de 0,01 px.
  for (const [lieu, lon0, lat0, cote, epsg] of [['Gordes', 5.2003, 43.9116, 1000, 2154],
                                                 ['Brest', -4.486, 48.39, 5000, 2154],
                                                 ['Gordes', 5.2003, 43.9116, 1000, 3943],
                                                 ['Brest', -4.486, 48.39, 5000, 32630]]) {
    const proj = PROJECTIONS.find(p => p.epsg === epsg);
    const dLat = cote / 111320, dLon = cote / (111320 * Math.cos(lat0 * Math.PI / 180));
    const bbox = [lon0 - dLon / 2, lat0 - dLat / 2, lon0 + dLon / 2, lat0 + dLat / 2];
    const sl = 2048, sh = 2048;
    const plan = planOrtho(bbox, proj.vers, sl, sh);
    const jgw = fichierJgw(plan).trim().split('\n').map(Number);
    let pire = 0;
    for (const [px, py] of [[0, 0], [plan.largeur - 1, 0], [0, plan.hauteur - 1], [plan.largeur - 1, plan.hauteur - 1],
                            [700, 311], [1234, 1500], [17, 903]]) {
      const x = jgw[4] + px * jgw[0], y = jgw[5] + py * jgw[3];
      const [lo, la] = inverseProjection(proj.vers, x, y, lon0, lat0);
      const su = (lo - bbox[0]) / (bbox[2] - bbox[0]) * sl, sv = (bbox[3] - la) / (bbox[3] - bbox[1]) * sh;
      const n = plan.n, N1 = n + 1;
      const gx = (px + 0.5) / plan.largeur * n, gy = (py + 0.5) / plan.hauteur * n;
      const i = Math.min(Math.floor(gx), n - 1), j = Math.min(Math.floor(gy), n - 1), fx = gx - i, fy = gy - j, k = j * N1 + i;
      const bil = t => (t[k] * (1 - fx) + t[k + 1] * fx) * (1 - fy) + (t[k + N1] * (1 - fx) + t[k + N1 + 1] * fx) * fy;
      pire = Math.max(pire, Math.hypot(bil(plan.u) - su, bil(plan.v) - sv));
    }
    verifier(pire < 0.01, `orthophoto ${lieu} ${cote} m EPSG:${epsg} : maillage à ${pire.toFixed(4)} px de l'inverse exact (< 0,01)`);
    verifier(plan.largeur === sl && jgw[0] > 0 && jgw[3] < 0 && jgw[1] === 0 && jgw[2] === 0,
             `orthophoto ${lieu} EPSG:${epsg} : ${plan.largeur} × ${plan.hauteur} px à ${jgw[0].toFixed(4)} m, world file sans rotation`);
  }

  // 3) Le rééchantillonnage : une source dont le rouge suit la colonne et le
  // vert la ligne ; la sortie doit les restituer à la position calculée par
  // l'inverse exact.
  {
    const proj = PROJECTIONS[0], [lon0, lat0] = [5.2003, 43.9116];
    const dLat = 1000 / 111320, dLon = 1000 / (111320 * Math.cos(lat0 * Math.PI / 180));
    const bbox = [lon0 - dLon / 2, lat0 - dLat / 2, lon0 + dLon / 2, lat0 + dLat / 2];
    const sl = 512, sh = 512;
    const src = new Uint8ClampedArray(sl * sh * 4);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sl; x++) {
      const o = (y * sl + x) * 4;
      src[o] = x * 255 / (sl - 1); src[o + 1] = y * 255 / (sh - 1); src[o + 2] = 100; src[o + 3] = 255;
    }
    const plan = planOrtho(bbox, proj.vers, sl, sh);
    const sortie = reechantillonnerOrtho(src, sl, sh, plan);
    const jgw = fichierJgw(plan).trim().split('\n').map(Number);
    let pire = 0, opaque = true;
    for (const [px, py] of [[3, 3], [256, 256], [500, 20], [30, 480], [511, plan.hauteur - 1]]) {
      const x = jgw[4] + px * jgw[0], y = jgw[5] + py * jgw[3];
      const [lo, la] = inverseProjection(proj.vers, x, y, lon0, lat0);
      const su = (lo - bbox[0]) / (bbox[2] - bbox[0]) * sl - 0.5, sv = (bbox[3] - la) / (bbox[3] - bbox[1]) * sh - 0.5;
      const o = (py * plan.largeur + px) * 4;
      pire = Math.max(pire, Math.abs(sortie[o] - Math.min(Math.max(su, 0), sl - 1) * 255 / (sl - 1)),
                      Math.abs(sortie[o + 1] - Math.min(Math.max(sv, 0), sh - 1) * 255 / (sh - 1)));
      opaque = opaque && sortie[o + 3] === 255 && sortie[o + 2] === 100;
    }
    verifier(pire <= 1.01 && opaque, `orthophoto : un dégradé de position est restitué à ${pire.toFixed(2)}/255, opaque`);
  }

  // 4) Le .prj relu par pyproj : chaque projection placée par le WKT doit
  // redonner la longitude et la latitude de nos formules, à 1e-8°.
  const cas = PROJECTIONS.map(proj => {
    const [x, y] = proj.vers(5.2003, 43.9116);
    return { epsg: proj.epsg, wkt: wktProjection(proj), x, y, lon: 5.2003, lat: 43.9116 };
  });
  const py = spawnSync('python', ['-I', '-c', [
    'import json, sys',
    'from pyproj import CRS, Transformer',
    'sortie = []',
    'for c in json.load(sys.stdin):',
    '    crs = CRS.from_wkt(c["wkt"])',
    '    lon, lat = Transformer.from_crs(crs, "EPSG:4326", always_xy=True).transform(c["x"], c["y"])',
    '    sortie.append([c["epsg"], crs.to_epsg(), max(abs(lon - c["lon"]), abs(lat - c["lat"]))])',
    'print(json.dumps(sortie))'].join('\n')], { input: JSON.stringify(cas), encoding: 'utf8' });
  if (py.status !== 0) {
    console.log('ignoré : pyproj indisponible (pip install pyproj) —', (py.stderr || '').split('\n').filter(Boolean).pop());
  } else {
    const lu = JSON.parse(py.stdout);
    const mauvais = lu.filter(([epsg, code, ecart]) => code !== epsg || ecart > 1e-8);
    verifier(!mauvais.length, `orthophoto : .prj des ${lu.length} projections relus par pyproj, EPSG retrouvé, position à 1e-8°`
             + (mauvais.length ? ' — ' + JSON.stringify(mauvais) : ''));
  }

  // 5) L'archive zip, relue par zipfile : CRC, contenus, dates, noms UTF-8.
  const octets = new TextEncoder().encode('héllo\n'.repeat(1000));
  const date = new Date(2026, 9, 26, 12, 30, 10);
  const deflate = await compresserDeflate(octets);
  verifier(deflate && deflate.length < octets.length / 10, `zip : deflate brut, ${octets.length} octets en ${deflate && deflate.length}`);
  const zip = Buffer.concat(archiveZip([{ nom: 'a.jgw', octets, deflate }, { nom: 'é.txt', octets: new Uint8Array(0) },
                                        { nom: 'b.bin', octets: Uint8Array.from({ length: 70000 }, (_, i) => i * 7) }], date));
  verifier(crc32(new TextEncoder().encode('123456789')) === 0xCBF43926, 'zip : CRC-32 de « 123456789 » = CBF43926');
  const fichierZip = path.join(os.tmpdir(), 'verifier-ortho.zip');
  fs.writeFileSync(fichierZip, zip);
  const z = spawnSync('python', ['-I', '-c', [
    'import sys, zipfile',
    'z = zipfile.ZipFile(sys.argv[1])',
    'assert z.testzip() is None, z.testzip()',
    'sys.stdout.reconfigure(encoding="utf-8")',
    'print("|".join(z.namelist()), len(z.read("a.jgw")), len(z.read("\\u00e9.txt")), len(z.read("b.bin")), z.getinfo("a.jgw").date_time)'].join('\n'),
    fichierZip], { encoding: 'utf8' });
  if (z.status !== 0) {
    console.log('ignoré : Python indisponible —', (z.stderr || '').split('\n').filter(Boolean).pop());
  } else {
    verifier(z.stdout.trim() === 'a.jgw|é.txt|b.bin 7000 0 70000 (2026, 10, 26, 12, 30, 10)',
             `zip : relu par zipfile, 3 entrées, CRC et dates justes (${z.stdout.trim()})`);
  }
  fs.rmSync(fichierZip, { force: true });
}

console.log(echecs ? `${echecs} contrôle(s) manqué(s)` : 'tous les contrôles passent');
process.exit(echecs ? 1 : 0);
