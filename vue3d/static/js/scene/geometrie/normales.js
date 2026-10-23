// Normales et sphères englobantes, au calcul de three.js r160, sans ses objets
// intermédiaires.

import * as THREE from 'three';

// Les mêmes calculs que three.js r160, à l'octet près, sans ses objets
// intermédiaires : chaque sommet y passait par un Vector3 et des accesseurs
// d'attribut. Mesuré au profil CPU de Chrome, computeVertexNormals pesait
// 0,36 s des 1,9 s de la végétation de Gordes en zone de 1 000 m (19 312
// houppiers, 3,9 millions de faces), et toCreasedNormals 0,41 s des 1,2 s des
// bâtiments de Strasbourg en zone de 1 000 m (251 surfaces de toit
// mesurées). Les opérations sont celles de three.js, dans le même ordre : le
// résultat est identique, ce que vérifie outils/verifier-geometrie.mjs.

/**
 * Normales d'une géométrie non indexée, une par facette : ce que rend
 * BufferGeometry.computeVertexNormals() — produit vectoriel (C − B) × (A − B)
 * rangé en Float32, puis normé depuis la valeur rangée (normalizeNormals).
 */
function normalesFacettes(pos) {
    const normales = new Float32Array(pos.length);
    for (let i = 0; i < pos.length; i += 9) poserNormaleFacette(pos, normales, i);
    return normales;
}

/** La normale de la face dont les sommets commencent en `i`, aux trois sommets. */
function poserNormaleFacette(pos, normales, i) {
    const ax = pos[i], ay = pos[i + 1], az = pos[i + 2];
    const bx = pos[i + 3], by = pos[i + 4], bz = pos[i + 5];
    const cbx = pos[i + 6] - bx, cby = pos[i + 7] - by, cbz = pos[i + 8] - bz;
    const abx = ax - bx, aby = ay - by, abz = az - bz;
    const x = Math.fround(cby * abz - cbz * aby);
    const y = Math.fround(cbz * abx - cbx * abz);
    const z = Math.fround(cbx * aby - cby * abx);
    const s = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
    normales[i] = normales[i + 3] = normales[i + 6] = x * s;
    normales[i + 1] = normales[i + 4] = normales[i + 7] = y * s;
    normales[i + 2] = normales[i + 5] = normales[i + 8] = z * s;
}

/** Géométrie non indexée sur des positions, normales par facette (computeVertexNormals). */
export function geometrieFacettes(pos) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(normalesFacettes(pos), 3));
    return g;
}

/**
 * Normales pliées : ce que rend toCreasedNormals(geo, angle) de
 * BufferGeometryUtils (three r160) sur une géométrie non indexée. Les sommets
 * sont regroupés au centimètre comme là-bas (~~(v × (1 + 1e-10) × 100), soit
 * v × 100,00000001, par composante), mais sans en faire des chaînes ; la
 * normale d'un sommet est la somme, dans l'ordre des faces, des normales des
 * faces de son groupe à moins de `angle` de la sienne, normée.
 */
export function normalesPliees(geo, angle) {
    const pos = geo.attributes.position.array;
    const nf = pos.length / 9, nv = pos.length / 3;
    const creaseDot = Math.cos(angle);
    const hashMultiplier = (1 + 1e-10) * 1e2;
    // Normale normée de chaque face : (C − B) × (A − B), Vector3.normalize().
    const fn = new Float64Array(3 * nf);
    for (let f = 0; f < nf; f++) {
        const i = 9 * f;
        const bx = pos[i + 3], by = pos[i + 4], bz = pos[i + 5];
        const t1x = pos[i + 6] - bx, t1y = pos[i + 7] - by, t1z = pos[i + 8] - bz;
        const t2x = pos[i] - bx, t2y = pos[i + 1] - by, t2z = pos[i + 2] - bz;
        const x = t1y * t2z - t1z * t2y, y = t1z * t2x - t1x * t2z, z = t1x * t2y - t1y * t2x;
        const s = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
        fn[3 * f] = x * s; fn[3 * f + 1] = y * s; fn[3 * f + 2] = z * s;
    }
    // Clé de chaque sommet, puis numéro de son groupe dans l'ordre d'apparition,
    // par une table à adressage ouvert : deux sommets sont du même groupe si
    // leurs trois entiers sont égaux, comme deux chaînes de three.js.
    const kx = new Int32Array(nv), ky = new Int32Array(nv), kz = new Int32Array(nv);
    let taille = 2;
    while (taille < 2 * nv) taille *= 2;
    const table = new Int32Array(taille).fill(-1), premier = new Int32Array(nv), groupe = new Int32Array(nv);
    let nbGroupes = 0;
    for (let v = 0; v < nv; v++) {
        const x = kx[v] = ~~(pos[3 * v] * hashMultiplier);
        const y = ky[v] = ~~(pos[3 * v + 1] * hashMultiplier);
        const z = kz[v] = ~~(pos[3 * v + 2] * hashMultiplier);
        let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & (taille - 1);
        for (;;) {
            const g = table[h];
            if (g < 0) { table[h] = nbGroupes; premier[nbGroupes] = v; groupe[v] = nbGroupes++; break; }
            const r = premier[g];
            if (kx[r] === x && ky[r] === y && kz[r] === z) { groupe[v] = g; break; }
            h = (h + 1) & (taille - 1);
        }
    }
    // Faces de chaque groupe, dans l'ordre des sommets : celui des push de three.js.
    const debut = new Int32Array(nbGroupes + 1);
    for (let v = 0; v < nv; v++) debut[groupe[v] + 1]++;
    for (let g = 0; g < nbGroupes; g++) debut[g + 1] += debut[g];
    const rempli = debut.slice(0, nbGroupes), faces = new Int32Array(nv);
    for (let v = 0; v < nv; v++) faces[rempli[groupe[v]]++] = (v / 3) | 0;
    const normales = new Float32Array(pos.length);
    for (let v = 0; v < nv; v++) {
        const f = (v / 3) | 0;
        const tx = fn[3 * f], ty = fn[3 * f + 1], tz = fn[3 * f + 2];
        let sx = 0, sy = 0, sz = 0;
        for (let k = debut[groupe[v]], fin = debut[groupe[v] + 1]; k < fin; k++) {
            const o = 3 * faces[k];
            const ox = fn[o], oy = fn[o + 1], oz = fn[o + 2];
            if (tx * ox + ty * oy + tz * oz > creaseDot) { sx += ox; sy += oy; sz += oz; }
        }
        const s = 1 / (Math.sqrt(sx * sx + sy * sy + sz * sz) || 1);
        normales[3 * v] = sx * s; normales[3 * v + 1] = sy * s; normales[3 * v + 2] = sz * s;
    }
    geo.setAttribute('normal', new THREE.BufferAttribute(normales, 3));
    return geo;
}

