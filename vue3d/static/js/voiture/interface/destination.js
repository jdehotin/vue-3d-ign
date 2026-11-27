// La destination : un lieu, une adresse ou une entreprise, cherchés comme
// dans la page de la scène ; la page repart vers lui.

import { PARAMS } from '../socle/parametres.js';
import { VERS, CLE_DESTINATION } from '../socle/etat.js';
import {
    RECHERCHE_MIN_CARACTERES, RECHERCHE_PAUSE_MS, lireCoordonnees, chercherLieux,
} from '../../commun/recherche.js';

// La page lit sa destination dans son URL (`vers=lat,lon`) : la choisir la
// recharge, comme un point choisi recharge la scène. Le graphe, les carrés
// et le sol se refont du cache du navigateur.
const fenetre = document.getElementById('destination');
const champ = document.getElementById('in-destination');
const liste = document.getElementById('destinations');
const boutonSans = document.getElementById('b-sans-destination');
let lieux = [], actif = -1, demande = null, minuterie = 0;

function ouvrir() {
    fenetre.hidden = false;
    boutonSans.hidden = !VERS;
    champ.value = '';
    montrer([]);
    champ.focus();
}
function fermer() {
    fenetre.hidden = true;
    if (demande) demande.abort();
}

/** L'URL de la page vers `l` ({ lat, lon }), ou sans destination. */
function urlVers(l) {
    const p = new URLSearchParams(PARAMS);
    for (const k of ['vers', 'versnom', 'par']) p.delete(k);
    if (l) p.set('vers', `${l.lat.toFixed(6)},${l.lon.toFixed(6)}`);
    return '?' + p;
}
function allerVers(l) {
    try {
        if (l.coordonnees) sessionStorage.removeItem(CLE_DESTINATION);
        else sessionStorage.setItem(CLE_DESTINATION, JSON.stringify({ lat: Number(l.lat.toFixed(6)), lon: Number(l.lon.toFixed(6)), nom: l.nom }));
    } catch (e) { /* stockage refusé : la destination n'aura pas de nom */ }
    location.search = urlVers(l);
}

function montrer(l, message) {
    lieux = l;
    actif = -1;
    liste.replaceChildren(...(l.length ? l.map((lieu, i) => {
        const li = document.createElement('li');
        li.id = `destination-${i}`;
        li.setAttribute('role', 'option');
        li.append(lieu.nom);
        if (lieu.detail) li.append(Object.assign(document.createElement('small'), { textContent: lieu.detail }));
        li.addEventListener('click', () => allerVers(lieu));
        return li;
    }) : message ? [Object.assign(document.createElement('li'), { className: 'message', textContent: message })] : []));
    liste.hidden = !liste.children.length;
    champ.setAttribute('aria-expanded', String(!liste.hidden));
}

async function suggerer() {
    const texte = champ.value.trim();
    if (texte.length < RECHERCHE_MIN_CARACTERES && !lireCoordonnees(texte)) { montrer([]); return; }
    if (demande) demande.abort();
    demande = new AbortController();
    try {
        const l = await chercherLieux(texte, demande.signal);
        if (l && champ.value.trim() === texte) montrer(l, 'Aucun lieu trouvé en France métropolitaine.');
    } catch (e) {
        if (e.name !== 'AbortError') montrer([], 'Recherche indisponible : le géocodage de l\'IGN ne répond pas.');
    }
}

document.getElementById('b-destination').addEventListener('click', ouvrir);
document.getElementById('b-fermer-destination').addEventListener('click', fermer);
boutonSans.addEventListener('click', () => {
    try { sessionStorage.removeItem(CLE_DESTINATION); } catch (e) { /* rien à oublier */ }
    location.search = urlVers(null);
});
fenetre.addEventListener('click', e => { if (e.target === fenetre) fermer(); });
champ.addEventListener('input', () => {
    clearTimeout(minuterie);
    minuterie = setTimeout(suggerer, RECHERCHE_PAUSE_MS);
});
champ.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); fermer(); return; }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && lieux.length) {
        e.preventDefault();
        actif = (actif + (e.key === 'ArrowDown' ? 1 : actif < 0 ? 0 : -1) + lieux.length) % lieux.length;
        [...liste.children].forEach((li, j) => li.setAttribute('aria-selected', String(j === actif)));
        champ.setAttribute('aria-activedescendant', liste.children[actif].id);
    }
});
// Entrée : la suggestion désignée, sinon la première, cherchée sur-le-champ
// si la liste n'est pas encore venue.
document.getElementById('form-destination').addEventListener('submit', async e => {
    e.preventDefault();
    if (actif >= 0 && lieux[actif]) { allerVers(lieux[actif]); return; }
    clearTimeout(minuterie);
    await suggerer();
    if (lieux.length) allerVers(lieux[0]);
});
