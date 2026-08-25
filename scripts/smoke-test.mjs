// smoke-test.mjs — headless E2E check for both maps.
//
// Usage: start `npm run dev` in another terminal, then:
//   node scripts/smoke-test.mjs
//
// Requires Brave (Flatpak path below is machine-specific).
import puppeteer from 'puppeteer-core';

const BRAVE = '/var/lib/flatpak/app/com.brave.Browser/current/active/files/brave/brave';
// Parallel worktrees run parallel dev servers on distinct ports (see
// AGENTS.md); point the test at one with CS_SMOKE_BASE=http://localhost:5174
const BASE = process.env.CS_SMOKE_BASE || 'http://localhost:5173';

const browser = await puppeteer.launch({
  executablePath: BRAVE,
  headless: 'new',
  args: ['--no-sandbox', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});

const errors = [];
let failures = 0;

// Stair specs for the stairsCheck phase, one per map with a flight. Kept as
// data because the phase below is map-agnostic: it drives a sprint up a flight
// and a walk back down, and only these numbers differ.
//   start     player EYE position at the foot of the flight
//   upYaw     yaw whose forward vector points UP the flight
//   deckFeet  feet height of the surface the flight lands on
//   downYaw   yaw pointing back down (upYaw rotated 180 degrees)
//   bottomZ   z past which the descent counts as back on open ground...
//   bottomDir ...compared with >= when +1, <= when -1 (flights face both ways)
const STAIRS = {
  // Arena: the raised platform's south flight, 8 x 0.3 = 2.4.
  arena: { start: [26, 1.7, 22.5], upYaw: Math.PI, deckFeet: 2.4, downYaw: 0, bottomZ: 23, bottomDir: -1 },
  // Elevation: the two-story building's EXTERNAL south flight, 12 x 0.3 = 3.6.
  // Deliberately the outside one — it is the flight a player uses without
  // entering the building, so this phase stays independent of the interior.
  elevation: { start: [8, 1.7, 22.5], upYaw: 0, deckFeet: 3.6, downYaw: Math.PI, bottomZ: 22, bottomDir: 1 },
};

async function runMap(name, url, { sprintCheck = false, configCheck = false, botCheck = false, stairsCheck = null } = {}) {
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

    // Menu-config defaults on a bare URL: 6 T bots, 2:00 round. Bot count
    // only checked on arena — the range spawns silhouettes, not registry bots.
    if (configCheck) {
      const cfgDefaults = await page.evaluate(() => ({
        botsT: window.__cs.game.botsT,
        roundSeconds: window.__cs.game.roundSeconds,
        botCount: window.__cs.bots.length,
      }));
      if (cfgDefaults.botsT !== 6 || cfgDefaults.roundSeconds !== 120 || cfgDefaults.botCount !== 6) {
        throw new Error(`default match config wrong: ${JSON.stringify(cfgDefaults)}`);
      }
    }

    // Enter "playing" state headlessly (pointer lock is unreliable in CI)
    await page.evaluate(() => {
      window.__cs.game.started = true;
      window.__cs.game.locked = true;
      window.__cs.weapon.mag = 10;
    });

    // 0) Low-ammo hint shows at the SMG's threshold (10 of 30)
    await page.evaluate(async () => { await new Promise(r => requestAnimationFrame(r)); });
    const hintLow = await page.evaluate(() => document.getElementById('reloadHint').style.visibility);
    if (hintLow !== 'visible') throw new Error(`reload hint hidden at smg mag 10/30: ${hintLow}`);

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
      // The HUD must HONESTLY mirror state: the knife work once dropped these
      // textContent writes and every gun's indicator froze at "30/90" while
      // state moved on — state-only reads never noticed.
      domMag: document.getElementById('magText').textContent,
      domReserve: document.getElementById('ammoReserve').textContent,
    }));
    if (fired.holes === 0) throw new Error('expected bullet holes after firing, got 0');
    if (fired.domMag !== String(fired.mag) || fired.domReserve !== String(fired.reserve)) {
      throw new Error(`ammo indicator stale: shows ${fired.domMag}/${fired.domReserve}, state is ${fired.mag}/${fired.reserve}`);
    }

    let stairs = null;
    // 2b) Stairs: step-up must carry a sprinting player up the map's stair
    //     flight onto the deck it lands on WITHOUT jumping — and then back
    //     DOWN again without going airborne per tread (the descend-stick in
    //     resolveVertical). Mechanics over position: poll until deterministic
    //     states are reached (grounded at deck height; grounded back on open
    //     ground), then assert — no sinking, no overshoot, and zero airborne
    //     frames on the way down. The flight itself is a STAIRS spec, so the
    //     same phase covers every map that has one.
    if (stairsCheck) {
      const spec = stairsCheck;
      stairs = await page.evaluate(async (spec) => {
        const cs = window.__cs;
        cs.player.hp = 100000; // bot fire during the walk must not kill the runner
        cs.game.pitch = 0;
        cs.player.pos.set(spec.start[0], spec.start[1], spec.start[2]);
        cs.game.yaw = spec.upYaw;
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft' }));
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
        const startY = cs.player.pos.y;
        let minY = Infinity;
        let reached = false;
        const t0 = performance.now();
        while (performance.now() - t0 < 8000) {
          await new Promise(r => requestAnimationFrame(r));
          minY = Math.min(minY, cs.player.pos.y);
          if ((cs.player.pos.y - 1.7) >= spec.deckFeet - 0.05 && cs.player.onGround) { reached = true; break; }
        }
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft' }));
        const result = {
          reached,
          climbedTo: +(cs.player.pos.y - 1.7).toFixed(2),
          onGround: cs.player.onGround,
          sankBy: +(startY - minY).toFixed(3),
        };
        cs.player.hp = 100; // restore for later phases
        return result;
      }, spec);
      if (!stairs.reached || stairs.climbedTo < spec.deckFeet - 0.3) throw new Error(`step-up never gained the deck (feet ${stairs.climbedTo} m, wanted ${spec.deckFeet}): ${JSON.stringify(stairs)}`);
      if (!stairs.onGround) throw new Error(`stairs climb ended airborne: ${JSON.stringify(stairs)}`);
      if (stairs.climbedTo > spec.deckFeet + 0.3) throw new Error(`climbed impossibly high (feet ${stairs.climbedTo} m): ${JSON.stringify(stairs)}`);
      if (stairs.sankBy > 0.05) throw new Error(`player sank ${stairs.sankBy} m below start during climb: ${JSON.stringify(stairs)}`);
      console.log(`[stairs] OK`, JSON.stringify(stairs));

      // 2c) Descent: turn around and walk back down the same flight. Every
      //     riser is exactly one STEP_HEIGHT drop, so a grounded player must
      //     stick tread-to-tread — ANY airborne frame is the micro-hop the
      //     descend-stick exists to prevent. Deck -> first tread and last
      //     tread -> ground are also one-step drops, so the whole run should
      //     stay glued.
      const down = await page.evaluate(async (spec) => {
        const cs = window.__cs;
        cs.player.hp = 100000; // bot fire must not kill the runner mid-descent
        cs.game.pitch = 0;
        cs.game.yaw = spec.downYaw;
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
        let airborneFrames = 0;
        let reachedBottom = false;
        const t0 = performance.now();
        while (performance.now() - t0 < 10000) {
          await new Promise(r => requestAnimationFrame(r));
          if (!cs.player.onGround) airborneFrames++;
          const pastBottom = spec.bottomDir > 0 ? cs.player.pos.z >= spec.bottomZ : cs.player.pos.z <= spec.bottomZ;
          if ((cs.player.pos.y - 1.7) <= 0.05 && pastBottom) { reachedBottom = true; break; }
        }
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
        const result = {
          reachedBottom,
          endedAtFeet: +(cs.player.pos.y - 1.7).toFixed(2),
          airborneFrames,
        };
        cs.player.hp = 100;
        return result;
      }, spec);
      if (!down.reachedBottom || Math.abs(down.endedAtFeet) > 0.05) throw new Error(`descent never reached open ground grounded (feet ${down.endedAtFeet} m): ${JSON.stringify(down)}`);
      if (down.airborneFrames > 0) throw new Error(`descent went airborne on ${down.airborneFrames} frames: ${JSON.stringify(down)}`);
      console.log(`[stairs-down] OK`, JSON.stringify(down));
    }

    let sprint = null;
    // 3) Hold-Shift sprint (range only — on arena, bot fire during earlier
    //    stationary phases can damage/distract the measurement).
    //
    // We assert MECHANICS, not absolute distance: headless SwiftShader FPS
    // swings enough that wall-clock displacement is unstable (the sim's dt
    // clamp makes game-time diverge from wall-time at low FPS). So:
    //   - `game.running` must be set while Shift is held
    //   - `game.runLerp` must climb past 0.4 (ramp works)
    //   - a mid-sprint jump must NOT drain the ramp (momentum carries)
    //   - player must cover >5 m (movement integration alive)
    if (sprintCheck) {
      sprint = await page.evaluate(async () => {
        const cs = window.__cs;
        cs.game.pitch = 0; // level, so all displacement is horizontal
        cs.player.pos.set(0, 1.7, 8);
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft' }));
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
        const startZ = cs.player.pos.z;
        let runningSeen = false, runLerpPeak = 0;
        const t0 = performance.now();
        while (performance.now() - t0 < 600) {
          await new Promise(r => requestAnimationFrame(r));
          runningSeen = runningSeen || cs.game.running;
          runLerpPeak = Math.max(runLerpPeak, cs.game.runLerp);
        }
        // Jump mid-sprint and keep sampling until landed. The ramp target
        // ignores ground contact, so runLerp must stay high while airborne.
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
        let airSamples = 0, airRunLerpMin = 1;
        const t1 = performance.now();
        while (performance.now() - t1 < 1200) {
          await new Promise(r => requestAnimationFrame(r));
          if (!cs.player.onGround) {
            airSamples++;
            airRunLerpMin = Math.min(airRunLerpMin, cs.game.runLerp);
          } else if (airSamples > 0) {
            break; // landed after the jump
          }
        }
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft' }));
        return {
          dist: Math.abs(startZ - cs.player.pos.z),
          runningSeen, runLerpPeak, airSamples, airRunLerpMin,
        };
      });
      if (!sprint.runningSeen) throw new Error('holding Shift did not set game.running');
      if (sprint.runLerpPeak < 0.4) throw new Error(`sprint ramp too weak: ${sprint.runLerpPeak.toFixed(2)}`);
      if (sprint.airSamples < 2) throw new Error(`jump never seen airborne (samples=${sprint.airSamples})`);
      if (sprint.airRunLerpMin < 0.5) throw new Error(`sprint ramp drained mid-jump: min runLerp ${sprint.airRunLerpMin.toFixed(2)}`);
      if (sprint.dist < 5) throw new Error(`barely moved during sprint: ${sprint.dist.toFixed(2)} m`);
    }

    // 4) Accuracy model: spread must reflect stance and movement
    if (sprintCheck) {
      const spreads = await page.evaluate(async () => {
        const cs = window.__cs;
        const wait = ms => new Promise(r => setTimeout(r, ms));
        cs.game.pitch = 0;
        cs.player.pos.set(0, 1.7, 8);
        await wait(400); // let moveLerp/crouchLerp settle
        cs.game.spray = 1; // isolate stance/movement layers from prior phases
        await wait(150);   // let the frame loop recompute spread from spray=1
        const standing = cs.game.spread;
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ControlLeft', repeat: false })); // Ctrl toggle: crouch on
        await wait(400); // crouchLerp -> 1
        cs.game.spray = 1;
        const crouched = cs.game.spread;
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ControlLeft', repeat: false })); // toggle back off
        await wait(400);
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
        await wait(600); // walk long enough for moveLerp to settle near 1
        cs.game.spray = 1;
        const walking = cs.game.spread;
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
        await wait(400); // let moveLerp settle back down before jumping
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
        await wait(250); // reach apex-ish; airLerp -> ~0.95
        cs.game.spray = 1;
        const airborne = cs.game.spread;
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
        return { standing, crouched, walking, airborne };
      });
      if (spreads.crouched >= spreads.standing) throw new Error(`crouch should tighten spread: ${JSON.stringify(spreads)}`);
      if (spreads.walking < spreads.standing * 3) throw new Error(`walking should open spread 3x+: ${JSON.stringify(spreads)}`);
      if (spreads.airborne <= spreads.walking) throw new Error(`jumping should be worse than walking: ${JSON.stringify(spreads)}`);
      console.log(`[accuracy] OK`, JSON.stringify(spreads));

      // 5) No-clip regression: walking into the backstop must stop the
      //    player at the wall instead of passing through it. The inner face
      //    of the backstop sits at z = -80; from -75 there's ~4.5 m runway.
      //    Bounded both ways: must make progress (collision fix didn't
      //    freeze movement) but must stop short of the face.
      const clip = await page.evaluate(async () => {
        const cs = window.__cs;
        cs.player.pos.set(0, 1.7, -75);
        cs.game.yaw = 0; // forward is -z: straight into the backstop
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
        const t0 = performance.now();
        while (performance.now() - t0 < 1200) await new Promise(r => requestAnimationFrame(r));
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
        return { z: cs.player.pos.z };
      });
      // Wall box spans [-81,-80]; with radius 0.45 the player stops at
      // ~z=-79.55. Fail if they penetrate past the inner face (-80) or
      // never made progress toward it.
      if (clip.z < -79.9) throw new Error(`no-clip: walked into/through backstop to z=${clip.z.toFixed(2)}`);
      if (clip.z > -76.5) throw new Error(`no progress toward backstop: z=${clip.z.toFixed(2)}`);
      console.log(`[noclip] OK`, JSON.stringify(clip));

      // 6) Target collision: walk into the 10 m silhouette (torso front
      //    face at z=-4.8, at x=-4.5). Must stop short of its center plane.
      const target = await page.evaluate(async () => {
        const cs = window.__cs;
        cs.player.pos.set(-4.5, 1.7, -2);
        cs.game.yaw = 0; // face -z, straight at the target
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
        const t0 = performance.now();
        while (performance.now() - t0 < 1200) await new Promise(r => requestAnimationFrame(r));
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
        return { x: cs.player.pos.x, z: cs.player.pos.z };
      });
      // Blocked around z ≈ -4.35 (front face + radius); through would reach
      // well past the torso center (-5)
      if (target.z < -4.9) throw new Error(`no-clip: walked through target to ${JSON.stringify(target)}`);
      if (target.z > -2.8 || Math.abs(target.x + 4.5) > 0.3) throw new Error(`no progress toward target: ${JSON.stringify(target)}`);
      console.log(`[targetclip] OK`, JSON.stringify(target));
    }

    // 4b) Loadout picker (range only): Play with a clean config opens the
    //     shared picker; clicking cards + Deploy commits the loadout through
    //     the real UI path. Deploys sniper/revolver so the weapon phases
    //     below exercise the new position-based switching.
    if (sprintCheck) {
      const picked = await page.evaluate(async () => {
        document.getElementById('playBtn').click();
        const screen = document.getElementById('loadoutScreen');
        if (!screen || screen.style.display !== 'flex') return { fail: 'Play did not open the loadout picker' };
        const cardCount = col => document.querySelectorAll(`#col${col} .wcard`).length;
        if (cardCount('Primary') < 2 || cardCount('Secondary') < 2) {
          return { fail: 'picker columns missing cards' };
        }
        const card = (col, name) =>
          [...document.querySelectorAll(`#col${col} .wcard`)].find(b => b.textContent.includes(name));
        card('Primary', 'SNIPER').click();
        card('Secondary', 'REVOLVER').click();
        document.getElementById('deployBtn').click();
        const cs = window.__cs;
        // Capture the armed PRIMARY before stepping off it.
        const armed = { name: cs.weapon.name, mag: cs.weapon.mag, magSize: cs.weapon.magSize };
        // Step off the primary so the next phase's Digit1 is a real switch
        // rather than a same-position no-op.
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2' }));
        await new Promise(r => setTimeout(r, 150));
        return {
          primary: cs.game.primary,
          secondary: cs.game.secondary,
          armed,
          offPrimarySlot: cs.game.slot,
          offPrimaryName: cs.weapon.name,
        };
      });
      if (picked.fail) throw new Error(picked.fail);
      if (picked.primary !== 'sniper' || picked.secondary !== 'revolver') throw new Error(`deploy did not commit the loadout: ${JSON.stringify(picked)}`);
      if (picked.armed.name !== 'SNIPER' || picked.armed.mag !== picked.armed.magSize) throw new Error(`deploy did not arm the primary: ${JSON.stringify(picked.armed)}`);
      if (picked.offPrimarySlot !== 1 || picked.offPrimaryName !== 'REVOLVER') throw new Error(`Digit2 did not take the secondary position: ${JSON.stringify(picked)}`);
      console.log(`[picker] OK`, JSON.stringify(picked));

      // 5) Sniper: 1/2 POSITION switching, scope overlay, and wheel zoom steps
      //    (range only, same reason as sprint/accuracy above). Position 0 is
      //    the deployed primary (sniper), so Digit1 holds it.
      const sniper = await page.evaluate(async () => {
        const cs = window.__cs;
        const wait = ms => new Promise(r => setTimeout(r, ms));
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1' }));
        await wait(150);
        const switched = { slot: cs.game.slot, name: cs.weapon.name, mag: cs.weapon.mag };
        // Issue #10: a FULL sniper mag (10) must not advertise a reload
        const hintFull = {
          mag: cs.weapon.mag,
          magSize: cs.weapon.magSize,
          vis: document.getElementById('reloadHint').style.visibility,
        };
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
        // R WHILE SCOPED (recoil settled — the rescope just passed the gate):
        // starting the reload must DROP the scope in the same motion, not
        // reload underneath a live reticle.
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
        await wait(200);
        const scopedReload = {
          mag: cs.weapon.mag,
          reloading: cs.weapon.reloading,
          aiming: cs.game.aiming,
          overlay: document.getElementById('scopeOverlay').style.display,
        };
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2' })); // also cancels the reload
        await wait(150);
        return { switched, hintFull, zoomed, shot, gated, rescope, scopedReload, backTo: cs.game.slot };
      });
      if (sniper.switched.slot !== 0 || sniper.switched.name !== 'SNIPER') throw new Error(`switch to sniper (primary position) failed: ${JSON.stringify(sniper.switched)}`);
      if (sniper.hintFull.mag !== sniper.hintFull.magSize || sniper.hintFull.vis !== 'hidden') throw new Error(`reload hint shown with a FULL mag (issue #10): ${JSON.stringify(sniper.hintFull)}`);
      if (sniper.zoomed.level !== 2 || sniper.zoomed.overlay !== 'block') throw new Error(`zoom steps failed: ${JSON.stringify(sniper.zoomed)}`);
      if (sniper.shot.fired !== 1) throw new Error(`semi-auto should fire exactly once while held: ${JSON.stringify(sniper.shot)}`);
      if (sniper.shot.aimingAfter !== false) throw new Error(`shot should exit the scope: ${JSON.stringify(sniper.shot)}`);
      if (sniper.gated.aiming !== false || sniper.gated.overlay !== 'none') throw new Error(`re-scope during recoil settle must stay blocked: ${JSON.stringify(sniper.gated)}`);
      if (sniper.rescope.aiming !== true || sniper.rescope.overlay !== 'block') throw new Error(`re-scope after settle failed: ${JSON.stringify(sniper.rescope)}`);
      if (sniper.scopedReload.reloading !== true || sniper.scopedReload.aiming !== false || sniper.scopedReload.overlay !== 'none') throw new Error(`R while scoped must start the reload AND drop the scope: ${JSON.stringify(sniper.scopedReload)}`);
      if (sniper.backTo !== 1) throw new Error(`switch back to secondary position failed: slot ${sniper.backTo}`);
      console.log(`[sniper] OK`, JSON.stringify(sniper));
    }

    // 6) Revolver: secondary-position switch + semi-auto trigger latch
    //    (range only). Digit2 holds position 1 = the deployed revolver.
    if (sprintCheck) {
      const revolver = await page.evaluate(async () => {
        const cs = window.__cs;
        const wait = ms => new Promise(r => setTimeout(r, ms));
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2' }));
        await wait(150);
        const switched = { slot: cs.game.slot, name: cs.weapon.name, mag: cs.weapon.mag, magSize: cs.weapon.magSize };
        cs.game.pitch = -1.2; // into the floor so shots land somewhere safe
        // Semi-auto: holding LMB must fire exactly once (trigger latch),
        // even held far past the 0.45 s fireRate.
        const magBeforeShot = cs.weapon.mag;
        window.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
        await wait(300);
        window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
        await wait(100);
        const held = { fired: magBeforeShot - cs.weapon.mag };
        // A fresh press after release may fire once more (latch reset).
        const magBeforeSecond = cs.weapon.mag;
        window.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
        await wait(300);
        window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
        const second = { fired: magBeforeSecond - cs.weapon.mag, reserve: cs.weapon.reserve };
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1' }));
        await wait(150);
        return { switched, held, second, backTo: cs.game.slot };
      });
      if (revolver.switched.slot !== 1 || revolver.switched.name !== 'REVOLVER' || revolver.switched.mag !== revolver.switched.magSize) throw new Error(`switch to revolver failed: ${JSON.stringify(revolver.switched)}`);
      if (revolver.held.fired !== 1) throw new Error(`semi-auto should fire exactly once while held: ${JSON.stringify(revolver.held)}`);
      if (revolver.second.fired !== 1) throw new Error(`second press should fire exactly once more: ${JSON.stringify(revolver.second)}`);
      if (revolver.second.reserve !== 24) throw new Error(`firing must not touch reserve: ${JSON.stringify(revolver.second)}`);
      if (revolver.backTo !== 0) throw new Error(`switch back to primary failed: slot ${revolver.backTo}`);
      console.log(`[revolver] OK`, JSON.stringify(revolver));
    }

    // 6b) Q quick-swap: works IMMEDIATELY. respawn() pre-seeds lastSlot with
    //     the secondary position, so the FIRST Q (before any manual switch)
    //     must take it — a playtest regression had Q no-op until you switched
    //     by hand once. After that each Q flips slot/lastSlot (Q,Q returns
    //     you where you were), and Digit1 restores the primary for the phases
    //     below. Range only, like the other switch phases.
    if (sprintCheck) {
      const qswap = await page.evaluate(async () => {
        const cs = window.__cs;
        const wait = ms => new Promise(r => setTimeout(r, ms));
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ' }));
        await wait(150);
        const firstQ = { slot: cs.game.slot };
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ' }));
        await wait(150);
        const secondQ = { slot: cs.game.slot, last: cs.game.lastSlot };
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ' }));
        await wait(150);
        const thirdQ = { slot: cs.game.slot };
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1' }));
        await wait(150);
        return { firstQ, secondQ, thirdQ, restored: cs.game.slot };
      });
      if (qswap.firstQ.slot !== 1) throw new Error(`first Q after spawn must take the secondary position: ${JSON.stringify(qswap.firstQ)}`);
      if (qswap.secondQ.slot !== 0 || qswap.secondQ.last !== 1) throw new Error(`second Q should return to the primary: ${JSON.stringify(qswap.secondQ)}`);
      if (qswap.thirdQ.slot !== 1) throw new Error(`third Q should toggle back to the secondary: ${JSON.stringify(qswap.thirdQ)}`);
      if (qswap.restored !== 0) throw new Error(`restore to primary failed: slot ${qswap.restored}`);
      console.log(`[qswap] OK`, JSON.stringify(qswap));
    }

    // 6c) A switch cancels an in-progress reload CS-style (any switch does;
    //     Digit2 here, but Q runs the same switchWeapon line). The partial
    //     mag must ride into ammoStore UN-refilled by the cancel, and R after
    //     switching back must start a fresh reload rather than resuming.
    //     Range only, like the other switch phases.
    if (sprintCheck) {
      const qcancel = await page.evaluate(async () => {
        const cs = window.__cs;
        const wait = ms => new Promise(r => setTimeout(r, ms));
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1' }));
        await wait(150);
        const partialMag = 8; // room below magSize (sniper 10) so a free refill can't hide
        cs.weapon.mag = partialMag;
        // Plain-firearm variant of the drop rule: hold RMB (no scopeGate on
        // the smg), then R — the reload must start AND clear input.aiming.
        window.dispatchEvent(new MouseEvent('mousedown', { button: 2 }));
        await wait(150);
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
        await wait(150);
        const aimedStart = { reloading: cs.weapon.reloading, aiming: cs.game.aiming };
        window.dispatchEvent(new MouseEvent('mouseup', { button: 2 }));
        const started = { reloading: cs.weapon.reloading };
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2' }));
        await wait(150);
        const cancelled = { slot: cs.game.slot, reloading: cs.weapon.reloading };
        // Back to the primary: same partial mag, NOT topped up by the cancel...
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1' }));
        await wait(150);
        const restored = { slot: cs.game.slot, mag: cs.weapon.mag, reloading: cs.weapon.reloading };
        // ...and R starts a fresh reload; let it run out so the phases below
        // see a full mag again.
        //
        // POLLED, not slept. The reload deadline is GAME time (weapons.ts sets
        // reloadEnd = gameTime.now() + reloadTime and checks it per frame),
        // while a sleep spends WALL time — and main.ts advances the clock by
        // Math.min(clock.getDelta(), 0.05), so game time can only ever lag,
        // never lead. A frame overrunning 50 ms contributes 50 ms of game time
        // and discards the rest. Budgeting 2600 ms of wall clock for 2.2 s of
        // game time therefore asserted that the loop keeps within ~18% of
        // real time, which the dt clamp exists precisely to NOT promise. One
        // slow frame in the window and the phase failed with mag still 24.
        // Poll for the thing being claimed instead, on a generous deadline —
        // the pattern the [respawn] phase below already uses.
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
        const reloadBy = performance.now() + 8000;
        let refilled = { reloading: cs.weapon.reloading, mag: cs.weapon.mag };
        while ((refilled.reloading || refilled.mag !== cs.weapon.magSize)
               && performance.now() < reloadBy) {
          await new Promise(r => requestAnimationFrame(r));
          refilled = { reloading: cs.weapon.reloading, mag: cs.weapon.mag };
        }
        return { aimedStart, started, cancelled, restored, refilled };
      });
      if (qcancel.aimedStart.reloading !== true || qcancel.aimedStart.aiming !== false) throw new Error(`R while holding RMB must start the reload AND drop the sights: ${JSON.stringify(qcancel.aimedStart)}`);
      if (qcancel.started.reloading !== true) throw new Error(`R did not start a reload: ${JSON.stringify(qcancel.started)}`);
      if (qcancel.cancelled.slot !== 1 || qcancel.cancelled.reloading !== false) throw new Error(`switching during a reload must cancel it: ${JSON.stringify(qcancel.cancelled)}`);
      if (qcancel.restored.slot !== 0 || qcancel.restored.mag !== 8 || qcancel.restored.reloading !== false) throw new Error(`interrupted weapon must keep its partial mag: ${JSON.stringify(qcancel.restored)}`);
      if (qcancel.refilled.reloading !== false || qcancel.refilled.mag !== 10) throw new Error(`a fresh reload after re-switching must still complete: ${JSON.stringify(qcancel.refilled)}`);
      console.log(`[qcancel] OK`, JSON.stringify(qcancel));
    }

    // 7) Dead players don't shoot. exitPointerLock() dispatches
    //    pointerlockchange asynchronously, so frames still run with
    //    alive === false and locked === true; a held LMB must not spend
    //    ammo (or score) in them. Guarded in weapons.js:updateWeapon.
    const dead = await page.evaluate(async () => {
      const cs = window.__cs;
      cs.weapon.mag = 10;
      cs.player.alive = false;
      cs.game.shooting = true;
      const t0 = performance.now();
      while (performance.now() - t0 < 300) await new Promise(r => requestAnimationFrame(r));
      cs.game.shooting = false;
      const mag = cs.weapon.mag;
      cs.player.alive = true; // restore for anything downstream
      return { mag };
    });
    if (dead.mag !== 10) throw new Error(`firing while dead consumed ammo: mag ${dead.mag}, expected 10`);
    console.log(`[deadfire] OK`, JSON.stringify(dead));

    // 8) Respawn observability (issue #17): bot revival rides the pausable
    //    game clock, not wall time. Kill one bot, PAUSE past its full 6 s
    //    revival delay, and it must still be dead on resume; keep simulating
    //    and it must revive right around when the frozen delay elapses.
    //    Also pins the id/name identity that devtools recipes and killfeeds
    //    rely on ("the one I killed" must be identifiable).
    if (botCheck) {
      const resp = await page.evaluate(async () => {
        const cs = window.__cs;
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const bot = cs.bots.find(b => b.alive);
        if (!bot) throw new Error('no alive bot found');
        bot.die('torso');
        const killed = {
          alive: bot.alive,
          t: cs.gameTime.now(),
          feedTop: document.getElementById('killfeed')?.firstElementChild?.textContent ?? '',
        };
        // Pause: animate()'s simulate branch keys on locked && started, and
        // gameTime only advances inside it — so this is a real pause of the
        // clock the revival is scheduled against, not just a render freeze.
        cs.game.locked = false;
        await wait(7000); // > the entire 6 s revival delay
        const paused = { alive: bot.alive, t: cs.gameTime.now() };
        // Resume; poll until revival fires or well past its window.
        cs.game.locked = true;
        let revivedAt = -1;
        const t0 = performance.now();
        while (performance.now() - t0 < 9000) {
          await new Promise(r => requestAnimationFrame(r));
          if (bot.alive) { revivedAt = cs.gameTime.now(); break; }
        }
        return { name: bot.name, id: bot.id, killed, paused, revivedAt };
      });
      if (!/^T-\d+$/.test(resp.name) || typeof resp.id !== 'number' || resp.id < 1) {
        throw new Error(`bot identity missing: ${JSON.stringify({ name: resp.name, id: resp.id })}`);
      }
      if (resp.killed.feedTop !== `You killed ${resp.name}`) throw new Error(`killfeed not named: "${resp.killed.feedTop}"`);
      if (resp.killed.alive) throw new Error('die() did not take effect');
      if (resp.paused.alive) throw new Error(`bot revived during pause (issue #17): paused.t=${resp.paused.t.toFixed(1)}, killed.t=${resp.killed.t.toFixed(1)}`);
      if (resp.paused.t - resp.killed.t > 0.25) throw new Error(`gameTime advanced while paused: +${(resp.paused.t - resp.killed.t).toFixed(2)}s`);
      if (resp.revivedAt < 0) throw new Error('bot never revived after resume within 9 s wall-clock');
      const delay = resp.revivedAt - resp.paused.t;
      if (delay < 5.5 || delay > 6.6) throw new Error(`revival fired at wrong game-time offset after resume: ${delay.toFixed(2)}s`);
      console.log(`[respawn] OK`, JSON.stringify({ name: resp.name, id: resp.id, frozeFor: +(resp.paused.t - resp.killed.t).toFixed(2), revivedAfter: +delay.toFixed(2) }));
    }

    console.log(`[${name}] OK`, JSON.stringify({ reload: 'ok', holes: fired.holes, magAfterBurst: fired.mag, reserve: fired.reserve, ...(sprint && { sprintDist: +sprint.dist.toFixed(2) }) }));
  } catch (e) {
    failures++;
    console.log(`[${name}] FAIL: ${e.message}`);
  }
  errors.push(...mapErrors.map(e => `[${name}] ${e}`));
  await page.close();
}

