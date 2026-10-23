// La prise en main.

import { fermerTiroir } from './tiroir.js';
import { TACTILE, droneActif, sortirDrone } from './drone.js';

// Ouverte d'elle-même à la première visite, pendant que la scène se construit
// (de 1 à 30 s pour un lieu neuf) ; ensuite par « ? ». Les gestes suivent
// l'appareil : au doigt si l'écran est tactile — une Tesla annonce un pointeur
// fin, mais des points de contact —, avec une bascule pour l'écran tactile
// tenu à la souris. Un navigateur piloté (essais, démos filmées) ne la voit
// pas s'ouvrir seule : elle masquerait la scène qu'il éprouve.
const tuto = document.getElementById('tuto');
const CLE_TUTO = 'vue3d.tuto-vu';
function modeTuto(mode) {
    for (const b of tuto.querySelectorAll('.tuto-mode button')) {
        b.setAttribute('aria-checked', String(b.dataset.mode === mode));
    }
    for (const s of tuto.querySelectorAll('[data-doigt]')) {
        s.textContent = mode === 'doigt' ? s.dataset.doigt : s.dataset.souris;
    }
}
function ouvrirTuto() {
    if (tuto.open) return;
    // Les flèches et l'espace du drone ne doivent pas courir sous le guide.
    if (droneActif) sortirDrone();
    if (document.documentElement.classList.contains('tiroir-ouvert')) fermerTiroir();
    tuto.showModal();
    tuto.querySelector('.tuto-ok').focus();
}
modeTuto(TACTILE ? 'doigt' : 'souris');
for (const b of tuto.querySelectorAll('.tuto-mode button')) b.addEventListener('click', () => modeTuto(b.dataset.mode));
document.getElementById('btn-aide').addEventListener('click', ouvrirTuto);
// Un toucher sur le voile, hors du cadre, le ferme aussi.
tuto.addEventListener('click', e => { if (e.target === tuto) tuto.close(); });
tuto.addEventListener('close', () => { try { localStorage.setItem(CLE_TUTO, '1'); } catch (e) { /* navigation privée */ } });
let tutoVu = false;
try { tutoVu = localStorage.getItem(CLE_TUTO) === '1'; } catch (e) { /* navigation privée : il s'ouvrira à chaque visite */ }
if (!tutoVu && !navigator.webdriver) ouvrirTuto();
