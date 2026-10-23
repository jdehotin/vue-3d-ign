// Ma position : le repère suivi au GPS, et le lien vers la vue en voiture.

import * as THREE from 'three';
import { DEPART, ACCUEIL, LAT0, LON0, RELANCE_MOI } from '../socle/point.js';
import { chargementArtefact } from '../socle/chargement.js';
import { toLocal, distanceAEmprise } from '../socle/projection.js';
import { ySol } from '../terrain/etat.js';
import { scene, camera, controls } from '../socle/rendu.js';
import { etatCouche } from './etat-couche.js';
import { poserSurLeRelief } from '../terrain/relief.js';

// Utile sur place : on se voit dans la scène. Tant que le bouton est allumé, la
// position suit (watchPosition) ; on ne se contente pas d'une lecture unique,
// un relevé se fait en marchant.
//
// La scène reste centrée sur le point : bâtiments, orthophoto et végétation
// ne sont chargés qu'à quelques centaines de mètres autour. Loin de là, le
// repère est posé mais flotte sur un sol vide — le panneau le dit.

const groupePosition = new THREE.Group();
groupePosition.visible = false;
scene.add(groupePosition);
poserSurLeRelief({ placer: placerPosition, apresBatiments: true });

const BLEU_POSITION = 0x3b8beb;
const moi = {
    point: new THREE.Mesh(
        new THREE.SphereGeometry(1.6, 24, 18),
        new THREE.MeshStandardMaterial({ color: BLEU_POSITION, emissive: 0x0d3a73, roughness: 0.4 })),
    tige: new THREE.Mesh(
        new THREE.CylinderGeometry(0.14, 0.14, 12, 8),
        new THREE.MeshStandardMaterial({ color: BLEU_POSITION, transparent: true, opacity: 0.55 })),
    cercle: null,
    lon: null, lat: null, precision: null, x: 0, y: 0, dehors: false,
};
moi.point.castShadow = true;
groupePosition.add(moi.point, moi.tige);

let positionPrete = false;

/** Repose le repère sur le terrain ; appelée aussi quand l'exagération change. */
function placerPosition() {
    if (!positionPrete || moi.lon == null) return;
    const sol = ySol(moi.lon, moi.lat);
    moi.point.position.set(moi.x, sol + 12, -moi.y);   // le nord de la scène est -Z
    moi.tige.position.set(moi.x, sol + 6, -moi.y);
    if (moi.cercle) moi.cercle.position.set(moi.x, sol + 0.2, -moi.y);
}

function majPosition(coords) {
    moi.lon = coords.longitude;
    moi.lat = coords.latitude;
    moi.precision = coords.accuracy;
    [moi.x, moi.y] = toLocal(moi.lon, moi.lat);
    positionPrete = true;

    // Le cercle de précision change de rayon à chaque relevé : on le refait
    // plutôt que de le mettre à l'échelle, une RingGeometry ne s'étire pas
    // proprement (l'épaisseur de l'anneau suivrait le rayon).
    if (moi.cercle) {
        groupePosition.remove(moi.cercle);
        moi.cercle.geometry.dispose();
        moi.cercle = null;
    }
    if (moi.precision > 0) {
        moi.cercle = new THREE.Mesh(
            new THREE.RingGeometry(Math.max(moi.precision - 0.5, 0.1), moi.precision, 64),
            new THREE.MeshBasicMaterial({ color: BLEU_POSITION, transparent: true,
                                          opacity: 0.35, side: THREE.DoubleSide }));
        moi.cercle.rotation.x = -Math.PI / 2;
        groupePosition.add(moi.cercle);
    }
    placerPosition();

    const dist = Math.hypot(moi.x, moi.y);
    document.getElementById('m-prec').textContent = moi.precision
        ? '± ' + Math.round(moi.precision) + ' m' : '—';
    document.getElementById('m-dist').textContent = dist >= 1000
        ? (dist / 1000).toFixed(1) + ' km' : Math.round(dist) + ' m';
    // Hors de la scène, cercle de précision compris : le bouton la recentre.
    moi.dehors = distanceAEmprise(moi.lon, moi.lat) > (moi.precision || 0);
    const note = document.getElementById('m-note');
    if (distanceAEmprise(moi.lon, moi.lat) > 0) {
        // Toutes les couches dérivent du centre calculé côté serveur : le seul
        // moyen de voir les environs est de recharger la page recentrée ici.
        note.innerHTML = "Vous êtes hors de la scène chargée : bâtiments, orthophoto "
            + "et végétation ne sont chargés qu'autour du point, le repère est posé "
            + "sur un sol vide.<br>"
            + '<a class="lien-ext" href="' + urlRecentree() + '">'
            + 'Recentrer la scène ici ↗</a>';
    } else if (moi.precision > 30) {
        note.textContent = "Position peu précise (" + Math.round(moi.precision)
            + " m) : à l'intérieur ou sans GPS, le navigateur se rabat sur le Wi-Fi "
            + "ou le réseau. Le cercle bleu montre l'incertitude.";
    } else {
        note.textContent = "Position suivie en continu. Éteindre le bouton pour arrêter.";
    }
}

