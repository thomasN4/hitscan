// Repeatable hip, ADS and reload views for every first-person weapon.
// CS_SMOKE_BASE=http://localhost:5178 CS_VIEWMODEL_QUERY='?map=arena&style=ligne-claire' \
//   node scripts/viewmodel-shots.mjs [outDir]
// Defaults to the range; also works against production preview. Uses the real
// persisted loadout and slot-switch input, so HUD and reload stats match the prop.
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const BASE = process.env.CS_SMOKE_BASE || 'http://localhost:5173';
const QUERY = process.env.CS_VIEWMODEL_QUERY || '?map=range';
const OUT = process.argv[2] || '/tmp/opencode/viewmodels';
mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: '/var/lib/flatpak/app/com.brave.Browser/current/active/files/brave/brave',
  headless: 'new',
  args: ['--no-sandbox', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});
const errors = [];

try {
  for (const id of ['smg', 'sniper', 'shotgun', 'pistol', 'revolver', 'knife']) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
    await page.evaluateOnNewDocument(id => {
      const primary = ['smg', 'sniper', 'shotgun'].includes(id) ? id : 'smg';
      const secondary = ['pistol', 'revolver'].includes(id) ? id : 'pistol';
      sessionStorage.setItem('acsc.loadout', JSON.stringify({ primary, secondary }));
    }, id);
    await page.goto(new URL(QUERY, BASE).href, { waitUntil: 'networkidle0', timeout: 20000 });
    await page.evaluate(() => {
      const cs = window.__cs;
      cs.game.started = true;
      cs.game.locked = true;
      if (cs.game.map === 'arena') {
        cs.player.pos.set(6, 1.7, 10);
        cs.game.yaw = -2.35;
        for (const bot of cs.bots) { bot.update = () => {}; bot.mesh.visible = false; }
      }
      document.getElementById('startMenu').style.display = 'none';
      document.getElementById('hud').style.display = 'block';
    });
    if (id === 'knife') await page.keyboard.press('Digit3');
    else if (id === 'pistol' || id === 'revolver') await page.keyboard.press('Digit2');
    await page.evaluate(async () => {
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    assert.equal(await page.evaluate(() => window.__cs.weapon.name), id.toUpperCase());
    await page.screenshot({ path: `${OUT}/${id}-hip.png` });

    await page.evaluate(() => window.dispatchEvent(new MouseEvent('mousedown', { button: 2 })));
    if (id !== 'knife') {
      await page.waitForFunction(() => window.__cs.game.adsLerp > 0.995, { timeout: 5000 });
    } else {
      await new Promise(r => setTimeout(r, 200));
      assert.equal(await page.evaluate(() => window.__cs.game.adsLerp), 0);
    }
    await page.screenshot({ path: `${OUT}/${id}-ads.png` });
    await page.evaluate(() => window.dispatchEvent(new MouseEvent('mouseup', { button: 2 })));
    await page.waitForFunction(() => window.__cs.game.adsLerp < 0.005, { timeout: 5000 });

    if (id !== 'knife') {
      await page.evaluate(() => { window.__cs.weapon.mag = window.__cs.weapon.magSize - 2; });
      await page.keyboard.press('KeyR');
      const posed = await page.evaluate(async () => {
        const cs = window.__cs;
        if (!cs.weapon.reloading) return false;
        const start = cs.gameTime.now();
        const interval = cs.weapon.nextRoundAt > 0
          ? cs.weapon.reloadTime / cs.weapon.magSize : cs.weapon.reloadTime;
        const deadline = performance.now() + 5000;
        while (cs.gameTime.now() - start < interval * 0.42 && performance.now() < deadline) {
          await new Promise(r => requestAnimationFrame(r));
        }
        cs.game.locked = false; // freeze the actual animated pose for the capture
        return cs.weapon.reloading && cs.gameTime.now() - start >= interval * 0.42;
      });
      assert.ok(posed, `${id}: did not reach the reload pose`);
      await page.screenshot({ path: `${OUT}/${id}-reload.png` });
      await page.evaluate(() => { window.__cs.game.locked = true; });
      await page.waitForFunction(() => !window.__cs.weapon.reloading, { timeout: 12000 });
      assert.equal(await page.evaluate(() => window.__cs.weapon.mag), await page.evaluate(() => window.__cs.weapon.magSize));
      await page.screenshot({ path: `${OUT}/${id}-restored.png` });
    }
    console.log(`${id}: hip, ADS${id === 'knife' ? ' (inert)' : ', reload and restored'} checked`);
    await page.close();
  }
  assert.deepEqual(errors, [], 'Browser errors or shader warnings');
  console.log(`done -> ${OUT}`);
} finally {
  await browser.close();
}
