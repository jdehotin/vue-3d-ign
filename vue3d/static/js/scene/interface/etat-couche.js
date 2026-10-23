// L'indicateur de chargement d'une couche à part, et ses reprises.

// Les couches à part (monuments, ouvrages, nuage) : quatre essais, à 30 s
// l'un de l'autre.
export const ESSAIS_MONUMENTS = 4;
export const ATTENTE_MONUMENTS_S = 30;

// Une couche déjà en cache répond en 6 ms (mesuré à Versailles) : l'indicateur
// n'apparaît qu'au-delà de ce délai, pour ne pas clignoter à chaque ouverture.
export const RETARD_ETAT_MONUMENTS_MS = 300;

/** Indicateur posé sur la vue ; la roue tourne tant qu'une réponse est attendue. */
export function etatCouche(id, texte, enCours = false) {
    const etat = document.getElementById(id);
    etat.hidden = !texte;
    etat.classList.toggle('en-cours', enCours);
    etat.querySelector('span').textContent = texte || '';
}
