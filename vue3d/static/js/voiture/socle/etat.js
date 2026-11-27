// L'état partagé : la voiture, la caméra, la route prévue jusqu'à l'arrivée.

import * as THREE from 'three';
import { PARAMS, SIMU } from './parametres.js';
import { versLambert93 } from './lambert93.js';

// Le sol, les carrés, le graphe et l'affichage les lisent, et viennent avant
// les modules qui les tiennent à jour (route/voiture, interface/camera,
// route/simulation) : l'état est donc ici, et ces modules l'écrivent.
export const voiture = {
    fix: null, ancre: null, chemin: null, dChemin: 0, recalculer: false,
    vue: false, x: 0, y: 0, alt: 0, cap: 0, v: 0, precision: 0, horsRoute: true,
    attendu: null,                    // le départ, avant le premier relevé
};

// Plus bas qu'à l'origine (70 m de recul sous 30°, 38 m au-dessus de la
// voiture à l'arrêt, 59 m à 130 km/h), à la demande de Yannick, « trop
// haut » : 45 m sous 18°, soit 17 m à l'arrêt et 22 m à 130 km/h ; puis
// encore « trop haute et trop éloignée, ça manque d'effet immersif », puis
// « plus proche, plus basse » : 20 m sous 15°, soit 8 m à l'arrêt et 10 m
// à 130 km/h. La voiture, à l'échelle réelle jusqu'à 60 m de recul
// (interface/maquette), y paraît deux fois plus grande qu'à 45 m.
export const RECUL_DEFAUT = 20, PENTE_DEFAUT = 15, HAUTEUR_DEFAUT = 200;
export const camVue = { mode: PARAMS.get('vue') === '2d' ? '2d' : '3d', recul: RECUL_DEFAUT, hauteur: HAUTEUR_DEFAUT,
                        lacet: 0, tangage: 0, dernierGeste: -Infinity, cap: 0, cible: new THREE.Vector3() };

// `vers=lat,lon` (et `versnom`, pour l'affichage) : la destination, au GPS
// comme en simulation. L'itinéraire est celui du service de l'IGN
// (route/guidage), calculé sur la BD TOPO entière ; la route prévue le suit
// sur le graphe des carrés, jusqu'à l'arrivée.
const LAT_LON = /^\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*$/;
// Le nom d'une destination cherchée dans la page (interface/destination) :
// gardé pour la session seulement, jamais dans l'URL — une adresse tapée ne
// doit finir ni dans l'historique ni dans un lien partagé, comme dans la page
// de la scène.
export const CLE_DESTINATION = 'vue3d-destination';
export const VERS = (() => {
    const m = LAT_LON.exec(PARAMS.get('vers') || '');
    if (!m) return null;
    const lat = Number(m[1]), lon = Number(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const [x, y] = versLambert93(lon, lat);
    let nom = PARAMS.get('versnom') || null;
    try {
        const d = JSON.parse(sessionStorage.getItem(CLE_DESTINATION) || 'null');
        if (!nom && d && Math.abs(d.lat - lat) < 1e-6 && Math.abs(d.lon - lon) < 1e-6) nom = d.nom;
    } catch (e) { /* stockage refusé ou illisible : sans nom */ }
    return { x, y, lat, lon, nom };
})();
// `par=lat,lon;lat,lon` : les points où passer avant `vers`, dans l'ordre —
// un trajet tracé sur une carte, une boucle qui revient près de son départ.
export const PAR = (() => {
    if (!VERS) return [];
    return (PARAMS.get('par') || '').split(';')
        .map(t => LAT_LON.exec(t)).filter(Boolean)
        .map(m => ({ lat: Number(m[1]), lon: Number(m[2]) }));
})();
// La route prévue s'étend jusqu'à l'arrivée, à ITINERAIRE_CHEMIN_MAX_M au
// plus : la distance qui reste se lit sur le tracé, au-delà.
export const ITINERAIRE_CHEMIN_MAX_M = 20000;
// Le tracé de l'IGN en Lambert-93 : { xs, ys, cum, longueur, duree, etD,
// etT, bornes, t } ; `t`, l'abscisse de la voiture sur lui (route/guidage).
export let itineraire = null;
export function poserItineraire(it) { itineraire = it; }
