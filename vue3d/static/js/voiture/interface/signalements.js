// Le bouton ⚠ : capture et état du sol, envoyés au serveur.

import { ALTI_NIVEAU_MIN, ALTI_NIVEAU_MAX } from '../../commun/tuiles.js';
import { SIMU, RAD } from '../socle/parametres.js';
import { depuisLambert93 } from '../socle/lambert93.js';
import { ORIGINE } from '../socle/monde.js';
import { renderer, ratio, ANISOTROPIE, camera } from '../socle/rendu.js';
import { voiture, camVue } from '../socle/etat.js';
import { elRue, elNom, elGps, elCarres, annoncer } from './ecran.js';
import {
    SOL_ZOOM_MIN, SOL_ZOOM_MAX, SOL_FINESSE, SOL_CACHE, tuilesSol, groupeSol, teinteSol,
    versTuile,
} from '../sol/tuiles.js';
import { manquees } from '../sol/manquees.js';
import { statsCache } from '../sol/cache.js';
import { ALTI_CACHE, altis, erreursAlti, pasAlti, altitude } from '../sol/altitudes.js';
import { carres } from '../carres/grille.js';
import { statsPrecharge, fond, generationFond, solEnVol } from '../sol/sol.js';
import { rendre } from './maquette.js';
import { bornesActives, blocsBornes } from '../couches/bornes.js';

// Le 23 octobre 2026, dans une Tesla, le sol près de la voiture n'avait pas
// sa photo, alors qu'aucune tuile n'avait été refusée (aucune relecture au
// serveur, aucune « tuile en attente » au bandeau) ; au même endroit, sur un
// ordinateur, le sol était entier. La page dit donc ce qu'elle voit sous la
// voiture, et le bouton ⚠ envoie au serveur une capture de l'écran avec
// l'état du sol (vue3d/signalements.py) : ce qu'elle croit montrer, à
// comparer à ce qui se voit.
const ALERTE_SOL_S = 5;                 // un sol qui se charge n'est pas un défaut
const DEVANT_ALERTE_M = 60;
const alerteSol = { actif: false, texte: '', depuis: 0, affichee: '', dernier: -Infinity };
const boutonSignaler = document.getElementById('b-signaler');

/** La tuile du sol montrée sous (x, y), Lambert-93 ; null s'il n'y en a pas. */
function tuileMontreeSous(x, y) {
    const [lon, lat] = depuisLambert93(x, y);
    for (let z = SOL_ZOOM_MAX; z >= SOL_ZOOM_MIN; z--) {
        const [tx, ty] = versTuile(lon, lat, z);
        const t = tuilesSol.get(`${z}/${tx}/${ty}`);
        if (t?.mesh?.visible) return t;
    }
    return null;
}

/** La part des pixels d'un blanc pur d'une image, sur 16 × 16 : l'orthophoto au-delà de sa prise de vue. */
function blancheur(img) {
    if (img.__blancheur !== undefined) return img.__blancheur;
    try {
        const c = document.createElement('canvas');
        c.width = c.height = 16;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0, 16, 16);
        const d = g.getImageData(0, 0, 16, 16).data;
        let n = 0;
        for (let k = 0; k < d.length; k += 4) if (Math.min(d[k], d[k + 1], d[k + 2]) > 245) n++;
        img.__blancheur = n / 256;
    } catch (e) { img.__blancheur = null; }
    return img.__blancheur;
}

/**
 * Le zoom que la tuile sous (x, y) devrait avoir, vue de la caméra : la plus
 * fine qui ne se découpe plus (couvrirSol), à SOL_FINESSE près.
 */
function zoomAttendu(x, y, alt) {
    const d = Math.hypot(camera.position.x + ORIGINE.x - x, ORIGINE.y - camera.position.z - y, camera.position.y - alt);
    const lat = depuisLambert93(x, y)[1];
    const z = Math.floor(Math.log2(SOL_FINESSE * 40075017 * Math.cos(lat * RAD) / Math.max(d, 1)));
    return Math.min(Math.max(z, SOL_ZOOM_MIN), SOL_ZOOM_MAX);
}

