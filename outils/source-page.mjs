// Le code JavaScript d'une page, ses modules mis bout à bout (vue3d/static/js/),
// pour les outils qui en extraient des fonctions par leur nom et les exécutent
// sous Node : `function nom(` et `const nom =` s'y lisent tels quels, exportés
// ou non. Les modules eux-mêmes ne s'importent pas sous Node : ils touchent au
// DOM dès leur chargement.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const JS = fileURLToPath(new URL('../vue3d/static/js/', import.meta.url));

/** Le texte des modules des dossiers donnés (« commun », « scene »…), dans l'ordre des chemins. */
export function sourceDesModules(...dossiers) {
  const fichiers = [];
  const parcourir = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) parcourir(p);
      else if (p.endsWith('.js')) fichiers.push(p);
    }
  };
  for (const d of dossiers) parcourir(path.join(JS, d));
  return fichiers.sort().map(f => fs.readFileSync(f, 'utf8')).join('\n');
}
