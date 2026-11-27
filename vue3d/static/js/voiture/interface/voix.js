// Le guidage à voix haute : la prochaine manœuvre, de loin puis de près,
// l'arrivée, un nouvel itinéraire. Coupé par défaut ; le choix est gardé.

const POSSIBLE = typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance === 'function';
const CLE = 'vue3d-voix';
let active = false;
try { active = POSSIBLE && localStorage.getItem(CLE) === '1'; } catch (e) { /* stockage refusé : coupée */ }

const bouton = document.getElementById('b-voix');
bouton.hidden = !POSSIBLE;
function majBouton() {
    bouton.classList.toggle('on', active);
    bouton.setAttribute('aria-pressed', String(active));
    bouton.title = active ? 'Couper la voix du guidage' : 'Guidage à voix haute';
}
majBouton();
bouton.addEventListener('click', () => {
    active = !active;
    try { localStorage.setItem(CLE, active ? '1' : '0'); } catch (e) { /* le choix vaut pour cette page */ }
    majBouton();
    // Dit dans le geste même : un navigateur peut refuser de parler sans lui.
    if (active) dire('Guidage vocal activé'); else window.speechSynthesis.cancel();
});

function dire(texte) {
    if (!active) return;
    const u = new SpeechSynthesisUtterance(texte);
    u.lang = 'fr-FR';
    const voix = window.speechSynthesis.getVoices().find(v => v.lang && v.lang.startsWith('fr'));
    if (voix) u.voice = voix;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
}

const ORDINAUX = ['', 'première', 'deuxième', 'troisième', 'quatrième', 'cinquième', 'sixième', 'septième', 'huitième'];
const COTE = angle => angle > 0 ? 'à droite' : 'à gauche';
/** La consigne d'une manœuvre (route/guidage), dite. */
function phrase(m) {
    const ab = Math.abs(m.angle);
    switch (m.type) {
        case 'demi-tour': return 'faites demi-tour';
        case 'rond-point': return m.sortie && ORDINAUX[m.sortie] ? `au rond-point, prenez la ${ORDINAUX[m.sortie]} sortie` : 'au rond-point';
        case 'sortir': return 'sortez du rond-point';
        case 'sortie': return `prenez la sortie ${COTE(m.angle)}`;
        case 'serrer': return `serrez à ${m.cote}`;
        case 'tourner': return ab < 60 ? `tournez légèrement ${COTE(m.angle)}` : ab < 135 ? `tournez ${COTE(m.angle)}` : `tournez franchement ${COTE(m.angle)}`;
        default: return null;
    }
}
const distanceDite = d => d >= 1000 ? `${(d / 1000).toFixed(1).replace('.0', '').replace('.', ',')} kilomètres`
    : `${Math.round(d / (d < 100 ? 10 : 50)) * (d < 100 ? 10 : 50)} mètres`;
const majuscule = t => t[0].toUpperCase() + t.slice(1);

// Deux fois par manœuvre : de loin, à vingt secondes de route (de 200 m à
// 1,2 km), avec la distance et la voie ; de près, à six secondes (de 40 à
// 300 m), la consigne seule.
const dites = new Map();
let demandes = 1, arrivee = false;
/**
 * Dit ce qu'il faut de la manœuvre `m` (avec `nom`, la voie où elle mène),
 * pour qui roule à `v` m/s ; `etat` et `nbDemandes` : ceux du guidage.
 */
export function direGuidage(m, nom, v, etat, nbDemandes) {
    if (nbDemandes > demandes) {
        demandes = nbDemandes;
        if (etat === 'suivi') { dites.clear(); dire('Nouvel itinéraire'); return; }
    }
    if (etat === 'arrivee' || m?.type === 'arrivee' && m.d < Math.min(Math.max(v * 6, 40), 300)) {
        if (!arrivee) { arrivee = true; dire('Vous êtes arrivé'); }
        return;
    }
    const texte = m && phrase(m);
    if (!texte) return;
    const cle = `${m.type}:${m.vers ? m.vers.id : ''}:${Math.round(m.t ?? 0)}`;
    const pres = Math.min(Math.max(v * 6, 40), 300), loin = Math.min(Math.max(v * 20, 200), 1200);
    const deja = dites.get(cle);
    if (m.d <= pres && deja !== 'pres') {
        dites.set(cle, 'pres');
        dire(majuscule(texte));
    } else if (m.d <= loin && m.d > pres + 30 && !deja) {
        dites.set(cle, 'loin');
        dire(`Dans ${distanceDite(m.d)}, ${texte}${nom ? ', ' + nom : ''}`);
    }
    if (dites.size > 200) dites.delete(dites.keys().next().value);
}
