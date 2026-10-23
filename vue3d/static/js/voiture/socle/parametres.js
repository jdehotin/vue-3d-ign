// Les paramètres de l'URL : simulation, vitesse, départ.

// La vue en voiture : un monde qui défile autour de la position, comme sur un
// GPS. Elle ne lit pas de scène (vue3d/scene.py), trop lente pour la route,
// mais des carrés de 500 m de bâtiments et de routes BD TOPO
// (vue3d/carres.py), chargés le long de la route prévue devant la voiture et
// libérés derrière elle, sur un sol de tuiles d'orthophoto (ou du plan IGN)
// posées sur le RGE ALTI, plus fines près de la caméra.

// --- Paramètres ------------------------------------------------------------
export const PARAMS = new URLSearchParams(location.search);
export const SIMU = PARAMS.get('simu') === '1';
const nombreParam = (nom, defaut) => {
    const v = Number(PARAMS.get(nom));
    return PARAMS.has(nom) && Number.isFinite(v) ? v : defaut;
};
export const VITESSE_SIMU_KMH = Math.min(Math.max(nombreParam('vitesse', 50), 5), 180);
// `vitesse=limite` : la voiture simulée roule à la limitation de la route
// (/api/vitesses), à VITESSE_SIMU_KMH tant qu'elle n'en connaît aucune.
export const SIMU_LIMITE = PARAMS.get('vitesse') === 'limite';
// La part des carrefours où la voiture simulée quitte la route prévue ;
// `hasard=0` : elle la suit, pour un essai qui se rejoue à l'identique.
export const HASARD_SIMU = Math.min(Math.max(nombreParam('hasard', 0.33), 0), 1);
// Départ de la simulation sans point : les Champs-Élysées, un lieu public
// où la route est longue et bordée de bâtiments.
export const DEPART_SIMU = { lat: 48.8706, lon: 2.3055 };
export const DEPART = PARAMS.has('lat') && PARAMS.has('lon')
    ? { lat: nombreParam('lat', NaN), lon: nombreParam('lon', NaN) } : (SIMU ? DEPART_SIMU : null);
if (DEPART && !(Number.isFinite(DEPART.lat) && Number.isFinite(DEPART.lon))) DEPART.lat = DEPART.lon = NaN;
export const RAD = Math.PI / 180;
