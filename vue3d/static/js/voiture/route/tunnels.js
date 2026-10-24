// Les tunnels : l'altitude de la route sous terre, et la sortie du tunnel.

import { altitudeL93 } from '../sol/altitudes.js';
import { generationGraphe } from './graphe.js';

// La BD TOPO ne donne pas l'altitude d'une route sous terre. Comparée au RGE
// ALTI sommet par sommet le 24 octobre 2026, elle manque entière à Toulon et
// au Mont-Blanc, passe au-dessus du terrain sur 36 sommets de 179 au
// Prado-Carénage (de 18 m au plus), reste à 36 m sous les Halles pour un
// terrain à 35, et à 13,2 m dans le tunnel Liautaud de Nice quand le terrain
// descend à 5,7. La route sous terre va donc en ligne droite d'une entrée à
// l'autre, à l'altitude du terrain là où elle sort au jour (ou du tablier,
// quand un pont prend la suite) ; un nœud entre deux tronçons souterrains
// prend la moyenne des entrées pondérée par l'inverse de la distance
// parcourue sous terre, soit la ligne droite quand il n'y en a que deux.
// Elle ne passe jamais au-dessus du terrain à Fourvière (73 m dessous au
// plus), à Toulon ni au Mont-Blanc ; au Prado-Carénage, dont trois entrées
// sont entre −4 et −1 m, sur 7 sommets de 179, de 3 m au plus.
// Au-delà, une entrée n'est plus cherchée : la plus longue traversée de
// France (le Fréjus) fait 13 km.
const RECHERCHE_ENTREES_M = 20000;

/** Un nœud où la route sort de terre : un tronçon souterrain et un autre qui ne l'est pas. */
export const estEntree = n => n.aretes.some(a => a.sol < 0) && n.aretes.some(a => a.sol >= 0);

const altitudes = new Map();
let generation = -1;

/** L'altitude de la route au nœud `n` d'un tunnel ; NaN tant qu'elle n'est pas connue. */
export function altitudeAuNoeud(n) {
    if (generation !== generationGraphe) { altitudes.clear(); generation = generationGraphe; }
    const deja = altitudes.get(n);
    if (deja !== undefined) return deja;
    const { z, complet } = estEntree(n) ? { z: altitudeEntree(n), complet: true } : moyenneDesEntrees(n);
    // Une tuile d'altitude encore en route : on y reviendra.
    if (complet && Number.isFinite(z)) altitudes.set(n, z);
    return z;
}

function altitudeEntree(n) {
    // Un viaduc entre deux tunnels, sur les autoroutes de montagne : le
    // tablier, dont la BD TOPO donne l'altitude.
    for (const a of n.aretes) {
        if (a.sol <= 0) continue;
        const z = a.n0 === n ? a.z[0] : a.z[a.z.length - 1];
        if (Number.isFinite(z)) return z;
    }
    return altitudeL93(n.x, n.y);
}

function moyenneDesEntrees(depart) {
    // Les plus courts chemins sous terre jusqu'aux entrées (Dijkstra : un
    // tunnel compte quelques dizaines de nœuds).
    const dist = new Map([[depart, 0]]), faits = new Set(), attente = [depart];
    let somme = 0, poids = 0, complet = true;
    while (attente.length) {
        let k = 0;
        for (let i = 1; i < attente.length; i++) if (dist.get(attente[i]) < dist.get(attente[k])) k = i;
        const n = attente.splice(k, 1)[0], d = dist.get(n);
        if (faits.has(n)) continue;
        faits.add(n);
        if (n !== depart && estEntree(n)) {
            const z = altitudeEntree(n);
            if (Number.isFinite(z)) { somme += z / d; poids += 1 / d; } else complet = false;
            continue;
        }
        for (const a of n.aretes) {
            if (a.sol >= 0) continue;
            const m = a.n0 === n ? a.n1 : a.n0, dm = d + a.L;
            if (dm > RECHERCHE_ENTREES_M || dm >= (dist.get(m) ?? Infinity)) continue;
            dist.set(m, dm);
            attente.push(m);
        }
    }
    return { z: poids ? somme / poids : NaN, complet };
}

/** L'altitude de la route à l'abscisse `s` du tronçon souterrain `a` ; NaN tant qu'elle n'est pas connue. */
export function altitudeSousTerre(a, s) {
    const z0 = altitudeAuNoeud(a.n0), z1 = altitudeAuNoeud(a.n1);
    return z0 + (z1 - z0) * Math.min(Math.max(s / a.L, 0), 1);
}

/** Sur le chemin `ch`, la distance de son début à la sortie du tunnel où passe l'abscisse `d` ; null hors d'un tunnel. */
export function sortieDuTunnel(ch, d) {
    const p = ch.parcours;
    let i = 0;
    while (i + 1 < p.length && p[i + 1].debut <= d) i++;
    if (p[i].a.sol >= 0) return null;
    while (i + 1 < p.length && p[i + 1].a.sol < 0) i++;
    return i + 1 < p.length ? p[i + 1].debut : ch.longueur;
}
