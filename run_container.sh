#!/usr/bin/env bash
# Lance le service avec `container`, l'outil d'Apple (macOS 26, Apple
# silicon), à la place de Docker : le même Dockerfile, mais chaque conteneur
# est une petite machine virtuelle Linux, sans Docker Desktop. Les variables
# sont celles de docker-compose.yml, avec les mêmes défauts :
#
#   ./run_container.sh                           # sans détecteur de véhicules
#   VUE3D_VEHICULES=rtmdet ./run_container.sh    # aucun | rtmdet | yolo | tous
#   VUE3D_PANNEAUX=oui ./run_container.sh        # registre OpenPVMapper
#   VUE3D_PORT=8081 ./run_container.sh           # à côté d'un autre service
#
# Pas de CoreML dans le conteneur : c'est un Linux, qui ne voit ni le Neural
# Engine ni le GPU, et les détecteurs y tournent au processeur comme sous
# Docker. Pour CoreML : ./run_macOS_CoreML.sh.
#
# Le script reconstruit l'image à chaque lancement (le code y est copié ; le
# cache de construction rend cela rapide quand rien n'a changé), remplace le
# conteneur précédent et garde les scènes dans le volume vue-3d-ign-scenes.
# Ensuite :
#
#   container logs -f vue-3d-ign       # journaux
#   container stop vue-3d-ign          # arrêt ; relancer le script pour repartir
#   container volume rm vue-3d-ign-scenes   # oublier les scènes (conteneur arrêté)
#
# Contrairement à Docker, rien ne relance le conteneur après un redémarrage
# du Mac : `container` n'a pas de politique de redémarrage.
#
# Seul prérequis : brew install container. Le premier lancement installe le
# noyau Linux de la machine virtuelle.
set -euo pipefail
cd "$(dirname "$0")"

NOM=vue-3d-ign
VOLUME=vue-3d-ign-scenes
PORT="${VUE3D_PORT:-8080}"
VEHICULES="${VUE3D_VEHICULES:-aucun}"
PANNEAUX="${VUE3D_PANNEAUX:-}"
# Une image par choix, comme docker-compose.yml.
ETIQUETTE="${VUE3D_VEHICULES:-latest}${PANNEAUX:+-panneaux}"
IMAGE="vue-3d-ign:$ETIQUETTE"
# Tous les cœurs : le bassin des toitures (vue3d/toits.py) en prend autant
# que la machine virtuelle en voit, et `container` n'en donne que 4.
CPUS="${VUE3D_CPUS:-$(sysctl -n hw.ncpu)}"
# Le défaut de `container` est 1 Go : trop juste, le service monte à 2,0 Go
# avec `tous` en zone de 1 000 m (CHANGELOG, mesure du 2 octobre 2026).
MEMOIRE="${VUE3D_MEMOIRE:-4g}"

if ! command -v container >/dev/null 2>&1; then
    echo "L'outil container d'Apple est introuvable : brew install container" >&2
    exit 1
fi

if ! container system status >/dev/null 2>&1; then
    echo "Démarrage du service container…"
    container system start --enable-kernel-install
fi

# La machine virtuelle de construction garde ses 2 Go par défaut : l'export
# des deux réseaux par torch y passe (1 min 22 s avec `tous`, 2026-10-18).
container build --tag "$IMAGE" \
    --build-arg VEHICULES="$VEHICULES" --build-arg PANNEAUX="$PANNEAUX" .

if container inspect "$NOM" >/dev/null 2>&1; then
    container delete --force "$NOM" >/dev/null
fi

# Le contrôle n'est pas laissé à `container run` : comme avec Docker, macOS
# laisserait deux services se partager le port selon IPv4 ou IPv6
# (run_macOS_CoreML.sh).
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Le port $PORT est déjà écouté (docker compose ? run_macOS_CoreML.sh ?) :" \
         "libérez-le, ou VUE3D_PORT=8081 $0" >&2
    exit 1
fi

if ! container volume inspect "$VOLUME" >/dev/null 2>&1; then
    container volume create "$VOLUME" >/dev/null
fi
# Un volume neuf de `container` appartient à root, alors que Docker lui donne
# le propriétaire du dossier de l'image : le service, qui tourne sous vue3d,
# n'y écrirait pas une scène.
container run --rm --progress none --user root --volume "$VOLUME:/cache" "$IMAGE" \
    chown vue3d /cache

container run --detach --progress none --name "$NOM" \
    --publish "$PORT:8080" --volume "$VOLUME:/cache" \
    --cpus "$CPUS" --memory "$MEMOIRE" "$IMAGE" >/dev/null

# `container` ignore le HEALTHCHECK de l'image : on attend /api/sante ici.
for _ in $(seq 60); do
    if curl -fsS "http://localhost:$PORT/api/sante" >/dev/null 2>&1; then
        echo "Prêt : http://localhost:$PORT/   (journaux : container logs -f $NOM)"
        exit 0
    fi
    sleep 0.5
done
echo "Le service ne répond pas sur le port $PORT. Journaux :" >&2
container logs -n 30 "$NOM" >&2
exit 1