/** La page recentrée sur la position, avec le suivi à relancer (moi=1). */
function urlRecentree() {
    const u = new URL(location.href);
    u.searchParams.set('lat', moi.lat.toFixed(6));
    u.searchParams.set('lon', moi.lon.toFixed(6));
    u.searchParams.set('moi', '1');
    return u.pathname + u.search;
}

/** Cadre la caméra sur le repère, avec le même recul que le cadrage initial. */
function cadrerSurMoi() {
    const centre = new THREE.Vector3(moi.x, ySol(moi.lon, moi.lat), -moi.y);
    const recul = 70;
    controls.target.copy(centre);
    camera.position.set(centre.x + recul, centre.y + recul * 0.8, centre.z + recul);
    controls.update();
}

const MESSAGES_GEOLOC = {
    1: "Géolocalisation refusée par le navigateur. À autoriser dans les réglages du site.",
    2: "Position indisponible : ni GPS, ni Wi-Fi, ni réseau exploitable.",
    3: "Le navigateur n'a pas répondu à temps. Réessayer, de préférence à l'extérieur.",
};

const btnMoi = document.getElementById('t-moi');

// La vue en voiture (static/voiture.html), qui part de la position suivie si
// elle est connue, sinon du point de la scène ; de l'accueil, de la
// géolocalisation seule.
const lienVoiture = document.getElementById('t-voiture');
function majLienVoiture() {
    const [lat, lon] = moi.lat != null ? [moi.lat, moi.lon] : ACCUEIL ? [null, null] : [LAT0, LON0];
    lienVoiture.href = lat == null ? 'voiture' : `voiture?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`;
}
lienVoiture.addEventListener('click', majLienVoiture);
majLienVoiture();
let suiviPosition = null;   // identifiant du watchPosition en cours

// Le bouton est sur la vue, et sur téléphone le panneau est replié : chaque
// message du suivi s'y affiche aussi, et s'efface après ANNONCE_MOI_S s'il
// n'annonce pas une attente.
const ANNONCE_MOI_S = 8;
let effacerAnnonceMoi = null;
function annoncerMoi(texte, enCours = false, auPanneau = true) {
    if (auPanneau) document.getElementById('m-note').textContent = texte;
    clearTimeout(effacerAnnonceMoi);
    etatCouche('etat-moi', texte, enCours);
    if (texte && !enCours) effacerAnnonceMoi = setTimeout(() => etatCouche('etat-moi', null), ANNONCE_MOI_S * 1000);
}

// Sortie de la scène pendant le suivi, dite sur la vue, là où est le bouton :
// le panneau, qui le disait seul, est replié sur un petit écran.
const annoncerSortie = () => annoncerMoi(
    "Hors de la scène chargée : le bouton de position la recentre ici.", false, false);