/**
 * computeVertexNormals() de three.js r160 sur une géométrie indexée, en
 * place : chaque face ajoute (C − B) × (A − B) aux normales de ses trois
 * sommets, rangées en Float32 à chaque ajout, puis chacune est normée depuis
 * sa valeur rangée. Les trois sommets sont lus avant d'être écrits, comme
 * là-bas : un sommet répété dans une face n'y compte qu'une fois.
 */
export function normalesIndexees(geo) {
    const pos = geo.attributes.position.array, index = geo.index.array;
    let attr = geo.attributes.normal;
    if (attr === undefined) {
        attr = new THREE.BufferAttribute(new Float32Array(pos.length), 3);
        geo.setAttribute('normal', attr);
    } else {
        attr.array.fill(0);
    }
    const n = attr.array;
    for (let i = 0; i < index.length; i += 3) {
        const a = 3 * index[i], b = 3 * index[i + 1], c = 3 * index[i + 2];
        const bx = pos[b], by = pos[b + 1], bz = pos[b + 2];
        const cbx = pos[c] - bx, cby = pos[c + 1] - by, cbz = pos[c + 2] - bz;
        const abx = pos[a] - bx, aby = pos[a + 1] - by, abz = pos[a + 2] - bz;
        const x = cby * abz - cbz * aby, y = cbz * abx - cbx * abz, z = cbx * aby - cby * abx;
        const nax = n[a] + x, nay = n[a + 1] + y, naz = n[a + 2] + z;
        const nbx = n[b] + x, nby = n[b + 1] + y, nbz = n[b + 2] + z;
        const ncx = n[c] + x, ncy = n[c + 1] + y, ncz = n[c + 2] + z;
        n[a] = nax; n[a + 1] = nay; n[a + 2] = naz;
        n[b] = nbx; n[b + 1] = nby; n[b + 2] = nbz;
        n[c] = ncx; n[c + 1] = ncy; n[c + 2] = ncz;
    }
    for (let i = 0; i < n.length; i += 3) {
        const x = n[i], y = n[i + 1], z = n[i + 2];
        const s = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
        n[i] = x * s; n[i + 1] = y * s; n[i + 2] = z * s;
    }
    attr.needsUpdate = true;
}

/**
 * computeBoundingSphere() de three.js r160 pour une géométrie sans morphose :
 * centre de la boîte englobante (Math.min, Math.max), rayon jusqu'au sommet
 * le plus éloigné. `boite` : [x0, y0, z0, x1, y1, z1], déjà relevée en
 * écrivant les sommets.
 */
export function sphereEnglobante(geo, boite = null) {
    const pos = geo.attributes.position.array;
    let [x0, y0, z0, x1, y1, z1] = boite || [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    if (!boite) for (let i = 0; i < pos.length; i += 3) {
        x0 = Math.min(x0, pos[i]); y0 = Math.min(y0, pos[i + 1]); z0 = Math.min(z0, pos[i + 2]);
        x1 = Math.max(x1, pos[i]); y1 = Math.max(y1, pos[i + 1]); z1 = Math.max(z1, pos[i + 2]);
    }
    if (geo.boundingSphere === null) geo.boundingSphere = new THREE.Sphere();
    const c = geo.boundingSphere.center;
    if (x1 < x0 || y1 < y0 || z1 < z0) c.set(0, 0, 0);
    else c.set((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
    let r2 = 0;
    for (let i = 0; i < pos.length; i += 3) {
        const dx = c.x - pos[i], dy = c.y - pos[i + 1], dz = c.z - pos[i + 2];
        r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
    }
    geo.boundingSphere.radius = Math.sqrt(r2);
}
