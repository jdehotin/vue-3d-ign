// Géométrie plane : enveloppe convexe, rectangle minimal, point dans un anneau.

/** Enveloppe convexe (marche de Andrew), pour poser le faîtage. */
function enveloppeConvexe(pts) {
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const croix = (o, a, b) => (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]);
    const bas = [], haut = [];
    for (const q of p) { while (bas.length >= 2 && croix(bas[bas.length-2], bas[bas.length-1], q) <= 0) bas.pop(); bas.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i];
        while (haut.length >= 2 && croix(haut[haut.length-2], haut[haut.length-1], q) <= 0) haut.pop(); haut.push(q); }
    bas.pop(); haut.pop();
    return bas.concat(haut);
}

/**
 * Boîte englobante de l'emprise dans le repère tourné de `ang` (radians depuis
 * l'est). Même structure que rectangleMin(), mais l'orientation est imposée :
 * c'est ce qui permet de poser le faîtage sur l'axe mesuré au LiDAR plutôt que
 * sur le grand côté de l'emprise — les deux ne coïncident pas toujours (une
 * maison en L, un toit à croupe sur emprise carrée).
 */
export function rectangleSelonAxe(pts, ang) {
    const cos = Math.cos(-ang), sin = Math.sin(-ang);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const q of pts) {
        const x = q[0] * cos - q[1] * sin, y = q[0] * sin + q[1] * cos;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    return { aire: (x1 - x0) * (y1 - y0), ang, x0, x1, y0, y1 };
}

/** Rectangle d'aire minimale (calipers tournants) : donne l'orientation du faîtage. */
export function rectangleMin(pts) {
    const h = enveloppeConvexe(pts);
    if (h.length < 3) return null;
    let best = null;
    for (let i = 0; i < h.length; i++) {
        const a = h[i], b = h[(i + 1) % h.length];
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const cos = Math.cos(-ang), sin = Math.sin(-ang);
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const q of h) {
            const x = q[0] * cos - q[1] * sin, y = q[0] * sin + q[1] * cos;
            x0 = Math.min(x0, x); x1 = Math.max(x1, x);
            y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
        const aire = (x1 - x0) * (y1 - y0);
        if (!best || aire < best.aire) best = { aire, ang, x0, x1, y0, y1 };
    }
    return best;
}

/** Point dans polygone par lancer de rayon. Coordonnées en degrés (lon, lat). */
export function pointDansAnneau(lon, lat, anneau) {
    let dedans = false;
    for (let i = 0, j = anneau.length - 1; i < anneau.length; j = i++) {
        const [xi, yi] = anneau[i], [xj, yj] = anneau[j];
        if ((yi > lat) !== (yj > lat) &&
            lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) dedans = !dedans;
    }
    return dedans;
}
