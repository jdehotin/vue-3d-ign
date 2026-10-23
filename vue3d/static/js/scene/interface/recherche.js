// La recherche d'un lieu ou d'une entreprise, et le nom du point dans l'onglet.

import { POINT_DEFAUT, ACCUEIL, LAT0, LON0, PARAM_ZONE_LIEN } from '../socle/point.js';

// Le géocodage de la Géoplateforme : adresses de la Base Adresse Nationale et
// lieux nommés de l'IGN (« Château de Chambord »), sans clé, appelé par le
// navigateur — le service répond à toute origine. Son quota, 50 requêtes par
// seconde, est compté par adresse IP : chaque visiteur a le sien, le serveur
// n'y prend aucune part.
//
// Ses deux index sont lus séparément : demandés ensemble, ils sont rangés sur
// un seul score, où toute rue de la commune passe devant le lieu nommé —
// « mairie bouc bel air » : quinze rues de Bouc-Bel-Air de 0,42 à 0,54, la
// mairie à 0,39, hors de la liste ; avec « de », elle était en tête.
const URL_GEOCODAGE = 'https://data.geopf.fr/geocodage';
// Les entreprises et commerces, que l'IGN ne nomme pas (une boulangerie, un
// cabinet) : l'API Recherche d'entreprises de l'État, sur le répertoire
// SIRENE de l'INSEE, elle aussi sans clé et ouverte à toute origine, 7
// requêtes par seconde et par adresse IP.
const URL_ENTREPRISES = 'https://recherche-entreprises.api.gouv.fr/search';
// Rien sous trois caractères (« go » rend des milliers de lieux), et une
// requête par pause de la frappe, la précédente annulée.
const RECHERCHE_MIN_CARACTERES = 3;
const RECHERCHE_PAUSE_MS = 250;
// Demandés en plus de ceux montrés : l'outre-mer et les doublons sont retirés
// après coup — « gordes » rend la commune trois fois (lieu nommé, lieu-dit,
// commune de la BAN) et « fort de france » met la Martinique en tête. Les
// entreprises qui ne portent pas les mots tapés dans leur nom sont écartées.
const RECHERCHE_DEMANDES = 15;
const ENTREPRISES_DEMANDEES = 10;
const ENTREPRISES_MONTREES = 3;
const SUGGESTIONS_MAX = 8;
// Une entreprise qui porte tout le nom d'un lieu nommé déjà proposé, à moins
// de DOUBLON_LIEU_M, est ce lieu : les sociétés du musée d'Orsay sont à 97 à
// 122 m du lieu de l'IGN, les associations d'Airbus Helicopters à 186 et
// 662 m de l'usine (son comité d'entreprise, à 2,7 km, reste). Deux
// entreprises à moins de DOUBLON_ADRESSE_M sont à la même adresse : 0 à 26 m
// entre celles d'Orsay, 0 m entre celles d'Airbus.
const DOUBLON_LIEU_M = 1000;
const DOUBLON_ADRESSE_M = 30;
// Mots qui ne disent rien du lieu : « mairie de bouc bel air » et « mairie
// bouc-bel-air » cherchent la même chose.
const MOTS_VIDES = new Set(['a', 'au', 'aux', 'd', 'de', 'des', 'du', 'en', 'et', 'l', 'la', 'le', 'les',
                            'pres', 'sous', 'sur']);
// Nom du lieu choisi, gardé pour l'onglet seulement, jamais dans l'URL : une
// adresse tapée ne doit finir ni dans l'historique ni dans un lien partagé.
const CLE_LIEU = 'vue3d-lieu';

/**
 * Coordonnées tapées ou collées — « 43.4715, 5.4861 », « 43,4715 5,4861 »,
 * ou dans l'ordre longitude, latitude —, sinon null : le texte est une
 * adresse. Chaque nombre a sa partie décimale, sans quoi « 45 5 » ou « 43,5 »
 * en cours de frappe passeraient pour des coordonnées. Reconnues en France
 * métropolitaine seulement, la seule couverte : latitude de 41 à 51,2,
 * longitude de -5,3 à 9,7 ; les deux plages ne se recoupent pas, ce qui dit
 * l'ordre.
 */
