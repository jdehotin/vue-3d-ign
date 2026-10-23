// La forme des houppiers et des troncs, d'après leur profil mesuré.

import * as THREE from 'three';
import { HAUTEUR_MIN_TRONC, alea } from '../../commun/regles.js';
import { normalesIndexees } from '../geometrie/normales.js';

// Le serveur (app/api_dir/houppiers.py) segmente le MNH LiDAR HD à 0,5 m en
// houppiers et renvoie, pour chacun, son sommet, sa surface, son allongement
// et son PROFIL RADIAL : hauteur moyenne par couronne de distance au sommet,
// rapportée à la hauteur du sommet. La forme de chaque arbre est donc lue,
// pas supposée. La version précédente tirait toutes les silhouettes d'une
// même allométrie (rayon = 26 % de la hauteur, houppier sur 80 % de la
// hauteur), d'où l'effet de baudruche : un pin d'Alep est un parasol aplati
// sur un fût nu, un chêne vert une boule presque aussi large que haute, un
// cyprès une colonne dix fois plus haute que large.
//
// L'essence BD Forêt v2, puis la nature BD TOPO, ne servent qu'à la palette
// et à la part de fût nu — jamais à la forme.

// `tronc` est la part de la hauteur laissée au fût nu, donc le bas du
// houppier. Les valeurs suivent les ports réels — un pin adulte porte son
// feuillage sur la moitié haute, un chêne un peu plus bas — et dégagent la vue
// sous la canopée, ce qui compte ici : le sujet est le bâti, pas les arbres.
const PORTS = {
    feuillu:    { nom: 'feuillu',    base: new THREE.Color(0x5e8a3e), cime: new THREE.Color(0x9cc06a), tronc: 0.42 },
    chene_vert: { nom: 'chêne vert', base: new THREE.Color(0x3f6b33), cime: new THREE.Color(0x6f9a55), tronc: 0.38 },
    pin:        { nom: 'pin',        base: new THREE.Color(0x4f7a4a), cime: new THREE.Color(0x8fb27a), tronc: 0.52 },
    conifere:   { nom: 'conifère',   base: new THREE.Color(0x3e6a3c), cime: new THREE.Color(0x6d9a63), tronc: 0.12 },
    peuplier:   { nom: 'peuplier',   base: new THREE.Color(0x76a24e), cime: new THREE.Color(0xb2d37f), tronc: 0.38 },
    arbuste:    { nom: 'arbuste',    base: new THREE.Color(0x6a8e44), cime: new THREE.Color(0xa2c46e), tronc: 0 },
    masse:      { nom: 'masse',      base: new THREE.Color(0x5f6256), cime: new THREE.Color(0x8a8c7c), tronc: 0 },
};

/** Port (palette, part de fût nu) d'après l'essence BD Forêt v2, puis la nature BD TOPO. */
export function portDe(el) {
    if (el.classe !== 'vegetation') return PORTS.masse;
    const e = (el.essence || '').toLowerCase();
    const n = (el.nature || '').toLowerCase();
    // « Sapin, épicéa » contient « pin » : le mot seul, ou les sapins des
    // Vosges sortaient en pins parasols. Le chêne vert est « Chênes
    // sempervirents » dans la BD Forêt v2 (valeurs relevées le 2026-10-20).
    if (/\bpins?\b/.test(e)) return PORTS.pin;
    if (/sapin|épicéa|epicea|douglas|mélèze|meleze/.test(e)) return PORTS.conifere;
    if (/vert|sempervirent/.test(e)) return PORTS.chene_vert;
    if (/peuplier/.test(e)) return PORTS.peuplier;
    if (/chêne|chene|hêtre|hetre|châtaignier|chataignier|robinier|feuillu/.test(e)) return PORTS.feuillu;
    if (/conif/.test(e) || /conif|sineux/.test(n)) return PORTS.conifere;
    if (/verger|vigne|lande|haie/.test(n)) return PORTS.arbuste;
    // « Mixte », ou rien du tout : les référentiels ne tranchent pas. La BD
    // Forêt donne l'essence dominante d'un MASSIF, jamais celle d'un arbre :
    // un pin au milieu d'une forêt mixte y est étiqueté « Mixte ». Le profil
    // mesuré de CET arbre, lui, en dit plus qu'un tirage au sort.
    return portMesure(el);
}

