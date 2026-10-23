// Le panneau en tiroir, et le plein écran.

// En tiroir (html.tiroir, posée dans <head>), le panneau passe par-dessus la
// vue, qui garde tout l'écran. Le plein écran y met aussi le panneau : sans
// cela, il n'aurait plus été joignable.
const racine = document.documentElement;
const btnTiroir = document.getElementById('btn-tiroir');
/** Ouvre le tiroir, sur `section` si elle est donnée. */
export function ouvrirTiroir(section) {
    racine.classList.add('tiroir-ouvert');
    btnTiroir.setAttribute('aria-expanded', 'true');
    if (section) section.scrollIntoView({ block: 'start' });
}
export function fermerTiroir() {
    racine.classList.remove('tiroir-ouvert');
    btnTiroir.setAttribute('aria-expanded', 'false');
}
btnTiroir.addEventListener('click', () => ouvrirTiroir());
document.getElementById('btn-fermer-tiroir').addEventListener('click', fermerTiroir);
document.getElementById('voile').addEventListener('click', fermerTiroir);
// Échap ferme d'abord la liste des lieux, qui l'a déjà pris (defaultPrevented).
window.addEventListener('keydown', e => {
    if (e.code === 'Escape' && !e.defaultPrevented && racine.classList.contains('tiroir-ouvert')) {
        fermerTiroir();
    }
});

const btnPleinEcran = document.getElementById('btn-plein-ecran');
const elementPleinEcran = () => document.fullscreenElement || document.webkitFullscreenElement;
// L'iPhone n'a pas l'API, seulement la page ajoutée à l'écran d'accueil : pas
// de bouton qui ne ferait rien.
btnPleinEcran.hidden = !(document.fullscreenEnabled || document.webkitFullscreenEnabled);
btnPleinEcran.addEventListener('click', () => {
    const p = elementPleinEcran()
        ? (document.exitFullscreen || document.webkitExitFullscreen).call(document)
        : (racine.requestFullscreen || racine.webkitRequestFullscreen).call(racine);
    if (p && p.catch) p.catch(() => {});
});
function majPleinEcran() {
    const plein = !!elementPleinEcran();
    racine.classList.toggle('plein-ecran', plein);
    const libelle = plein ? 'Quitter le plein écran' : 'Plein écran';
    btnPleinEcran.title = libelle;
    btnPleinEcran.setAttribute('aria-label', libelle);
    window.majTiroir();
    btnPleinEcran.blur();
}
document.addEventListener('fullscreenchange', majPleinEcran);
document.addEventListener('webkitfullscreenchange', majPleinEcran);