// Menu-config round trip: the committed query must drive spawn count, round
// length and the HUD timer, and pre-fill the start-menu form. Uses time=90
// (1.5 min) so a passing timer read can't just be stale markup ('2:00');
// remember `time` rides the URL in SECONDS — the menu's minutes input is
// converted before commit.
async function runConfigCheck() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const mapErrors = [];
  page.on('pageerror', e => mapErrors.push('PAGEERROR: ' + e.message));
  try {
    await page.goto(BASE + '/?map=arena&tbots=10&ctbots=3&time=90', { waitUntil: 'networkidle0', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1200));

    const applied = await page.evaluate(() => ({
      botsT: window.__cs.game.botsT,
      botsCt: window.__cs.game.botsCt,
      roundSeconds: window.__cs.game.roundSeconds,
      botCount: window.__cs.bots.length,
      form: {
        map: document.getElementById('cfgMap').value,
        botsT: document.getElementById('cfgBotsT').value,
        botsCt: document.getElementById('cfgBotsCt').value,
        timeMin: document.getElementById('cfgTimeMin').value,
      },
    }));
    if (applied.botsT !== 10 || applied.botsCt !== 3 || applied.roundSeconds !== 90) {
      throw new Error(`config not parsed from query: ${JSON.stringify(applied)}`);
    }
    // 10 T + 3 CT since allied bots became real spawns.
    if (applied.botCount !== 13) throw new Error(`expected 13 spawned bots, got ${applied.botCount}`);
    if (applied.form.map !== 'arena' || applied.form.botsT !== '10' || applied.form.botsCt !== '3' || applied.form.timeMin !== '1.5') {
      throw new Error(`menu form not initialized from config: ${JSON.stringify(applied.form)}`);
    }

    // Dirty-commit path: changing a form field and pressing Play must
    // navigate to the rebuilt query (and NOT request pointer lock), and the
    // freshly loaded page must apply the committed values.
    await page.evaluate(() => { document.getElementById('cfgBotsT').value = '12'; });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 20000 }),
      page.click('#playBtn'),
    ]);
    const url = page.url();
    if (!/[?&]tbots=12&/.test(url) || !/[?&]time=90$/.test(url)) {
      throw new Error(`Play with changed settings navigated wrong: ${url}`);
    }
    const recommitted = await page.evaluate(() => ({ botsT: window.__cs.game.botsT, botCount: window.__cs.bots.length }));
    if (recommitted.botsT !== 12 || recommitted.botCount !== 15) { // 12 T + 3 CT
      throw new Error(`reloaded page did not apply committed config: ${JSON.stringify(recommitted)}`);
    }

    // Enter "playing" state headlessly; one simulated frame must render the
    // configured clock into the timer widget.
    await page.evaluate(() => { window.__cs.game.started = true; window.__cs.game.locked = true; });
    await page.evaluate(async () => { await new Promise(r => requestAnimationFrame(r)); });
    const timerText = await page.evaluate(() => document.getElementById('timer').textContent);
    // The entered state has already simulated ≥1 frame, so 90 s may read as
    // 1:30 or have ticked down to 1:29 — either proves the CONFIGURED length
    // rendered (stale '2:00' markup would fail).
    if (timerText !== '1:30' && timerText !== '1:29') throw new Error(`timer should show configured 90 s, got "${timerText}"`);
    console.log('[config] OK', JSON.stringify(applied));
  } catch (e) {
    failures++;
    console.log(`[config] FAIL: ${e.message}`);
  }
  errors.push(...mapErrors.map(e => `[config] ${e}`));
  await page.close();
}

