// Les tuiles manquées, gardées d'une session à l'autre pour être redemandées.

// Une tuile qui n'a pas pu se charger (pas de réseau, IGN en panne) est
// notée, avec le nombre de fois où la page l'a demandée, et gardée d'une
// session à l'autre (localStorage) : elle est redemandée en arrière-plan, les
// plus demandées d'abord — celles d'un trajet habituel —, de plus en plus
// tard (30 s, puis jusqu'à 10 min), quand le sol visible laisse de la place ;
// arrivée, elle entre au cache et sort de la liste. Une absence confirmée par
// l'IGN l'en retire aussi.
export const MANQUEES_CLE = 'vue3d-voiture-manquees', MANQUEES_MAX = 2000, MANQUEES_PARALLELE = 2;
export const MANQUEES_ATTENTE_MS = 30000, MANQUEES_ATTENTE_MAX_MS = 600000;
export const manquees = new Map();            // url → { n : demandes, prochain : instant, essais }
try {
    for (const [url, n] of JSON.parse(localStorage.getItem(MANQUEES_CLE) || '[]')) {
        if (typeof url === 'string' && Number.isFinite(n)) manquees.set(url, { n, prochain: 0, essais: 0 });
    }
} catch (e) { /* stockage refusé ou illisible : une liste neuve */ }
let manqueesModifiees = false;
export function noterManquee(url) {
    const m = manquees.get(url) || { n: 0, prochain: 0, essais: 0 };
    m.n++;
    if (m.prochain !== Infinity) m.prochain = performance.now() + MANQUEES_ATTENTE_MS;
    manquees.set(url, m);
    manqueesModifiees = true;
    if (manquees.size > MANQUEES_MAX) {
        // Trop de tuiles en attente : les moins demandées s'en vont.
        const moindre = [...manquees].reduce((a, b) => (b[1].n < a[1].n ? b : a));
        manquees.delete(moindre[0]);
    }
}
export function oublierManquee(url) { if (manquees.delete(url)) manqueesModifiees = true; }
export function sauverManquees() {
    if (!manqueesModifiees) return;
    try {
        localStorage.setItem(MANQUEES_CLE, JSON.stringify([...manquees].map(([u, m]) => [u, m.n])));
        manqueesModifiees = false;
    } catch (e) { /* stockage refusé : la liste vit le temps de la page */ }
}
window.addEventListener('pagehide', sauverManquees);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') sauverManquees(); });
