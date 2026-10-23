// L'export IFC 4.

import { ENFONCEMENT } from '../terrain/etat.js';
import { gabaritTronc } from '../vegetation/formes.js';

// Le contexte d'un projet pour un logiciel de conception (Revit, ArchiCAD,
// Vectorworks, Allplan, Bonsai) : relief, bâtiments, arbres. Écrit dans la
// page, d'après ce qu'elle dessine : la géométrie des murs, des toits et des
// houppiers n'existe qu'ici, et un export côté serveur la réécrirait en
// Python, en double.
//
// IFC 4 (ADD2 TC1), vue de référence : des maillages triangulés
// (IfcTriangulatedFaceSet), que les logiciels importent tels quels. Les
// coordonnées sont en Lambert-93, rapportées à une origine entière au point
// visé (IfcMapConversion) : les logiciels de conception perdent en précision
// loin de leur origine, et Revit refuse la géométrie au-delà de 32 km. Les
// longueurs sont celles de la carte, sans facteur d'échelle : l'altération
// linéaire de Lambert-93 vaut +0,07 mm/m à Gordes, −0,95 vers 46,5° N, +2,2 à
// Dunkerque et Ajaccio. Des longueurs vraies demanderaient un facteur
// (Scale) que tous les logiciels ne lisent pas, et qui déplacerait chez eux
// les objets d'autant plus qu'ils sont loin du centre. Le nord vrai est donné
// (TrueNorth) : la convergence des méridiens vaut −1,6° à Gordes, +5,4° à
// Brest, et une étude d'ensoleillement en dépend.

// Lambert-93 (RGF93, ellipsoïde GRS80), constantes de l'IGN (ALG0019), comme
// vue3d/nuage.py : au millimètre de pyproj (outils/verifier-export.mjs).
const L93 = { e: 0.0818191910428158, n: 0.7256077650532670, c: 11754255.426096,
              xs: 700000, ys: 12655612.049876, lon0: 3 * Math.PI / 180 };

/** [x, y] Lambert-93 d'une longitude et d'une latitude en degrés. */
export function versLambert93(lon, lat) {
    const phi = lat * Math.PI / 180, s = Math.sin(phi);
    const iso = Math.log(Math.tan(Math.PI / 4 + phi / 2) * ((1 - L93.e * s) / (1 + L93.e * s)) ** (L93.e / 2));
    const r = L93.c * Math.exp(-L93.n * iso), g = L93.n * (lon * Math.PI / 180 - L93.lon0);
    return [L93.xs + r * Math.sin(g), L93.ys - r * Math.cos(g)];
}

const ALPHABET_IFC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

/**
 * GlobalId IFC tiré d'un texte : 128 bits d'un hachage en 22 caractères de
 * l'alphabet IFC, deux bits dans le premier. Un bâtiment garde le sien d'un
 * export à l'autre : le logiciel qui recharge le contexte y retrouve ses
 * objets.
 */
function guidIfc(texte) {
    const n = hachage128(texte);
    let s = '';
    for (let i = 21; i >= 0; i--) s += ALPHABET_IFC[Number((n >> BigInt(6 * i)) & 63n)];
    return s;
}

/** gml:id CityGML tiré d'un texte, stable comme le GlobalId IFC : « ID_ » et 32 chiffres hexadécimaux. */
export function idGml(texte) {
    return 'ID_' + hachage128(texte).toString(16).padStart(32, '0');
}

