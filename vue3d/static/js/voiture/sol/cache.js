// Les tuiles gardées dans la voiture, et la relecture d'une tuile refusée.

import { DELAI_IMAGE_MS, chargerImage, lireAvecDelai, TuileAbsente } from './tuiles.js';
import { noterManquee, oublierManquee } from './manquees.js';

// Les tuiles de l'IGN (photo, plan, altitudes) n'ont aucun en-tête de cache
// (vérifié le 2026-10-20) : le navigateur les relisait à chaque trajet, sur
// le réseau mobile, et le serveur ne peut pas les relayer sans y user ses
// fils (l'IGN mettait ce jour-là de 0,3 à 6,7 s par tuile). La page les
// range elle-même dans le stockage du navigateur (Cache Storage, permanent
// en https) : un trajet refait se charge de là, même sans réseau. Au plus
// CACHE_TUILES_MAX tuiles (une photo ~20 Ko, une tuile d'altitude ~210 Ko :
// quelques centaines de mégaoctets), les plus anciennes rendues d'abord ; un
// cache par trimestre, l'ancien effacé, comme le stock du serveur qui purge à
// 90 jours : une nouvelle prise de vue de l'IGN arrive dans la voiture.
const CACHE_PREFIXE = 'vue3d-voiture-tuiles-';
const CACHE_TUILES_MAX = 15000, CACHE_PURGE_TOUTES = 400;
export const statsCache = { lues: 0, gardees: 0, reseau: 0, abimees: 0 };
let ecrituresCache = 0;
export const ouvertureCache = (async () => {
    try {
        if (!window.caches) return null;
        const d = new Date(), nom = `${CACHE_PREFIXE}${d.getFullYear()}T${Math.floor(d.getMonth() / 3) + 1}`;
        for (const autre of await caches.keys()) if (autre.startsWith(CACHE_PREFIXE) && autre !== nom) caches.delete(autre);
        // Que le navigateur ne l'efface pas de lui-même quand il manque de place.
        navigator.storage?.persist?.().catch(() => {});
        return await caches.open(nom);
    } catch (e) { return null; }        // navigation privée, stockage refusé : sans cache
})();

function garderEnCache(cache, url, reponse) {
    cache.put(url, reponse).then(async () => {
        statsCache.gardees++;
        if (++ecrituresCache % CACHE_PURGE_TOUTES) return;
        const cles = await cache.keys();
        for (const c of cles.slice(0, Math.max(cles.length - Math.floor(CACHE_TUILES_MAX * 0.9), 0))) await cache.delete(c);
    }).catch(() => {});
}

// Une tuile d'altitude est gardée entière ou pas du tout : 256 × 256
// flottants. Coupée par le réseau en plein corps, une réponse sortait 200,
// entrait au cache, et en était relue à chaque essai, refusée à chaque fois
// sans jamais repartir au réseau ni compter parmi les tuiles en attente. Dans
// une Tesla, le 23 octobre 2026, la tuile 8/66/263 (d'Aix et Gardanne
// jusqu'à Rousset) n'a ainsi plus laissé construire une seule tuile du zoom
// 13 : le sol retombait au zoom 12, une photo de 10 km agrandie sous la
// voiture, dès qu'une tuile plus fine manquait — en roulant, presque
// toujours. Une copie abîmée gardée avant cette vérification est effacée.
const ALTI_OCTETS = 256 * 256 * 4;
async function entiere(url, r) {
    if (!url.includes('LAYER=ELEVATION.')) return true;
    if (!(r.headers.get('content-type') || '').startsWith('image/x-bil')) return false;
    try { return (await r.clone().arrayBuffer()).byteLength === ALTI_OCTETS; } catch (e) { return false; }
}

/** La réponse de `url`, du cache de la voiture, sinon du réseau (gardée si elle est bonne). */
export async function lireEnCache(url, delai, noter = true) {
    const cache = await ouvertureCache;
    if (cache) {
        try {
            const r = await cache.match(url);
            if (r && await entiere(url, r)) { statsCache.lues++; return r; }
            if (r) { statsCache.abimees++; await cache.delete(url); }
        } catch (e) { /* cache illisible : le réseau */ }
    }
    let r;
    try { r = await lireAvecDelai(url, delai); }
    catch (e) { if (noter) noterManquee(url); throw e; }
    statsCache.reseau++;
    if (r.ok && await entiere(url, r)) {
        oublierManquee(url);
        if (cache) garderEnCache(cache, url, r.clone());
    } else if (noter && (r.ok || r.status >= 500 || r.status === 429)) {
        // Incomplète, comme une panne : redemandée plus tard.
        noterManquee(url);
    }
    return r;
}

// Une tuile refusée au navigateur est relue par le serveur, qui la garde
// (vue3d/tuiles.py) : l'IGN en refuse de loin en loin une qui existe. Deux à
// la fois, comme la page.
const RELECTURES_SIMULTANEES = 2;
let relecturesEnCours = 0;
const relecturesEnAttente = [];
export async function relireTuile(url) {
    if (relecturesEnCours >= RELECTURES_SIMULTANEES) await new Promise(r => relecturesEnAttente.push(r));
    relecturesEnCours++;
    try {
        for (let essai = 0; essai < 3; essai++) {
            const reponse = await lireAvecDelai(`${url}?relire=1`, DELAI_IMAGE_MS);
            if (reponse.ok) {
                // Gardée sous l'adresse de la tuile : le prochain trajet l'y trouve.
                const cache = await ouvertureCache;
                if (cache) garderEnCache(cache, url, reponse.clone());
                const lien = URL.createObjectURL(await reponse.blob());
                try { return await chargerImage(lien); } finally { URL.revokeObjectURL(lien); }
            }
            if (reponse.status === 404) throw new TuileAbsente(url);
            if (reponse.status !== 503) break;
            await new Promise(r => setTimeout(r, (Number(reponse.headers.get('retry-after')) || 2) * 1000));
        }
        throw new Error(`tuile non relue : ${url}`);
    } finally {
        relecturesEnCours--;
        relecturesEnAttente.shift()?.();
    }
}
