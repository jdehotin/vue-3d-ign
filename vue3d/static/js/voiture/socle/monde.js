// L'origine du monde, en Lambert-93, recalée quand la voiture s'en éloigne.

// X = x − ORIGINE.x (vers l'est), Z = ORIGINE.y − y (le nord est −Z), Y =
// l'altitude. L'origine se recale quand la voiture s'en éloigne : les
// sommets d'un objet sont relatifs à son ancre, mais le nuanceur calcule la
// courbure en flottants 32 bits, qu'on garde petits.
export const ORIGINE = { x: 0, y: 0 };
export const RECALAGE_M = 20000;
export const ancres = new Set();
export function ancrer(objet, x, y, alt = 0) {
    objet.userData.ancre = [x, y];
    objet.position.set(x - ORIGINE.x, alt, ORIGINE.y - y);
    ancres.add(objet);
}
export function recaler(x, y) {
    ORIGINE.x = Math.round(x / 1000) * 1000;
    ORIGINE.y = Math.round(y / 1000) * 1000;
    for (const o of ancres) {
        const [ax, ay] = o.userData.ancre;
        o.position.x = ax - ORIGINE.x;
        o.position.z = ORIGINE.y - ay;
    }
}
