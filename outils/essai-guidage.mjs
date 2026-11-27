// Essai du guidage de la vue en voiture (static/voiture.html) dans un vrai
// navigateur : une conduite simulée vers `vers=`, arrêtée au départ
// (`attente=1`) le temps que la route prévue, qui suit le tracé du service
// d'itinéraire de l'IGN sur le graphe des carrés, aille jusqu'à l'arrivée.
// Liste alors les manœuvres que la page annoncerait, avec leur distance au
// départ ; échoue si la route prévue n'arrive pas, ou si sa longueur s'écarte
// de celle du tracé (le tracé perdu à un carrefour : elle repart au hasard).
// Pour un trajet de 20 km au plus : la route prévue n'est pas plus longue.
//
//   node outils/essai-guidage.mjs "http://localhost:8080/voiture?simu=1&lat=43.5263&lon=5.4474&vers=43.4546,5.4697&versnom=Gardanne"
//
// CHROME désigne l'exécutable de Chrome ou Chromium ; par défaut celui de macOS.
import puppeteer from 'puppeteer-core';

const url = process.argv[2];
if (!url || !/[?&]vers=/.test(url)) { console.error('usage : node outils/essai-guidage.mjs "<url de /voiture avec simu=1 et vers=>" [capture.png]'); process.exit(2); }
const navigateur = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new', args: [`--use-angle=${process.env.ANGLE || (process.platform === 'darwin' ? 'metal' : 'swiftshader')}`],
});
const page = await navigateur.newPage();
await page.setViewport({ width: 1100, height: 760 });
const erreurs = [];
page.on('pageerror', e => erreurs.push('pageerror: ' + e.message));
await page.goto(url + '&attente=1', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__voiture, { timeout: 30000 });
const t0 = Date.now();
let etat;
for (;;) {
    etat = await page.evaluate(() => {
        const V = window.__voiture, ch = V.voiture.chemin;
        return { fin: ch?.fin, longueur: ch?.longueur, surTrace: ch?.t0 != null, trace: V.itineraire?.longueur, guidage: V.guidage.etat };
    });
    if (etat.fin === 'arrivee' || Date.now() - t0 > 180000) break;
    await new Promise(r => setTimeout(r, 2000));
}
// Les manœuvres : prochaineManoeuvre() rejouée en avançant la voiture le long
// de la route prévue, d'une manœuvre à la suivante.
const releve = await page.evaluate(() => {
    const V = window.__voiture, v = V.voiture, ch = v.chemin;
    if (!ch) return { manoeuvres: [] };
    const d0 = v.dChemin, manoeuvres = [];
    let d = 0;
    for (let garde = 0; d < ch.longueur && garde < 500; garde++) {
        v.dChemin = d;
        const m = V.prochaineManoeuvre();
        if (!m) { manoeuvres.push({ d: Math.round(d), type: 'tracé perdu' }); break; }
        manoeuvres.push({ d: Math.round(d + m.d), type: m.type, angle: Math.round(m.angle), sortie: m.sortie, cote: m.cote,
                          vers: m.vers ? (m.vers.nom || m.vers.numero || '').replace(/\s+/g, ' ') + ` [${m.vers.nature}]` : '' });
        if (m.type === 'arrivee' || m.type === 'suivre') break;
        d += m.d + 1;
    }
    v.dChemin = d0;
    return { manoeuvres };
});
console.log(`tracé IGN ${Math.round(etat.trace ?? 0)} m · route prévue ${Math.round(etat.longueur ?? 0)} m, fin « ${etat.fin} » · guidage ${etat.guidage}`);
for (const m of releve.manoeuvres) {
    console.log(`${String(m.d).padStart(7)} m  ${m.type}${m.sortie ? ' ' + m.sortie + 'e sortie' : ''}${m.cote ? ' ' + m.cote : ''}`
        + `${m.angle != null && m.type !== 'arrivee' ? ` (${m.angle}°)` : ''}  ${m.vers || ''}`);
}
if (process.argv[3]) await page.screenshot({ path: process.argv[3] });
if (etat.fin !== 'arrivee') erreurs.push(`la route prévue n'arrive pas (fin « ${etat.fin} »)`);
else if (Math.abs(etat.longueur - etat.trace) > 5 + 0.005 * etat.trace) {
    erreurs.push(`route prévue de ${Math.round(etat.longueur)} m pour un tracé de ${Math.round(etat.trace)} m`);
}
console.log(erreurs.length ? `ERREURS :\n  ${erreurs.join('\n  ')}` : 'ERREURS : aucune');
await navigateur.close();
process.exit(erreurs.length ? 1 : 0);
