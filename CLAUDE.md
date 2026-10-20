# CLAUDE.md

Vue 3D d'un lieu de France métropolitaine, reconstruite à partir des données
ouvertes de l'IGN. Un serveur Flask construit une **scène** autour d'un point et
la met en cache sur disque ; une page three.js unique l'affiche. Présentation et
méthode : [README.md](README.md).

## Commandes

```bash
python3.12 -m venv .venv && . .venv/bin/activate   # 3.12, comme l'image ; pas 3.14 (0 houppier)
pip install -r requirements.txt pytest          # dépendances
pytest                                           # tests Python (réseau jamais appelé)
VUE3D_CACHE=./cache flask --app vue3d.app run --port 8080   # serveur local
docker compose up -d --build                     # conteneur, port 8080 (VUE3D_PORT)
VUE3D_VEHICULES=rtmdet docker compose up -d --build   # avec la couche des véhicules (aucun | rtmdet | yolo | tous)
VUE3D_PANNEAUX=oui docker compose up -d --build        # avec les panneaux solaires du registre OpenPVMapper (CC-BY 4.0)
./run_macOS_CoreML.sh                            # sans Docker, les deux détecteurs sur CoreML (Mac)
./run_container.sh                               # l'image sous container d'Apple (macOS 26) au lieu de Docker ; pas de CoreML
node outils/verifier-geometrie.mjs               # géométrie de la page, exécutée sous Node
node outils/verifier-recherche.mjs               # recherche d'un lieu, exécutée sous Node
node outils/verifier-export.mjs essai.ifc essai.gml   # exports IFC et CityGML, exécutés sous Node
node outils/mesure-ecarts-toits.mjs "http://localhost:8080/?lat=43.9116&lon=5.2003"   # toits contre le nuage LiDAR (puppeteer-core)
python outils/valider_ifc.py essai.ifc           # validation par ifcopenshell (pip install ifcopenshell pytest, hors requirements)
python outils/valider_citygml.py essai.gml       # géométrie du CityGML ; son schéma : citygml-tools validate essai.gml
python3 -m http.server -d outils 8000            # visionneuse-ifc.html : un IFC exporté, relu par web-ifc, propriétés au clic
npm install puppeteer-core && node outils/essai-navigateur.mjs "http://localhost:8080/?lat=43.9116&lon=5.2003"
```

## Architecture

```
vue3d/
  app.py        Flask : /, /api/scene, /api/ortho, /api/monuments, /api/ouvrages, /api/emprises, /api/nuage, /api/piscines, /api/navires, /api/vehicules, /api/panneaux, /api/dpe, /api/dvf, /api/bornes, /api/avancement, /api/sante, /api/tuile, POST /api/reconstruire ; quota de scènes neuves par IP (VUE3D_QUOTA, VUE3D_PROXY derrière un proxy)
  scene.py      assemblage d'une scène, cache disque par point arrondi
  couches.py    lecture WFS (bâtiments, végétation, BD Forêt, routes)
  batiments.py  bâtiments découpés sur l'emprise, en retrait du bord
  mnh.py        hauteurs du sursol, LiDAR HD, repli MNS − MNT
  toits.py      gouttière, faîtage, corps de toit, surface du toit, bâtiments sous les arbres ; bassin de processus né au démarrage (VUE3D_TOITS_PROCESSUS, 16 au plus)
  pans.py       toit en pans : plans ajustés au MNH, volume fermé et vérifié
  houppiers.py  segmentation des arbres sur la grille à 0,5 m
  constructions.py  réservoirs et constructions ponctuelles BD TOPO, retirés du sursol des houppiers
  ortho.py      indice de verdure ExG, mosaïque d'orthophoto
  relief.py     RGE ALTI quantifié au décimètre, anneau de relief alentour
  eau.py        étendues et cours d'eau BD TOPO, découpés sur l'emprise
  lignes.py     lignes à haute tension et hauteur de leurs supports
  monuments.py  parties de monuments OSM (building:part), seule source hors IGN
  ouvrages.py   murs, ponts, voies ferrées, terrains de sport : couche à part, chargée après la scène
  emprises.py   cimetières, aérodromes et leurs pistes, postes de transformation, haies : couche à part, chargée après la scène
  nuage.py      bâti du nuage de points LiDAR HD (dalles COPC lues par plages, via geopf) ; ouvrages ajourés en points : couche à part, lue en deux temps (carré proche, puis zone entière)
  vehicules.py  véhicules, piscines et navires lus sur l'orthophoto par un réseau ONNX : couche à part, optionnelle (VUE3D_VEHICULES) ; les navires gardés sur l'eau, mer comprise (communes BD TOPO, RGE ALTI)
  releves.py    détections gardées par rectangle de terrain (cache/releves/) : un point décalé ne détecte que la bande nouvelle
  panneaux.py   panneaux solaires du registre OpenPVMapper (SQLite R-tree) : couche à part, optionnelle (VUE3D_PANNEAUX)
  dpe.py        DPE de l'ADEME rattachés aux bâtiments (RNB, sinon adresse à 5 m) : couche à part, lue au clic seulement, datée
  dvf.py        ventes DVF (fichiers Etalab) jointes aux parcelles du cadastre IGN : couche à part, lue au clic seulement, datée
  bornes.py     bornes de recharge (Base nationale des IRVE, API tabulaire de data.gouv.fr) réunies par station : couche à part, lue au clic seulement, datée
  geopf.py      GET avec reprise sur la Géoplateforme ; 8 places pour tout le service, lectures groupées abandonnées au premier échec
  tuiles.py     tuiles WMTS de la page (ortho, plan) : stock servi, sinon redirection vers l'IGN ; une tuile refusée au navigateur est relue ici et gardée 90 jours (cache/tuiles/)
  static/index.html   la page entière : HTML, CSS et JavaScript (three.js r160)
```

