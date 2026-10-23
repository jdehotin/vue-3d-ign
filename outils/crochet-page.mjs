// Un crochet dans la page de la scène, pour les outils qui lisent ses objets
// (outils/demo-video.mjs, outils/mesure-ecarts-toits.mjs) : son module
// principal est servi tel quel, suivi du code de l'outil, dont les `import`
// se résolvent depuis vue3d/static/js/scene/main.js. Il s'exécute à la fin du
// chargement des modules, avant la première image.

export const MODULE_PRINCIPAL = '/static/js/scene/main.js';

/** Vrai si la requête `r` (puppeteer) demande le module principal de la page. */
export const estModulePrincipal = r => new URL(r.url()).pathname === MODULE_PRINCIPAL;

/** Répond à `r`, la requête du module principal, avec `code` à sa suite. */
export async function repondreAvecCrochet(r, code) {
  const rep = await fetch(r.url());
  if (!rep.ok) return r.respond({ status: rep.status, body: await rep.text() });
  r.respond({ status: 200, contentType: 'text/javascript; charset=utf-8',
              body: `${await rep.text()}\n// --- Crochet de l'outil ---\n${code}\n` });
}
