// Vérifie la recherche d'un lieu de la page en exécutant son vrai code : les
// fonctions sont extraites de vue3d/static/index.html et appelées sous Node,
// sur des réponses réelles du géocodage de la Géoplateforme enregistrées dans
// outils/geocodage-exemples.json — des lieux publics seulement.
//
//   node outils/verifier-recherche.mjs
//
// Les contrôles :
// - coordonnées tapées ou collées (lireCoordonnees) : reconnues dans les deux
//   ordres et avec la virgule décimale, refusées hors de France métropolitaine
//   et en cours de frappe (« 43,5 », « 45 5 ») ;
// - suggestions (suggestionsDe) : ordre du service gardé, outre-mer écarté,
//   commune présente une seule fois, nom et détail lisibles ;
// - lieux nommés, entreprises et adresses fusionnés (motsDe, couvre,
//   casseTitre, suggestionsEntreprises, fusionnerLieux), sur les réponses
//   des trois sources enregistrées dans outils/recherche-exemples.json :
//   « mairie bouc bel air » trouve la mairie, que le géocodage mélangé
//   laissait hors de la liste ; une entreprise du même lieu qu'un lieu nommé
//   n'est pas proposée deux fois ; un entrepreneur individuel n'est trouvé
//   que par son enseigne (exemple fictif).
//
// Pour rafraîchir les exemples, rejouer les quatre requêtes du fichier sur
// https://data.geopf.fr/geocodage/search?autocomplete=1&index=address,poi&limit=15&q=…
// Ceux de recherche-exemples.json : index=poi, puis index=address, et
// https://recherche-entreprises.api.gouv.fr/search?per_page=10&etat_administratif=A&minimal=true&include=siege,matching_etablissements&q=…
// en n'y gardant que des collectivités, établissements publics et grandes
// sociétés : le siège d'une petite association peut être un domicile.
//
// Sort en erreur si un contrôle est manqué, après les avoir tous faits.
import fs from 'fs';
import { fileURLToPath } from 'url';

const lire = chemin => fs.readFileSync(fileURLToPath(new URL(chemin, import.meta.url)), 'utf8');
const src = lire('../vue3d/static/index.html');
const EXEMPLES = JSON.parse(lire('./geocodage-exemples.json'));
function extraire(nom) {
  const i = src.indexOf(`function ${nom}(`);
  if (i < 0) throw new Error('introuvable dans la page : ' + nom);
  let n = 0;
  for (let j = src.indexOf('{', src.indexOf(')', i)); j < src.length; j++) {
    if (src[j] === '{') n++;
    else if (src[j] === '}' && --n === 0) return src.slice(i, j + 1);
  }
}
const { lireCoordonnees, suggestionsDe } = new Function(
  `${extraire('lireCoordonnees')}\n${extraire('suggestionsDe')}\nreturn { lireCoordonnees, suggestionsDe };`)();

let tout = true;
function ok(nom, vrai, detail = '') {
  console.log(`${vrai ? 'OK ' : 'ÉCHEC'} ${nom}${detail ? ' : ' + detail : ''}`);
  tout &&= vrai;
}
const memes = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- Coordonnées ----------------------------------------------------------------
for (const [texte, attendu] of [
  ['43.4715, 5.4861', { lat: 43.4715, lon: 5.4861 }],
  ['43,4715 5,4861', { lat: 43.4715, lon: 5.4861 }],
  ['43,4715, 5,4861', { lat: 43.4715, lon: 5.4861 }],
  ['43.4715;5.4861', { lat: 43.4715, lon: 5.4861 }],
  ['  5.2003 43.9116 ', { lat: 43.9116, lon: 5.2003 }],          // longitude d'abord
  ['48.8530,-4.4860', { lat: 48.853, lon: -4.486 }],             // Finistère, longitude négative
  ['41.9192 8.7386', { lat: 41.9192, lon: 8.7386 }],             // Ajaccio
  ['43,5', null], ['45 5', null], ['13120', null],               // en cours de frappe
  ['40.7128, -74.0060', null],                                   // hors de France
  ['14.6413, -61.0702', null],                                   // Martinique : non couverte
  ['place du château gordes', null], ['', null],
]) {
  const lu = lireCoordonnees(texte);
  ok(`coordonnées « ${texte} »`, memes(lu, attendu), JSON.stringify(lu));
}

// --- Suggestions -----------------------------------------------------------------
const toutes = Object.values(EXEMPLES).flatMap(r => suggestionsDe(r, 6));
ok('au plus six suggestions', Object.values(EXEMPLES).every(r => suggestionsDe(r, 6).length <= 6));
ok('aucune suggestion sans nom ni position', toutes.every(s =>
  s.nom && Number.isFinite(s.lat) && Number.isFinite(s.lon)));
