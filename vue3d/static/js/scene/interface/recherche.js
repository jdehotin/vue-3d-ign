// La recherche d'un lieu ou d'une entreprise, et le nom du point dans l'onglet.

import { POINT_DEFAUT, ACCUEIL, LAT0, LON0, PARAM_ZONE_LIEN } from '../socle/point.js';
import {
    URL_GEOCODAGE, RECHERCHE_MIN_CARACTERES, RECHERCHE_PAUSE_MS, lireCoordonnees, chercherLieux as chercher,
} from '../../commun/recherche.js';

// Nom du lieu choisi, gardé pour l'onglet seulement, jamais dans l'URL : une
// adresse tapée ne doit finir ni dans l'historique ni dans un lien partagé.
const CLE_LIEU = 'vue3d-lieu';

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
function chercherLieux(texte) {
    if (demandeLieux) demandeLieux.abort();
    demandeLieux = new AbortController();
    return chercher(texte, demandeLieux.signal);
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