// Two-sided combat: a CT and a T must actually fight. Headless bots converge
// slowly from their spawn halves, so the phase TELEPORTS one of each side
// adjacent to each other, at collider-free mid-field spots (an embedded bot
// is stuck for life — see Bot.spawnAtRandom), and waits for evidence: any
// bot below full HP or a named cross-team killfeed line. The player idles,
// so only bot-vs-bot fire can produce either.
// Contract: PROVE any cross-team engagement happens (an hp drop on either
// side), not that a specific pair fights. The teleport loop below only
// accelerates an encounter; with 4T/2CT loose on the map for ~15 s the
// evidence may equally come from an unteleported pair wandering into range,
// and that satisfies the assertion by design.
async function runAllyCheck() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const mapErrors = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') mapErrors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => mapErrors.push('PAGEERROR: ' + e.message));
  try {
    await page.goto(BASE + '/?map=arena&tbots=4&ctbots=2', { waitUntil: 'networkidle0', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1200));
    const result = await page.evaluate(async () => {
      const cs = window.__cs;
      const wait = ms => new Promise(r => setTimeout(r, ms));
      cs.game.started = true;
      cs.game.locked = true;

      // Per-team name counters, globally unique across both teams.
      const names = cs.bots.map(b => b.name);
      if (!names.every(n => /^(T|CT)-\d+$/.test(n))) return { fail: 'bad names: ' + names.join(',') };
      if (new Set(names).size !== names.length) return { fail: 'duplicate names: ' + names.join(',') };

      const blocked = (x, z) => cs.colliders.some(c =>
        x > c.min.x - 0.7 && x < c.max.x + 0.7 && z > c.min.z - 0.7 && z < c.max.z + 0.7);
      const spots = [[8, 8], [-8, 8], [8, -14], [-14, -8], [20, 20], [0, -30]]
        .filter(([x, z]) => !blocked(x, z) && !blocked(x + 2.5, z));
      if (spots.length === 0) return { fail: 'no free meeting spots' };

      const t = cs.bots.find(b => b.team === 'T' && b.alive);
      const ct = cs.bots.find(b => b.team === 'CT' && b.alive);
      if (!t || !ct) return { fail: 'missing live bots of both teams' };

      for (const [x, z] of spots) {
        t.mesh.position.set(x, 0, z);
        ct.mesh.position.set(x + 2.5, 0, z);
        const deadline = performance.now() + 2500;
        while (performance.now() < deadline) {
          await wait(200);
          const feed = document.getElementById('killfeed').textContent;
          const evidence = {
            spot: [x, z],
            tHpDrop: cs.bots.some(b => b.team === 'T' && b.hp < 100),
            ctHpDrop: cs.bots.some(b => b.team === 'CT' && b.hp < 100),
            crossKill: /(T|CT)-\d+ killed (T|CT)-\d+/.test(feed),
          };
          if (evidence.tHpDrop || evidence.ctHpDrop || evidence.crossKill) {
            evidence.tHp = t.hp;
            evidence.ctHp = ct.hp;
            return evidence;
          }
        }
      }
      return { fail: 'no cross-team engagement observed at any meeting spot' };
    });
    if (result.fail) throw new Error(result.fail);
    console.log('[allies] OK', JSON.stringify(result));
  } catch (e) {
    failures++;
    console.log(`[allies] FAIL: ${e.message}`);
  }
  errors.push(...mapErrors.map(e => `[allies] ${e}`));
  await page.close();
}

