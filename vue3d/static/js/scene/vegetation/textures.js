// Les textures procédurales de la végétation.

import * as THREE from 'three';

// Générées en DataTexture et non sur un canvas : le tableau de pixels se
// vérifie hors navigateur, là où document.createElement('canvas') n'existe pas.
// Aucun fichier à servir, aucune requête de plus.

/** Hachage entier -> [0,1[, périodique par construction. */
function hacher(i, j, periode, graine) {
    const x = ((i % periode) + periode) % periode;
    const y = ((j % periode) + periode) % periode;
    const v = Math.sin(x * 127.1 + y * 311.7 + graine * 74.7) * 43758.5453;
    return v - Math.floor(v);
}

/** Bruit de valeur périodique : la texture se raccorde d'un bord à l'autre. */
function bruit(x, y, periode, graine) {
    const i = Math.floor(x), j = Math.floor(y);
    const fx = x - i, fy = y - j;
    // Lissage en smoothstep, sinon le bruit laisse voir la grille du réseau.
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = hacher(i, j, periode, graine), b = hacher(i + 1, j, periode, graine);
    const c = hacher(i, j + 1, periode, graine), d = hacher(i + 1, j + 1, periode, graine);
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

/**
 * Texture de modulation : une luminance mouchetée, jamais une couleur.
 *
 * La teinte vient des couleurs de sommet, la texture ne fait que la moduler —
 * `map` est multiplié par `vertexColor`. Une texture colorée écraserait le
 * dégradé sombre-en-bas / clair-en-haut cuit dans la géométrie.
 *
 * @param etirementX  > 1 étire le motif en colonnes : des veines verticales
 *                    pour l'écorce, un moucheté isotrope pour le feuillage.
 */
function textureMouchetee(taille, octaves, basse, etirementX, graine) {
    const px = new Uint8Array(taille * taille * 4);
    for (let j = 0; j < taille; j++) {
        for (let i = 0; i < taille; i++) {
            let v = 0, amplitude = 0.5, frequence = 4;
            for (let o = 0; o < octaves; o++) {
                v += amplitude * bruit(i / taille * frequence * etirementX,
                                       j / taille * frequence,
                                       frequence * etirementX, graine + o);
                amplitude *= 0.5;
                frequence *= 2;
            }
            const l = Math.round(255 * Math.min(basse + v * (1 - basse), 1));
            const n = (j * taille + i) * 4;
            px[n] = px[n + 1] = px[n + 2] = l;
            px[n + 3] = 255;
        }
    }
    const tex = new THREE.DataTexture(px, taille, taille, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
}

// Écorce : octaves étirées 6 fois en X, d'où des veines verticales.
export const TEX_ECORCE = textureMouchetee(64, 3, 0.55, 6, 11);