function lireCoordonnees(texte) {
    const m = /^\s*(-?\d{1,3}[.,]\d+)\s*[,;\s]\s*(-?\d{1,3}[.,]\d+)\s*$/.exec(texte || '');
    if (!m) return null;
    const [a, b] = [m[1], m[2]].map(v => Number(v.replace(',', '.')));
    const estLat = v => v >= 41 && v <= 51.2, estLon = v => v >= -5.3 && v <= 9.7;
    if (estLat(a) && estLon(b)) return { lat: a, lon: b };
    if (estLon(a) && estLat(b)) return { lat: b, lon: a };
    return null;
}

/**
 * Suggestions tirées d'une réponse du géocodage, dans son ordre de score :
 * [{ nom, detail, lat, lon }], au plus `max`. L'outre-mer est écarté (le
 * lieu nommé le dit par `territory`, l'adresse par son code postal en 97 ou
 * 98), ainsi qu'un nom déjà vu avec le même code postal.
 */
function suggestionsDe(reponse, max) {
    const vues = new Set(), out = [];
    for (const f of (reponse && reponse.features) || []) {
        const p = f.properties || {};
        const [lon, lat] = (f.geometry && f.geometry.coordinates) || [];
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        let nom, detail, cp;
        if (p._type === 'poi') {
            if (p.territory && p.territory !== 'METROPOLE') continue;
            cp = (p.postcode || [])[0] || '';
            nom = p.toponym || (p.name || [])[0];
            const commune = (p.city || [])[0];
            // « administratif » précède « commune » : c'est le second qui parle.
            const genre = (p.category || []).find(c => c !== 'administratif');
            detail = [genre, commune && commune !== nom ? commune : null, cp].filter(Boolean).join(' · ');
        } else {
            cp = p.postcode || '';
            if (/^9[78]/.test(cp)) continue;
            if (p.type === 'municipality') {
                nom = p.city || p.name;
                detail = ['commune', (p.context || '').split(', ').slice(0, 2).join(' ')]
                    .filter(Boolean).join(' · ');
            } else {
                nom = p.name;
                detail = [cp, p.city].filter(Boolean).join(' ');
            }
        }
        if (!nom) continue;
        const cle = nom.toLocaleLowerCase('fr') + '|' + cp;
        if (vues.has(cle)) continue;
        vues.add(cle);
        out.push({ nom, detail, lat, lon, cle, poi: p._type === 'poi', score: p.score || 0 });
        if (out.length >= max) break;
    }
    return out;
}