// Bots and stairs — the question the elevation map exists to answer.
//
// A T bot is placed at the foot of the two-story building's INTERNAL flight
// with the player directly up the fall line on the deck above, which is the
// most favorable case the steering policy can get: the beeline points straight
// up the stairs. What it proves is narrow but real — that a bot is not WALLED
// OUT of the flight (a riser built over STEP_HEIGHT would block it entirely,
// and nothing else in the suite would notice).
//
// How far the bot gets is now ASSERTED. It was reported-only for as long as
// arriving was luck rather than policy, and there turned out to be two stalls
// stacked on top of each other — worth keeping, because the second one hid
// behind the first for as long as this comment existed.
//
//   1. A COLLISION WEDGE, now fixed here. The bot drifted east until its 0.5
//      radius overlapped the x >= 6 second-floor slab (x[6,14], y[3.2,3.6]); at
//      feet 1.5 that slab's underside sits below its head, so collidesAt refused
//      every direction, the ones reducing the overlap included. Frozen at one
//      coordinate with moveBlocked set, permanently — and the same trap caught
//      the PLAYER (verified: four cardinals plus jump, zero displacement). The
//      [wedge] phase pins the escape.
//
//   2. ORBITING AT CONSTANT RADIUS, still live and steering-level. With the
//      wedge gone the bot slides freely and climbs, then stops gaining ground
//      and sweeps across the flight instead: inside the band the radial term
//      drops out, so it circles rather than climbing. This is what the comment
//      here always described. It was not wrong — it was right about a stall
//      nobody could see yet, because the wedge stopped the bot before it ever
//      got there.
//
//      3D ranging moved where it stalls but not that it stalls: the bot now
//      reaches feet 2.4 instead of 1.5, because the overhead suppression keeps
//      the radial term alive while the target is a level up. At 2.4 the rise
//      is 1.2 — under climbThreshold — the suppression switches off, and the
//      band holds it one step short of the deck.
//
// Both are fixed. 1 by the slideMoveXZ unwedge escape; 2 by routing on the
// navigation graph — a bot with a target a level up follows waypoints to the
// flight and up it, which is the thing no band around the target could
// express. So this phase now demands the deck rather than reporting a height.
async function runBotClimbCheck() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const mapErrors = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') mapErrors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => mapErrors.push('PAGEERROR: ' + e.message));

  try {
    await page.goto(BASE + '/?map=elevation&tbots=1&ctbots=0', { waitUntil: 'networkidle0', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1500));
    const result = await page.evaluate(async () => {
      const cs = window.__cs;
      cs.game.started = true;
      cs.game.locked = true;
      cs.player.hp = 100000; // the bot shoots back; the climb is what matters
      // Player on the second-floor slab, directly up the fall line of the
      // internal flight (which runs x [2,6], z -9 -> 0, deck at 3.6).
      cs.player.pos.set(4, 3.6 + 1.7, 8);
      const bot = cs.bots[0];
      if (!bot) return { fail: 'no bot spawned on the elevation map' };
      bot.mesh.position.set(4, 0, -10); // just north of the first riser
      let maxFeet = 0;
      let groundedFrames = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < 25000) {
        await new Promise(r => requestAnimationFrame(r));
        if (!bot.alive) continue; // a self-respawn resets it to a spawn band; keep watching
        maxFeet = Math.max(maxFeet, bot.mesh.position.y);
        if (bot.onGround) groundedFrames++;
        if (maxFeet >= 3.55) break;
      }
      return {
        maxFeet: +maxFeet.toFixed(2),
        gainedDeck: maxFeet >= 3.55,
        risersClimbed: Math.round(maxFeet / 0.3),
        groundedFrames,
      };
    });
    if (result.fail) throw new Error(result.fail);
    // The geometry gate: one riser proves the flight is climbable at all.
    if (result.maxFeet < 0.25) throw new Error(`bot never gained a single riser — is a riser taller than STEP_HEIGHT? ${JSON.stringify(result)}`);
    // The policy gate: the bot must actually arrive.
    if (!result.gainedDeck) throw new Error(`bot never reached the deck (feet ${result.maxFeet}) — routing regressed: ${JSON.stringify(result)}`);
    console.log('[botClimb] OK', JSON.stringify(result));
  } catch (e) {
    failures++;
    console.log(`[botClimb] FAIL: ${e.message}`);
  }
  errors.push(...mapErrors.map(e => `[botClimb] ${e}`));
  await page.close();
}

