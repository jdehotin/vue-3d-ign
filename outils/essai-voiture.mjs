// Essai de la vue en voiture (static/voiture.html) dans un vrai navigateur :
// une conduite simulée (?simu=1), suivie pendant `duree` secondes. Relève
// toutes les cinq secondes la position, la route prévue, les carrés de
// bâtiments (lus, construits, prêts devant la voiture), les tuiles du sol et
// les images par seconde ; échoue à la moindre erreur JavaScript, à un carré
// refusé par le serveur, ou si les bâtiments ne sont jamais prêts devant.
//
//   npm install puppeteer-core
//   node outils/essai-voiture.mjs "http://localhost:8080/voiture?simu=1&lat=48.8706&lon=2.3055&vitesse=50" 60 voiture.png
//
// CHROME désigne l'exécutable de Chrome ou Chromium ; par défaut celui de
// macOS, rendu par Metal (ANGLE=swiftshader pour le rendu logiciel).
import puppeteer from 'puppeteer-core';

const url = process.argv[2] || 'http://localhost:8080/voiture?simu=1&lat=48.8706&lon=2.3055&vitesse=50';
const duree = Number(process.argv[3] || 60);
const sortie = process.argv[4] || 'voiture.png';
const angle = process.env.ANGLE || (process.platform === 'darwin' ? 'metal' : 'swiftshader');
const navigateur = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: [`--use-angle=${angle}`, '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
           '--autoplay-policy=no-user-gesture-required'],
});
const page = await navigateur.newPage();
await page.setViewport({ width: 1280, height: 800 });
const erreurs = [];
const carres = { lus: 0, caches: 0, refus: 0 };
const tuiles = { absentes: 0 };
page.on('pageerror', e => erreurs.push('pageerror: ' + e.message));
page.on('console', m => {
    if (m.type() !== 'error') return;
    // Une tuile du fond refusée par l'IGN : la page la fait relire, ou prend
    // celle d'un ancêtre ; jugée par sa réponse, plus bas.
    if (/api\/tuile|data\.geopf\.fr\/wmts|Failed to load resource/.test(m.text() + (m.location()?.url || ''))) return;
    erreurs.push('console: ' + m.text());
});
page.on('requestfailed', r => {
    if (/api\/tuile|data\.geopf\.fr/.test(r.url())) return;
    erreurs.push('échec requête: ' + r.url().slice(0, 100) + ' ' + (r.failure()?.errorText || ''));
});
page.on('response', r => {
    const u = r.url();
    if (/\/api\/carre\?/.test(u)) {
        if (r.status() === 200) { if (r.fromCache()) carres.caches++; else carres.lus++; }
        else if (r.status() !== 304) { carres.refus++; erreurs.push(`HTTP ${r.status()} ${u.slice(0, 100)}`); }
        return;
    }
    if (/\/api\/tuile\//.test(u)) { if (r.status() === 404) tuiles.absentes++; return; }
    if (/data\.geopf\.fr\/wmts/.test(u)) return;
    if (r.status() >= 400) erreurs.push(`HTTP ${r.status()} ${u.slice(0, 100)}`);
});
// Images comptées dans la page : un compteur posé avant son script.
await page.evaluateOnNewDocument(() => {
    window.__images = 0;
    const compter = () => { window.__images++; requestAnimationFrame(compter); };
    requestAnimationFrame(compter);
});
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__voiture, { timeout: 30000 });

const releves = [];
let images0 = await page.evaluate(() => window.__images), t0 = Date.now(), depart = null;
for (let t = 5; t <= duree; t += 5) {
    await new Promise(r => setTimeout(r, 5000));
    const e = await page.evaluate(() => {
        const V = window.__voiture, v = V.voiture;
        let lus = 0, construits = 0, montres = 0, batiments = 0;
        for (const c of V.carres.values()) {
            if (c.etat === 'pret') lus++;
            if (c.mesh) { construits++; if (c.mesh.visible) { montres++; batiments += c.nbBatiments; } }
        }
        let solMontrees = 0;
        for (const t of V.tuilesSol.values()) if (t.mesh && t.mesh.visible) solMontrees++;
        const info = V.renderer.info;
        return {
            vue: v.vue, x: v.x, y: v.y, v: v.v * 3.6, horsRoute: v.horsRoute,
            chemin: v.chemin ? { longueur: v.chemin.longueur, fin: v.chemin.fin } : null,
            lus, construits, montres, batiments, aretes: V.aretes.size,
            sol: V.tuilesSol.size, solMontrees, triangles: info.render.triangles, appels: info.render.calls,
            textures: info.memory.textures, geometries: info.memory.geometries,
            rue: document.getElementById('rue-nom').textContent,
            numero: document.getElementById('rue-numero').hidden ? '' : document.getElementById('rue-numero').textContent,
            pret: document.getElementById('etat-carres').textContent,
            images: window.__images, budget: V.budget,
        };
    });
    const ips = (e.images - images0) / ((Date.now() - t0) / 1000);
    images0 = e.images; t0 = Date.now();
    if (e.vue && !depart) depart = { x: e.x, y: e.y };
    const parcouru = depart ? Math.hypot(e.x - depart.x, e.y - depart.y) : 0;
    releves.push({ ...e, ips, parcouru });
    console.log(`${String(t).padStart(3)} s  ${e.vue ? `${e.v.toFixed(0)} km/h` : 'sans position'}`
        + `  ${e.numero ? e.numero + ' ' : ''}${e.rue || '—'}${e.horsRoute ? ' (hors route)' : ''}`
        + `  à ${Math.round(parcouru)} m du départ`
        + `  · chemin ${e.chemin ? Math.round(e.chemin.longueur) + ' m ' + e.chemin.fin : '—'}`
        + `  · carrés ${e.lus} lus, ${e.construits} construits, ${e.montres} montrés (${e.batiments} bât.)`
        + `  · ${e.pret}`
        + `  · sol ${e.solMontrees}/${e.sol}  · ${(e.triangles / 1e3).toFixed(0)} k tri, ${e.appels} appels`
        + `  · ${ips.toFixed(0)} i/s`);
}
await page.screenshot({ path: sortie });
// Durée de construction d'un carré (un par image au plus, voiture.html) :
// la médiane et le pire, avec les bâtiments du carré.
const durees = await page.evaluate(() => window.__voiture.durees.slice());
if (durees.length) {
    const tri = durees.slice().sort((a, b) => a[0] - b[0]);
    const pire = tri[tri.length - 1];
    console.log(`\nConstruction d'un carré : médiane ${tri[tri.length >> 1][0].toFixed(1)} ms, `
        + `pire ${pire[0].toFixed(1)} ms (${pire[1]} bâtiments), sur ${tri.length}`);
}
console.log(`\nCarrés : ${carres.lus} lus au serveur, ${carres.caches} du cache du navigateur, ${carres.refus} refusés ; `
    + `tuiles absentes : ${tuiles.absentes}. Capture : ${sortie}`);
const roule = releves.filter(r => r.vue && r.chemin);
if (!roule.length) erreurs.push('la voiture n\'a jamais été calée sur une route');
else if (!roule.slice(-3).some(r => /prêts sur/.test(r.pret) && !/prêts sur 0 m/.test(r.pret))) {
    erreurs.push('aucun bâtiment prêt devant la voiture en fin d\'essai');
}
console.log(erreurs.length ? `ERREURS :\n  ${erreurs.join('\n  ')}` : 'ERREURS : aucune');
await navigateur.close();
process.exit(erreurs.length ? 1 : 0);
