// viewmodel-shots.mjs — capture hip vs ADS screenshots for every catalog
// weapon, for tuning/verifying the per-weapon ADS alignment (VIEWMODELS'
// aimOffset in weapons.ts).
//
// Usage: start `npm run dev` in another terminal, then:
//   CS_SMOKE_BASE=http://localhost:5173 node scripts/viewmodel-shots.mjs [outDir]
//
// Writes <outDir>/<weaponId>-hip.png and <weaponId>-ads.png. The crosshair is
// left visible on purpose: it marks exact screen center, so a correctly
// aligned ADS shot has the gun's sight line sitting ON the crosshair.
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const BRAVE = '/var/lib/flatpak/app/com.brave.Browser/current/active/files/brave/brave';
const BASE = process.env.CS_SMOKE_BASE || 'http://localhost:5173';
const OUT = process.argv[2] || '/tmp/opencode/viewmodels';
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: BRAVE,
  headless: 'new',
  args: ['--no-sandbox', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto(BASE + '/?map=range', { waitUntil: 'networkidle0', timeout: 20000 });
await new Promise(r => setTimeout(r, 1500));

const ids = await page.evaluate(() => {
  const cs = window.__cs;
  if (!cs) throw new Error('debug hook __cs missing');
  cs.game.started = true;
  cs.game.locked = true;
  // Fake-locking never fires pointerlockchange, so the start menu stays up
  // and the HUD stays hidden. Clear both by hand: the crosshair must be
  // visible because it marks exact screen center — the whole point.
  document.getElementById('startMenu').style.display = 'none';
  document.getElementById('hud').style.display = 'block';
  return true;
});
if (!ids) throw new Error('failed to enter fake-play state');
// Catalog ids enumerated here to keep the script dependency-free of src/.
for (const id of ['smg', 'sniper', 'shotgun', 'pistol', 'revolver']) {
  await page.evaluate(weaponId => {
    const cs = window.__cs;
    // Raw facade writes: this script only needs loadout/slot for VIEWMODEL
    // selection — live ammo stats are irrelevant to an idle render.
    cs.game.primary = weaponId;
    cs.game.secondary = 'pistol';
    cs.game.slot = 0;
    // Neutral camera + settled stance: no bob (standing), no recoil.
    cs.game.pitch = 0;
    cs.game.yaw = 0;
    cs.game.spray = 1;
    cs.game.recoil = 0;
    cs.game.recoilYaw = 0;
  }, id);
  await new Promise(r => setTimeout(r, 400));

  await page.screenshot({ path: `${OUT}/${id}-hip.png` });

  // Raise iron sights: hold RMB until adsLerp settles (~80 ms blend).
  await page.evaluate(() => {
    window.dispatchEvent(new MouseEvent('mousedown', { button: 2 }));
  });
  await new Promise(r => setTimeout(r, 700));
  await page.screenshot({ path: `${OUT}/${id}-ads.png` });
  await page.evaluate(() => {
    window.dispatchEvent(new MouseEvent('mouseup', { button: 2 }));
  });
  console.log(`captured ${id}`);
  await new Promise(r => setTimeout(r, 400)); // let adsLerp fall back out
}

await browser.close();
console.log(`done -> ${OUT}`);