// The unwedge escape, end to end (collision.ts:slideMoveXZ).
//
// Stands the player at the exact coordinate that used to soft-lock: riser 5 of
// the elevation map's internal flight, radius lapping the x >= 6 second-floor
// slab whose underside sits below head height at feet 1.5. Before the escape
// existed, every direction was refused here — all four cardinals plus jump,
// zero displacement, forever. This asserts you can walk back out, and that the
// directions INTO the slab are still solid, because an escape that let you
// through geometry would be the worse bug.
async function runWedgeCheck() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const mapErrors = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') mapErrors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => mapErrors.push('PAGEERROR: ' + e.message));

  try {
    await page.goto(BASE + '/?map=elevation&tbots=0&ctbots=0', { waitUntil: 'networkidle0', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1200));
    const result = await page.evaluate(async () => {
      const cs = window.__cs;
      cs.game.started = true; cs.game.locked = true; cs.player.hp = 100000; cs.game.pitch = 0;
      const TRAP = { x: 6.15, feet: 1.5, z: -6.42 };
      const attempt = async (yaw) => {
        cs.player.pos.set(TRAP.x, TRAP.feet + cs.player.eyeHeight, TRAP.z);
        cs.player.vel.set(0, 0, 0);
        cs.game.yaw = yaw;
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
        for (let i = 0; i < 90; i++) await new Promise(r => requestAnimationFrame(r));
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
        return +Math.hypot(cs.player.pos.x - TRAP.x, cs.player.pos.z - TRAP.z).toFixed(2);
      };
      // Away from the slab (west) must free the player; into it (east) must not.
      const out = await attempt(Math.PI / 2);
      const into = await attempt(-Math.PI / 2);
      // And the slab must still stop a clean approach from open ground.
      cs.player.pos.set(5, TRAP.feet + cs.player.eyeHeight, TRAP.z);
      cs.player.vel.set(0, 0, 0);
      cs.game.yaw = -Math.PI / 2;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
      for (let i = 0; i < 90; i++) await new Promise(r => requestAnimationFrame(r));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
      const approachedTo = +cs.player.pos.x.toFixed(2);
      cs.player.hp = 100;
      return { out, into, approachedTo };
    });
    if (result.out < 1) throw new Error(`player still soft-locked in the slab wedge: ${JSON.stringify(result)}`);
    if (result.into > 0.05) throw new Error(`escape leaked THROUGH the slab — walls must stay solid: ${JSON.stringify(result)}`);
    if (result.approachedTo > 5.55) throw new Error(`player pushed past the slab's west face: ${JSON.stringify(result)}`);
    console.log('[wedge] OK', JSON.stringify(result));
  } catch (e) {
    failures++;
    console.log(`[wedge] FAIL: ${e.message}`);
  }
  errors.push(...mapErrors.map(e => `[wedge] ${e}`));
  await page.close();
}