/**
 * Port déduit du profil radial mesuré, quand le référentiel ne tranche pas.
 *
 * Un pin porte un houppier en parasol : la hauteur se maintient loin du
 * sommet, donc un profil en plateau. Un sapin ou un cyprès s'effile dès la
 * première couronne. Un feuillu fait un dôme, entre les deux. Les seuils sont
 * ceux qu'affiche déjà l'infobulle, pour que le dessin et le texte disent la
 * même chose.
 *
 * Ce que ça remplace : un tirage à 35 % de conifères d'après la position,
 * stable d'un rechargement à l'autre mais sans rapport avec l'arbre.
 */
function portMesure(el) {
    const p = el.profil || [];
    if (p.length < 4) return PORTS.feuillu;
    if (p[3] >= 0.85) return PORTS.pin;         // sommet plat : parasol, fût nu
    if (p[1] <= 0.75) return PORTS.conifere;    // cime en pointe
    return PORTS.feuillu;
}

/** Lecture du profil mesuré : plateau (pin parasol), pointe (cyprès, sapin) ou dôme. */
export function formeDe(el) {
    const p = el.profil || [];
    if (p.length < 4) return 'dôme';
    if (p[3] >= 0.85) return 'sommet plat';
    if (p[1] <= 0.75) return 'en pointe';
    return 'en dôme';
}

const SEGMENTS_HOUPPIER = 10;
// Angles des segments, leurs cosinus et sinus : les mêmes pour tous les
// houppiers, calculés une fois.
const ANGLES_HOUPPIER = Float64Array.from({ length: SEGMENTS_HOUPPIER },
                                          (_, s) => s / SEGMENTS_HOUPPIER * Math.PI * 2);
const COS_HOUPPIER = ANGLES_HOUPPIER.map(Math.cos), SIN_HOUPPIER = ANGLES_HOUPPIER.map(Math.sin);
const BOSSES_HOUPPIER = new Float64Array(SEGMENTS_HOUPPIER);
// Part linéaire du segment mesuré effectivement occupée par le houppier.
const EMPRISE_HOUPPIER = 0.8;

/** Seuls les ports à fût nu ont un tronc, et au-dessus de 3 m. Partagé par la vue et l'export IFC. */
export function aUnTronc(el) {
    return el.classe === 'vegetation' && el.h >= HAUTEUR_MIN_TRONC && portDe(el).tronc >= 0.1;
}

/**
 * Hauteur et rayon du tronc d'un arbre (GEO_TRONC mis à l'échelle). Le fût
 * monte un peu dans le houppier, sinon on voit le bâton sortir de la boule.
 * Partagé par la vue (placerVegetation) et l'export IFC.
 */
export function gabaritTronc(el) {
    const hT = el.h * portDe(el).tronc + Math.min(1, el.h * 0.1);
    // Un fût d'arbre adulte fait 30 à 60 cm ; la géométrie l'évase à la base.
    const rT = Math.min(Math.max(el.h / 20, 0.18), 0.6);
    return { hT, rT };
}

/**
 * Tampon de triangles indexés, avec couleur par sommet.
 *
 * Chaque sommet retient l'élément dont il vient : c'est ce qui permet de
 * reposer la végétation sur le relief (exagération) en décalant les Y, sans
 * reconstruire un million de sommets à chaque cran du curseur. Les faces et
 * les sommets d'un élément se suivent ; leurs débuts, relevés à chaque
 * élément, désignent l'élément sous une face (elementSousFace) et le
 * recopient (vegetationExtraite).
 *
 * Indexé : un sommet d'anneau est écrit une fois, et non une fois par face
 * qui le touche (six). Les normales ne servent pas à l'éclairage, que
 * flatShading tire de la facette, seulement au décalage de l'ombre reçue
 * (normalBias). Mesuré sous Metal, Retina, 1 400 × 850, à Porquerolles en
 * zone de 1 000 m (17 613 houppiers, 913 masses) : 10,6 millions de sommets
 * deviennent 1,6, l'image en orbite passe de 22 à 14 ms, de 26 à 18 ms
 * quand l'ombre est redessinée ; les tableaux passent de 400 à 100 Mo.
 *
 * Écrit dans des tableaux typés. En tableaux JavaScript — un tableau par
 * sommet, neuf `push` par face —, le tampon prenait 0,75 s et sa géométrie
 * 0,86 s des 1,9 s de la végétation de Gordes en zone de 1 000 m (19 312
 * houppiers, profil CPU de Chrome).
 */
