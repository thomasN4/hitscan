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
    }

    // 5) Sniper: 1/2 weapon switch, scope overlay, and wheel zoom steps
    //    (range only, same reason as sprint/accuracy above)
    if (sprintCheck) {
      const sniper = await page.evaluate(async () => {
        const cs = window.__cs;
        const wait = ms => new Promise(r => setTimeout(r, ms));
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2' }));
        await wait(150);
        const switched = { slot: cs.game.slot, name: cs.weapon.name, mag: cs.weapon.mag };
        // Hold "RMB" to raise the scope, then scroll through the zoom levels
        window.dispatchEvent(new MouseEvent('mousedown', { button: 2 }));
        await wait(800); // let adsLerp settle onto the first zoom step
        window.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })); // zoom in
        await wait(400);
        window.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
        await wait(600); // FOV needs time to blend to the tightest step
        const zoomed = { level: cs.game.zoomLevel, overlay: document.getElementById('scopeOverlay').style.display };
        window.dispatchEvent(new MouseEvent('mouseup', { button: 2 }));
        await wait(400); // let adsLerp fall back out
        // Semi-auto + unscope-on-shot: aim, fire one round (the trigger
        // latch makes holding LMB a no-op after the first shot).
        window.dispatchEvent(new MouseEvent('mousedown', { button: 2 }));
        await wait(800);
        const magBeforeShot = cs.weapon.mag;
        cs.game.pitch = -1.2; // into the floor so the shot lands somewhere safe
        window.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
        await wait(250); // enough for one frame to process the semi-auto shot
        window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
        const shot = { fired: magBeforeShot - cs.weapon.mag, aimingAfter: cs.game.aiming };
        // Re-scope gate: an immediate RMB press after the shot must be
        // rejected while recoil (kick 4, recover 13/s) is still settling.
        window.dispatchEvent(new MouseEvent('mousedown', { button: 2 }));
        await wait(150);
        const gated = { aiming: cs.game.aiming, overlay: document.getElementById('scopeOverlay').style.display };
        window.dispatchEvent(new MouseEvent('mouseup', { button: 2 }));
        await wait(900); // recoil falls below the 0.5 gate (~0.27 s at full sim speed)
        // After settling, a fresh press must scope in normally.
        window.dispatchEvent(new MouseEvent('mousedown', { button: 2 }));
        await wait(800); // adsLerp needs ~0.16 s to cross the overlay threshold
        const rescope = { aiming: cs.game.aiming, overlay: document.getElementById('scopeOverlay').style.display };
        window.dispatchEvent(new MouseEvent('mouseup', { button: 2 }));
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1' }));
        await wait(150);
        return { switched, zoomed, shot, gated, rescope, backTo: cs.game.slot };
      });
      if (sniper.switched.slot !== 1 || sniper.switched.name !== 'SNIPER') throw new Error(`switch to sniper failed: ${JSON.stringify(sniper.switched)}`);
      if (sniper.zoomed.level !== 2 || sniper.zoomed.overlay !== 'block') throw new Error(`zoom steps failed: ${JSON.stringify(sniper.zoomed)}`);
      if (sniper.shot.fired !== 1) throw new Error(`semi-auto should fire exactly once while held: ${JSON.stringify(sniper.shot)}`);
      if (sniper.shot.aimingAfter !== false) throw new Error(`shot should exit the scope: ${JSON.stringify(sniper.shot)}`);
      if (sniper.gated.aiming !== false || sniper.gated.overlay !== 'none') throw new Error(`re-scope during recoil settle must stay blocked: ${JSON.stringify(sniper.gated)}`);
      if (sniper.rescope.aiming !== true || sniper.rescope.overlay !== 'block') throw new Error(`re-scope after settle failed: ${JSON.stringify(sniper.rescope)}`);
      if (sniper.backTo !== 0) throw new Error(`switch back to rifle failed: slot ${sniper.backTo}`);
      console.log(`[sniper] OK`, JSON.stringify(sniper));
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