/** Ce qui manque au sol montré en (x, y) ; '' s'il est entier. `sous` : sous la voiture, dont l'altitude compte. */
function defautSol(x, y, sous) {
    const t = tuileMontreeSous(x, y);
    if (!t) return 'absent';
    // Trois zooms de moins que la caméra n'en demande : la photo d'une tuile
    // de 10 km agrandie sous la voiture, un aplat. Dite avec ce qui bloque la
    // tuile plus fine, quand elle a échoué.
    const attendu = Number.isFinite(voiture.alt) ? zoomAttendu(x, y, voiture.alt) : t.z;
    if (t.z <= attendu - 3) {
        const [lon, lat] = depuisLambert93(x, y), [fx, fy] = versTuile(lon, lat, t.z + 1);
        const fille = tuilesSol.get(`${t.z + 1}/${fx}/${fy}`);
        return `flou (zoom ${t.z} au lieu de ${attendu})${fille?.erreur ? ' : ' + fille.erreur : ''}`;
    }
    if (t.altiManquantes) return `sans relief (zoom ${t.z})`;
    if (!t.mesh.material.map) return `sans photo (zoom ${t.z})`;
    // Blanche au niveau de la mer, la teinte de la mer la couvre (courberSol).
    if (t.ymax > 1.5 && t.habit?.image && blancheur(t.habit.image) > 0.9) return `photo blanche (zoom ${t.habit.z})`;
    // Hors d'un pont ou d'un tunnel, la voiture se pose sur le relief que porte la tuile.
    const v = voiture;
    if (sous && Number.isFinite(v.alt) && !v.arete?.sol && (v.alt < t.ymin - 25 || v.alt > t.ymax + 25)) {
        return `à ${Math.round(t.ymin)}-${Math.round(t.ymax)} m, la voiture à ${Math.round(v.alt)} m (zoom ${t.z})`;
    }
    return '';
}

/** Le défaut du sol sous la voiture ou juste devant, une fois qu'il dure ; '' sinon. */
export function majAlerteSol(maintenant) {
    if (maintenant - alerteSol.dernier < 1000) return alerteSol.affichee;
    alerteSol.dernier = maintenant;
    const v = voiture;
    let texte = '';
    if (v.vue && groupeSol.visible) {
        texte = defautSol(v.x, v.y, true);
        if (!texte) {
            const devant = defautSol(v.x + Math.sin(v.cap * RAD) * DEVANT_ALERTE_M,
                                     v.y + Math.cos(v.cap * RAD) * DEVANT_ALERTE_M, false);
            if (devant) texte = `${devant}, ${DEVANT_ALERTE_M} m devant`;
        }
    }
    if (!!texte !== alerteSol.actif) { alerteSol.actif = !!texte; alerteSol.depuis = maintenant; }
    alerteSol.texte = texte;
    alerteSol.affichee = texte && maintenant - alerteSol.depuis > ALERTE_SOL_S * 1000 ? texte : '';
    boutonSignaler.classList.toggle('alerte', !!alerteSol.affichee);
    return alerteSol.affichee;
}

// Ce que la page vit sans le voir : les pertes du contexte WebGL et ses
// pauses (voiture endormie, onglet caché) — l'onglet photographié le 23
// octobre était ouvert depuis la veille au soir.
const gpu = { pertes: 0, retablissements: 0, dernierePerte: null };
renderer.domElement.addEventListener('webglcontextlost', () => { gpu.pertes++; gpu.dernierePerte = new Date().toISOString(); });
renderer.domElement.addEventListener('webglcontextrestored', () => { gpu.retablissements++; });
export const sommeils = [];
let imagesParS = 0;
/** La moyenne glissante des images par seconde, à chaque image. */
export function compterImage(maintenant, precedent) {
    if (maintenant > precedent) imagesParS += (1000 / (maintenant - precedent) - imagesParS) * 0.05;
}

const arrondi = (v, k = 1) => (Number.isFinite(v) ? Math.round(v * k) / k : null);

function decrireTuile(t, maintenant) {
    return { z: t.z, x: t.x, y: t.y, maillage: !!t.mesh, montree: !!t.mesh?.visible,
             photo: !!t.mesh?.material.map, habit: t.habit ? t.habit.z : null,
             image: t.image ? [t.image.naturalWidth, t.image.naturalHeight] : null,
             blancheur: t.habit?.image ? arrondi(blancheur(t.habit.image), 100) : null,
             sansImage: t.sansImage === generationFond, fondGen: t.fondGen, enCours: t.enCours,
             echecs: t.echecs || 0, reessai_s: t.reessai > maintenant ? arrondi((t.reessai - maintenant) / 1000) : 0,
             altiManquantes: t.altiManquantes ?? null, niveau: t.niveau ?? null, echecsAlti: t.echecsAlti || 0,
             erreur: t.erreur || null, ymin: arrondi(t.ymin, 10), ymax: arrondi(t.ymax, 10),
             vue_s: arrondi((maintenant - t.vue) / 1000) };
}

function infoGpu() {
    const gl = renderer.getContext();
    let nom = null;
    try {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        nom = gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    } catch (e) { /* le nom du GPU n'est pas donné */ }
    return { nom, perdu: gl.isContextLost(), webgl2: renderer.capabilities.isWebGL2,
             textureMax: renderer.capabilities.maxTextureSize, anisotropie: ANISOTROPIE, ...gpu,
             memoire: { ...renderer.info.memory }, programmes: renderer.info.programs?.length ?? null,
             appels: renderer.info.render.calls, triangles: renderer.info.render.triangles };
}

