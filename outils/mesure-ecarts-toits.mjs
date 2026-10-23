// Mesure des écarts entre les toits dessinés et les points du nuage LiDAR HD
// (verifierToits, vue3d/static/js/scene/couches/ecarts-toits.js), sur la vraie
// page servie.
//
// Pour chaque lieu : quand arrivent la couche du carré proche puis celle de la
// zone entière, ce que coûte la vérification, puis la distribution des écarts —
// par forme de toit, et selon la distance du point au contour de l'emprise —,
// toits mesurés allumés puis éteints (le toit résumé seul). C'est la mesure à
// relancer avant de toucher ECART_TOIT_M, PART_EN_ECART, POINTS_MIN_ECART ou
// MARGE_ECART_M.
//
//   npm install puppeteer-core
//   node outils/mesure-ecarts-toits.mjs "http://localhost:8080/?lat=43.9116&lon=5.2003" [url …]
//
// CHROME désigne l'exécutable de Chrome ou Chromium ; par défaut celui de macOS.
import puppeteer from 'puppeteer-core';
import { estModulePrincipal, repondreAvecCrochet } from './crochet-page.mjs';

const urls = process.argv.slice(2);
if (!urls.length) { console.error('usage : node outils/mesure-ecarts-toits.mjs URL [URL …]'); process.exit(2); }
const navigateur = await puppeteer.launch({
  executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

// La page est servie telle quelle, à un ajout près : de quoi lire le bilan.
const CROCHET = `import { bilanEcarts, ecartsParToit, distanceAuContour } from './couches/ecarts-toits.js';
import { toitsEnPente } from './batiments/etat.js';
window.__ecarts = {
    bilan: () => bilanEcarts,
    resume(seuil) {
        const b = bilanEcarts;
        if (!b) return null;
        const forme = ud => ud.surface ? (ud.lidar && ud.lidar.pans ? 'pans' : 'surface')
            : ud.lidar && ud.lidar.corps && ud.lidar.corps.length >= 2 ? 'corps'
            : ud.lidar ? (ud.lidar.faitage - ud.lidar.gouttiere > 0.5 && toitsEnPente ? 'deux pans' : 'plat LiDAR')
            : 'BD TOPO';
        const parForme = {}, bords = [[0, 1], [1, 2], [2, 4], [4, Infinity]].map(([a, z]) => ({ a, z, n: 0, loin: 0 }));
        const tous = [];
        // Écarts à la forme de chaque toit, son décalage ôté, selon la
        // distance au contour (façades, débords, précision de l'emprise).
        for (let p = 0; p < b.toit.length; p++) {
            const k = b.toit[p];
            if (k < 0) continue;
            const t = b.toits[k], e = b.ecart[p] - t.mediane;
            tous.push(b.ecart[p]);
            const d = distanceAuContour(b.xs[p], b.zs[p], t.contour);
            const c = bords.find(c => d >= c.a && d < c.z);
            c.n++; if (Math.abs(e) > seuil) c.loin++;
        }
        for (const t of b.toits) {
            const v = ecartsParToit.get(t.ud.anneau);
            if (v) (parForme[forme(t.ud)] = parForme[forme(t.ud)] || []).push(v);
        }
        return { verifies: b.verifies, enEcart: b.enEcart, phase: b.phase, ms: b.ms, tous, parForme, bords };
    },
};`;

const q = (tab, p) => { const t = Float64Array.from(tab).sort(); return t.length ? t[Math.min(t.length - 1, Math.floor(p * t.length))] : NaN; };
const f2 = x => (x >= 0 ? '+' : '') + x.toFixed(2);

function afficher(r, titre) {
  console.log(`\n### ${titre} : ${r.verifies} toits vérifiés, ${r.enEcart} en écart (${r.phase}), `
              + `calcul ${Math.round(r.ms)} ms, ${r.tous.length} points comparés`);
  console.log(`- écart des points au toit : p5 ${f2(q(r.tous, .05))}, p25 ${f2(q(r.tous, .25))}, médiane ${f2(q(r.tous, .5))}, `
              + `p75 ${f2(q(r.tous, .75))}, p95 ${f2(q(r.tous, .95))} m`);
  console.log('- hors de la forme (à plus de 0,5 m, décalage ôté), selon la distance au contour : '
              + r.bords.map(c => `${c.a}-${c.z === null || c.z === Infinity ? '…' : c.z} m : `
                                 + `${c.n ? Math.round(100 * c.loin / c.n) : '—'} % de ${c.n}`).join(', '));
  for (const [forme, vs] of Object.entries(r.parForme).sort((a, b) => b[1].length - a[1].length)) {
    const meds = vs.map(v => v.mediane), parts = vs.map(v => v.part);
    console.log(`- ${forme.padEnd(10)} ${String(vs.length).padStart(4)} toits : décalage p10 ${f2(q(meds, .1))}, `
                + `p50 ${f2(q(meds, .5))}, p90 ${f2(q(meds, .9))} m ; hors de la forme p10 ${Math.round(100 * q(parts, .1))} %, `
                + `p50 ${Math.round(100 * q(parts, .5))} %, p90 ${Math.round(100 * q(parts, .9))} % ; `
                + `en écart ${vs.filter(v => v.enEcart).length} ; au seuil de 30, 40, 50 % : `
                + [0.3, 0.4, 0.5].map(x => vs.filter(v => v.n >= 20 && v.part >= x).length).join(', '));
  }
}

for (const url of urls) {
  const page = await navigateur.newPage();
  await page.setViewport({ width: 1400, height: 850 });
  page.on('pageerror', e => console.error('pageerror: ' + e.message));
  await page.setRequestInterception(true);
  page.on('request', r => estModulePrincipal(r) ? repondreAvecCrochet(r, CROCHET) : r.continue());
  console.log(`\n## ${url}`);
  const debut = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('attente').hidden, { timeout: 15 * 60 * 1000 });
  console.log(`- scène affichée à ${Math.round((Date.now() - debut) / 1000)} s`);
  // Les phases du nuage, à mesure qu'elles arrivent.
  let vue = null;
  for (;;) {
    const etat = await page.evaluate(() => {
      const b = window.__ecarts.bilan(), e = document.getElementById('etat-nuage');
      return { phase: b && b.phase, enCours: !e.hidden && e.classList.contains('en-cours'), texte: e.textContent };
    });
    if (etat.phase && etat.phase !== vue) {
      vue = etat.phase;
      console.log(`- ${vue} vérifié à ${Math.round((Date.now() - debut) / 1000)} s`);
      if (vue === 'carré proche') afficher(await page.evaluate(() => window.__ecarts.resume(0.5)), 'carré proche');
    }
    if (!etat.enCours && (vue === 'zone entière' || /indisponible/.test(etat.texte))) break;
    if (!etat.enCours && !vue && Date.now() - debut > 30000) { console.log('- pas de nuage ici'); break; }
    await new Promise(r => setTimeout(r, 500));
  }
  if (vue === 'zone entière') {
    afficher(await page.evaluate(() => window.__ecarts.resume(0.5)), 'zone entière, toits mesurés');
    // Toits mesurés éteints : le toit résumé seul, comme avant les pans.
    await page.evaluate(() => { window.__ecarts.avant = window.__ecarts.bilan(); });
    await page.click('#t-mesure');
    await page.waitForFunction(() => window.__ecarts.bilan() && window.__ecarts.bilan() !== window.__ecarts.avant,
      { timeout: 60000 });
    afficher(await page.evaluate(() => window.__ecarts.resume(0.5)), 'zone entière, toit résumé seul');
  }
  await page.close();
}
await navigateur.close();