/** Les mots d'un texte, sans accents, sans casse et sans mots vides. */
function motsDe(texte) {
    return String(texte || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .split(/[^a-z0-9]+/).filter(m => m && !MOTS_VIDES.has(m));
}

/**
 * Tous les mots tapés sont parmi `mots`, au singulier comme au pluriel
 * (« notaire » : « Aix Mistral Notaires »), ou au début de l'un d'eux à
 * partir de quatre lettres (« recharge » : « Borne de rechargement
 * électrique ») ; le dernier, peut-être en cours de frappe, toujours au début
 * de l'un d'eux. Rien de tapé, rien de couvert.
 */
function couvre(tapes, mots) {
    const racine = w => (w.length > 3 ? w.replace(/[sx]$/, '') : w);
    const racines = mots.map(racine);
    return tapes.length > 0 && tapes.every((m, i) => {
        const r = racine(m);
        return i === tapes.length - 1 || r.length >= 4 ? racines.some(x => x.startsWith(r)) : racines.includes(r);
    });
}

/** Un nom en capitales du répertoire SIRENE, en casse de titre. */
function casseTitre(texte) {
    if (/\p{Ll}/u.test(texte)) return texte;
    return texte.toLocaleLowerCase('fr')
        .replace(/(^|[\s\-'’(])(\p{L})/gu, (_, avant, c) => avant + c.toLocaleUpperCase('fr'))
        // Les petits mots restent en minuscules, sauf en tête : « Aix-en-Provence ».
        .replace(/([ -])(De|Du|Des|La|Le|Les|Et|En|Sur|Sous|Au|Aux|À)(?=[ -])/g, m => m.toLocaleLowerCase('fr'));
}

/**
 * Entreprises tirées d'une réponse de l'API Recherche d'entreprises, dans son
 * ordre : [{ nom, detail, lat, lon, cle, entreprise }], au plus `max`. Seules
 * restent celles dont le nom ou l'enseigne, avec la commune, porte tous les
 * mots tapés, et le nom au moins l'un : l'API rend aussi des homonymes
 * lointains (« gordes » : une société « Gord » à Moulins). Un entrepreneur
 * individuel porte le nom d'une personne : il n'est trouvé que par son
 * enseigne, jamais par ce nom. L'établissement retenu est celui qui répond à
 * la recherche — une boulangerie de Bouc-Bel-Air dont le siège est à Aix —,
 * sinon le siège.
 */
function suggestionsEntreprises(reponse, tapes, max) {
    const out = [];
    for (const r of (reponse && reponse.results) || []) {
        // Cessée (C) pour l'entreprise, fermé (F) pour l'établissement : la
        // requête ne demande que les entreprises actives, mais l'une d'elles
        // peut avoir fermé l'établissement trouvé.
        if (r.etat_administratif === 'C') continue;
        const e = (r.matching_etablissements || []).find(m => m.etat_administratif !== 'F' && m.latitude && m.longitude)
            || r.siege || {};
        if (e.etat_administratif === 'F') continue;
        const lat = Number(e.latitude), lon = Number(e.longitude), cp = e.code_postal || '';
        if (!e.latitude || !e.longitude || !Number.isFinite(lat) || !Number.isFinite(lon) || /^9[78]/.test(cp)) continue;
        const enseigne = (e.liste_enseignes || [])[0] || '';
        const individuel = r.nature_juridique === '1000';
        // « AUCHAN CARBURANT (AUCHAN CARBURANT) (AUCHAN CARBURANT) » : les
        // parenthèses qui répètent le nom tombent.
        const complet = r.nom_complet || '';
        const nomSocial = complet.replace(/\s*\(([^()]*)\)/g, (tout, dedans) => (complet.startsWith(dedans) ? '' : tout)).trim();
        const motsNom = [...new Set(motsDe(individuel ? enseigne : `${nomSocial} ${enseigne}`))];
        if (!motsNom.length) continue;
        const commune = e.libelle_commune || '';
        if (!couvre(tapes, [...motsNom, ...motsDe(commune)])) continue;
        if (!tapes.some(m => motsNom.some(x => x.startsWith(m)))) continue;
        // Le nom montré est celui qui répond à la recherche : l'enseigne si
        // elle porte un mot tapé, sinon la société, l'enseigne en détail —
        // « auchan aubagne » : « Auchan Supermarche », enseigne « Simply
        // Market ». Jamais le nom d'un entrepreneur individuel.
        const parEnseigne = Boolean(enseigne) && (individuel || tapes.some(m => motsDe(enseigne).some(x => x.startsWith(m))));
        const nom = casseTitre(parEnseigne ? enseigne : nomSocial);
        const detailEnseigne = enseigne && !parEnseigne ? casseTitre(enseigne) : '';
        // Mots du nom que la recherche ne demandait pas : « Airbus
        // Helicopters » (aucun) passe devant le « Syndicat FO Airbus
        // Helicopters Marignane » (deux), que l'API classait premier.
        const enTrop = motsNom.filter(x => !tapes.some(m => x.startsWith(m))).length;
        out.push({ nom, detail: ['entreprise', detailEnseigne, [cp, casseTitre(commune)].filter(Boolean).join(' ')]
                                    .filter(Boolean).join(' · '),
                   lat, lon, cle: nom.toLocaleLowerCase('fr') + '|' + cp, entreprise: true, mots: motsNom, enTrop });
    }
    return out.sort((a, b) => a.enTrop - b.enTrop).slice(0, max);
}

/**
 * Les suggestions des trois sources en une liste d'au plus `max` : d'abord
 * les lieux nommés et les adresses qui portent tous les mots tapés, puis les
 * entreprises (ENTREPRISES_MONTREES au plus, toutes les portent), enfin les
 * autres lieux et adresses. Lieux et adresses gardent l'ordre du score du
 * géocodage, commun aux deux index : sans mot couvert, « 12 rue de la
 * republique aix en provence » mettait sinon un parking de Saint-Rémy avant
 * les adresses. Un même nom au même code postal n'y est qu'une fois ; une
 * entreprise n'y est pas quand un lieu proposé ou une autre entreprise est
 * déjà là (DOUBLON_LIEU_M, DOUBLON_ADRESSE_M).
 */
function fusionnerLieux(texte, { lieux, entreprises, adresses }, max) {
    const tapes = motsDe(texte);
    const vues = new Set(), out = [];
    let nbEntreprises = 0;
    const distance = (a, b) => Math.hypot((a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180),
                                          (a.lat - b.lat) * 111320);
    const doublon = (e, o) => o.poi
        ? distance(o, e) < DOUBLON_LIEU_M && motsDe(o.nom).every(m => e.mots.includes(m))
        : o.entreprise && distance(o, e) < DOUBLON_ADRESSE_M;
    const ajouter = l => {
        if (out.length >= max || vues.has(l.cle)) return;
        if (l.entreprise) {
            if (nbEntreprises >= ENTREPRISES_MONTREES || out.some(o => doublon(l, o))) return;
            nbEntreprises++;
        }
        vues.add(l.cle);
        out.push(l);
    };
    const couvert = l => couvre(tapes, motsDe(`${l.nom} ${l.detail}`));
    const parScore = (a, b) => b.score - a.score;
    const lieuxEtAdresses = [...lieux, ...adresses];
    lieuxEtAdresses.filter(couvert).sort(parScore).forEach(ajouter);
    entreprises.forEach(ajouter);
    lieuxEtAdresses.filter(l => !couvert(l)).sort(parScore).forEach(ajouter);
    return out;
}

const champLieu = document.getElementById('in-lieu');
const listeLieux = document.getElementById('suggestions');
let lieux = [];             // suggestions montrées
let texteLieux = null;      // le texte qui les a données
let lieuActif = -1;         // celle que désignent les flèches
let demandeLieux = null;    // AbortController de la recherche en cours
let minuterieLieux = 0;

function fermerLieux() {
    listeLieux.hidden = true;
    champLieu.setAttribute('aria-expanded', 'false');
    champLieu.removeAttribute('aria-activedescendant');
}

/** Montre `liste`, ou `message` à sa place quand elle est vide. */
function montrerLieux(liste, message) {
    lieux = liste;
    lieuActif = -1;
    listeLieux.replaceChildren(...(liste.length ? liste.map((l, i) => {
        const li = document.createElement('li');
        li.id = `lieu-${i}`;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', 'false');
        li.append(l.nom);
        if (l.detail) {
            const petit = document.createElement('small');
            petit.textContent = l.detail;
            li.append(petit);
        }
        // Au mousedown, le champ perdrait le focus et fermerait la liste
        // avant le clic.
        li.addEventListener('mousedown', e => e.preventDefault());
        li.addEventListener('click', () => allerAuLieu(l));
        return li;
    }) : message ? [Object.assign(document.createElement('li'),
                                  { className: 'message', textContent: message })] : []));
    listeLieux.hidden = !listeLieux.children.length;
    champLieu.setAttribute('aria-expanded', String(!listeLieux.hidden));
    champLieu.removeAttribute('aria-activedescendant');
}

function activerLieu(i) {
    if (!lieux.length) return;
    lieuActif = (i + lieux.length) % lieux.length;
    [...listeLieux.children].forEach((li, j) => li.setAttribute('aria-selected', String(j === lieuActif)));
    const li = listeLieux.children[lieuActif];
    champLieu.setAttribute('aria-activedescendant', li.id);
    li.scrollIntoView({ block: 'nearest' });
}

function allerAuLieu(l) {
    try {
        if (l.coordonnees) sessionStorage.removeItem(CLE_LIEU);
        else sessionStorage.setItem(CLE_LIEU, JSON.stringify({ lat: l.lat, lon: l.lon, nom: l.nom }));
    } catch (e) { /* stockage refusé : le nom viendra de la commune */ }
    location.search = `?lat=${l.lat}&lon=${l.lon}${PARAM_ZONE_LIEN}`;
}

/** Suggestions pour `texte` ; null si une frappe plus récente l'a annulée. */
async function chercherLieux(texte) {
    const coord = lireCoordonnees(texte);
    if (coord) return [{ ...coord, nom: `${coord.lat}, ${coord.lon}`, detail: 'coordonnées', coordonnees: true }];
    if (demandeLieux) demandeLieux.abort();
    const demande = demandeLieux = new AbortController();
    const lire = async url => {
        const r = await fetch(url, { signal: demande.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
    };
    const geocodage = index => lire(`${URL_GEOCODAGE}/search?` + new URLSearchParams({
        q: texte, autocomplete: 1, index, limit: RECHERCHE_DEMANDES }));
    const [lieuxNommes, entreprises, adresses] = await Promise.allSettled([
        geocodage('poi'),
        // Les entreprises en activité seulement : sans ce filtre, les trois
        // boulangeries de « boulangerie bouc bel air » étaient fermées.
        lire(`${URL_ENTREPRISES}?` + new URLSearchParams({
            q: texte, per_page: ENTREPRISES_DEMANDEES, etat_administratif: 'A', minimal: true,
            include: 'siege,matching_etablissements' })),
        geocodage('address'),
    ]);
    if (demande.signal.aborted) return null;
    // L'IGN fait la recherche ; les entreprises ne sont qu'un plus, et leur
    // panne ou leur quota (429) ne la privent que d'elles.
    if (lieuxNommes.status === 'rejected' && adresses.status === 'rejected') throw adresses.reason;
    const valeur = (p, lire) => (p.status === 'fulfilled' ? lire(p.value) : []);
    return fusionnerLieux(texte, {
        lieux: valeur(lieuxNommes, r => suggestionsDe(r, RECHERCHE_DEMANDES)),
        entreprises: valeur(entreprises, r => suggestionsEntreprises(r, motsDe(texte), ENTREPRISES_DEMANDEES)),
        adresses: valeur(adresses, r => suggestionsDe(r, RECHERCHE_DEMANDES)),
    }, SUGGESTIONS_MAX);
}

async function suggererLieux() {
    const texte = champLieu.value.trim();
    if (texte.length < RECHERCHE_MIN_CARACTERES && !lireCoordonnees(texte)) { montrerLieux([]); return; }
    try {
        const liste = await chercherLieux(texte);
        if (liste && champLieu.value.trim() === texte) {
            montrerLieux(liste, 'Aucun lieu trouvé en France métropolitaine.');
            texteLieux = texte;
        }
    } catch (e) {
        montrerLieux([], 'Recherche indisponible : le géocodage de l\'IGN ne répond pas.');
    }
}

champLieu.addEventListener('input', () => {
    clearTimeout(minuterieLieux);
    minuterieLieux = setTimeout(suggererLieux, RECHERCHE_PAUSE_MS);
});
champLieu.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (listeLieux.hidden && lieux.length) montrerLieux(lieux);
        activerLieu(lieuActif + (e.key === 'ArrowDown' ? 1 : lieuActif < 0 ? 0 : -1));
    } else if (e.key === 'Escape' && !listeLieux.hidden) {
        e.preventDefault();
        fermerLieux();
    }
});
champLieu.addEventListener('focus', () => { if (lieux.length) montrerLieux(lieux); });
champLieu.addEventListener('blur', fermerLieux);
// Entrée ou « Voir » : la suggestion désignée, sinon la première — cherchée
// sur-le-champ si la frappe n'a pas encore laissé à la liste le temps de venir.
document.getElementById('form-point').addEventListener('submit', async e => {
    e.preventDefault();
    if (lieuActif >= 0 && !listeLieux.hidden) { allerAuLieu(lieux[lieuActif]); return; }
    clearTimeout(minuterieLieux);
    const texte = champLieu.value.trim();
    if (texte.length < RECHERCHE_MIN_CARACTERES && !lireCoordonnees(texte)) return;
    if (lieux.length && texteLieux === texte) { allerAuLieu(lieux[0]); return; }
    try {
        const liste = await chercherLieux(texte);
        if (!liste) return;
        if (liste.length) allerAuLieu(liste[0]);
        else montrerLieux([], 'Aucun lieu trouvé en France métropolitaine.');
    } catch (err) {
        montrerLieux([], 'Recherche indisponible : le géocodage de l\'IGN ne répond pas.');
    }
});

// Nom du point, au-dessus de ses coordonnées : celui choisi dans la liste si
// c'est bien ce point, sinon la commune, par géocodage inverse. Pas le lieu
// nommé le plus proche : il est trop souvent anodin — « Poste de gaz » à 48 m
// du point de Gardanne, « Poste de Gordes » avant le château, « Clocher » à
// Notre-Dame. Sans réponse, les coordonnées suffisent.
// L'onglet prend l'adresse postale du point, la plus proche selon le même
// géocodage : il n'en rend pas au-delà de 200 à 300 m (au château de
// Chambord, 190 m à 150 m au nord, rien à 300 m), et sur quinze lieux publics
// elle est à 2 à 126 m du point (l'Arc de Triomphe, Versailles). Le nom
// choisi dans la liste la précède (« Arc de Triomphe — 9 Place Charles de
// Gaulle, 75116 Paris »), sauf s'il y est déjà : une adresse, une commune.
// Sans adresse, en forêt ou sur l'eau, l'onglet prend le nom du panneau.
(async () => {
    const nomPoint = document.getElementById('nom-point');
    let nom = ACCUEIL ? POINT_DEFAUT.nom : null, adresse = null;
    try {
        const l = JSON.parse(sessionStorage.getItem(CLE_LIEU) || 'null');
        if (l && Math.abs(l.lat - LAT0) < 1e-7 && Math.abs(l.lon - LON0) < 1e-7) nom = l.nom;
    } catch (e) { /* stockage refusé ou illisible */ }
    const choisi = nom;
    try {
        const r = await fetch(`${URL_GEOCODAGE}/reverse?` + new URLSearchParams({
            lat: LAT0, lon: LON0, index: 'address', limit: 1 }));
        const p = r.ok ? (((await r.json()).features || [])[0] || {}).properties : null;
        if (p && p.city) {
            const commune = p.postcode ? `${p.city} (${p.postcode})` : p.city;
            nom = nom || commune;
            adresse = p.name && p.name !== p.city ? `${p.name}, ${[p.postcode, p.city].filter(Boolean).join(' ')}` : commune;
        }
    } catch (e) { /* le nom n'est qu'un confort */ }
    if (nom) { nomPoint.textContent = nom; nomPoint.hidden = false; }
    const dedans = (a, b) => a.toLocaleLowerCase('fr').includes(b.toLocaleLowerCase('fr'));
    const titre = [...new Set([choisi && !(adresse && dedans(adresse, choisi)) ? choisi : null, adresse || nom])].filter(Boolean);
    if (titre.length) document.title = `${titre.join(' — ')} · Vue 3D IGN`;
})();