export function nouveauTampon(nbFaces = 1 << 16, nbSommets = nbFaces) {
    // À la taille exacte quand les nombres de faces et de sommets sont connus
    // (facesHouppier, sommetsHouppier), sans copie à l'agrandissement ni à la
    // fin ; doublés sinon. Agrandir coûtait 34 ms, la copie finale 25 ms, à
    // Strasbourg en zone de 1 000 m (profil CPU de Chrome).
    let capFaces = Math.max(nbFaces, 1), capSommets = Math.max(nbSommets, 1);
    let positions = new Float32Array(3 * capSommets), couleurs = new Float32Array(3 * capSommets);
    let elements = new Int32Array(capSommets), index = new Uint32Array(3 * capFaces);
    let ns = 0, nf = 0, courant = 0;
    const facesDebut = [], sommetsDebut = [];
    const agrandi = (t, n) => { const u = new t.constructor(n); u.set(t); return u; };
    return {
        element(e) { courant = e; facesDebut.push(nf); sommetsDebut.push(ns); },
        sommet(x, y, z, c) {
            if (ns === capSommets) {
                capSommets *= 2;
                positions = agrandi(positions, 3 * capSommets);
                couleurs = agrandi(couleurs, 3 * capSommets);
                elements = agrandi(elements, capSommets);
            }
            const k = 3 * ns;
            positions[k] = x; positions[k + 1] = y; positions[k + 2] = z;
            couleurs[k] = c.r; couleurs[k + 1] = c.g; couleurs[k + 2] = c.b;
            elements[ns] = courant;
            return ns++;
        },
        face(i, j, k) {
            if (nf === capFaces) { capFaces *= 2; index = agrandi(index, 3 * capFaces); }
            const m = 3 * nf++;
            index[m] = i; index[m + 1] = j; index[m + 2] = k;
        },
        geometrie() {
            const pos = ns === capSommets ? positions : positions.slice(0, 3 * ns);
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            geo.setAttribute('color', new THREE.BufferAttribute(ns === capSommets ? couleurs : couleurs.slice(0, 3 * ns), 3));
            geo.setIndex(new THREE.BufferAttribute(nf === capFaces ? index : index.slice(0, 3 * nf), 1));
            normalesIndexees(geo);
            const baseY = new Float32Array(ns);
            for (let i = 0; i < ns; i++) baseY[i] = pos[3 * i + 1];
            geo.userData.baseY = baseY;
            geo.userData.elements = ns === capSommets ? elements : elements.slice(0, ns);
            geo.userData.facesDebut = Int32Array.from(facesDebut);
            geo.userData.sommetsDebut = Int32Array.from(sommetsDebut);
            return geo;
        },
    };
}

/**
 * Nombre de faces qu'ajouterHouppier() pose pour un élément. Ses anneaux : le
 * sommet, une couronne par valeur du profil (six par défaut), le bord, trois
 * dessous dont le centre. Deux faces par segment entre deux anneaux, une
 * seule contre le sommet et le centre du dessous, qui sont des points.
 */
export function facesHouppier(el) {
    const nb = el.profil && el.profil.length ? el.profil.length : 6;
    return 2 * SEGMENTS_HOUPPIER * (nb + 3);
}

/** Nombre de sommets qu'ajouterHouppier() pose : nb + 3 anneaux et deux points. */
export function sommetsHouppier(el) {
    const nb = el.profil && el.profil.length ? el.profil.length : 6;
    return SEGMENTS_HOUPPIER * (nb + 3) + 2;
}

/**
 * Gabarit d'un houppier : port, hauteurs, demi-axes et axe de son emprise,
 * teinte. Commun à sa forme détaillée (ajouterHouppier) et à sa forme simple
 * (ajouterHouppierSimple), qui occupent ainsi le même volume.
 */
