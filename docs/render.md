# Déploiement sur Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/jdehotin/vue-3d-ign)

L'application est un serveur Flask qui interroge la Géoplateforme de l'IGN à la
demande, met la scène en cache sur disque et sert la page three.js. Render
l'héberge en HTTPS, ce dont l'extension Trimble Connect a besoin : le panneau
de l'extension ne parle qu'à cette adresse, jamais directement à l'IGN.

La configuration est décrite dans [`render.yaml`](../render.yaml). Il n'y a
**ni base de données ni clé d'API** : la seule persistance est le cache des
scènes, sur le disque Render monté dans `/var/data`.

## Mise en place

1. Le dépôt est `jdehotin/vue-3d-ign` (fork de `ysimonx/vue-3d-ign`).
   `origin` pousse sur le fork, `upstream` reste la source d'origine.
2. Sur [Render](https://dashboard.render.com), **New → Blueprint**, autoriser
   GitHub, choisir `jdehotin/vue-3d-ign`, branche `main`.
3. Render lit `render.yaml` et crée le service et son disque de 5 Go.
4. Si l'option est proposée, régler *Auto-Deploy* sur **After CI Checks Pass** :
   un `pytest` rouge ne partira pas en production.
5. Noter l'adresse du service : `https://vue3d-ign-oncdesncf.onrender.com`.
   C'est elle qui ira dans le `config.json` de l'extension.

### Le nom et l'adresse ne sont pas la même chose

Render attribue le sous-domaine `onrender.com` **au moment de la création du
service**, d'après son nom. Renommer un service dans le dashboard (*Settings →
Name*) change son nom — celui que voit le Blueprint et qui figure dans
`render.yaml` — mais **pas son adresse** : l'ancienne continue de répondre et
la nouvelle renvoie 404. Le service affiché dans le dashboard sous le nom
`vue3d-ign-oncdesncf` répond donc toujours sur
`https://vue3d-ign-jdehotin.onrender.com`.

Le Blueprint, lui, identifie un service **par son nom** : si `render.yaml` porte
un nom qu'aucun service ne porte, Render **recrée** un service à ce nom — avec
un disque neuf et une facture en plus. Le nom de `render.yaml` doit donc
toujours être celui du service existant.

Pour obtenir une nouvelle adresse `onrender.com`, il faut donc recréer le
service, pas le renommer. La marche à suivre est décrite dans
[Changer l'adresse du service](#changer-ladresse-du-service).

Le premier déploiement est plus lent : Render installe les dépendances, puis le
service démarre à froid. Les suivants partent à chaque push sur `main`.

## Variables

| Variable | Valeur | Pourquoi |
|---|---|---|
| `VUE3D_CACHE` | `/var/data/cache` | Le disque, et non `/tmp` qui disparaît à chaque redéploiement. |
| `VUE3D_PROXY` | `1` | Render est un proxy : l'IP réelle est lue dans `X-Forwarded-For`, sans quoi tous les visiteurs partagent le quota de `127.0.0.1`. |
| `VUE3D_QUOTA` | `60` | Scènes neuves par heure et par IP ; la Géoplateforme est publique et ne doit pas être martelée. |

La version de Python est épinglée par `.python-version` (`3.12`). Render prend
sinon 3.14, où les houppiers retombent à zéro.

## Changer l'adresse du service

L'adresse `onrender.com` étant figée à la création, une nouvelle adresse
suppose un **nouveau service**. Render le crée à partir du Blueprint, qui
identifie le service par son nom : changer le `name:` de `render.yaml` suffit
à demander cette création.

1. Renommer le service existant dans le dashboard (*Settings → Name*), avec un
   nom de repli, par exemple `vue3d-ign-oncdesncf-ancien`. Son adresse ne change
   pas : `https://vue3d-ign-jdehotin.onrender.com` reste le secours.
2. Changer le `name:` de `render.yaml` pour le nom voulu, ici
   `vue3d-ign-oncdesncf`, et le pousser.
3. Render crée le service et son disque. Le Blueprint ne supprime jamais une
   ressource : l'ancien service reste, avec son cache.
4. Une fois le nouveau service **Live** et vérifié, supprimer l'ancien service
   et son disque. Sans cela, deux instances payantes tournent en parallèle.

Le cache est propre à chaque disque : la première scène du nouveau service
prend 20 à 30 s, comme après n'importe quel premier déploiement.

## Recette après déploiement

Service en ligne : `https://vue3d-ign-oncdesncf.onrender.com`.

- `GET /api/sante` répond 200.
- `GET /?lat=43.9116&lon=5.2003` construit la scène de Gordes en 20 à 30 s.
- Un second appel est rapide, **et le reste après un redémarrage** du service :
  c'est la preuve que `/var/data/cache` est bien écrit.
- Les journaux Render ne montrent aucune erreur d'écriture dans le cache.

Mesures du 21 octobre 2026 : première scène de Gordes à 500 m en 11 s, relue
en 3,3 s ; contour `poly` en 4,6 s.

## Ce que ce service ne fait pas

- Pas de couche des véhicules ni des panneaux solaires : elles demandent des
  modèles ONNX ou une base SQLite préparés dans l'image Docker, et ne sont pas
  nécessaires au contexte IGN de Trimble Connect.
- Pas de base de données : un disque Render ne se partage pas entre instances,
  et l'application est sans base par invariant.

## Dépannage

- **Build Python** : si un wheel binaire manquait pour 3.12, revenir au
  `Dockerfile` et monter le disque sur `/cache`, en s'assurant que
  l'utilisateur `vue3d` peut y écrire.
- **Scène reconstruite à chaque appel** : le disque n'est pas monté au bon
  chemin, ou `VUE3D_CACHE` ne pointe pas dessus.
- **Quota partagé** : `VUE3D_PROXY` vaut 0, ou le proxy de Render n'est pas
  celui attendu.
- **Houppiers absents** : la version de Python n'est pas 3.12.
- **`onrender.com` renvoie 404 après un renommage** : le sous-domaine est
  attribué à la création du service et ne suit pas le renommage. Vérifier
  l'adresse affichée sous le nom du service dans le dashboard : c'est elle qui
  répond, l'autre renvoie 404. Pour une nouvelle adresse, recréer le service
  ([procédure](#changer-ladresse-du-service)).
- **Le Blueprint recrée le service** : `render.yaml` porte un nom qu'aucun
  service ne porte plus. Le nom de `render.yaml` doit être celui du service
  dans le dashboard.
