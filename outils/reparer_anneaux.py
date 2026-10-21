"""Relit l'anneau de relief des scènes en cache dans les tuiles natives du RGE ALTI.

    python outils/reparer_anneaux.py cache            # répare
    python outils/reparer_anneaux.py cache --essai    # compte, n'écrit rien

Jusqu'au 2026-10-21, l'anneau était lu au WMS, qui y glisse une ligne prise
130 m plus au nord toutes les 8 lignes environ (vue3d/relief.py) : des arêtes
est-ouest dans l'anneau de presque toutes les scènes vallonnées. Le cache ne
périme pas. Plutôt que de monter SCENE_VERSION et de reconstruire chaque
scène pour son seul anneau — rien d'autre dans la scène n'en dépend, seule la
vue le lit —, ce script le relit à l'emprise et à la taille de l'ancien, puis
réécrit la scène d'un bloc, comme Cache._ecrire.

Une scène dont l'anneau n'a pas pu être lu reste telle quelle : relancer le
script la reprend. Une scène déjà réparée n'est pas réécrite (son ETag reste
le même), ni une scène reconstruite par le service pendant la lecture.
"""
import base64
import gzip
import json
import os
import sys
import tempfile
from pathlib import Path

import numpy as np
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vue3d.relief import RELIEF_SENTINELLE, fetch_relief_anneau
from vue3d.scene import NOM_SCENE, SCENE_VERSION


def lignes_aberrantes(anneau):
    """Lignes dont la courbure nord-sud dépasse trois fois la médiane des
    lignes et des colonnes : le défaut du WMS, sans référence à relire."""
    q = np.frombuffer(base64.b64decode(anneau["altitudes"]), dtype="<i2").reshape(
        anneau["height"], anneau["width"])
    a = anneau["zero_m"] + q.astype(float) * anneau["pas_m"]
    a[q == RELIEF_SENTINELLE] = np.nan
    with np.errstate(all="ignore"):
        lignes = np.sqrt(np.nanmean((a[1:-1] - (a[:-2] + a[2:]) / 2) ** 2, axis=1))
        colonnes = np.sqrt(np.nanmean((a[:, 1:-1] - (a[:, :-2] + a[:, 2:]) / 2) ** 2, axis=0))
        reference = np.nanmedian(np.concatenate([lignes, colonnes]))
    return int((lignes > 3 * reference).sum())


def reparer(chemin, essai=False):
    """Rend (état, lignes aberrantes avant, après)."""
    avant = os.stat(chemin).st_mtime_ns
    with gzip.open(chemin, "rt") as f:
        scene = json.load(f)
    ancien = scene.get("anneau")
    if not ancien:
        return "sans anneau", 0, 0
    try:
        neuf = fetch_relief_anneau(*ancien["bbox"], taille=ancien["width"])
    except requests.RequestException as exc:
        return f"illisible ({exc})", lignes_aberrantes(ancien), None
    if neuf is None:
        return "hors couverture à la relecture, laissé", lignes_aberrantes(ancien), None
    if neuf == ancien:
        return "déjà juste", 0, 0
    if not essai:
        scene["anneau"] = neuf
        octets = gzip.compress(json.dumps(scene, separators=(",", ":")).encode(), 6)
        dossier = os.path.dirname(chemin)
        fd, tmp = tempfile.mkstemp(dir=dossier)
        with os.fdopen(fd, "wb") as f:
            f.write(octets)
        if os.stat(chemin).st_mtime_ns != avant:
            os.unlink(tmp)
            return "reconstruite entre-temps, laissée", lignes_aberrantes(ancien), None
        os.chmod(tmp, os.stat(chemin).st_mode & 0o777)
        os.replace(tmp, chemin)
    return "réparée" if not essai else "à réparer", lignes_aberrantes(ancien), lignes_aberrantes(neuf)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    essai = "--essai" in sys.argv
    if len(args) != 1:
        sys.exit(__doc__)
    scenes = sorted(Path(args[0], f"v{SCENE_VERSION}").glob(f"*/{NOM_SCENE}"))
    bilan = {}
    for chemin in scenes:
        etat, avant, apres = reparer(str(chemin), essai)
        bilan[etat.split(" (")[0]] = bilan.get(etat.split(" (")[0], 0) + 1
        print(f"{chemin.parent.name:32s} {etat:40s} lignes aberrantes {avant}"
              + (f" → {apres}" if apres is not None else ""), flush=True)
    print(f"\n{len(scenes)} scènes : " + ", ".join(f"{n} {e}" for e, n in sorted(bilan.items())))
    if any(e.startswith("illisible") for e in bilan):
        sys.exit(1)
