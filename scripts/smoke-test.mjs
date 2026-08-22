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
    //
    // We assert MECHANICS, not absolute distance: headless SwiftShader FPS
    // swings enough that wall-clock displacement is unstable (the sim's dt
    // clamp makes game-time diverge from wall-time at low FPS). So:
    //   - `game.running` must latch after the double tap (detector works)
    //   - `game.runLerp` must climb past 0.4 (ramp works)
    //   - player must cover >5 m (movement integration alive)
    if (sprintCheck) {
      sprint = await page.evaluate(async () => {
        const cs = window.__cs;
        cs.game.pitch = 0; // level, so all displacement is horizontal
        cs.player.pos.set(0, 1.7, 8);
        // Two rapid W presses -> inside the 300 ms double-tap window.
        // Dispatched back-to-back WITHOUT an async gap: under SwiftShader
        // the main thread can stall long enough for a timed gap (>300 ms)
        // to miss the window and make this test flaky.
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', repeat: false }));
        const startZ = cs.player.pos.z;
        let runningSeen = false, runLerpPeak = 0;
        const t0 = performance.now();
        while (performance.now() - t0 < 1000) {
          await new Promise(r => requestAnimationFrame(r));
          runningSeen = runningSeen || cs.game.running;
          runLerpPeak = Math.max(runLerpPeak, cs.game.runLerp);
        }
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
        return { dist: Math.abs(startZ - cs.player.pos.z), runningSeen, runLerpPeak };
      });
      if (!sprint.runningSeen) throw new Error('double-tap did not latch game.running');
      if (sprint.runLerpPeak < 0.4) throw new Error(`sprint ramp too weak: ${sprint.runLerpPeak.toFixed(2)}`);
      if (sprint.dist < 5) throw new Error(`barely moved during sprint: ${sprint.dist.toFixed(2)} m`);
    }

    // 4) Accuracy model: spread must reflect stance and movement
    if (sprintCheck) {
      const spreads = await page.evaluate(async () => {
        const cs = window.__cs;
        const wait = ms => new Promise(r => setTimeout(r, ms));
        cs.game.pitch = 0;
        cs.player.pos.set(0, 1.7, 8);
        await wait(400); // let bloom from earlier phases decay
        const standing = cs.game.spread;
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft' }));
        await wait(400); // crouchLerp -> 1
        const crouched = cs.game.spread;
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft' }));
        await wait(400);
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
        await wait(600); // walk long enough for moveLerp to settle near 1
        const walking = cs.game.spread;
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
        return { standing, crouched, walking };
      });
      if (spreads.crouched >= spreads.standing) throw new Error(`crouch should tighten spread: ${JSON.stringify(spreads)}`);
      if (spreads.walking < spreads.standing * 3) throw new Error(`walking should open spread 3x+: ${JSON.stringify(spreads)}`);
      console.log(`[accuracy] OK`, JSON.stringify(spreads));

      // 5) No-clip regression: walking into the backstop must stop the
      //    player at the wall instead of passing through it. The inner face
      //    of the backstop sits at z = -80; from -75 there's ~4.5 m runway.
      //    Bounded both ways: must make progress (collision fix didn't
      //    freeze movement) but must stop short of the face.
      const clip = await page.evaluate(async () => {
        const cs = window.__cs;
        cs.player.pos.set(0, 1.7, -75);
        cs.game.yaw = Math.PI; // face +z, straight into the backstop
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
        const t0 = performance.now();
        while (performance.now() - t0 < 1200) await new Promise(r => requestAnimationFrame(r));
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
        return { z: cs.player.pos.z };
      });
      // Player radius 0.45 stops them ~0.95 m short of the face (-79.05)
      if (clip.z < -78.8) throw new Error(`no-clip: walked through backstop to z=${clip.z.toFixed(2)}`);
      if (clip.z > -76.5) throw new Error(`no progress toward backstop: z=${clip.z.toFixed(2)}`);
      console.log(`[noclip] OK`, JSON.stringify(clip));
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