Pas de base de données, pas de clé d'API, pas de build front : la page est un
fichier statique qui lit le point dans son URL.

Les couches des véhicules et des panneaux sont les seules dépendances
optionnelles : sans `VUE3D_VEHICULES`, ni onnxruntime ni réseau ne sont
chargés ; sans `VUE3D_PANNEAUX`, aucune base n'est lue ; les tests ne
demandent jamais ni l'un ni l'autre (`/donnees/` est ignoré par git). Les poids (RTMDet-R, Apache-2.0 ; YOLO11-OBB, AGPL-3.0 ;
tous deux entraînés sur DOTA, usage académique) ne doivent **jamais** entrer
dans le dépôt : ils sont exportés par `outils/exporter_vehicules.py` dans
l'étage `export` du Dockerfile.

## Invariants — à ne pas défaire

- **Une scène est complète ou n'existe pas.** Le cache ne périme jamais, donc
  une scène écrite pendant une panne reste fausse pour toujours. Toute source en
  échec lève `SceneIncomplete` et rien n'est écrit. Distinguer « la donnée
  n'existe pas ici » (un fait : `fetch_relief` rend `None` hors couverture) de
  « on n'a pas pu la lire » (un incident). Ne jamais ajouter un
  `try/except` qui avale une erreur de source pour « publier quand même ».
- **Les refus de la Géoplateforme sont sporadiques.** `get_avec_reprise`
  réessaie tout échec, 4xx compris ; une requête rejetée en 400 a répondu 200
  six fois de suite rejouée à l'identique.
- **WMS 1.3.0 en EPSG:4326 : la BBOX s'écrit `lat,lon`.** Inversée, le service
  répond 200 avec une dalle vide. Une image en EPSG:4326 doit avoir des côtés
  proportionnels à l'étendue en **mètres**, sinon elle sort étirée.
- **La grille MNH à 0,5 m est lue une fois** et passée aux toitures et aux
  houppiers ; elle n'est jamais embarquée dans la scène (1,9 Mo d'entrée de
  calcul).
- **Ce qui touche au MNH ou aux houppiers va dans la scène ; le reste peut
  être une couche à part.** Une couche chargée après la scène (monuments,
  ouvrages) a son fichier de cache, sa version, et la même règle : écrite
  entière ou pas du tout. Elle ne lit de la scène que ses résultats.
- **Un toit en pans est fermé ou n'est pas publié.** `pans.py` vérifie le
  volume transmis, après quantification : chaque arête portée par exactement
  deux triangles, en sens opposés. Sinon il rend None et le toit garde sa
  surface mesurée. Ne jamais publier un volume « presque » fermé.