/** Tout ce qui décide du sol à l'écran, pour un signalement. */
export function etatDiagnostic() {
    const v = voiture, maintenant = performance.now();
    const etat = {
        pris: new Date().toISOString(),
        page: { chargee: new Date(performance.timeOrigin).toISOString(), fichier: document.lastModified,
                url: location.pathname + location.search, simu: SIMU },
        ecran: { largeur: innerWidth, hauteur: innerHeight, dpr: devicePixelRatio, ratio, images_s: arrondi(imagesParS) },
        bandeau: { gps: elGps.innerText, carres: elCarres.innerText, rue: elRue.hidden ? null : elNom.textContent },
        alerte: alerteSol.texte, gpu: infoGpu(), sommeils,
    };
    const x = v.vue ? v.x : v.attendu?.x, y = v.vue ? v.y : v.attendu?.y;
    if (x == null) return etat;
    const [lon, lat] = depuisLambert93(x, y);
    etat.voiture = { vue: v.vue, lat: arrondi(lat, 1e6), lon: arrondi(lon, 1e6), x: arrondi(x, 10), y: arrondi(y, 10),
                     alt: arrondi(v.alt, 10), cap: arrondi(v.cap), kmh: arrondi(v.v * 3.6), horsRoute: v.horsRoute,
                     precision: v.precision, releve_s: v.fix ? arrondi((maintenant - v.fix.t) / 1000) : null,
                     route: v.arete ? { nom: v.arete.nom, nature: v.arete.nature, sol: v.arete.sol } : null };
    etat.camera = { x: arrondi(camera.position.x + ORIGINE.x, 10), y: arrondi(ORIGINE.y - camera.position.z, 10),
                    alt: arrondi(camera.position.y, 10), mode: camVue.mode, recul: arrondi(camVue.recul),
                    lacet: arrondi(camVue.lacet), tangage: arrondi(camVue.tangage) };
    const sol = etat.sol = { fond, generationFond, visible: groupeSol.visible, tuiles: tuilesSol.size, cache: SOL_CACHE,
                             enVol: solEnVol, teinte: teinteSol.getHexString(), navigateur: { ...statsCache },
                             manquees: manquees.size, manqueesExemples: [...manquees.keys()].slice(0, 10),
                             precharge: { ...statsPrecharge }, sousVoiture: [], autour: [], parZoom: {} };
    for (let z = SOL_ZOOM_MIN; z <= SOL_ZOOM_MAX; z++) {
        const [tx, ty] = versTuile(lon, lat, z), t = tuilesSol.get(`${z}/${tx}/${ty}`);
        sol.sousVoiture.push(t ? decrireTuile(t, maintenant) : { z, x: tx, y: ty, inconnue: true });
    }
    for (const t of tuilesSol.values()) {
        const p = sol.parZoom[t.z] ??= { tuiles: 0, maillees: 0, montrees: 0, sansPhoto: 0, sansRelief: 0, sansImage: 0 };
        p.tuiles++;
        if (t.mesh) p.maillees++;
        if (t.altiManquantes) p.sansRelief++;
        if (t.sansImage === generationFond) p.sansImage++;
        if (!t.mesh?.visible) continue;
        p.montrees++;
        if (!t.mesh.material.map) p.sansPhoto++;
        const dx = Math.max(t.minX - x, 0, x - t.maxX), dy = Math.max(t.minY - y, 0, y - t.maxY);
        if (Math.hypot(dx, dy) < 400) sol.autour.push(decrireTuile(t, maintenant));
    }
    etat.altitudes = { tuiles: altis.size, cache: ALTI_CACHE,
                       absentes: [...altis].filter(([, a]) => a.absente).map(([k]) => k).slice(0, 20),
                       erreurs: Object.fromEntries(erreursAlti), sousVoiture: [] };
    for (let n = ALTI_NIVEAU_MIN; n <= ALTI_NIVEAU_MAX; n++) {
        const q = pasAlti(n) * 256, cle = `${n}/${Math.floor((90 - lat) / q)}/${Math.floor((lon + 180) / q)}`;
        const a = altis.get(cle);
        etat.altitudes.sousVoiture.push({ niveau: n, cle, connue: !!a, lue: !!a?.valeurs, absente: !!a?.absente,
                                         m: arrondi(altitude(lon, lat, n), 10) });
    }
    const etats = {};
    for (const c of carres.values()) etats[c.etat] = (etats[c.etat] || 0) + 1;
    etat.carres = { total: carres.size, etats, construits: [...carres.values()].filter(c => c.mesh?.visible).length };
    const blocs = [...blocsBornes.values()];
    etat.bornes = { actives: bornesActives, blocs: blocs.length, prets: blocs.filter(b => b.stations).length,
                    stations: blocs.reduce((n, b) => n + (b.stations?.length || 0), 0),
                    posees: blocs.reduce((n, b) => n + (b.stations?.filter(st => st.niveau >= 0).length || 0), 0) };
    return etat;
}

