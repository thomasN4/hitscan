// Matching views for the arena art study, plus browser-only regression checks.
// CS_SMOKE_BASE=http://localhost:5178 node scripts/ligne-claire-shots.mjs [outDir]
// Also works against production preview. All scene inspection uses the existing
// debug hook; no dev-only source imports. Captures are local, not committed.
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const BASE = process.env.CS_SMOKE_BASE || 'http://localhost:5178';
const OUT = process.argv[2] || '/tmp/ligne-claire-shots';
mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: '/var/lib/flatpak/app/com.brave.Browser/current/active/files/brave/brave',
  headless: 'new',
  args: ['--no-sandbox', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});
const errors = [];
const report = {};

async function pose(page, position, yaw, pitch = 0.02) {
  await page.evaluate(async ({ position, yaw, pitch }) => {
    const cs = window.__cs;
    cs.game.started = true;
    cs.game.locked = true;
    cs.game.yaw = yaw;
    cs.game.pitch = pitch;
    cs.player.pos.set(...position);
    cs.player.vel.set(0, 0, 0);
    for (const bot of cs.bots) bot.update = () => {};
    cs.bots[0].mesh.position.set(13, 0, 17);
    cs.bots[0].mesh.rotation.y = -2.35;
    cs.bots[1].mesh.position.set(10, 0, 22);
    cs.bots[1].mesh.rotation.y = -2.35;
    document.getElementById('startMenu').style.display = 'none';
    document.getElementById('hud').style.display = 'block';
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    cs.game.locked = false;
  }, { position, yaw, pitch });
}

try {
  for (const style of ['original', 'ligne-claire']) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text());
    });
    // Same spawn randomness in both versions, before any module executes.
    await page.evaluateOnNewDocument(() => {
      let seed = 47;
      Math.random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; };
    });
    await page.goto(`${BASE}/?map=arena&tbots=1&ctbots=1&time=600&style=${style}`, { waitUntil: 'networkidle0' });
    await pose(page, [6, 1.7, 10], -2.35);
    await page.screenshot({ path: `${OUT}/${style}-courtyard.png` });
    report[style] = await page.evaluate(() => {
      const cs = window.__cs;
      const scene = cs.bots[0].mesh.parent;
      let ink = 0;
      scene.traverse(object => { if (object.name === 'ligne-claire-ink') ink++; });
      return {
        ink,
        colliders: cs.colliders.map(box => [...box.min.toArray(), ...box.max.toArray()]),
        navNodes: cs.nav.grid().count,
      };
    });
    await pose(page, [9, 1.7, 13], -2.35);
    await page.screenshot({ path: `${OUT}/${style}-bot.png` });

    if (style === 'ligne-claire') {
      for (const weapon of ['smg', 'sniper', 'shotgun', 'pistol', 'revolver', 'knife']) {
        await page.evaluate(weapon => {
          const cs = window.__cs;
          if (weapon === 'knife') cs.game.slot = 2;
          else { cs.game.primary = weapon; cs.game.slot = 0; }
          cs.game.zoomLevel = 0;
          cs.game.aiming = false;
        }, weapon);
        await pose(page, [6, 1.7, 10], -2.35);
        await page.screenshot({ path: `${OUT}/${weapon}-hip.png` });
      }
      // Maximum scope zoom and resized / high-DPI strokes.
      await page.evaluate(() => {
        const cs = window.__cs;
        cs.game.primary = 'sniper'; cs.game.slot = 0;
        cs.game.zoomLevel = 2; cs.game.aiming = true; cs.game.locked = true;
      });
      await new Promise(resolve => setTimeout(resolve, 500));
      await page.screenshot({ path: `${OUT}/sniper-zoom.png` });
      await page.evaluate(() => { window.__cs.game.aiming = false; window.__cs.game.zoomLevel = 0; });
      await page.setViewport({ width: 960, height: 640, deviceScaleFactor: 2 });
      await pose(page, [6, 1.7, 10], -2.35);
      await page.screenshot({ path: `${OUT}/resized-dpr2.png` });
      await page.keyboard.press('KeyV');
      await page.screenshot({ path: `${OUT}/debug.png` });
    }
    await page.close();
  }
  assert.equal(report.original.ink, 0);
  assert.ok(report['ligne-claire'].ink > 0);
  assert.deepEqual(report.original.colliders, report['ligne-claire'].colliders, 'Art changed collision bounds');
  assert.ok(report.original.navNodes > 0, 'Missing baseline navigation graph');
  assert.equal(report.original.navNodes, report['ligne-claire'].navNodes);
  assert.deepEqual(errors, [], 'Browser errors or shader warnings');
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(`Visual checks passed; matching captures in ${OUT}`);
} finally {
  await browser.close();
}
