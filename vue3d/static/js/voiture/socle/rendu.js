// La scène three.js : rendu, caméra, brume et ciel, lumières, courbure de la Terre.

import * as THREE from 'three';

export const hote = document.getElementById('vue');
export const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.autoClear = false;
renderer.setClearColor(0x0e1116);
// Deux rendus par image (le monde, puis la voiture) : compter les deux.
renderer.info.autoReset = false;
const RATIO_MAX = Math.min(window.devicePixelRatio || 1, 2);
export let ratio = RATIO_MAX;
renderer.setPixelRatio(ratio);
hote.appendChild(renderer.domElement);
/** Un quart de pixel de moins par pixel d'écran, jusqu'à 1 : l'image ramait. */
export function reduireRatio() {
    ratio = Math.max(1, ratio - 0.25);
    renderer.setPixelRatio(ratio);
}
export const ANISOTROPIE = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);

export const scene = new THREE.Scene();
export const camera = new THREE.PerspectiveCamera(55, 1, 1.5, 90000);
// Même brume que l'horizon de la page : rien à 3 km, 15 % à 10 km, 86 % à 35 km.
const brume = new THREE.FogExp2(0xbcd0e2, 4e-5);
scene.fog = brume;
export const couleursCiel = { zenith: new THREE.Color(0x4f86c6), horizon: brume.color };
export const ciel = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 16),
    new THREE.ShaderMaterial({
        uniforms: { zenith: { value: couleursCiel.zenith }, horizon: { value: couleursCiel.horizon } },
        vertexShader: 'varying vec3 vDir;\nvoid main() {\n  vDir = position;\n'
            + '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);\n}',
        fragmentShader: 'uniform vec3 zenith;\nuniform vec3 horizon;\nvarying vec3 vDir;\nvoid main() {\n'
            + '  gl_FragColor = vec4(mix(horizon, zenith, smoothstep(0.0, 0.45, normalize(vDir).y)), 1.0);\n'
            + '  #include <colorspace_fragment>\n}',
        side: THREE.BackSide, depthWrite: false, fog: false }));
ciel.scale.setScalar(80000);
ciel.renderOrder = -1;
ciel.frustumCulled = false;
scene.add(ciel);

export const ambiance = new THREE.HemisphereLight(0xdfe8f5, 0x5a5348, 1.5);
export const soleil = new THREE.DirectionalLight(0xfff2dd, 2.0);
scene.add(ambiance, soleil, soleil.target);

// La Terre se courbe sous la caméra : à 50 km, l'horizon descend de 170 m
// (rayon apparent R / (1 − k), k = 0,13, la réfraction, comme l'horizon de
// la page). Ici dans le nuanceur, depuis la caméra qui bouge, et non à la
// construction des tuiles, depuis un centre fixe.
export const COURBURE = (1 - 0.13) / (2 * 6371000);
export function courber(materiau) {
    materiau.onBeforeCompile = shader => {
        shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>',
            'vec4 mondeP = vec4(transformed, 1.0);\n'
            + '#ifdef USE_INSTANCING\nmondeP = instanceMatrix * mondeP;\n#endif\n'
            + 'mondeP = modelMatrix * mondeP;\n'
            + 'vec2 ecartCam = mondeP.xz - cameraPosition.xz;\n'
            + `mondeP.y -= dot(ecartCam, ecartCam) * ${COURBURE.toExponential(8)};\n`
            + 'vec4 mvPosition = viewMatrix * mondeP;\n'
            + 'gl_Position = projectionMatrix * mvPosition;');
    };
    materiau.customProgramCacheKey = () => 'courbe';
    return materiau;
}

// Au large, l'orthophoto de l'IGN n'est pas absente mais blanche : passé le
// bord de la prise de vue, ses tuiles sont d'un blanc pur, entières dès le
// zoom 15 à 7 km au sud de Cassis, coupées en deux au zoom 13, quand le zoom
// 11 y montre la mer bleue. Vue de la route des Crêtes, la mer sortait
// blanche jusqu'à l'horizon. Un texel blanc pur posé au niveau de la mer (le
// RGE ALTI n'y a pas d'altitude : 0 m) prend la teinte de la mer des tuiles
// côtières ; le calcaire blanc des sommets, en altitude, garde la sienne.
const MER = new THREE.Color(0x103448);
export function courberSol(materiau) {
    courber(materiau);
    const avant = materiau.onBeforeCompile;
    materiau.onBeforeCompile = shader => {
        avant(shader);
        shader.uniforms.uMer = { value: MER };
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying float vAltSol;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAltSol = position.y;');
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nvarying float vAltSol;\nuniform vec3 uMer;')
            .replace('#include <map_fragment>', '#include <map_fragment>\n#ifdef USE_MAP\n'
                + 'if (vAltSol < 1.5 && min(min(sampledDiffuseColor.r, sampledDiffuseColor.g), sampledDiffuseColor.b) > 0.96)'
                + ' diffuseColor.rgb = diffuse * uMer;\n#endif');
    };
    materiau.customProgramCacheKey = () => 'courbe-sol';
    return materiau;
}