btnMoi.addEventListener('click', () => {
    if (suiviPosition === null) {
        demarrerSuivi();
        return;
    }
    // Suivi en cours, position sortie de la scène : le bouton la recentre
    // ici, et le suivi reprend après le rechargement. Il arrêtait le suivi,
    // et la scène restait où elle était : dans une Tesla en marche, le
    // 16 octobre 2026, rappuyer pour se retrouver n'y changeait rien. En
    // voiture, on sort d'une zone de 1 000 m en moins d'une minute.
    if (moi.dehors) {
        annoncerMoi("Recentrage sur votre position…", true);
        location.assign(urlRecentree());
        return;
    }
    navigator.geolocation.clearWatch(suiviPosition);
    suiviPosition = null;
    groupePosition.visible = false;
    btnMoi.classList.remove('on');
    annoncerMoi("Suivi arrêté.");
});

/**
 * Allume le suivi. Son premier relevé hors de la scène la recentre, sauf à la
 * reprise qui suit un recentrage (`recentrer` faux) : un relevé encore hors
 * de la scène y bouclerait. Un appui sur le bouton recentre toujours.
 */
function demarrerSuivi(recentrer = true) {
    document.getElementById('sec-moi').hidden = false;
    if (!navigator.geolocation) {
        annoncerMoi("Ce navigateur ne propose pas de géolocalisation.");
        return;
    }
    // La géolocalisation exige un contexte sécurisé : sur http, l'API existe
    // mais échoue avec PERMISSION_DENIED sans que l'utilisateur ait rien refusé.
    if (!window.isSecureContext) {
        annoncerMoi("La géolocalisation exige une page en https.");
        return;
    }

    btnMoi.disabled = true;
    annoncerMoi("Localisation…", true);
    let premiere = true;
    suiviPosition = navigator.geolocation.watchPosition(
        pos => {
            const etaitDehors = moi.dehors;
            majPosition(pos.coords);
            groupePosition.visible = true;
            if (premiere) {
                premiere = false;
                // Premier relevé hors de la scène, cercle de précision compris :
                // la page se recentre sur soi, une seule fois. Pas à chaque
                // relevé — on bouge en marchant, et chaque recentrage relance
                // une construction de plusieurs secondes.
                if (recentrer && moi.dehors) {
                    annoncerMoi("Hors de la scène : recentrage sur votre position…", true);
                    location.assign(urlRecentree());
                    return;
                }
                // Le détail (précision) reste au panneau.
                clearTimeout(effacerAnnonceMoi);
                etatCouche('etat-moi', null);
                cadrerSurMoi();
                btnMoi.disabled = false;
                btnMoi.classList.add('on');
                if (moi.dehors) annoncerSortie();
            } else if (moi.dehors && !etaitDehors) {
                annoncerSortie();
            }
        },
        err => {
            annoncerMoi(MESSAGES_GEOLOC[err.code] || ("Géolocalisation impossible : " + err.message));
            btnMoi.disabled = false;
            if (suiviPosition !== null) navigator.geolocation.clearWatch(suiviPosition);
            suiviPosition = null;
            btnMoi.classList.remove('on');
        },
        // Haute précision = GPS quand il y en a un ; sinon le navigateur se
        // rabat de lui-même sur le Wi-Fi. maximumAge évite de payer un premier
        // fix complet si une position toute fraîche est déjà connue.
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
}

// Page rechargée par un recentrage : le suivi reprend une fois la scène
// arrivée — son cadrage tombe alors sur la position, centre de la page.
if (RELANCE_MOI) chargementArtefact.then(() => demarrerSuivi(false));

// Arrivée à l'accueil faute de position (DEPART, en tête de page) : on dit
// pourquoi la tour Eiffel plutôt que là où l'on est.
const ANNONCES_ACCUEIL = {
    refusee: "Géolocalisation non autorisée : voici la tour Eiffel, en points du nuage LiDAR HD.",
    'sans-reponse': "Pas de réponse à la demande de position : voici la tour Eiffel. "
        + "Autorisée, elle vous emmène là où vous êtes.",
    indisponible: "Position indisponible : voici la tour Eiffel, en points du nuage LiDAR HD.",
    'hors-emprise': "Vous êtes hors de France métropolitaine, seule couverte : voici la tour Eiffel.",
};
if (ACCUEIL && ANNONCES_ACCUEIL[DEPART.raison]) {
    chargementArtefact.then(a => { if (a) annoncerMoi(ANNONCES_ACCUEIL[DEPART.raison]); });
}