ok('rien hors de France métropolitaine', toutes.every(s =>
  s.lat >= 41 && s.lat <= 51.2 && s.lon >= -5.3 && s.lon <= 9.7),
  toutes.filter(s => s.lat < 41).map(s => s.nom).join(', '));

const gordes = suggestionsDe(EXEMPLES['gordes'], 6);
ok('« gordes » : la commune en tête', gordes[0].nom === 'Gordes' && gordes[0].detail === 'commune · 84220',
   JSON.stringify(gordes[0]));
ok('« gordes » : la commune une seule fois (trois fois dans la réponse)',
   gordes.filter(s => s.nom === 'Gordes' && s.detail.includes('84220')).length === 1);
ok('« gordes » : le lieu-dit homonyme de Berre-l\'Étang reste',
   gordes.some(s => s.nom === 'Gordes' && s.detail.includes("Berre-l'Étang")));

const fdf = suggestionsDe(EXEMPLES['fort de france'], 6);
ok('« fort de france » : la Martinique écartée, le fort de Colmars en tête',
   fdf.length >= 1 && fdf[0].detail.includes('Colmars'), fdf.map(s => s.nom).join(', '));

const chambord = suggestionsDe(EXEMPLES['chateau de chambord'], 6);
ok('« chateau de chambord » : le château en tête', chambord[0].nom === 'Château de Chambord'
   && chambord[0].detail === 'château · Chambord · 41250', JSON.stringify(chambord[0]));

const place = suggestionsDe(EXEMPLES['place du chateau gordes'], 6);
ok('« place du chateau gordes » : la place, avec code postal et commune',
   place[0].nom === 'Place du Château' && place[0].detail === '84220 Gordes'
   && Math.abs(place[0].lat - 43.9112) < 0.001 && Math.abs(place[0].lon - 5.1997) < 0.001,
   JSON.stringify(place[0]));

ok('réponse vide ou mal formée : aucune suggestion',
   [null, {}, { features: null }, { features: [{}] }].every(r => suggestionsDe(r, 6).length === 0));

// --- Lieux nommés, entreprises et adresses ------------------------------------------
function extraireConst(nom) {
  const i = src.indexOf(`const ${nom} =`);
  if (i < 0) throw new Error('introuvable dans la page : ' + nom);
  let n = 0;
  for (let j = i; j < src.length; j++) {
    if ('([{'.includes(src[j])) n++;
    else if (')]}'.includes(src[j])) n--;
    else if (src[j] === ';' && n === 0) return src.slice(i, j + 1);
  }
}
const CONSTS = ['MOTS_VIDES', 'ENTREPRISES_MONTREES', 'DOUBLON_LIEU_M', 'DOUBLON_ADRESSE_M'];
const NOMS = ['motsDe', 'couvre', 'casseTitre', 'suggestionsEntreprises', 'fusionnerLieux'];
const R = new Function(CONSTS.map(extraireConst).join('\n') + '\n' + NOMS.map(extraire).join('\n')
                       + `\nreturn { ${NOMS.join(', ')} };`)();
const EX = JSON.parse(lire('./recherche-exemples.json'));
const lister = texte => R.fusionnerLieux(texte, {
  lieux: suggestionsDe(EX[texte].poi, 15),
  entreprises: R.suggestionsEntreprises(EX[texte].entreprises, R.motsDe(texte), 10),
  adresses: suggestionsDe(EX[texte].adresses, 15),
}, 8);

ok('mots : accents, casse, traits d\'union et mots vides',
   memes(R.motsDe('Mairie de Bouc-Bel-Air'), ['mairie', 'bouc', 'bel', 'air'])
   && memes(R.motsDe("Musée d'Orsay"), ['musee', 'orsay']));
ok('couverture : pluriel, dernier mot en cours de frappe, rien de tapé',
   R.couvre(['notaire', 'aix'], R.motsDe('Aix Mistral Notaires'))
   && R.couvre(['mairie', 'bouc', 'be'], R.motsDe('Mairie de Bouc-Bel-Air'))
   && !R.couvre(['mairie', 'bouc', 'bel', 'air'], R.motsDe('Bel Air 13320 Bouc-Bel-Air'))
   && !R.couvre([], ['gordes']));
ok('casse de titre des noms SIRENE',
   R.casseTitre('BOULANGERIE DE LA GRATIANE') === 'Boulangerie de la Gratiane'
   && R.casseTitre('AIX-EN-PROVENCE') === 'Aix-en-Provence'
   && R.casseTitre("L'OLIVIER") === "L'Olivier" && R.casseTitre('Déjà écrit') === 'Déjà écrit',
   [R.casseTitre('BOULANGERIE DE LA GRATIANE'), R.casseTitre('AIX-EN-PROVENCE')].join(', '));