export function gabaritHouppier(el) {
    const port = portDe(el);
    const h = el.h;
    const p = el.profil && el.profil.length ? el.profil : [1, 0.9, 0.8, 0.7, 0.6, 0.5];
    const nb = p.length;
    // Demi-axes de l'ellipse au sol. L'aire est celle qui a été MESURÉE
    // (pi*a*b = pi*r^2, r étant le rayon équivalent de la surface du segment)
    // et l'excentricité vient de l'allongement mesuré, le rapport des axes
    // principaux du segment : a/b = allongement.
    //
    // La version précédente prenait a = r_max, la distance à la cellule la
    // plus lointaine, et en déduisait b = r^2/a. Une seule cellule excentrée
    // gouvernait donc toute la forme, et comme r_max vaut 1,88 fois r à la
    // médiane, le rapport des axes valait son carré, 3,5, contre 1,51
    // d'allongement réellement mesuré. Résultat : des losanges très étalés,
    // dessinés deux fois trop larges. Mesuré sur 1 776 houppiers d'une forêt
    // mixte, la largeur dessinée rapportée à la hauteur tombe de 0,98 à 0,71
    // en médiane, et la part de houppiers plus larges que hauts de 47 % à
    // 19 %. Aucune borne en plus : une haie, un chêne vert ou un verger sont
    // réellement plus larges que hauts, et c'est la mesure qui le dit.
    const etirement = Math.sqrt(Math.max(el.allongement || 1, 1));
    // Le segment mesuré est la part de canopée RATTACHÉE à ce sommet, pas la
    // projection du houppier : il englobe les trouées entre les arbres, puisque
    // toute cellule du sursol est attribuée à un sommet. Dessiner les houppiers
    // à 100 % du segment pave donc le sol sans un interstice, et la forêt
    // redevient la masse informe qu'on cherchait à éviter. Le houppier est
    // inscrit dans son segment, à EMPRISE_HOUPPIER près en linéaire, soit 64 %
    // de sa surface.
    const rBase = Math.max(el.r * EMPRISE_HOUPPIER, 0.5);
    const a = rBase * etirement;
    const b = Math.max(rBase / etirement, 0.4);
    const axe = (el.axe_deg || 0) * Math.PI / 180;
    const hBase = h >= HAUTEUR_MIN_TRONC ? h * port.tronc : 0;
    const hMin = hBase + Math.max(0.4, h * 0.08);
    const g = alea(el.lon, el.lat);          // tirage stable par houppier
    const teinte = 0.9 + g * 0.2;
    // Le bord descend franchement sous la dernière couronne du profil. Sans
    // cette pente, les deux derniers anneaux se retrouvaient à la MÊME hauteur
    // (le profil y est déjà bloqué par hMin), et la bande entre eux devenait un
    // ruban horizontal d'à peine 0,7 m de large. Le grain vertical, appliqué à
    // l'anneau intérieur mais pas au bord, la retournait dans tous les sens :
    // 16 de ses 20 facettes sortaient à l'envers, donc éliminées au rendu, et
    // la lisière du houppier s'ouvrait sur l'intérieur de la coque.
    const yBord = Math.max(p[nb - 1] * h - Math.min(0.8, (h - hBase) * 0.08),
                           hBase + 0.3);
    // Dessous : une lisière verticale au bord, puis une surface qui remonte
    // DOUCEMENT vers le tronc. C'est le sens physique — les branches basses
    // sont les plus extérieures — et l'inverse de ce que faisait la version
    // précédente, dont le dessous plongeait en entonnoir du bord vers le
    // tronc (1,74 m de creux sur un arbre de 17 m mesuré). À 72 % d'opacité
    // l'entonnoir restait caché ; à 45 % il se voit par transparence et le
    // houppier se lit la tête en bas.
    //
    // La remontée reste sous le sommet du tronc, sinon le fût sortirait du
    // feuillage : au plus 0,6 m, contre 1 m de fût qui dépasse la base.
    const montee = Math.min(0.6, (h - hBase) * 0.04);
    return { port, h, p, nb, a, b, axe, hBase, hMin, g, teinte, yBord, montee };
}

/**
 * Ajoute un houppier au tampon.
 *
 * Surface de révolution sur le profil mesuré : un anneau par couronne du
 * profil, du sommet vers le bord, puis retour à la base du houppier. L'aire
 * mesurée est conservée et l'allongement étire l'ellipse sur l'axe mesuré :
 * une haie reste une haie. Un relief angulaire, lobes basse fréquence et
 * grain par sommet, évite le vase tourné. Retourne le nombre de faces.
 */