- **Un calcul plus rapide rend la même scène, au bit près.** Le cache ne
  périme pas : une scène reconstruite doit être celle d'avant. Un raccourci
  garde les mêmes opérations flottantes dans le même ordre (`sum()` de Python
  3.12 est compensée, `x ** 2` n'est pas `x * x`), et se vérifie contre le
  calcul d'origine (`tests/references_toits.py`). Le bassin des toitures
  (`toits.py`) ne sert qu'au service, qui l'autorise : ses processus
  réexécutent le script principal, qu'un script de mesure doit garder derrière
  `if __name__ == "__main__"` s'il passe `processus=`. Les houppiers ne lisent
  pas les toits : `assembler` les calcule pendant les toitures du bassin ; si
  la végétation devait un jour lire les toits, retirer ce recouvrement.
- **Une scène en échec ne lance plus de requête.** Toute requête vers la
  Géoplateforme passe par `geopf.place()`, toute lecture lancée en parallèle
  par `geopf.en_parallele` ou `Groupe.soumettre` : au premier échec, les
  lectures qui attendent leur place ne partent plus. Un fil nu y échappe.
- **Le contour dessiné (`?poly=`) est une frontière, pas un filtre d'affichage.**
  La boîte englobante est lue, puis chaque source GeoJSON est découpée au
  contour avant tout calcul (`polygone.decouper_features`), la grille MNH est
  lue sur la boîte — ses cellules servent aux toitures du bord — et les
  houppiers sont gardés par leur sommet ; la scène porte l'anneau, et la page
  masque le terrain au-delà. Rien hors contour n'est calculé, dessiné ni
  exporté. Le cache est celui du contour (`_poly-<clé>`), jamais celui du
  carré : deux contours différents ne partagent pas une scène. La page et le
  serveur arrondissent les sommets à six décimales et les écrivent dans le même
  ordre, sans quoi l'URL et la clé du cache divergeraient.
- **Le CRS écrit est celui des coordonnées, jamais un autre.** Une projection
  choisie à l'export (`PROJECTIONS`, dans la page) change les coordonnées, le
  `srsName` du CityGML, l'`IFCPROJECTEDCRS` et l'`IFCMAPCONVERSION` de l'IFC et
  le nord vrai — pas seulement l'en-tête. Un CityGML qui dit EPSG:2154 en
  portant des mètres UTM se replace ailleurs, et une conversion qui ment
  déplace tout le projet chez le lecteur. L'altitude NGF ne se compose qu'avec
  RGF93 (EPSG:5720, 5721 en Corse) : ailleurs elle s'écrit sans être déclarée.
  Les projections sont vérifiées contre pyproj par `outils/verifier-export.mjs`,
  au dixième de millimètre ; la série de l'UTM est celle de Krüger à l'ordre 6,
  pas celle de Snyder, qui perd 77 cm à 13° du méridien.
- **Le décalage du site est porté une fois, par le site ou par la conversion.**
  L'ancrage se choisit à l'export (`#export-ancrage`) : `origine` laisse le
  site à zéro et met les coordonnées dans `IFCMAPCONVERSION` — Revit, ArchiCAD,
  Bonsai ; `site` pose le site à ses coordonnées et met la conversion à zéro —
  ce que lisent Trimble Connect et les visionneuses qui ignorent la conversion,
  le « IfcSite coordinate system » de Tekla. Dans les deux cas la géométrie
  reste rapportée à `origine`, et les éléments placés à l'identité dans le
  site. `outils/valider_ifc.py` refuse un décalage porté deux fois comme un
  décalage porté nulle part.
- **La géométrie d'un houppier ne doit jamais se retourner** : rayon croissant
  avec la couronne, hauteur décroissante du sommet au bord, dessous qui remonte
  vers le tronc, lobage partagé par tous les anneaux. Un défaut ici passe
  inaperçu à forte opacité et saute aux yeux à 30 %.
- **La fenêtre d'enregistrement de l'export s'ouvre avant le calcul**, et son
  flux d'écriture s'ouvre dans la foulée. `showSaveFilePicker` veut une
  activation utilisateur : appelée après les une à deux secondes de
  `modeleExport`, Chromium la refuse. Elle n'existe que sur Chromium et en
  contexte sûr (https, localhost) ; ailleurs le bouton « Enregistrer sous… » est
  masqué, « Télécharger » va au dossier du navigateur.
  Le repli doit rester, et couvrir aussi le refus de l'écriture : dans un
  navigateur embarqué (l'aperçu d'un éditeur, une WebView), la fenêtre s'ouvre
  puis `createWritable` lève « The request is not allowed by the user agent or
  the platform in the current context » — le fichier part alors au
  téléchargement, la note et l'infobulle du bouton le disent. La fenêtre ne doit
  jamais coûter l'export.
- **Un interrupteur d'export suit la scène.** Une couche que la scène ne porte
  pas s'éteint dans la fenêtre, et l'option effective est le cochage **et** la
  présence (`COUCHES_PRESENTES` dans `modeleExport` de la page) : sans quoi la
  note annoncerait « 0 cimetière » pour une couche absente. `demo-video.mjs`
  et `essai-navigateur.mjs` cliquent les boutons d'export : garder `#btn-ifc`,
  `#btn-citygml` et `#note-export` au panneau, et ouvrir la fenêtre avant d'y
  cliquer un interrupteur.
- **L'export relit la scène, il ne la reconstruit pas.** Un aplat drapé, un
  ruban de route, un fût de pylône partent des mêmes triangles et du même
  drapage que la vue : `routesPosees` et `eauPosee` gardent ceux de chaque
  entité (la vue, elle, n'en dessine qu'un maillage par matériau pour les
  routes), `facettesDrapes()` rejoue le drapage de `placerDrapes()` sans
  exagération du relief, et les pylônes se lisent dans `groupeLignes` par
  leur `userData`. Changer la construction d'un ruban ou d'un pylône sans
  changer l'export ferait diverger le fichier et l'écran. En CityGML, les
  réseaux passent par la branche générique (`ecrireCityGml` inchangé) ;
  `outils/valider_citygml.py` ne demande un volume tourné vers l'extérieur
  qu'aux surfaces fermées, un aplat ou un câble n'enfermant rien.
- **Un grand tableau s'ajoute avec `etendre()`, jamais `push(...valeurs)`.**
  L'export rassemble les tableaux de la scène — 62 208 valeurs pour le tube
  d'un conducteur HT, des dizaines de milliers pour un aplat — et les passer
  en arguments dépasse la pile (« Maximum call stack size exceeded »), ce qui
  perdait l'export d'une scène avec lignes. `outils/verifier-export.mjs` le
  vérifie sur ces 62 208 valeurs.
- **Dans la fenêtre d'export, tout `<button>` porte son `type`.** La fenêtre
  est un `<form method="dialog">` : un bouton sans `type` est un bouton de
  soumission, et chaque clic sur une couche la fermait.

## Méthode de travail

- **Mesurer avant de changer un seuil.** Chaque constante des modules de calcul
  porte en commentaire la mesure qui l'a fixée. Un nouveau seuil se justifie de
  la même façon, sur des données réelles.
- **La géométrie se vérifie en exécutant le vrai code**, pas en le relisant :
  extraire les fonctions de `index.html` et les exécuter sous Node avec un
  THREE minimal a trouvé des facettes retournées que la lecture avait ratées.
- **La page se vérifie dans un navigateur** avec `outils/essai-navigateur.mjs` :
  les tests Python ne voient aucun chemin du rendu. Le script échoue à la
  moindre erreur JavaScript ou requête en échec.
- **Données publiques uniquement dans le dépôt.** Exemples et captures sur des
  lieux publics (monuments, centres de villages), jamais l'adresse d'un
  particulier.

## Conventions

- Code, commentaires, messages de commit et documentation en **français**.
- Les commentaires expliquent le **pourquoi**, mesure à l'appui, pas le quoi.
- Messages de commit au format `type(portée): résumé`, corps explicatif ; pas de
  trailer `Co-Authored-By`.
- Tout changement de `SCENE_VERSION`, ou visible de l'utilisateur, s'inscrit
  dans [CHANGELOG.md](CHANGELOG.md).
- Toujours lancer toute la suite `pytest` avant de conclure.