/** 128 bits d'un texte (hachage cyrb128), en BigInt. */
function hachage128(texte) {
    let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    for (let i = 0; i < texte.length; i++) {
        const k = texte.charCodeAt(i);
        h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
        h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
        h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
        h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    h1 ^= h2 ^ h3 ^ h4; h2 ^= h1; h3 ^= h1; h4 ^= h1;
    let n = 0n;
    for (const h of [h1, h2, h3, h4]) n = (n << 32n) | BigInt(h >>> 0);
    return n;
}

/** Chaîne STEP (ISO 10303-21) : apostrophe et barre doublées, le reste de l'ASCII imprimable tel quel, les autres caractères en \X2\…\X0\. */
function chaineIfc(texte) {
    let s = '';
    for (const c of String(texte)) {
        const code = c.codePointAt(0);
        if (c === "'") s += "''";
        else if (c === '\\') s += '\\\\';
        else if (code >= 0x20 && code < 0x7f) s += c;
        else if (code <= 0xffff) s += '\\X2\\' + code.toString(16).toUpperCase().padStart(4, '0') + '\\X0\\';
        else s += '?';
    }
    return `'${s}'`;
}

/** Réel STEP au millimètre : le point décimal est obligatoire. */
const reelIfc = v => (Math.abs(v) < 5e-4 ? 0 : v).toFixed(3);

/** Angle en degrés décimaux, en degrés, minutes, secondes et millionièmes (IfcCompoundPlaneAngleMeasure). */
function angleIfc(deg) {
    const signe = deg < 0 ? -1 : 1;
    const micro = Math.round(Math.abs(deg) * 3600e6);
    const parts = [Math.floor(micro / 3600e6), Math.floor(micro / 60e6) % 60,
                   Math.floor(micro / 1e6) % 60, micro % 1e6];
    return parts.map(v => signe * v).join(',');
}

/**
 * Sommets et triangles d'un maillage en coordonnées IFC (neuf réels par
 * triangle) : sommets confondus au millimètre, triangles dégénérés retirés.
 * `ferme` quand chaque arête est portée par exactement deux triangles, en
 * sens opposés — la règle des toits en pans (vue3d/pans.py) ; IFC le déclare
 * (Closed), un logiciel peut alors en faire un solide.
 */
export function facettesIfc(triangles) {
    const index = new Map(), points = [], faces = [];
    const sommet = (x, y, z) => {
        const mx = Math.round(x * 1000), my = Math.round(y * 1000), mz = Math.round(z * 1000);
        const cle = `${mx},${my},${mz}`;
        let i = index.get(cle);
        if (i === undefined) {
            index.set(cle, i = points.length / 3);
            points.push(mx / 1000, my / 1000, mz / 1000);
        }
        return i;
    };
    for (let t = 0; t + 8 < triangles.length; t += 9) {
        const a = sommet(triangles[t], triangles[t + 1], triangles[t + 2]);
        const b = sommet(triangles[t + 3], triangles[t + 4], triangles[t + 5]);
        const c = sommet(triangles[t + 6], triangles[t + 7], triangles[t + 8]);
        if (a !== b && b !== c && a !== c) faces.push(a, b, c);
    }
    const n = points.length / 3, aretes = new Set();
    let ferme = faces.length > 0;
    for (let f = 0; f < faces.length && ferme; f += 3) {
        for (let k = 0; k < 3; k++) {
            const cle = faces[f + k] * n + faces[f + (k + 1) % 3];
            if (aretes.has(cle)) { ferme = false; break; }
            aretes.add(cle);
        }
    }
    if (ferme) for (const cle of aretes) if (!aretes.has((cle % n) * n + Math.floor(cle / n))) { ferme = false; break; }
    return { points, faces, ferme };
}

/**
 * Triangles d'une grille de relief, en coordonnées IFC : `point(i, j)` est le
 * sommet de la colonne i (vers l'est) et de la ligne j (vers le sud), de 0 à
 * nx et nz. Un sommet sur `pas` est gardé, les bords toujours. Chaque maille
 * donne deux triangles tournés vers le haut.
 */
export function trianglesRelief(nx, nz, point, pas) {
    const crans = n => {
        const c = [];
        for (let i = 0; i < n; i += pas) c.push(i);
        c.push(n);
        return c;
    };
    const ci = crans(nx), cj = crans(nz);
    const grille = cj.map(j => ci.map(i => point(i, j)));
    const tri = [];
    for (let b = 0; b + 1 < cj.length; b++) {
        for (let a = 0; a + 1 < ci.length; a++) {
            const no = grille[b][a], ne = grille[b][a + 1], so = grille[b + 1][a], se = grille[b + 1][a + 1];
            tri.push(...no, ...so, ...se, ...no, ...se, ...ne);
        }
    }
    return tri;
}

/**
 * Tronc d'un arbre en coordonnées IFC : le cylindre évasé de GEO_TRONC, à
 * sept pans et fermé — les couvercles que la vue s'épargne en font un solide
 * pour le logiciel qui l'importe. Il monte jusqu'à `sol` + hT, comme dans la
 * vue sous un houppier posé au même `sol`, et son pied descend d'ENFONCEMENT
 * sous le terrain : le relief exporté, plus grossier que celui qui pose
 * l'arbre, ne le laisse pas flotter.
 */
export function trianglesTronc(el, sol, versIfc) {
    const { hT, rT } = gabaritTronc(el);
    const n = 7, tri = [];
    const anneau = (r, y) => Array.from({ length: n }, (_, s) => {
        const a = s / n * 2 * Math.PI;
        return versIfc(el.x + r * rT * Math.sin(a), y, -el.y + r * rT * Math.cos(a));
    });
    const pied = sol - ENFONCEMENT;
    const bas = anneau(0.78, pied), haut = anneau(0.34, sol + hT);
    const cBas = versIfc(el.x, pied, -el.y), cHaut = versIfc(el.x, sol + hT, -el.y);
    for (let s = 0; s < n; s++) {
        const t = (s + 1) % n;
        tri.push(...bas[s], ...bas[t], ...haut[t], ...bas[s], ...haut[t], ...haut[s],
                 ...cHaut, ...haut[s], ...haut[t], ...cBas, ...bas[t], ...bas[s]);
    }
    return tri;
}

/**
 * Entité IFC, type prédéfini et type d'objet de chaque genre d'élément.
 * Tous sont dans le site, sans bâtiment ni étage IFC : un contexte de 600
 * bâtiments importé dans un projet n'y crée pas 600 bâtiments, et chaque
 * logiciel range ces volumes à sa façon.
 */
const ENTITES_IFC = {
    batiment: ['IFCBUILDINGELEMENTPROXY', 'USERDEFINED', 'Bâtiment existant'],
    arbre: ['IFCGEOGRAPHICELEMENT', 'USERDEFINED', 'Arbre'],
    masse: ['IFCGEOGRAPHICELEMENT', 'USERDEFINED', 'Masse de sursol'],
    terrain: ['IFCGEOGRAPHICELEMENT', 'TERRAIN', null],
};

/**
 * Fichier IFC 4 d'un modèle (modeleExport), en texte ISO 10303-21. Le modèle :
 *   { base, horodatage, cle, nom, description, site, lon, lat,
 *     origine: { x, y, z }   en Lambert-93 et en altitude, l'origine du fichier,
 *     nordVrai: [x, y]       le nord vrai dans ce repère,
 *     crs: { nom, description, datum, datumVertical, projection, epsgVertical },
 *     styles: { nom: [r, v, b] },
 *     elements: [{ cle, genre, nom, description, tag,
 *                  proprietes: { nom, valeurs: [[nom, type IFC, valeur]] },
 *                  parties: [{ nom }]           bâtiments : une par emprise,
 *                  maillages: [{ style, facettes, partie }] }] }
 * `facettes` : ce que rend facettesIfc, en coordonnées rapportées à
 * l'origine. Un élément sans triangle est omis ; l'IFC y met tous ses
 * maillages, parties confondues.
 */
export function ecrireIfc(m) {
    const L = [];
    let n = 0;
    const ent = texte => { L.push(`#${++n}=${texte};`); return `#${n}`; };
    const guids = new Set();
    const guid = cle => {
        let g = guidIfc(cle);
        for (let k = 1; guids.has(g); k++) g = guidIfc(`${cle}#${k}`);
        guids.add(g);
        return `'${g}'`;
    };
    const opt = v => v == null || v === '' ? '$' : chaineIfc(v);
    const valeur = (type, v) => type === 'IFCINTEGER' ? `${type}(${Math.round(v)})`
        : /MEASURE$/.test(type) ? `${type}(${reelIfc(v)})` : `${type}(${chaineIfc(v)})`;

    const origine = ent('IFCCARTESIANPOINT((0.,0.,0.))');
    const axe = ent(`IFCAXIS2PLACEMENT3D(${origine},$,$)`);
    const nord = ent(`IFCDIRECTION((${m.nordVrai[0].toFixed(6)},${m.nordVrai[1].toFixed(6)}))`);
    const contexte = ent(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${axe},${nord})`);
    const corps = ent(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${contexte},$,.MODEL_VIEW.,$)`);
    const metre = ent('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)');
    const unites = ent(`IFCUNITASSIGNMENT((${metre},${ent('IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)')},`
        + `${ent('IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)')},${ent('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)')}))`);
    const crs = ent(`IFCPROJECTEDCRS(${chaineIfc(m.crs.nom)},${opt(m.crs.description)},${opt(m.crs.datum)},`
        + `${opt(m.crs.datumVertical)},${opt(m.crs.projection)},$,${metre})`);
    ent(`IFCMAPCONVERSION(${contexte},${crs},${reelIfc(m.origine.x)},${reelIfc(m.origine.y)},`
        + `${reelIfc(m.origine.z)},1.,0.,$)`);
    const projet = ent(`IFCPROJECT(${guid('projet|' + m.cle)},$,${opt(m.nom)},${opt(m.description)},$,$,$,`
        + `(${contexte}),${unites})`);
    const placeSite = ent(`IFCLOCALPLACEMENT($,${axe})`);
    const site = ent(`IFCSITE(${guid('site|' + m.cle)},$,${opt(m.site)},$,$,${placeSite},$,$,.ELEMENT.,`
        + `(${angleIfc(m.lat)}),(${angleIfc(m.lon)}),${reelIfc(m.origine.z)},$,$)`);
    ent(`IFCRELAGGREGATES(${guid('agrege|' + m.cle)},$,$,$,${projet},(${site}))`);

    const styles = {};
    for (const [nom, rvb] of Object.entries(m.styles)) {
        const couleur = ent(`IFCCOLOURRGB($,${rvb.map(c => c.toFixed(3)).join(',')})`);
        styles[nom] = ent(`IFCSURFACESTYLE(${chaineIfc(nom)},.BOTH.,(${ent(`IFCSURFACESTYLESHADING(${couleur},$)`)}))`);
    }

    const contenus = [];
    for (const el of m.elements) {
        const items = [];
        for (const { style, facettes: f } of el.maillages) {
            if (!f.faces.length) continue;
            const pts = new Array(f.points.length / 3), tri = new Array(f.faces.length / 3);
            for (let i = 0; i < pts.length; i++) {
                pts[i] = `(${reelIfc(f.points[3 * i])},${reelIfc(f.points[3 * i + 1])},${reelIfc(f.points[3 * i + 2])})`;
            }
            for (let i = 0; i < tri.length; i++) tri[i] = `(${f.faces[3 * i] + 1},${f.faces[3 * i + 1] + 1},${f.faces[3 * i + 2] + 1})`;
            const liste = ent(`IFCCARTESIANPOINTLIST3D((${pts.join(',')}))`);
            const item = ent(`IFCTRIANGULATEDFACESET(${liste},$,${f.ferme ? '.T.' : '.F.'},(${tri.join(',')}),$)`);
            if (styles[style]) ent(`IFCSTYLEDITEM(${item},(${styles[style]}),$)`);
            items.push(item);
        }
        if (!items.length) continue;
        const representation = ent(`IFCSHAPEREPRESENTATION(${corps},'Body','Tessellation',(${items.join(',')}))`);
        const forme = ent(`IFCPRODUCTDEFINITIONSHAPE($,$,(${representation}))`);
        const place = ent(`IFCLOCALPLACEMENT(${placeSite},${axe})`);
        const [entite, type, objectType] = ENTITES_IFC[el.genre];
        const objet = ent(`${entite}(${guid(el.cle)},$,${opt(el.nom)},${opt(el.description)},`
            + `${opt(objectType)},${place},${forme},${opt(el.tag)},.${type}.)`);
        contenus.push(objet);
        const valeurs = ((el.proprietes && el.proprietes.valeurs) || []).filter(([, , v]) => v != null && v !== '');
        if (valeurs.length) {
            const proprietes = valeurs.map(([nom, type, v]) =>
                ent(`IFCPROPERTYSINGLEVALUE(${chaineIfc(nom)},$,${valeur(type, v)},$)`));
            const pset = ent(`IFCPROPERTYSET(${guid('pset|' + el.cle)},$,${chaineIfc(el.proprietes.nom)},$,(${proprietes.join(',')}))`);
            ent(`IFCRELDEFINESBYPROPERTIES(${guid('definit|' + el.cle)},$,$,$,(${objet}),${pset})`);
        }
    }
    if (contenus.length) {
        ent(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${guid('contient|' + m.cle)},$,$,$,(${contenus.join(',')}),${site})`);
    }
    return ['ISO-10303-21;', 'HEADER;',
            "FILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');",
            `FILE_NAME(${chaineIfc(m.base + '.ifc')},${chaineIfc(m.horodatage)},(''),(''),'Vue 3D IGN','Vue 3D IGN','');`,
            "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;', ...L, 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');
}
