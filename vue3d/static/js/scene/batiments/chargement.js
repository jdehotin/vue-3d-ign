// L'arrivée des bâtiments et des toitures de la scène ; ce qui suit est
// inscrit par main.js.

import { ARTEFACT, ERREUR_SCENE, chargementArtefact } from '../socle/chargement.js';
import { poserToits } from './etat.js';

export let features = [];
export const note = document.getElementById('note');

// Les toits LiDAR partent en même temps que les bâtiments et sont attendus au
// plus 8 s : la première lecture d'une emprise à 0,5 m prend ~2 s côté serveur
// (puis cache), et une panne de l'IGN sur l'altimétrie ne doit pas priver la
// scène des bâtiments.
/**
 * Bâtiments et toitures, depuis l'artefact s'il existe, des appels IGN sinon.
 *
 * Le repli garde la course à 8 s sur les toitures : une première lecture d'une
 * emprise à 0,5 m prend une dizaine de secondes côté IGN, et une panne de
 * l'altimétrie ne doit pas priver la scène de ses bâtiments.
 */
async function chargerScene() {
    await chargementArtefact;
    if (!ARTEFACT) throw new Error(ERREUR_SCENE || 'scène indisponible');
    return [ARTEFACT.batiments, ARTEFACT.toits];
}

// Ce qui suit l'arrivée des bâtiments, inscrit par le module principal : leur
// construction, le cadrage, puis les couches qui en dépendent. Une erreur en
// chemin est affichée comme un chargement impossible.
const apresLesBatiments = [];
export function quandLesBatimentsArrivent(fn) { apresLesBatiments.push(fn); }

chargerScene()
    .then(([json, toits]) => {
        if (toits && toits.toits) poserToits(toits);
        features = json.features || [];
        for (const fn of apresLesBatiments) fn(features);
    })
    .catch(err => {
        note.textContent = 'Chargement impossible : ' + err.message;
        // Sans bâtiments, tout le sursol basculerait en « masse indéterminée »,
        // toitures comprises : mieux vaut ne rien afficher.
        document.getElementById('v-note').textContent =
            "Végétation non chargée : les emprises bâties manquent pour "
            + "distinguer les toitures du sursol.";
        document.getElementById('sec-veg').hidden = false;
    });