// The navigation graph, asked directly (nav.ts / sim/navGrid.ts).
//
// This is the one part of the bot AI whose correctness does not require
// watching a bot move, and it is the claim everything downstream rests on: if
// the graph cannot route the ground floor to the deck, no steering policy
// built on it can either. Checked on the elevation map because that is where
// the hard cases live — a two-storey interior, four flights, and doorways.
//
// The route asked for is the exact situation the playtest complained about: a
// bot standing under the second-floor deck, with the player above it.
async function runNavGraphCheck() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const mapErrors = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') mapErrors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => mapErrors.push('PAGEERROR: ' + e.message));

  try {
    await page.goto(BASE + '/?map=elevation&tbots=1&ctbots=0', { waitUntil: 'networkidle0', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1000));
    const result = await page.evaluate(() => {
      const cs = window.__cs;
      const grid = cs.nav.grid();
      if (!grid) return { fail: 'no navigation graph was built' };
      const V = (x, y, z) => ({ x, y, z });
      // Under the deck, on the ground -> the deck itself.
      const up = cs.nav.route(V(4, 0, 8), V(4, 3.6, 8));
      // Non-vacuity for the height claim: the same query with the goal on the
      // ground must NOT need to gain any height.
      const flat = cs.nav.route(V(4, 0, 8), V(-20, 0, 20));
      const peak = up ? Math.max(...up.map(p => p.y)) : -1;
      // Section D — the jump-only crates (maps/elevation.ts): 1.2 m and 2.4 m
      // hops, over STEP_HEIGHT so nobody walks up them and under the player's
      // jump apex so only the player gets there. Bots have no jump, and the
      // graph must not hand them one. Their tops ARE sampled as standable, and
      // nodes on one flat top legitimately join each other — what matters is
      // that no route leads there from the floor, because every edge into the
      // island is a climb bigger than STEP_HEIGHT.
      let crateNodes = 0;
      for (let i = 0; i < grid.count; i++) {
        const x = grid.xs[i], y = grid.ys[i], z = grid.zs[i];
        const lower = y > 1 && y < 1.5 && x > 16 && x < 20 && z > 6 && z < 10;
        const upper = y > 2.2 && y < 2.6 && x > 16 && x < 20 && z > 2 && z < 6;
        if (lower || upper) crateNodes++;
      }
      const ontoLowCrate = cs.nav.route(V(18, 0, 14), V(18, 1.2, 8));
      const ontoHighCrate = cs.nav.route(V(18, 0, 14), V(18, 2.4, 4));
      const crateReach = [ontoLowCrate, ontoHighCrate]
        .map(p => (p ? +p[p.length - 1].y.toFixed(2) : null));
      return {
        nodes: grid.count,
        edges: grid.edgeTo.length,
        crateNodes,
        crateReach,
        levels: [...new Set(Array.from(grid.ys, y => +y.toFixed(2)))].sort((a, b) => a - b).slice(0, 6),
        routeUp: up ? up.length : null,
        reachedY: up ? +up[up.length - 1].y.toFixed(2) : null,
        peakY: +peak.toFixed(2),
        flatPeakY: flat ? +Math.max(...flat.map(p => p.y)).toFixed(2) : null,
      };
    });
    if (result.fail) throw new Error(result.fail);
    if (!result.routeUp) throw new Error(`no route from the floor to the deck: ${JSON.stringify(result)}`);
    if (result.reachedY < 3.5) throw new Error(`route ends below the deck: ${JSON.stringify(result)}`);
    // A route that gains height must have used a flight; the sampled grid
    // cannot climb 3.6 m on its own (every edge is capped at STEP_HEIGHT).
    if (result.peakY < 3.5) throw new Error(`route never gained the deck: ${JSON.stringify(result)}`);
    if (result.flatPeakY > 0.5) throw new Error(`a ground-to-ground route climbed for no reason: ${JSON.stringify(result)}`);
    if (result.levels.length < 2) throw new Error(`graph is single-level — the deck was never sampled: ${JSON.stringify(result)}`);
    if (result.crateNodes === 0) throw new Error(`the jump-only crate tops were never sampled, so their unreachability proves nothing: ${JSON.stringify(result)}`);
    // A route may exist to the FLOOR beside a crate — the goal snaps to the
    // nearest reachable node — but it must never arrive on top of one.
    for (const reached of result.crateReach) {
      if (reached !== null && reached > 0.5) {
        throw new Error(`a route reached a jump-only crate top (y ${reached}) — bots have no jump: ${JSON.stringify(result)}`);
      }
    }
    console.log('[navGraph] OK', JSON.stringify(result));
  } catch (e) {
    failures++;
    console.log(`[navGraph] FAIL: ${e.message}`);
  }
  errors.push(...mapErrors.map(e => `[navGraph] ${e}`));
  await page.close();
}

