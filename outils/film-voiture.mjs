// Film d'un trajet de la vue en voiture (static/voiture.html), en conduite
// simulée vers une destination : la page est chargée, la voiture attend au
// départ que les carrés de l'itinéraire, le sol et les arbres soient là
// (`attente=1`), puis le trajet est capturé image par image jusqu'à l'arrivée.
//
//   node outils/film-voiture.mjs "http://localhost:8080/voiture?simu=1&lat=48.8532&lon=2.3692&vers=48.8483,2.3958&versnom=Nation&vitesse=40" docs/demo/demo-voiture-paysage.mp4
//
// Muet, sans légende : ce qu'on voit est la page. LARGEUR et HAUTEUR (1920 ×
// 1080), FPS (30), DUREE_MAX_S (600), CHROME sont les réglages.
//
// L'horloge figée de demo-video.mjs : requestAnimationFrame et
// performance.now sont repris à la page, chaque pas avance le temps de 1/FPS
// s et exécute la boucle de rendu, puis l'image est prise. La voiture roule
// donc à la vitesse exacte de la vidéo. Le réseau, lui, garde son temps
// réel : une capture prend ~80 ms pour 33 ms de film, et les tuiles ont deux
// à trois fois plus de temps pour arriver qu'en roulant vraiment.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const url = process.argv[2];
const sortie = process.argv[3] || 'docs/demo/demo-voiture-paysage.mp4';
if (!url) {
    console.error('usage : node outils/film-voiture.mjs "<url de /voiture?simu=1&…&vers=…>" [sortie.mp4]');
    process.exit(2);
}
const LARGEUR = Number(process.env.LARGEUR || 1920), HAUTEUR = Number(process.env.HAUTEUR || 1080);
const FPS = Number(process.env.FPS || 30), DUREE_MAX_S = Number(process.env.DUREE_MAX_S || 600);
// Avant le départ, à l'arrêt ; après l'arrivée, le temps de la voir arrêtée.
const AVANT_S = 3, APRES_S = 4;
const adresse = new URL(url);
adresse.searchParams.set('attente', '1');

const navigateur = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--use-angle=metal', '--ignore-gpu-blocklist', `--window-size=${LARGEUR},${HAUTEUR}`],
});
const page = await navigateur.newPage();
await page.setViewport({ width: LARGEUR, height: HAUTEUR, deviceScaleFactor: 1 });
const erreurs = [];
page.on('pageerror', e => erreurs.push('pageerror: ' + e.message));

// Horloge figée : posée avant tout script de la page.
await page.evaluateOnNewDocument(() => {
    const vraiRAF = window.requestAnimationFrame.bind(window);
    const vraiNow = performance.now.bind(performance);
    let manuel = false, horloge = 0, file = [];
    window.requestAnimationFrame = cb => { if (!manuel) return vraiRAF(cb); file.push(cb); return file.length; };
    performance.now = () => (manuel ? horloge : vraiNow());
    window.__manuel = () => { horloge = vraiNow(); manuel = true; };
    window.__pas = dt => { horloge += dt; const cbs = file; file = []; for (const cb of cbs) cb(horloge); };
});

await page.goto(adresse.toString(), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__voiture, { timeout: 60000 });

// Le départ prêt : l'itinéraire, la photo nette sous la voiture, les
// bâtiments et les arbres autour d'elle (deux minutes au plus).
const t0 = Date.now();
for (;;) {
    const e = await page.evaluate(() => {
        const V = window.__voiture, v = V.voiture;
        let z = 0, bati = 0, arbres = 0;
        for (const t of V.tuilesSol.values()) {
            if (t.mesh && t.mesh.visible && t.mesh.material.map && v.x >= t.minX && v.x <= t.maxX
                && v.y >= t.minY && v.y <= t.maxY) z = Math.max(z, t.z);
        }
        for (const c of V.carres.values()) { if (c.mesh && c.mesh.visible) bati++; if (c.veg.mesh && c.veg.mesh.visible) arbres++; }
        return { iti: !!V.itineraire, vue: v.vue, z, bati, arbres, chemin: v.chemin && v.chemin.fin };
    });
    if (e.iti && e.vue && e.z >= 18 && e.bati >= 6 && e.arbres >= 3 && e.chemin === 'arrivee') break;
    if (Date.now() - t0 > 120000) { console.log('départ pas tout à fait prêt :', JSON.stringify(e)); break; }
    await new Promise(r => setTimeout(r, 1000));
}
const itineraire = await page.evaluate(() => {
    const it = window.__voiture.itineraire;
    return it && { metres: Math.round(it.longueur), rues: [...new Set(it.etapes.map(e => e.a.nom).filter(Boolean))] };
});
console.log('itinéraire :', itineraire ? `${itineraire.metres} m, ${itineraire.rues.join(' › ')}` : 'aucun');

fs.mkdirSync(path.dirname(sortie), { recursive: true });
const ffmpeg = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', sortie],
    { stdio: ['pipe', 'inherit', 'inherit'] });
const cdp = await page.createCDPSession();
let images = 0;
async function filmer() {
    await page.evaluate(dt => window.__pas(dt), 1000 / FPS);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
    const jpeg = Buffer.from(data, 'base64');
    if (!ffmpeg.stdin.write(jpeg)) await new Promise(r => ffmpeg.stdin.once('drain', r));
    images++;
}

await page.evaluate(() => window.__manuel());
for (let i = 0; i < AVANT_S * FPS; i++) await filmer();
await page.evaluate(() => window.__voiture.partir());
let arrivee = null;
while (images < DUREE_MAX_S * FPS) {
    await filmer();
    if (images % FPS === 0) {
        const fini = await page.evaluate(() => window.__voiture.simu.arrive && window.__voiture.voiture.v < 0.3);
        if (fini && arrivee === null) arrivee = images;
        if (arrivee !== null && images - arrivee >= APRES_S * FPS) break;
        if (images % (10 * FPS) === 0) process.stdout.write(`  ${images / FPS} s filmées\n`);
    }
}
ffmpeg.stdin.end();
await new Promise(r => ffmpeg.on('close', r));
await navigateur.close();
console.log(`${sortie} : ${(images / FPS).toFixed(1)} s, ${(fs.statSync(sortie).size / 1e6).toFixed(1)} Mo`
    + (arrivee === null ? ' — arrivée non atteinte' : ''));
if (erreurs.length) { console.log('ERREURS :\n  ' + erreurs.join('\n  ')); process.exit(1); }
