// Vérifie l'export IFC de la page en exécutant son vrai code : les fonctions
// sont extraites de vue3d/static/index.html et appelées sous Node, comme dans
// outils/verifier-geometrie.mjs.
//
//   npm install three@0.160.0          # ignoré par git, comme puppeteer-core
//   node outils/verifier-export.mjs [essai.ifc]
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
// - fichier (ecrireIfc) d'un petit modèle : chaque référence #n est définie,
//   chaque GlobalId unique. Écrit dans le fichier donné en argument, il se
//   valide ensuite avec ifcopenshell (outils/valider_ifc.py).
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
const NOMS = ['versLambert93', 'guidIfc', 'chaineIfc', 'angleIfc', 'facettesIfc', 'trianglesRelief',
              'trianglesTronc', 'ecrireIfc', 'alea', 'portDe', 'portMesure', 'aUnTronc', 'gabaritTronc',
              'gabaritHouppier', 'ajouterHouppierSimple'];
const CONSTS = ['L93', 'ALPHABET_IFC', 'reelIfc', 'STYLES_IFC', 'PORTS', 'EMPRISE_HOUPPIER', 'ENFONCEMENT',
                'HAUTEUR_MIN_TRONC', 'SEGMENTS_SIMPLE'];
const { versLambert93, guidIfc, chaineIfc, angleIfc, facettesIfc, trianglesRelief, trianglesTronc,
        ecrireIfc, aUnTronc, portDe, ajouterHouppierSimple, ALPHABET_IFC, STYLES_IFC, ENFONCEMENT } =
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

// --- Fichier -----------------------------------------------------------------------
{
  const s = [[0, 0, 0], [8, 0, 0], [8, 5, 0], [0, 5, 0], [0, 0, 6], [8, 0, 6], [8, 5, 6], [0, 5, 6]];
  const quads = [[0, 3, 2, 1], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [4, 5, 6, 7]];
  const murs = facettesIfc(quads.flatMap(([a, b, c, d]) => [[a, b, c], [a, c, d]]).flatMap(t => t.flatMap(i => s[i])));
  const toit = facettesIfc([0, 0, 6, 8, 0, 6, 8, 2.5, 8.5, 0, 0, 6, 8, 2.5, 8.5, 0, 2.5, 8.5,
                            0, 5, 6, 0, 2.5, 8.5, 8, 2.5, 8.5, 0, 5, 6, 8, 2.5, 8.5, 8, 5, 6]);
  const terrain = facettesIfc(trianglesRelief(4, 4, (i, j) => [-20 + 10 * i, 20 - 10 * j, -0.3 + 0.05 * i], 1));
  const modele = {
    fichier: 'essai.ifc', horodatage: '2026-10-15T12:00:00', cle: 'essai',
    nom: 'Essai d\'export', description: 'Données IGN, Licence Ouverte 2.0.', site: 'Emprise de 50 m',
    lon: 5.2003, lat: 43.9116, origine: { x: 876729, y: 6314973, z: 312 },
    nordVrai: [-0.027868, 0.999612],
    crs: { nom: 'EPSG:2154', description: 'RGF93 v1 / Lambert-93, altitudes NGF-IGN69', datum: 'RGF93 v1',
           datumVertical: 'NGF-IGN69', projection: 'Lambert conique conforme' },
    styles: STYLES_IFC,
    elements: [
      { cle: 'batiment|ESSAI', entite: 'IFCBUILDINGELEMENTPROXY', type: 'USERDEFINED', objectType: 'Bâtiment existant',
        nom: 'Résidentiel', description: 'Hauteur LiDAR HD, toit deux pans résumés', tag: 'ESSAI',
        pset: { nom: 'VueIGN_Batiment', valeurs: [['IdentifiantBDTOPO', 'IFCIDENTIFIER', 'ESSAI'],
                                                  ['NombreEtages', 'IFCINTEGER', 2],
                                                  ['Hauteur', 'IFCLENGTHMEASURE', 8.5],
                                                  ['Usage', 'IFCLABEL', null]] },
        maillages: [{ style: 'murs', facettes: murs }, { style: 'toit', facettes: toit }] },
      { cle: 'vide', entite: 'IFCBUILDINGELEMENTPROXY', type: 'USERDEFINED', objectType: 'Bâtiment existant',
        nom: 'Vide', maillages: [{ style: 'murs', facettes: facettesIfc([]) }] },
      { cle: 'terrain', entite: 'IFCGEOGRAPHICELEMENT', type: 'TERRAIN', objectType: null, nom: 'Terrain naturel',
        pset: { nom: 'VueIGN_Terrain', valeurs: [['Source', 'IFCLABEL', 'RGE ALTI (IGN)']] },
        maillages: [{ style: 'terrain', facettes: terrain }] },
    ],
  };
  const texte = ecrireIfc(modele);
  const definis = new Set([...texte.matchAll(/^#(\d+)=/gm)].map(m => m[1]));
  const references = new Set([...texte.matchAll(/#(\d+)(?!\d|=)/g)].map(m => m[1]));
  const manquants = [...references].filter(r => !definis.has(r));
  verifier(!manquants.length, `fichier : ${definis.size} entités, toute référence définie${manquants.length ? ' — manquent ' + manquants.join(', ') : ''}`);
  const guids = [...texte.matchAll(/^#\d+=IFC\w+\('([0-9A-Za-z_$]{22})'/gm)].map(m => m[1]);
  verifier(guids.length === 10 && new Set(guids).size === guids.length, `fichier : ${guids.length} GlobalId, tous distincts`);
  verifier(!/Vide/.test(texte), 'fichier : un élément sans triangle est omis');
  verifier(texte.startsWith('ISO-10303-21;\nHEADER;') && texte.endsWith('END-ISO-10303-21;\n'), 'fichier : en-tête et fin ISO 10303-21');
  verifier(/IFCTRIANGULATEDFACESET\(#\d+,\$,\.T\./.test(texte) && /IFCTRIANGULATEDFACESET\(#\d+,\$,\.F\./.test(texte),
           'fichier : murs fermés, toit et terrain ouverts');
  if (process.argv[2]) {
    fs.writeFileSync(process.argv[2], texte);
    console.log(`écrit : ${process.argv[2]} (${texte.length} octets)`);
  }
}

console.log(echecs ? `${echecs} contrôle(s) manqué(s)` : 'tous les contrôles passent');
process.exit(echecs ? 1 : 0);
