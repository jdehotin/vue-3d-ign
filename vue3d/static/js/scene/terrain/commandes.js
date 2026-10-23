// Le bouton du relief et le curseur d'exagération.

import { relief, exagVert, reglerRelief } from './etat.js';
import { appliquerExageration, appliquerRelief } from './relief.js';

const btnRelief = document.getElementById('t-relief');
btnRelief.addEventListener('click', () => {
    reglerRelief(!relief);
    btnRelief.classList.toggle('on', relief);
    appliquerRelief();
});

const curseurExag = document.getElementById('exag');
const valeurExag = document.getElementById('s-exag');
curseurExag.addEventListener('input', () => {
    reglerRelief(relief, Number(curseurExag.value));
    valeurExag.textContent = `×${exagVert}`;
    // Toucher au curseur rallume le relief ; c'est le seul cas où le fond doit
    // être reposé, d'où les deux chemins.
    if (!relief) { reglerRelief(true); btnRelief.classList.add('on'); appliquerRelief(); }
    else appliquerExageration();
});
valeurExag.textContent = `×${exagVert}`;