// The DEV debug overlay (src/debugView.ts), end to end.
//
// It is presentation, so nothing here claims it LOOKS right — that is a
// playtest's job (ai-plan.md, lesson 25). What this owns is the wiring, which
// is exactly the class the other three gates cannot see: a missing import in a
// browser-side module is a silent ReferenceError the first time its code path
// runs, and this overlay's code path only runs after a keypress. Toggling it on
// for real frames, then off again, is what makes that path run.
//
// Also asserts the x-ray REVERTS: it mutates the map's shared materials, and a
// toggle that left them wireframed would corrupt the session it was inspecting.
async function runDebugViewCheck() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const mapErrors = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') mapErrors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => mapErrors.push('PAGEERROR: ' + e.message));

  try {
    await page.goto(BASE + '/?map=elevation&tbots=2&ctbots=1', { waitUntil: 'networkidle0', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1200));
    const result = await page.evaluate(async () => {
      const cs = window.__cs;
      cs.game.started = true;
      cs.game.locked = true;
      cs.player.hp = 100000;
      const frames = async n => { for (let i = 0; i < n; i++) await new Promise(r => requestAnimationFrame(r)); };
      // The scene is deliberately not on __cs, and widening that hook for a
      // DEV view is not worth it — every bot is scene-parented, so one bot's
      // mesh.parent IS the scene.
      const wireframeCount = () => {
        const scene = cs.bots[0] && cs.bots[0].mesh.parent;
        if (!scene) return -1;
        let n = 0;
        scene.traverse(o => {
          const m = o.material;
          for (const mm of Array.isArray(m) ? m : m ? [m] : []) if (mm.wireframe) n++;
        });
        return n;
      };
      const before = wireframeCount();
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV' }));
      await frames(30);
      const on = wireframeCount();
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV' }));
      await frames(10);
      const off = wireframeCount();
      return { before, on, off, bots: cs.bots.length };
    });
    if (result.before === -1) throw new Error('no bot mesh to reach the scene through');
    if (result.before !== 0) throw new Error(`level geometry was already wireframed before the toggle: ${JSON.stringify(result)}`);
    if (result.on === 0) throw new Error(`toggling the debug view wireframed nothing — the x-ray is not wired: ${JSON.stringify(result)}`);
    if (result.off !== 0) throw new Error(`toggling the debug view off left ${result.off} materials wireframed: ${JSON.stringify(result)}`);
    console.log('[debugView] OK', JSON.stringify(result));
  } catch (e) {
    failures++;
    console.log(`[debugView] FAIL: ${e.message}`);
  }
  errors.push(...mapErrors.map(e => `[debugView] ${e}`));
  await page.close();
}

// Shotgun: the picker-deployed pump gun fires MULTIPLE hitscan rays per
// trigger pull. One shell straight into the floor must punch roughly one
// hole per pellet and consume exactly one round (semi-auto latch). Also pins
// the per-round reload (playtest round 2): shells transfer one at a time and
// an LMB pull cancels the remainder CS-style.
async function runShotgunCheck() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const mapErrors = [];
  page.on('pageerror', e => mapErrors.push('PAGEERROR: ' + e.message));
  try {
    await page.goto(BASE + '/?map=range', { waitUntil: 'networkidle0', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1500));
    const result = await page.evaluate(async () => {
      const cs = window.__cs;
      // Real UI path: Play opens the picker, cards select, Deploy commits.
      document.getElementById('playBtn').click();
      const screen = document.getElementById('loadoutScreen');
      if (!screen || screen.style.display !== 'flex') return { fail: 'picker did not open' };
      const card = name => [...document.querySelectorAll('.wcard')].find(b => b.textContent.includes(name));
      card('SHOTGUN').click();
      card('PISTOL').click();
      document.getElementById('deployBtn').click();
      // Enter "playing" state headlessly, aim into the floor, fire ONE pull.
      cs.game.started = true;
      cs.game.locked = true;
      await new Promise(r => requestAnimationFrame(r));
      cs.game.pitch = -1.4;
      cs.weapon.lastShot = -9; // the fire-rate gate must not eat the fresh deploy's first shell
      const holesBefore = cs.bulletHoles.length;
      const magBefore = cs.weapon.mag;
      window.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
      await new Promise(r => setTimeout(r, 300));
      window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
      const magAfterFirstShot = cs.weapon.mag;
      const holesAfterFirstShot = cs.bulletHoles.length;
      // Per-round reload: start R two shells down, let ~2 intervals elapse,
      // then fire mid-reload — the shot must cancel the rest and go out.
      cs.weapon.mag = 2;
      const reserveBefore = cs.weapon.reserve;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
      await new Promise(r => setTimeout(r, 1500)); // shotgun interval = 3.2s / 7 ≈ 0.46s
      const mid = {
        mag: cs.weapon.mag,
        reserve: cs.weapon.reserve,
        reloading: cs.weapon.reloading,
      };
      window.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
      await new Promise(r => setTimeout(r, 300));
      window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
      return {
        primary: cs.game.primary,
        secondary: cs.game.secondary,
        name: cs.weapon.name,
        fired: magAfterFirstShot === magBefore - 1,
        newHoles: holesAfterFirstShot - holesBefore,
        reloadMid: mid,
        loaded: mid.mag - 2,
        reserveUntouched: mid.reserve === reserveBefore, // range mode never drains the reserve
        shotMag: cs.weapon.mag,
        shotCancelledReload: !cs.weapon.reloading,
      };
    });
    if (result.fail) throw new Error(result.fail);
    if (result.primary !== 'shotgun' || result.secondary !== 'pistol' || result.name !== 'SHOTGUN') throw new Error(`deploy did not commit the loadout: ${JSON.stringify(result)}`);
    if (!result.fired) throw new Error(`one trigger pull must consume exactly one shell: ${JSON.stringify(result)}`);
    if (result.newHoles < 5 || result.newHoles > 8) throw new Error(`expected 5-8 pellet holes from one shell, got ${result.newHoles}`);
    // Per-round reload assertions.
    if (!result.reloadMid.reloading) throw new Error(`reload not in progress after 1.5s: ${JSON.stringify(result.reloadMid)}`);
    if (result.loaded < 1 || result.loaded > 4) throw new Error(`expected 1-4 shells loaded mid-reload, got ${result.loaded}: ${JSON.stringify(result.reloadMid)}`);
    if (!result.reserveUntouched) throw new Error(`range-mode reload drained the reserve: ${JSON.stringify(result.reloadMid)}`);
    if (result.shotMag !== result.reloadMid.mag - 1 || !result.shotCancelledReload) throw new Error(`firing must cancel the per-round reload and consume the chambered shell: ${JSON.stringify(result)}`);
    console.log('[shotgun] OK', JSON.stringify(result));
  } catch (e) {
    failures++;
    console.log(`[shotgun] FAIL: ${e.message}`);
  }
  errors.push(...mapErrors.map(e => `[shotgun] ${e}`));
  await page.close();
}

