// smoke-test.mjs — headless E2E check for both maps.
//
// Usage: start `npm run dev` in another terminal, then:
//   node scripts/smoke-test.mjs
//
// Requires Brave (Flatpak path below is machine-specific).
import puppeteer from 'puppeteer-core';

const BRAVE = '/var/lib/flatpak/app/com.brave.Browser/current/active/files/brave/brave';
const BASE = 'http://localhost:5173';

const browser = await puppeteer.launch({
  executablePath: BRAVE,
  headless: 'new',
  args: ['--no-sandbox', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});

const errors = [];
let failures = 0;

async function runMap(name, url, { sprintCheck = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const mapErrors = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') mapErrors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => mapErrors.push('PAGEERROR: ' + e.message));

  try {
    await page.goto(BASE + url, { waitUntil: 'networkidle0', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1500));

    const hook = await page.evaluate(() => !!window.__cs);
    if (!hook) throw new Error('debug hook __cs missing — module failed to load?');

    // Enter "playing" state headlessly (pointer lock is unreliable in CI)
    await page.evaluate(() => {
      window.__cs.game.started = true;
      window.__cs.game.locked = true;
      window.__cs.weapon.mag = 10;
    });

    // 1) Reload works
    await page.keyboard.press('KeyR');
    await new Promise(r => setTimeout(r, 2600));
    const reload = await page.evaluate(() => ({ ...window.__cs.weapon }));
    if (reload.mag !== 30 || reload.reloading) throw new Error(`reload incomplete: ${JSON.stringify(reload)}`);

    // 2) Firing spawns bullet-hole decals (aim down at the floor)
    await page.evaluate(() => {
      const cs = window.__cs;
      cs.game.pitch = -1.4;
      cs.game.shooting = true;
    });
    await new Promise(r => setTimeout(r, 600));
    await page.evaluate(() => { window.__cs.game.shooting = false; });
    const fired = await page.evaluate(() => ({
      holes: window.__cs.bulletHoles.length,
      mag: window.__cs.weapon.mag,
      reserve: window.__cs.weapon.reserve,
    }));
    if (fired.holes === 0) throw new Error('expected bullet holes after firing, got 0');

    let sprint = null;
    // 3) Double-tap-W sprint (range only — on arena, bot fire during earlier
    //    stationary phases can damage/distract the measurement).
    //    Displacement over 1 s must exceed walk speed (6.5 m/s); full run is
    //    9.75 m/s minus the ~0.2 s ramp. dt-scaled movement keeps this stable
    //    under SwiftShader's low FPS.
    if (sprintCheck) {
      sprint = await page.evaluate(async () => {
        const cs = window.__cs;
        cs.game.pitch = 0; // level, so all displacement is horizontal
        cs.player.pos.set(0, 1.7, 8);
        // Two W presses 100 ms apart -> inside the 300 ms double-tap window
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
        await new Promise(r => setTimeout(r, 100));
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', repeat: false }));
        const startZ = cs.player.pos.z;
        const t0 = performance.now();
        while (performance.now() - t0 < 1000) await new Promise(r => requestAnimationFrame(r));
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
        return { dist: Math.abs(startZ - cs.player.pos.z), running: cs.game.running };
      });
      if (sprint.dist < 7.5) throw new Error(`sprint distance too low: ${sprint.dist.toFixed(2)} m`);
    }

    console.log(`[${name}] OK`, JSON.stringify({ reload: 'ok', holes: fired.holes, magAfterBurst: fired.mag, reserve: fired.reserve, ...(sprint && { sprintDist: +sprint.dist.toFixed(2) }) }));
  } catch (e) {
    failures++;
    console.log(`[${name}] FAIL: ${e.message}`);
  }
  errors.push(...mapErrors.map(e => `[${name}] ${e}`));
  await page.close();
}

try {
  await runMap('arena', '/');
  await runMap('range', '/?map=range', { sprintCheck: true });
} finally {
  await browser.close();
}

console.log('console/page errors:', errors.length ? JSON.stringify(errors, null, 2) : 'none');
process.exit(failures > 0 || errors.length > 0 ? 1 : 0);