// Au plus 1 280 px de large : 89 Ko en JPEG pour 1 280 × 800 (vue3d/signalements.py).
const CAPTURE_LARGEUR = 1280;
/** L'image de la vue, rendue à l'instant (le tampon WebGL ne la garde pas d'une image à l'autre) ; null si illisible. */
function capturer() {
    try {
        rendre();
        const src = renderer.domElement, k = Math.min(1, CAPTURE_LARGEUR / src.width);
        const c = document.createElement('canvas');
        c.width = Math.round(src.width * k); c.height = Math.round(src.height * k);
        c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
        return c.toDataURL('image/jpeg', 0.75);
    } catch (e) { return null; }
}

// Sans réseau, le signalement attend, gardé d'une session à l'autre : c'est
// souvent quand le sol manque que le réseau manque aussi.
const SIGNALEMENTS_CLE = 'vue3d-voiture-signalements', SIGNALEMENTS_GARDES = 3, SIGNALEMENT_RENVOI_MS = 30000;
let signalementsEnAttente = [];
try {
    signalementsEnAttente = JSON.parse(localStorage.getItem(SIGNALEMENTS_CLE) || '[]').filter(s => s && s.etat);
} catch (e) { /* stockage refusé ou illisible : aucun en attente */ }
function garderSignalements() {
    try { localStorage.setItem(SIGNALEMENTS_CLE, JSON.stringify(signalementsEnAttente)); }
    catch (e) {
        // Trop gros pour le stockage : les captures s'en vont, les états restent.
        try { localStorage.setItem(SIGNALEMENTS_CLE, JSON.stringify(signalementsEnAttente.map(s => ({ ...s, capture: null })))); }
        catch (e2) { /* stockage refusé : ils vivent le temps de la page */ }
    }
}
/** Le serveur n'en veut pas : le renvoyer n'y changerait rien. */
class SignalementRefuse extends Error {}
async function envoyerSignalement(s) {
    const arret = new AbortController(), minuterie = setTimeout(() => arret.abort(), 20000);
    try {
        const r = await fetch('api/signalement', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                    body: JSON.stringify(s), signal: arret.signal });
        const corps = await r.json().catch(() => ({}));
        if (r.ok) return corps.id;
        if (r.status === 429 || (r.status >= 500 && r.status !== 507)) throw new Error(`HTTP ${r.status}`);
        throw new SignalementRefuse(corps.erreur || `HTTP ${r.status}`);
    } finally { clearTimeout(minuterie); }
}

let signalementEnCours = false, dernierRenvoi = -Infinity;
export async function signaler() {
    if (signalementEnCours) return;
    signalementEnCours = true;
    boutonSignaler.classList.add('envoi');
    const s = { etat: etatDiagnostic(), capture: capturer() };
    try {
        const id = await envoyerSignalement(s);
        annoncer(`Signalement ${id} envoyé : capture, position et état du sol.`, 10);
    } catch (e) {
        if (e instanceof SignalementRefuse) {
            annoncer(`Signalement refusé : ${e.message}`, 10);
        } else {
            signalementsEnAttente.push(s);
            while (signalementsEnAttente.length > SIGNALEMENTS_GARDES) signalementsEnAttente.shift();
            garderSignalements();
            dernierRenvoi = performance.now();
            annoncer('Pas de réseau : le signalement partira dès qu\'il reviendra.', 8);
        }
    } finally {
        signalementEnCours = false;
        boutonSignaler.classList.remove('envoi');
    }
}
boutonSignaler.addEventListener('click', signaler);

export async function majSignalements(maintenant) {
    if (!signalementsEnAttente.length || signalementEnCours || maintenant - dernierRenvoi < SIGNALEMENT_RENVOI_MS) return;
    dernierRenvoi = maintenant;
    signalementEnCours = true;
    const s = signalementsEnAttente[0];
    try {
        const id = await envoyerSignalement(s);
        signalementsEnAttente.shift();
        const pris = new Date(s.etat.pris).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        annoncer(`Signalement ${id} envoyé (pris à ${pris}).`, 8);
    } catch (e) {
        if (e instanceof SignalementRefuse) signalementsEnAttente.shift();
    } finally {
        garderSignalements();
        signalementEnCours = false;
    }
}
