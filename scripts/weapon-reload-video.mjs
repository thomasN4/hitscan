// Review videos of real-input reloads; run against dev or production preview.
// CS_SMOKE_BASE=http://127.0.0.1:5193/model-review node scripts/weapon-reload-video.mjs /tmp
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
const base = process.env.CS_SMOKE_BASE || 'http://127.0.0.1:5173';
const out = process.argv[2] || '/tmp';
mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: '/var/lib/flatpak/app/com.brave.Browser/current/active/files/brave/brave',
  headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});
try {
  const ids = process.argv.slice(3);
  for (const id of ids.length ? ids : ['shotgun', 'revolver', 'pistol']) {
    const page = await browser.newPage();
    await page.setViewport({ width: 960, height: 540 });
    await page.evaluateOnNewDocument(secondary => sessionStorage.setItem('acsc.loadout', JSON.stringify({primary:'shotgun',secondary})), id === 'pistol' ? 'pistol' : 'revolver');
    await page.goto(`${base}/?map=arena&tbots=1&time=600&style=ligne-claire`, {waitUntil:'networkidle0'});
    await page.waitForFunction(() => Boolean(window.__cs));
    await page.evaluate(() => {
      const cs = window.__cs;
      cs.game.started = true; cs.game.locked = true;
      cs.player.pos.set(6, 1.6, 10); cs.game.yaw = -2.35;
      cs.bots.forEach(bot => { bot.update = () => {}; bot.mesh.visible = false; });
      document.getElementById('startMenu').style.display = 'none';
      document.getElementById('hud').style.display = 'block';
    });
    if (id === 'revolver' || id === 'pistol') await page.keyboard.press('Digit2');
    await page.evaluate(id => { window.__cs.weapon.mag = id === 'pistol' ? 0 : 3; }, id);
    const video = await page.screencast({path:`${out}/acsc-${id}-authored.webm`,fps:24});
    await new Promise(resolve => setTimeout(resolve, 700));
    await page.keyboard.press('KeyR');
    await page.waitForFunction(() => !window.__cs.weapon.reloading && window.__cs.weapon.mag === window.__cs.weapon.magSize, {timeout:20000});
    await new Promise(resolve => setTimeout(resolve, 500));
    await video.stop();
    await page.close();
    console.log(`${out}/acsc-${id}-authored.webm`);
  }
} finally { await browser.close(); }