const mairie = lister('mairie bouc bel air');
ok('« mairie bouc bel air » : la mairie en tête (hors des quinze du géocodage mélangé)',
   mairie[0].nom === 'Mairie de Bouc-Bel-Air', mairie.map(s => s.nom).slice(0, 3).join(', '));
ok('« mairie bouc bel air » : la commune (enseigne « Mairie ») n\'est pas proposée en double',
   !mairie.some(s => s.entreprise), mairie.filter(s => s.entreprise).map(s => s.nom).join(', '));

const orsay = lister("musée d'orsay");
ok('« musée d\'orsay » : le musée en tête, ses sociétés et son établissement public pas en double',
   orsay[0].nom === "Musée d'Orsay" && !orsay.some(s => s.entreprise && /orsay/i.test(s.nom)),
   orsay.filter(s => s.entreprise).map(s => s.nom).join(', ') || 'aucune entreprise');

const airbus = lister('airbus helicopters marignane');
const entreprisesAirbus = airbus.filter(s => s.entreprise);
ok('« airbus helicopters marignane » : l\'usine en tête, les associations du site écartées',
   airbus[0].nom === 'Airbus Helicopters' && airbus[0].poi
   && !entreprisesAirbus.some(s => /syndicat|cooperative|ailes/i.test(s.nom))
   && entreprisesAirbus.length <= 3,
   entreprisesAirbus.map(s => s.nom).join(', '));

const gordesMairie = lister('mairie de gordes');
ok('« mairie de gordes » : la mairie en tête, une seule fois',
   gordesMairie[0].nom === 'Mairie de Gordes' && !gordesMairie.some(s => s.entreprise && s.nom === 'Mairie'),
   gordesMairie.map(s => s.nom).slice(0, 3).join(', '));

// Exemple fictif : un entrepreneur individuel, une société cessée, l'outre-mer.
const etab = (commune, cp, lat, lon, enseignes = null) =>
  ({ latitude: String(lat), longitude: String(lon), code_postal: cp, libelle_commune: commune,
     etat_administratif: 'A', liste_enseignes: enseignes });
const FICTIF = { results: [
  { nom_complet: 'JEAN EXEMPLE', nature_juridique: '1000', etat_administratif: 'A',
    siege: etab('AIX-EN-PROVENCE', '13100', 43.5297, 5.4474) },
  { nom_complet: 'JEAN EXEMPLE', nature_juridique: '1000', etat_administratif: 'A',
    siege: etab('AIX-EN-PROVENCE', '13100', 43.5290, 5.4480, ['BOULANGERIE DU COURS']) },
  { nom_complet: 'BOULANGERIE FERMEE', nature_juridique: '5710', etat_administratif: 'C',
    siege: etab('AIX-EN-PROVENCE', '13100', 43.5280, 5.4490) },
  { nom_complet: 'BOULANGERIE DES ILES', nature_juridique: '5710', etat_administratif: 'A',
    siege: etab('FORT-DE-FRANCE', '97200', 14.6041, -61.0661) },
  { nom_complet: 'SOCIETE SANS RAPPORT', nature_juridique: '5710', etat_administratif: 'A',
    siege: etab('AIX-EN-PROVENCE', '13100', 43.5270, 5.4500) },
] };
const boulangeries = R.suggestionsEntreprises(FICTIF, R.motsDe('boulangerie aix'), 10);
ok('entreprises : l\'individuel par son enseigne seulement, ni cessée, ni outre-mer, ni la commune seule',
   memes(boulangeries.map(s => s.nom), ['Boulangerie du Cours'])
   && boulangeries[0].detail === 'entreprise · 13100 Aix-en-Provence',
   JSON.stringify(boulangeries.map(s => [s.nom, s.detail])));
const societe = R.suggestionsEntreprises({ results: [
  { nom_complet: 'SOCIETE EXEMPLE (SOCIETE EXEMPLE) (SOCIETE EXEMPLE)', nature_juridique: '5710', etat_administratif: 'A',
    siege: etab('AIX-EN-PROVENCE', '13100', 43.5290, 5.4480, ['MAGASIN FICTIF']) },
] }, R.motsDe('societe exemple aix'), 10);
ok('entreprises : la société quand son enseigne ne répond pas, l\'enseigne en détail, sans nom répété',
   societe.length === 1 && societe[0].nom === 'Societe Exemple'
   && societe[0].detail === 'entreprise · Magasin Fictif · 13100 Aix-en-Provence',
   JSON.stringify(societe.map(s => [s.nom, s.detail])));
ok('entreprises : un individuel jamais trouvé par le nom de la personne',
   R.suggestionsEntreprises(FICTIF, R.motsDe('jean exemple aix'), 10).length === 0);
ok('entreprises : réponse vide ou mal formée, aucune suggestion',
   [null, {}, { results: null }, { results: [{}] }].every(r => R.suggestionsEntreprises(r, ['x'], 10).length === 0));

process.exit(tout ? 0 : 1);
