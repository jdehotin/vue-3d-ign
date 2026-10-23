"""Les réponses que partagent les routes : erreur en JSON, fichier gzippé
revalidé à chaque demande."""

import os

from flask import current_app, jsonify, request


def erreur(code, message):
    return jsonify({"erreur": message}), code


# Tout ce qui sort du dossier d'une scène est revalidé à chaque demande :
# une scène et ses couches peuvent être reconstruites sous la même adresse
# (Cache.reconstruire), et une couche change avec le détecteur du service
# et avec sa version. Gardée un jour par le navigateur, la scène
# reconstruite n'apparaissait pas, et la couche des véhicules montrait
# encore les véhicules sans les piscines après une reconstruction de
# l'image. Le validateur est le fichier lui-même, son nom et l'instant de
# son écriture : un 304 sans corps tant qu'il n'a pas été réécrit.
def validateur(chemin):
    etat = os.stat(chemin)
    return f"{os.path.basename(chemin)}-{etat.st_mtime_ns}-{etat.st_size}"


def servir_gzip(dossier, nom):
    chemin = os.path.join(dossier, nom)
    etag = validateur(chemin)
    if request.if_none_match.contains(etag):
        reponse = current_app.response_class(status=304)
    else:
        with open(chemin, "rb") as f:
            charge = f.read()
        # Déjà gzippé : annoncé tel quel, le navigateur le décompresse.
        reponse = current_app.response_class(charge, mimetype="application/json")
        reponse.headers["Content-Encoding"] = "gzip"
    reponse.set_etag(etag)
    reponse.headers["Cache-Control"] = "no-cache"
    return reponse