export function ajouterHouppier(tampon, el, sol) {
    const { port, h, p, nb, a, b, axe, hBase, hMin, g, teinte, yBord, montee } = gabaritHouppier(el);
    // Dessus : le profil mesuré, du sommet vers le bord, puis le bord, qui
    // descend franchement sous la dernière couronne (gabaritHouppier).
    const anneaux = [{ u: 0, y: h }];
    for (let k = 0; k < nb; k++) anneaux.push({ u: (k + 0.5) / nb, y: Math.max(p[k] * h, hMin) });
    anneaux.push({ u: 1.0, y: yBord });
    // Dessous : une lisière verticale au bord, puis une surface qui remonte
    // doucement vers le tronc (gabaritHouppier).
    anneaux.push({ u: 1.0, y: hBase });
    anneaux.push({ u: 0.6, y: hBase + montee * 0.7 });
    anneaux.push({ u: 0, y: hBase + montee });
    const couleur = new THREE.Color();
    const cx = el.x, cz = -el.y;
    const cosA = Math.cos(axe), sinA = Math.sin(axe);
    // Lobage : un défaut de rondeur du HOUPPIER, donc le même à toutes les
    // hauteurs. Le tirer anneau par anneau faisait bomber un anneau intérieur
    // au-delà du bord — jusqu'à 8,83 m pour un bord à 8,45 m sur l'arbre
    // mesuré — et la lisière se repliait sur elle-même. Partagé, il garantit
    // que le rayon croît avec u, donc une surface qui ne se retourne jamais.
    // Calculé une fois par houppier, et non par anneau : les mêmes valeurs.
    const bosses = BOSSES_HOUPPIER;
    for (let s = 0; s < SEGMENTS_HOUPPIER; s++) {
        bosses[s] = 1 + 0.10 * Math.sin(3 * ANGLES_HOUPPIER[s] + g * 6.28)
                      + 0.08 * (alea(el.lon + s, el.lat) - 0.5);
    }
    const pts = [];
    for (let i = 0; i < anneaux.length; i++) {
        const { u, y } = anneaux[i];
        const t = (y - hBase) / Math.max(h - hBase, 0.1);
        couleur.copy(port.base).lerp(port.cime, Math.max(0, Math.min(1, t))).multiplyScalar(teinte);
        // Sommet et centre du dessous : un seul sommet, d'où partent les
        // éventails ; ses dix copies étaient confondues, au bit près.
        if (u === 0) {
            pts.push(Array(SEGMENTS_HOUPPIER).fill(tampon.sommet(cx, sol + y, cz, couleur)));
            continue;
        }
        const ligne = [];
        const interieur = u < 1;
        for (let s = 0; s < SEGMENTS_HOUPPIER; s++) {
            const bosse = bosses[s];
            const ex = a * u * bosse * COS_HOUPPIER[s], ez = b * u * bosse * SIN_HOUPPIER[s];
            // axe_deg est compté depuis l'est vers le nord ; le nord de la scène est -Z.
            const x = cx + ex * cosA - ez * sinA;
            const z = cz - (ex * sinA + ez * cosA);
            // Grain vertical : il casse le vase tourné, il ne doit pas défaire
            // la surface. Il valait 12 % de la hauteur de l'ARBRE, soit ±1,04 m
            // sur un arbre de 17 m — plus que l'écart entre deux couronnes du
            // profil, d'où des facettes géantes orientées au hasard. Il suit
            // désormais la hauteur du HOUPPIER, et reste borné.
            const dy = interieur
                ? (alea(el.lat + i, el.lon + s) - 0.5) * Math.min(0.9, (h - hBase) * 0.07)
                : 0;
            ligne.push(tampon.sommet(x, sol + y + dy, z, couleur));
        }
        pts.push(ligne);
    }
    // Sans les triangles dégénérés contre le sommet et le centre du dessous :
    // 20 faces sur 200, qui ne dessinaient rien.
    let faces = 0;
    for (let i = 0; i + 1 < anneaux.length; i++) {
        for (let s = 0; s < SEGMENTS_HOUPPIER; s++) {
            const s1 = (s + 1) % SEGMENTS_HOUPPIER;
            if (i + 2 < anneaux.length) { tampon.face(pts[i][s], pts[i + 1][s], pts[i + 1][s1]); faces++; }
            if (i > 0) { tampon.face(pts[i][s], pts[i + 1][s1], pts[i][s1]); faces++; }
        }
    }
    return faces;
}

// Segments de la forme simple : six, sans lobage ni grain.
const SEGMENTS_SIMPLE = 6;

/**
 * Nombre de faces qu'ajouterHouppierSimple() pose : un éventail sous le
 * sommet, deux bandes jusqu'au bord, un éventail dessous — 36, quand la
 * forme détaillée en compte 180 avec un profil de six couronnes.
 */
export function facesHouppierSimple() {
    return 6 * SEGMENTS_SIMPLE;
}