// Knife: the always-carried fallback (key 3). Pins the position-3 swap
// through the real keybind, the hidden ammo readout while knifing, the
// inert R/RMB paths (a blade holds no rounds and raises no sights), the
// ABSENCE of a knife card in the picker, and an actual kill: two swings at
// a teleported bot must drop it through the melee arc without touching ammo.
// Swapping back to a firearm must re-reveal the readout with FRESH numbers.
async function runKnifeCheck() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const mapErrors = [];
  page.on('pageerror', e => mapErrors.push('PAGEERROR: ' + e.message));
  try {
    await page.goto(BASE + '/?map=arena&tbots=1&ctbots=0', { waitUntil: 'networkidle0', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1500));
    const result = await page.evaluate(async () => {
      const cs = window.__cs;
      const wait = ms => new Promise(r => setTimeout(r, ms));
      // Real UI path: Play -> picker -> Deploy. The KNIFE card must NOT exist
      // (melee builds no card; it would otherwise land in the secondary col).
      document.getElementById('playBtn').click();
      const screen = document.getElementById('loadoutScreen');
      if (!screen || screen.style.display !== 'flex') return { fail: 'picker did not open' };
      const knifeCard = [...document.querySelectorAll('.wcard')].find(b => b.textContent.includes('KNIFE'));
      if (knifeCard) return { fail: 'KNIFE built a picker card; melee must be skipped' };
      const hint = document.getElementById('loadoutScreen').textContent;
      if (!/knife/i.test(hint)) return { fail: 'picker never mentions the carried knife' };
      const card = name => [...document.querySelectorAll('.wcard')].find(b => b.textContent.includes(name));
      card('SMG').click();
      card('PISTOL').click();
      document.getElementById('deployBtn').click();
      cs.game.started = true;
      cs.game.locked = true;
      await wait(150);

      // Key 3 takes the always-carried third position.
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit3' }));
      await wait(150);
      const swapped = {
        slot: cs.game.slot,
        name: cs.weapon.name,
        mag: cs.weapon.mag,
        magSize: cs.weapon.magSize,
        reserve: cs.weapon.reserve,
        ammoHidden: document.getElementById('magText').style.display === 'none',
      };

      // R is inert while knifing — no reload may start.
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
      await wait(300);
      const reloadInert = { reloading: cs.weapon.reloading };
      // RMB is inert while knifing — input flips, but ADS must never blend in.
      window.dispatchEvent(new MouseEvent('mousedown', { button: 2 }));
      await wait(400);
      const rmbInert = { aimingInput: cs.game.aiming, adsLerp: +cs.game.adsLerp.toFixed(3) };
      window.dispatchEvent(new MouseEvent('mouseup', { button: 2 }));

      // The kill: TWO clean swings — which also pins the dropped headshot
      // multiplier E2E (the old x4 knife killed in one, because the arc's
      // nearest part point-blank IS the head). Headless frames advance game
      // time slower than wall time (the sim's dt clamp), so fixed sleeps
      // under-run the 0.45 s cadence gate: instead, pin the target, hold the
      // gate open, and swing until the drop — bounded by a deadline.
      cs.player.hp = 100000; // the bot shoots back; the swings are what matter
      const bot = cs.bots.find(b => b.team === 'T' && b.alive);
      if (!bot) return { fail: 'no live T bot' };
      cs.game.yaw = 0; // forward is -z, straight at the bot
      cs.game.pitch = 0; // torso sits inside the arc from here
      const pin = () => bot.mesh.position.set(cs.player.pos.x, 0, cs.player.pos.z - 1.4);
      pin();
      let swings = 0;
      let hpAfterSwing1 = null;
      const t0 = performance.now();
      while (bot.alive && performance.now() - t0 < 6000) {
        pin();
        cs.weapon.lastShot = -9; // the cadence gate must not eat a fresh swing
        window.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
        await new Promise(r => setTimeout(r, 120));
        window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
        swings++;
        if (swings === 1) hpAfterSwing1 = bot.hp;
        await new Promise(r => setTimeout(r, 180));
      }
      // Ammo untouched by the swings — must be sampled BEFORE the swap-back
      // below, which arms the SMG and would mask the knife's zeros.
      const magStillZero = cs.weapon.mag === 0 && cs.weapon.reserve === 0;
      // Swap-back freshness: leaving the knife must REVEAL the readout with
      // text matching live state immediately — the exact surface whose
      // textContent writes once went stale ("30/90" forever, all firearms).
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1' }));
      await wait(150);
      const swapBack = {
        slot: cs.game.slot,
        name: cs.weapon.name,
        visible: document.getElementById('magText').style.display !== 'none',
        domMag: document.getElementById('magText').textContent,
        domReserve: document.getElementById('ammoReserve').textContent,
        mag: cs.weapon.mag,
        reserve: cs.weapon.reserve,
      };
      return {
        swapped, reloadInert, rmbInert,
        swapBack,
        killed: !bot.alive,
        swings,
        hpAfterSwing1,
        // Head/torso depends on which part took the final swing, and the
        // round-win banner may prepend above either (one bot = an instant
        // round) — so match anywhere in the feed.
        feedHasKill: /You (killed|☠ headshot) T-\d+/.test(document.getElementById('killfeed')?.textContent ?? ''),
        magStillZero,
      };
    });
    if (result.fail) throw new Error(result.fail);
    if (result.swapped.slot !== 2 || result.swapped.name !== 'KNIFE') throw new Error(`key 3 did not take the knife: ${JSON.stringify(result.swapped)}`);
    if (result.swapped.mag !== 0 || result.swapped.magSize !== 0 || result.swapped.reserve !== 0) throw new Error(`knife armed holding ammo: ${JSON.stringify(result.swapped)}`);
    if (!result.swapped.ammoHidden) throw new Error('ammo readout still visible while knifing');
    if (result.reloadInert.reloading) throw new Error('R started a reload while knifing');
    if (result.rmbInert.adsLerp > 0.01) throw new Error(`RMB blended into ADS while knifing: ${JSON.stringify(result.rmbInert)}`);
    if (!result.killed) throw new Error(`swings never dropped the bot (swing 1 hp: ${result.hpAfterSwing1})`);
    // Exactly two: 55 x 2 = 110 with NO head premium. One swing means a
    // headshot multiplier crept back in; three means damage regressed.
    if (result.swings !== 2) throw new Error(`expected exactly 2 swings to kill, got ${result.swings} (swing 1 hp: ${result.hpAfterSwing1})`);
    if (result.swapBack.slot !== 0 || result.swapBack.name !== 'SMG') throw new Error(`Digit1 swap-back failed: ${JSON.stringify(result.swapBack)}`);
    if (!result.swapBack.visible) throw new Error('ammo readout did not reappear after swapping off the knife');
    if (result.swapBack.domMag !== String(result.swapBack.mag) || result.swapBack.domReserve !== String(result.swapBack.reserve)) {
      throw new Error(`swap-back revealed stale ammo text: shows ${result.swapBack.domMag}/${result.swapBack.domReserve}, state ${result.swapBack.mag}/${result.swapBack.reserve}`);
    }
    if (!result.feedHasKill) throw new Error('killfeed missing the knife kill line');
    if (!result.magStillZero) throw new Error(`swinging consumed ammo: ${JSON.stringify({ mag: result.swapped })}`);
    console.log('[knife] OK', JSON.stringify(result));
  } catch (e) {
    failures++;
    console.log(`[knife] FAIL: ${e.message}`);
  }
  errors.push(...mapErrors.map(e => `[knife] ${e}`));
  await page.close();
}

try {
  await runMap('arena', '/', { configCheck: true, botCheck: true, stairsCheck: STAIRS.arena });
  await runConfigCheck();
  await runAllyCheck();
  await runMap('elevation', '/?map=elevation', { configCheck: true, botCheck: true, stairsCheck: STAIRS.elevation });
  await runBotClimbCheck();
  await runNavGraphCheck();
  await runWedgeCheck();
  await runDebugViewCheck();
  await runMap('range', '/?map=range', { sprintCheck: true });
  await runShotgunCheck();
  await runKnifeCheck();
} finally {
  await browser.close();
}

console.log('console/page errors:', errors.length ? JSON.stringify(errors, null, 2) : 'none');
process.exit(failures > 0 || errors.length > 0 ? 1 : 0);