/** Nombre de sommets qu'ajouterHouppierSimple() pose : trois anneaux et deux points. */
export function sommetsHouppierSimple() {
    return 3 * SEGMENTS_SIMPLE + 2;
}

/**
 * Ajoute au tampon la forme simple d'un houppier, dessinée à sa place pendant
 * le mouvement, au loin ou quand la vue rame (montrerVegetation). Même gabarit que
 * la forme détaillée — emprise, axe, sommet, bord, dessous, palette — sur
 * quatre anneaux : le sommet, le profil au quart et aux trois quarts du
 * rayon, le bord ; le dessous remonte en cône plat vers le tronc.
 * Avec une seule couronne, celle du milieu, les feuillus sortaient en pointe
 * et se lisaient comme des sapins. Le rayon croît du sommet au
 * bord et la hauteur décroît : la surface ne se retourne pas. Retourne le
 * nombre de faces.
 *
 * Sauf sur un profil mesuré qui remonte vers le bord : le dessus y fait une
 * cuvette, que le cône du dessous traverse. 1 848 houppiers et masses sur
 * 418 839 des 36 scènes en cache (0,44 %) sortaient ainsi retournés, de
 * volume négatif ; aucun en forme détaillée, dont le bord descend d'abord à
 * la verticale jusqu'à la base du houppier. `lisiere` ajoute cet anneau, et
 * 12 faces : plus aucun retourné ni ouvert. L'export IFC, qui en fait des solides, le prend ; la
 * vue, qui ne montre cette forme qu'en mouvement, s'en passe.
 */
export function ajouterHouppierSimple(tampon, el, sol, lisiere = false) {
    const { port, h, p, nb, a, b, axe, hBase, hMin, teinte, yBord, montee } = gabaritHouppier(el);
    // Le profil lu au rayon u, entre ses couronnes (u = (k + 0.5) / nb) et
    // depuis le sommet : deux anneaux distincts même sur un profil court.
    const couronne = u => {
        let u0 = 0, y0 = h;
        for (let k = 0; k < nb; k++) {
            const u1 = (k + 0.5) / nb, y1 = p[k] * h;
            if (u <= u1) return { u, y: Math.max(y0 + (y1 - y0) * (u - u0) / (u1 - u0), hMin) };
            u0 = u1; y0 = y1;
        }
        return { u, y: Math.max(y0, hMin) };
    };
    const anneaux = [{ u: 0, y: h }, couronne(0.25), couronne(0.75), { u: 1, y: yBord },
                     ...(lisiere ? [{ u: 1, y: hBase }] : []), { u: 0, y: hBase + montee }];
    const couleur = new THREE.Color();
    const cx = el.x, cz = -el.y;
    const cosA = Math.cos(axe), sinA = Math.sin(axe);
    const pts = anneaux.map(({ u, y }) => {
        const t = (y - hBase) / Math.max(h - hBase, 0.1);
        couleur.copy(port.base).lerp(port.cime, Math.max(0, Math.min(1, t))).multiplyScalar(teinte);
        // Sommet et centre du dessous : un seul sommet, d'où partent les éventails.
        if (u === 0) return Array(SEGMENTS_SIMPLE).fill(tampon.sommet(cx, sol + y, cz, couleur));
        return Array.from({ length: SEGMENTS_SIMPLE }, (_, s) => {
            const ang = s / SEGMENTS_SIMPLE * Math.PI * 2;
            const ex = a * u * Math.cos(ang), ez = b * u * Math.sin(ang);
            // Même repère qu'ajouterHouppier : axe_deg depuis l'est vers le nord, nord en -Z.
            return tampon.sommet(cx + ex * cosA - ez * sinA, sol + y, cz - (ex * sinA + ez * cosA), couleur);
        });
    });
    // Mêmes faces qu'ajouterHouppier, d'un anneau au suivant, sans les
    // triangles dégénérés au sommet et au centre du dessous.
    let faces = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
        for (let s = 0; s < SEGMENTS_SIMPLE; s++) {
            const s1 = (s + 1) % SEGMENTS_SIMPLE;
            // Le premier triangle dégénère quand l'anneau du dessous est un
            // point (centre du dessous), le second quand c'est celui du dessus.
            if (i + 2 < pts.length) { tampon.face(pts[i][s], pts[i + 1][s], pts[i + 1][s1]); faces++; }
            if (i > 0) { tampon.face(pts[i][s], pts[i + 1][s1], pts[i][s1]); faces++; }
        }
    }
    return faces;
}
