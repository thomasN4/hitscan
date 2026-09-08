// smoke-test.mjs — headless E2E check across every map.
//
// Usage: start `npm run dev` in another terminal, then:
//   node scripts/smoke-test.mjs
//
// Requires Brave (Flatpak path below is machine-specific).
import puppeteer from 'puppeteer-core';
import { checkElevators } from './elevator-smoke.mjs';

const BRAVE = '/var/lib/flatpak/app/com.brave.Browser/current/active/files/brave/brave';
// Parallel worktrees run parallel dev servers on distinct ports (see
// AGENTS.md); point the test at one with CS_SMOKE_BASE=http://localhost:5174
const BASE = process.env.CS_SMOKE_BASE || 'http://localhost:5173';

const browser = await puppeteer.launch({
  executablePath: BRAVE,
  protocolTimeout: 300000, // complete elevator rides can span several cycles
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
  // warehouse1: the south mezzanine flight, mouth at z = 17 ascending z-.
  warehouse1: { start: [0, 1.7, 18], upYaw: 0, deckFeet: 3.6, downYaw: Math.PI, bottomZ: 17.5, bottomDir: 1 },
  // warehouse2: the YARD flight, mouth at z = 15.75 on x = 32.5, ascending z-.
  // Deliberately the outdoor one, for the same reason as elevation's: it is
  // the flight a player uses without entering the building, so this phase
  // stays independent of the interior. It is an open flight like the two in
  // the void (world.ts:addOpenStairs) — the climb/descend assertions hold for
  // thin treads exactly as for solid risers, since tread TOPS sit at the same
  // heights either way.
  warehouse2: { start: [32.5, 1.7, 17], upYaw: 0, deckFeet: 5.1, downYaw: Math.PI, bottomZ: 16.25, bottomDir: 1 },
};

async function runMap(name, url, { sprintCheck = false, configCheck = false, botCheck = false, stairsCheck = null, liftCheck = null } = {}) {
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
    // Reload deadlines use game time; slow rendered frames must not turn
    // a correct reload into a wall-clock timing failure (review lesson 26).
    await page.waitForFunction(() => !window.__cs.weapon.reloading && window.__cs.weapon.mag === 30,
      { timeout: 15000 });
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

    if (liftCheck) console.log('[elevators] OK', JSON.stringify(await checkElevators(page)));

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

    // 3b) Sprint/reload exclusion (#83). Active sprint refuses both R and
    // held-LMB dry-fire reloads; stationary Shift is allowed, and movement
    // beginning after that accepted R cancels the reload before ammo moves.
    if (sprintCheck) {
      const sprintReload = await page.evaluate(async () => {
        const cs = window.__cs;
        const frame = () => new Promise(r => requestAnimationFrame(r));
        const tapR = () => {
          window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', repeat: false }));
          window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR' }));
        };

        cs.weapon.mag = 10;
        cs.weapon.reserve = 90;
        cs.weapon.reloading = false;
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft' }));
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
        await frame();
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', repeat: false }));
        await frame();
        const refused = { reloading: cs.weapon.reloading, mag: cs.weapon.mag };
        await new Promise(r => setTimeout(r, 250));
        const remainedRefused = { reloading: cs.weapon.reloading, mag: cs.weapon.mag };

        // Ending sprint while R remains held must not let OS key-repeat queue
        // a reload. A released and freshly pressed R may start; re-adding
        // movement then cancels it before the whole-mag transfer.
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', repeat: true }));
        await frame();
        const heldRAfterStop = { reloading: cs.weapon.reloading, mag: cs.weapon.mag };
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR' }));
        tapR();
        await frame();
        const stationaryStart = { reloading: cs.weapon.reloading, mag: cs.weapon.mag };
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
        await frame();
        const sprintCancelled = { reloading: cs.weapon.reloading, mag: cs.weapon.mag };

        // The empty full-auto path retries every frame while held unless the
        // refusal is latched. Ending sprint must not turn that held LMB into a
        // queued reload; release and press again to make a new attempt.
        cs.weapon.mag = 0;
        cs.weapon.reloading = false;
        cs.game.shooting = true;
        await frame();
        const drySprint = { reloading: cs.weapon.reloading };
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
        await frame();
        await frame();
        const heldAfterStop = { reloading: cs.weapon.reloading };
        cs.game.shooting = false;
        await frame();
        cs.game.shooting = true;
        await frame();
        const freshClick = { reloading: cs.weapon.reloading };

        cs.game.shooting = false;
        cs.weapon.reloading = false;
        cs.weapon.mag = 30;
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft' }));
        return { refused, remainedRefused, heldRAfterStop, stationaryStart, sprintCancelled, drySprint, heldAfterStop, freshClick };
      });
      if (sprintReload.refused.reloading || sprintReload.refused.mag !== 10) throw new Error(`R started a reload during sprint: ${JSON.stringify(sprintReload)}`);
      if (sprintReload.remainedRefused.reloading || sprintReload.remainedRefused.mag !== 10) throw new Error(`sprint-refused R queued a reload: ${JSON.stringify(sprintReload)}`);
      if (sprintReload.heldRAfterStop.reloading || sprintReload.heldRAfterStop.mag !== 10) throw new Error(`held R repeat queued reload after sprint: ${JSON.stringify(sprintReload)}`);
      if (!sprintReload.stationaryStart.reloading) throw new Error(`stationary Shift blocked reload: ${JSON.stringify(sprintReload)}`);
      if (sprintReload.sprintCancelled.reloading || sprintReload.sprintCancelled.mag !== 10) throw new Error(`sprint did not cancel whole-mag reload cleanly: ${JSON.stringify(sprintReload)}`);
      if (sprintReload.drySprint.reloading) throw new Error(`empty held LMB started reload during sprint: ${JSON.stringify(sprintReload)}`);
      if (sprintReload.heldAfterStop.reloading) throw new Error(`held LMB queued reload after sprint: ${JSON.stringify(sprintReload)}`);
      if (!sprintReload.freshClick.reloading) throw new Error(`fresh LMB did not start dry-fire reload: ${JSON.stringify(sprintReload)}`);
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
        const cs = window.__cs;
        // Exercise Deploy's real dead-player respawn path with both weapon
        // input latches dirty; a fresh life must not inherit either edge.
        cs.game.triggerLatch = true;
        cs.game.emptyReloadLatch = true;
        cs.player.alive = false;
        document.getElementById('deployBtn').click();
        // Capture the armed PRIMARY before stepping off it.
        const armed = {
          name: cs.weapon.name,
          mag: cs.weapon.mag,
          magSize: cs.weapon.magSize,
          triggerLatch: cs.game.triggerLatch,
          emptyReloadLatch: cs.game.emptyReloadLatch,
        };
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
      if (picked.armed.triggerLatch || picked.armed.emptyReloadLatch) throw new Error(`respawn preserved a weapon input latch: ${JSON.stringify(picked.armed)}`);
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
    await page.goto(BASE + '/?map=arena&tbots=10&ctbots=3&time=90&tweap=smg&tsec=pistol&ctweap=smg&ctsec=pistol', { waitUntil: 'networkidle0', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1200));

    const applied = await page.evaluate(() => ({
      botsT: window.__cs.game.botsT,
      botsCt: window.__cs.game.botsCt,
      roundSeconds: window.__cs.game.roundSeconds,
      botCount: window.__cs.bots.length,
      botWeaponT: window.__cs.game.botWeaponT,
      botSecondaryT: window.__cs.game.botSecondaryT,
      botSecondaryCt: window.__cs.game.botSecondaryCt,
      weapons: window.__cs.bots.map(b => b.weapon),
      form: {
        map: document.getElementById('cfgMap').value,
        botsT: document.getElementById('cfgBotsT').value,
        botsCt: document.getElementById('cfgBotsCt').value,
        timeMin: document.getElementById('cfgTimeMin').value,
        weaponT: document.getElementById('cfgWeaponT').value,
        weaponCt: document.getElementById('cfgWeaponCt').value,
        secondaryT: document.getElementById('cfgSecondaryT').value,
        secondaryCt: document.getElementById('cfgSecondaryCt').value,
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
    // The weapon setting reaches the session, the form AND every bot: a
    // forced weapon must arm the whole field, since that is what every other
    // bot phase now relies on to hold its fixture still.
    if (applied.botWeaponT !== 'smg' || applied.form.weaponT !== 'smg' || applied.form.weaponCt !== 'smg') {
      throw new Error(`bot weapon not applied: ${JSON.stringify(applied)}`);
    }
    if (applied.botSecondaryT !== 'pistol' || applied.botSecondaryCt !== 'pistol'
        || applied.form.secondaryT !== 'pistol' || applied.form.secondaryCt !== 'pistol') {
      throw new Error(`bot secondary not applied: ${JSON.stringify(applied)}`);
    }
    if (!applied.weapons.every(w => w === 'smg')) {
      throw new Error(`forced weapon did not arm every bot: ${JSON.stringify(applied.weapons)}`);
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
    if (!/[?&]tbots=12&/.test(url) || !/[?&]time=90&/.test(url) || !/[?&]ctsec=pistol$/.test(url)) {
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
// slowly from their spawn halves, so the phase isolates one of each side and
// TELEPORTS that named pair face-to-face at collider-free mid-field spots.
// Their +z/-z team spawn facings now put each straight inside the other's
// horizontal FOV; the pre-6a x-offset fixture put both exactly 90° off-axis,
// where non-omniscient bots correctly held forever. The player and bystanders
// are made non-candidates, so only pair-specific HP or killfeed evidence can
// pass — no incidental unteleported encounter lottery.
async function runAllyCheck() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const mapErrors = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') mapErrors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => mapErrors.push('PAGEERROR: ' + e.message));
  try {
    await page.goto(BASE + '/?map=arena&tbots=4&ctbots=2&tweap=smg&ctweap=smg', { waitUntil: 'networkidle0', timeout: 20000 });
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
        .filter(([x, z]) => !blocked(x, z) && !blocked(x, z + 2.5));
      if (spots.length === 0) return { fail: 'no free meeting spots' };

      const t = cs.bots.find(b => b.team === 'T' && b.alive);
      const ct = cs.bots.find(b => b.team === 'CT' && b.alive);
      if (!t || !ct) return { fail: 'missing live bots of both teams' };

      // Isolate the named pair before the first simulated frame. Dead entries
      // stay in perception's candidate lists but are cheap rejections, which
      // also pins the 6a liveness boundary this fixture depends on.
      cs.player.alive = false;
      for (const b of cs.bots) {
        if (b === t || b === ct) continue;
        b.alive = false;
        b.mesh.visible = false;
      }

      for (const [x, z] of spots) {
        t.mesh.position.set(x, 0, z);
        ct.mesh.position.set(x, 0, z + 2.5);
        t.mesh.rotation.y = 0;          // +z, toward CT
        ct.mesh.rotation.y = Math.PI;  // -z, toward T
        const deadline = performance.now() + 2500;
        while (performance.now() < deadline) {
          await wait(200);
          const feed = document.getElementById('killfeed').textContent;
          const evidence = {
            spot: [x, z],
            tHpDrop: t.hp < 100,
            ctHpDrop: ct.hp < 100,
            crossKill: feed.includes(`${t.name} killed ${ct.name}`)
              || feed.includes(`${ct.name} killed ${t.name}`),
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

// Flat routing (issue #44): band steering has no representation of obstacles,
// so a same-level target behind the arena's mid wall can be unreachable — the
// bot paces at the wall face (no `blk`: sliding keeps ~0.7 of its step) and
// never arrives. The stagnation latch hands the problem to the graph.
//
// 6a reshaped the premise: a bot must never know a position it has not SEEN,
// so the phase seeds travel knowledge through a real visual first. The bot
// and player start together north of the mid wall, in the bot's +z FOV with
// clear LOS, and the phase polls until the bot reports a current visual and
// an observed endpoint. Only then — in one synchronous step, no respawn and
// no brain reset, so the copied observation stays the bot's ONLY travel
// knowledge — the same bot is teleported to the original south start and the
// live player moves to an occluded north-side point. The copied observation
// is now the frozen-memory goal behind the wall: the phase verifies the
// intent endpoint never follows the live hidden eye and grading stays
// non-shootable, while the original outcome claim stands — ARRIVAL across
// the wall (feet z ≥ 2) within the wall-clock give-up bound, mechanism-free
// (lesson 28): whether the bot routed (#44), committed a strafe slide around
// the wall end (#45/#43), or simply got lucky is recorded in sawRoute for
// information, not asserted — policy isolation belongs to the unit suite;
// this phase owns the outcome "the trap does not hold against legitimate
// memory".
async function runFlatRouteCheck() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const mapErrors = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') mapErrors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => mapErrors.push('PAGEERROR: ' + e.message));
  try {
    await page.goto(BASE + '/?map=arena&tbots=1&ctbots=0&time=120&tweap=smg', { waitUntil: 'networkidle0', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1200));
    const result = await page.evaluate(async () => {
      const cs = window.__cs;
      const wait = ms => new Promise(r => setTimeout(r, ms));
      cs.game.started = true;
      cs.game.locked = true;
      cs.player.hp = 100000;

      const bot = cs.bots.find(b => b.team === 'T' && b.alive);
      if (!bot) return { fail: 'no live T bot' };

      // Collider-free placement, [allies]' margin: an embedded bot is stuck
      // for life and would poison everything measured after the teleport.
      const blocked = (x, z) => cs.colliders.some(c =>
        x > c.min.x - 0.7 && x < c.max.x + 0.7 && z > c.min.z - 0.7 && z < c.max.z + 0.7);
      const SEED_BOT = [-6, 4];    // north of the mid wall, facing +z
      const SEED_EYE = [0, 16];    // player eye: north, in the bot's FOV, LOS clear
      const SOUTH_START = [-6, -10]; // the original south-side start
      const HIDDEN = [-40, 2];     // occluded north-side player after the teleport
      for (const [label, [x, z]] of [['seed bot', SEED_BOT], ['seed player', SEED_EYE], ['south start', SOUTH_START], ['hidden player', HIDDEN]]) {
        if (blocked(x, z)) return { fail: `${label} spot (${x}, ${z}) is inside geometry` };
      }

      // Seed the memory through a real visual: 6a forbids travel knowledge
      // the bot has not observed.
      bot.mesh.position.set(SEED_BOT[0], 0, SEED_BOT[1]);
      bot.vy = 0;      // clear vertical state carried from wherever it spawned,
      bot.onGround = true; // like Bot.spawnAtRandom does
      // path/leg are TS-private ("written here only" in bots.ts); the harness
      // reaches past that on purpose — a teleport is not a flow the executor
      // otherwise sees, and without this the stale route survives until the
      // ROUTE_ABANDON drift check drops it a frame later.
      bot.path = [];
      bot.leg = 0;
      cs.player.pos.set(SEED_EYE[0], 1.7, SEED_EYE[1]);
      cs.player.vel.set(0, 0, 0);
      let seen = false;
      const tSeed = performance.now();
      while (performance.now() - tSeed < 8000) {
        await wait(100);
        if (!bot.alive) return { fail: 'bot died before seeding memory' };
        if (bot.targetLOS === true) { seen = true; break; }
      }
      if (!seen || !bot.targetEye) {
        return {
          fail: 'bot never acquired the seeded player',
          los: bot.targetLOS,
          endpoint: bot.targetEye !== null,
          botAt: [+bot.mesh.position.x.toFixed(1), +bot.mesh.position.z.toFixed(1)],
          playerAt: [+cs.player.pos.x.toFixed(1), +cs.player.pos.z.toFixed(1)],
        };
      }
      const observed = bot.targetEye.clone();

      // One synchronous setup step before the next animation frame: same
      // bot, no respawn, no brain reset — the copied observation at (0, 16)
      // must remain its only travel knowledge.
      bot.mesh.position.set(SOUTH_START[0], 0, SOUTH_START[1]);
      bot.vy = 0;
      bot.onGround = true;
      bot.path = [];
      bot.leg = 0;
      cs.player.pos.set(HIDDEN[0], 1.7, HIDDEN[1]);
      cs.player.vel.set(0, 0, 0);

      const t0 = performance.now();
      let sawRoute = false, maxDrift = 0, minLive = Infinity, gradeOk = true;
      while (performance.now() - t0 < 45000) { // give-up bound, not the claim
        await wait(150);
        if (!bot.alive) return { fail: 'bot died before crossing', sawRoute };
        if (bot.mode === 'route') sawRoute = true;
        if (bot.targetEye) {
          maxDrift = Math.max(maxDrift, bot.targetEye.distanceTo(observed));
          minLive = Math.min(minLive, bot.targetEye.distanceTo(cs.player.pos));
        }
        if (bot.targetInRange || bot.targetLOS === true) gradeOk = false;
        if (bot.mesh.position.z >= 2) {
          return {
            crossedZ: +bot.mesh.position.z.toFixed(2),
            crossedX: +bot.mesh.position.x.toFixed(1),
            sawRoute,
            maxEndpointDrift: +maxDrift.toFixed(2),
            minLiveEyeDist: minLive === Infinity ? null : +minLive.toFixed(2),
            gradeOk,
            elapsedS: +((performance.now() - t0) / 1000).toFixed(1),
          };
        }
      }
      return {
        fail: 'bot never crossed the mid wall',
        finalX: +bot.mesh.position.x.toFixed(1),
        finalZ: +bot.mesh.position.z.toFixed(1),
        sawRoute,
        maxEndpointDrift: +maxDrift.toFixed(2),
        minLiveEyeDist: minLive === Infinity ? null : +minLive.toFixed(2),
        gradeOk,
      };
    });
    if (result.fail) throw new Error(`${result.fail} (${JSON.stringify(result)})`);
    if (result.maxEndpointDrift > 1) throw new Error(`intent endpoint left the seeded observation — travel knowledge must be the frozen memory: ${JSON.stringify(result)}`);
    if (result.minLiveEyeDist === null || result.minLiveEyeDist < 8) throw new Error(`intent endpoint followed the live hidden player: ${JSON.stringify(result)}`);
    if (!result.gradeOk) throw new Error(`memory pursuit graded shootable: ${JSON.stringify(result)}`);
    console.log('[flatRoute] OK', JSON.stringify(result));
  } catch (e) {
    failures++;
    console.log(`[flatRoute] FAIL: ${e.message}`);
  }
  errors.push(...mapErrors.map(e => `[flatRoute] ${e}`));
  await page.close();
}

// Vision awareness (tranche 6a), end to end in the browser.
//
// The pure suite pins the perception/brain seams; this phase owns the WIRING:
// that the executor's acquisition, the brain's memory/search/damage policy and
// the shot gate agree through the real frame loop. One T bot, one wall — the
// arena's west mid wall (x ∈ [-52.5, 2.5], z ∈ [-1, 1]) — and five staged
// claims, each polled on wall-clock give-up bounds (lesson 26) rather than
// slept:
//
//   1. hidden: the player is a non-candidate, so the bot faces the wall,
//      holds through the one-second patrol stand-down, then patrols —
//      materially, with no shootable grading and no damage.
//   2. acquisition: respawn clears the patrol state; the player steps into
//      FOV + LOS on the bot's side; the bot engages and its intent endpoint
//      is the observed eye.
//   3. frozen memory: sight breaks; the bot routes to the COPIED last-known
//      eye — the endpoint must not follow the live player — and grades
//      non-shootable throughout.
//   4. investigation: arrival stands a still scan (endpoint up, non-shootable)
//      until the 8 s forget timer expires into hold, which clears both.
//   5. damage priority through the real firing path: one SMG round lands, and
//      the SAME frame's decision is a bearing search — body and endpoint face
//      the planar victim-to-player bearing, grading stays non-shootable, and
//      the bot does not retaliate. Damage must outrank the simultaneous
//      ordinary visual the 5 m setup supplies, for that one decision.
//
// Assertions stay on public behavior (mode, targetEye, the r/s grading bits,
// hp, the public respawn()); no private brain state, and no claim about WHICH
// routing mechanism produced an allowed outcome.
async function runVisionAwarenessCheck() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const mapErrors = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') mapErrors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => mapErrors.push('PAGEERROR: ' + e.message));
  try {
    await page.goto(BASE + '/?map=arena&tbots=1&ctbots=0&time=120&tweap=smg', { waitUntil: 'networkidle0', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1200));
    const result = await page.evaluate(async () => {
      const cs = window.__cs;
      const frame = () => new Promise(r => requestAnimationFrame(r));
      const blocked = (x, z) => cs.colliders.some(c =>
        x > c.min.x - 0.7 && x < c.max.x + 0.7 && z > c.min.z - 0.7 && z < c.max.z + 0.7);
      const BOT_SPOT = [-40, -10]; // south side of the west mid wall
      const NORTH = [-40, 2];      // north side, hidden from the bot
      const SOUTH = [-27.3, -2];   // south side: 15.0 m from the bot, dot 0.53 into its 120° FOV
      for (const [label, [x, z]] of [['bot', BOT_SPOT], ['north player', NORTH], ['south player', SOUTH]]) {
        if (blocked(x, z)) return { fail: `${label} spot (${x}, ${z}) is inside geometry` };
      }
      cs.player.hp = 100000;
      cs.player.pos.set(NORTH[0], 1.7, NORTH[1]);
      cs.player.vel.set(0, 0, 0);
      // The hidden phase wants the bot UNAWARE: with the player a
      // non-candidate there is nothing to acquire, so patrol begins after
      // the stand-down. Restored before the acquisition staging below.
      cs.player.alive = false;
      const bot = cs.bots.find(b => b.team === 'T' && b.alive);
      if (!bot || cs.bots.length !== 1) return { fail: `expected exactly one live T bot, got ${cs.bots.length}` };
      bot.mesh.position.set(BOT_SPOT[0], 0, BOT_SPOT[1]);
      bot.vy = 0;
      bot.onGround = true;
      // T spawn convention faces +z — toward the hidden player. The plan's
      // "faces toward the player" gate, asserted before any frame runs.
      const toHidden = { x: NORTH[0] - BOT_SPOT[0], z: NORTH[1] - BOT_SPOT[1] };
      const fx = Math.sin(bot.mesh.rotation.y), fz = Math.cos(bot.mesh.rotation.y);
      if ((fx * toHidden.x + fz * toHidden.z) / Math.hypot(toHidden.x, toHidden.z) < 0.5) {
        return { fail: 'bot does not face the hidden player at setup' };
      }
      cs.game.started = true;
      cs.game.locked = true;
      const simT0 = cs.gameTime.now();

      // 1) Hidden: observe past the spawn stagger (<= 3 s game time). The 6a
      //    follow-up lets an unaware bot patrol after a one-second
      //    stand-down, so the claim is: it holds through the pause, then
      //    patrols — and never grades a shootable target, exposes a current
      //    visual, or damages the player.
      let firstMode = null, sawPatrol = false, leftModes = false;
      let graded = false, patrolDrift = 0, patrolAt = null, patrolAnchor = null;
      let observed = 0;
      const t1 = performance.now();
      while (performance.now() - t1 < 20000 && cs.gameTime.now() - simT0 < 4) {
        await frame();
        observed++;
        if (firstMode === null) firstMode = bot.mode;
        if (bot.mode === 'patrol') {
          if (!sawPatrol) { sawPatrol = true; patrolAt = cs.gameTime.now() - simT0; patrolAnchor = bot.mesh.position.clone(); }
          patrolDrift = Math.max(patrolDrift, bot.mesh.position.distanceTo(patrolAnchor));
        } else if (bot.mode !== 'hold') leftModes = true;
        if (bot.targetInRange || bot.targetLOS === true) graded = true;
        if (cs.game.matchOver) return { fail: 'match ended while hidden' };
      }
      const hidden = {
        observed, firstMode, sawPatrol, leftModes, graded,
        patrolAfterS: patrolAt === null ? null : +patrolAt.toFixed(2),
        patrolDrift: +patrolDrift.toFixed(2),
        inRange: bot.targetInRange,
        los: bot.targetLOS,
        playerHpLost: 100000 - cs.player.hp,
        simS: +(cs.gameTime.now() - simT0).toFixed(2),
      };
      if (hidden.simS < 4) return { fail: 'simulation too slow to cover the spawn stagger', hidden };
      if (hidden.firstMode !== 'hold') return { fail: 'the unaware bot did not begin in the one-second patrol pause', hidden };
      if (!hidden.sawPatrol) return { fail: 'the unaware bot never began patrolling', hidden };
      if (hidden.patrolAfterS < 0.85) return { fail: 'patrol began before the one-second pause elapsed', hidden };
      if (hidden.patrolDrift < 2) return { fail: 'patrol never travelled materially', hidden };
      if (hidden.leftModes) return { fail: 'hidden bot left hold/patrol', hidden };
      if (hidden.graded) return { fail: 'hidden bot graded a current visual', hidden };
      if (hidden.playerHpLost !== 0) return { fail: 'hidden bot damaged the player', hidden };

      // 2) Acquisition: respawn drops every patrol/search state, then the
      //    player steps into FOV + LOS on the bot's side of the wall, ~15 m
      //    out — acquisition on the first eligible frame.
      bot.respawn();
      bot.mesh.position.set(BOT_SPOT[0], 0, BOT_SPOT[1]);
      bot.vy = 0;
      bot.onGround = true;
      bot.path = [];
      bot.leg = 0;
      cs.player.alive = true;
      cs.player.pos.set(SOUTH[0], 1.7, SOUTH[1]);
      cs.player.vel.set(0, 0, 0);
      let acquired = false;
      const t2 = performance.now();
      while (performance.now() - t2 < 8000) {
        await frame();
        if (bot.targetLOS === true) { acquired = true; break; }
        if (cs.game.matchOver) return { fail: 'match ended during acquisition' };
      }
      const seen = {
        acquired,
        mode: bot.mode,
        endpoint: bot.targetEye ? { x: +bot.targetEye.x.toFixed(2), y: +bot.targetEye.y.toFixed(2), z: +bot.targetEye.z.toFixed(2) } : null,
      };
      if (!acquired) return { fail: 'bot never acquired a player in FOV+LOS', seen };
      if (seen.mode !== 'engage') return { fail: `acquisition did not engage (mode ${seen.mode})`, seen };
      if (!seen.endpoint) return { fail: 'engaged bot exposed no intent endpoint', seen };

      // 3) Frozen memory: break sight north; the pursuit endpoint must stay
      //    pinned to the COPIED pre-break eye and grade non-shootable.
      const preBreak = bot.targetEye.clone();
      cs.player.pos.set(NORTH[0], 1.7, NORTH[1]);
      cs.player.vel.set(0, 0, 0);
      let routed = false;
      const t3 = performance.now();
      while (performance.now() - t3 < 10000) {
        await frame();
        if (bot.mode === 'route') { routed = true; break; }
        if (bot.mode === 'search' || bot.mode === 'hold') break;
        if (cs.game.matchOver) return { fail: 'match ended while breaking sight' };
      }
      let maxDev = 0, minLive = Infinity, gradeOk = true;
      const t3b = performance.now();
      while (performance.now() - t3b < 20000) {
        await frame();
        if (bot.mode !== 'route') break; // arrival hands over to the scan
        if (bot.targetEye) {
          maxDev = Math.max(maxDev, bot.targetEye.distanceTo(preBreak));
          minLive = Math.min(minLive, bot.targetEye.distanceTo(cs.player.pos));
        }
        if (bot.targetInRange || bot.targetLOS === true) gradeOk = false;
        if (cs.game.matchOver) return { fail: 'match ended during memory pursuit' };
      }
      const mem = {
        routed, mode: bot.mode,
        maxEndpointDrift: +maxDev.toFixed(2),
        minLiveEyeDist: minLive === Infinity ? null : +minLive.toFixed(2),
        gradeOk,
      };
      if (!routed) return { fail: `sight loss never produced a route (mode ${mem.mode})`, mem };
      if (mem.maxEndpointDrift > 1) return { fail: 'pursuit endpoint left the frozen last-known eye', mem };
      if (mem.minLiveEyeDist === null || mem.minLiveEyeDist < 8) return { fail: 'pursuit endpoint followed the live player', mem };
      if (!gradeOk) return { fail: 'memory pursuit graded shootable', mem };

      // 4) Investigation: arrival -> standing scan -> forget (8 s) -> hold.
      let searched = bot.mode === 'search';
      const t4 = performance.now();
      while (!searched && performance.now() - t4 < 15000) {
        await frame();
        if (bot.mode === 'search') searched = true;
        else if (bot.mode === 'hold') break;
        if (cs.game.matchOver) return { fail: 'match ended before the scan' };
      }
      if (!searched) return { fail: `arrival never entered search (mode ${bot.mode})` };
      const scanPos = bot.mesh.position.clone();
      const scanT = cs.gameTime.now();
      let drift = 0, endpointUp = true, gradeOk2 = true;
      const t4b = performance.now();
      while (performance.now() - t4b < 30000) {
        await frame();
        drift = Math.max(drift, bot.mesh.position.distanceTo(scanPos));
        if (bot.mode === 'hold') break;
        if (bot.mode !== 'search') { endpointUp = false; break; }
        if (bot.targetEye === null) endpointUp = false;
        if (bot.targetInRange) gradeOk2 = false;
        if (cs.game.matchOver) return { fail: 'match ended during the scan' };
      }
      const scan = {
        mode: bot.mode,
        drift: +drift.toFixed(2),
        endpointUp, gradeOk: gradeOk2,
        scanGameS: +(cs.gameTime.now() - scanT).toFixed(2),
      };
      if (scan.mode !== 'hold') return { fail: 'search never expired to hold', scan };
      if (scan.drift > 0.4) return { fail: 'search did not stand still', scan };
      if (!scan.endpointUp) return { fail: 'search lost its scan endpoint', scan };
      if (!scan.gradeOk) return { fail: 'search graded shootable', scan };
      if (bot.targetEye !== null) return { fail: 'hold kept an intent endpoint', scan };
      if (bot.targetInRange || bot.targetLOS === true) return { fail: 'hold kept shootable grading', scan };

      // 5) Damage priority through the real firing path: reset the SAME bot
      //    via its public respawn(), stand 5 m apart in open arena, and fire
      //    the SMG until one real round lands. The weapon's inherent rest
      //    cone is NOT zero — it spreads ~1.4 cm at this range, which a
      //    torso hit absorbs deterministically — so the setup forces the
      //    situational spread layers to rest instead of pretending the gun
      //    is a ray. The respawned T faces +z, straight at the player, so
      //    the firing frame carries an eligible FOV/range/LOS candidate:
      //    the simultaneous ordinary visual the incoming-fire bearing must
      //    outrank for that one decision.
      bot.respawn();
      bot.hp = 100000; // the hit must be nonlethal
      const BOT5 = [10, 5], PLAYER5 = [10, 10];
      if (blocked(...BOT5) || blocked(...PLAYER5)) return { fail: 'damage-priority spots inside geometry' };
      bot.mesh.position.set(BOT5[0], 0, BOT5[1]);
      bot.vy = 0;
      bot.onGround = true;
      cs.player.pos.set(PLAYER5[0], 1.7, PLAYER5[1]);
      cs.player.vel.set(0, 0, 0);
      cs.game.yaw = 0; // forward is -z: straight at the bot
      cs.game.pitch = 0;
      cs.weapon.mag = 30;
      cs.weapon.lastShot = -9;
      const playerHpBefore = cs.player.hp;
      const botHpBefore = bot.hp;
      cs.game.shooting = true;
      let fired = false;
      const t5 = performance.now();
      while (performance.now() - t5 < 3000) {
        await frame();
        if (bot.hp < botHpBefore) { fired = true; break; }
      }
      // Freeze on the firing frame's edge: the reaction under test happened in
      // the SAME frame (updateWeapon damages before updateBots decides).
      cs.game.shooting = false;
      cs.game.locked = false;
      const bx = Math.sin(bot.mesh.rotation.y), bz = Math.cos(bot.mesh.rotation.y);
      const bear = { x: PLAYER5[0] - bot.mesh.position.x, z: PLAYER5[1] - bot.mesh.position.z };
      const bl = Math.hypot(bear.x, bear.z);
      bear.x /= bl; bear.z /= bl;
      const bodyDot = bx * bear.x + bz * bear.z;
      let endDot = null, endLen = null;
      if (bot.targetEye) {
        const ex = bot.targetEye.x - bot.mesh.position.x, ez = bot.targetEye.z - bot.mesh.position.z;
        endLen = Math.hypot(ex, ez);
        endDot = endLen > 1e-6 ? (ex * bear.x + ez * bear.z) / endLen : null;
      }
      const dmg = {
        fired,
        botHp: +bot.hp.toFixed(1),
        mode: bot.mode,
        bodyDot: +bodyDot.toFixed(3),
        endDot: endDot === null ? null : +endDot.toFixed(3),
        endLen: endLen === null ? null : +endLen.toFixed(2),
        inRange: bot.targetInRange,
        los: bot.targetLOS,
        playerHpLost: playerHpBefore - cs.player.hp,
      };
      if (!fired) return { fail: 'the SMG round never landed', dmg };
      if (dmg.mode !== 'search') return { fail: `damage did not start a bearing search (mode ${dmg.mode})`, dmg };
      if (dmg.bodyDot < 0.99) return { fail: 'body did not face the incoming bearing', dmg };
      if (dmg.endDot === null || dmg.endDot < 0.98 || Math.abs(dmg.endLen - 1) > 0.2) {
        return { fail: 'intent endpoint did not face the incoming bearing', dmg };
      }
      if (dmg.inRange) return { fail: 'damage reaction graded shootable range', dmg };
      // EXACTLY false, not merely "not true": false proves acquisition spent
      // the frame's probe on the eligible 5 m candidate but the
      // higher-priority damage intent discarded its focus agreement (null
      // would mean no probe was ever attempted, which would make the
      // "simultaneous visual" claim vacuous).
      if (dmg.los !== false) return { fail: 'the damage frame did not discard the simultaneous visual (targetLOS must be exactly false)', dmg };
      if (dmg.playerHpLost !== 0) return { fail: 'the bot retaliated on the damage-priority frame', dmg };
      return { hiddenSimS: hidden.simS, endpoint: seen.endpoint, mem, scan, dmg };
    });
    if (result.fail) throw new Error(`${result.fail} (${JSON.stringify(result)})`);
    console.log('[vision] OK', JSON.stringify(result));
  } catch (e) {
    failures++;
    console.log(`[vision] FAIL: ${e.message}`);
  }
  errors.push(...mapErrors.map(e => `[vision] ${e}`));
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
// Hearing — the wiring 6b adds, end to end on arena.
//
// Arena's west mid wall (x [-52.5, 2.5], z [-1, 1]) is the fixture: a bot at
// z = -10 and the player at z = +2 are 12 m apart with solid geometry between
// them, so NOTHING the bot does about the player can have come from sight.
// That is what makes each claim below about hearing specifically:
//
//   1. a hostile gunshot through the wall is investigated, and graded
//      non-shootable the whole time;
//   2. a CT bot 35 m from the same shot ignores it, because the player is its
//      ALLY — the team filter, which no unit test can reach through the
//      executor;
//   3. the player's own footsteps are heard the same way (a separate emitter,
//      in player.ts, on a separate radius);
//   4. crouch-walking the identical path is silent — asserted alongside proof
//      that the player really moved, so the phase cannot pass by the player
//      standing still.
//
// Assertions are on the INVARIANT — "it is heading at the noise, and it cannot
// shoot" — never on which of route/search produced it (lesson 28).
async function runHearingCheck() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const mapErrors = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') mapErrors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => mapErrors.push('PAGEERROR: ' + e.message));
  try {
    await page.goto(BASE + '/?map=arena&tbots=1&ctbots=1&time=180&tweap=smg&ctweap=smg', { waitUntil: 'networkidle0', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1200));
    const result = await page.evaluate(async () => {
      const cs = window.__cs;
      const frame = () => new Promise(r => requestAnimationFrame(r));
      const blocked = (x, z) => cs.colliders.some(c =>
        x > c.min.x - 0.7 && x < c.max.x + 0.7 && z > c.min.z - 0.7 && z < c.max.z + 0.7);
      const planar = (a, x, z) => Math.hypot(a.x - x, a.z - z);

      const BOT = [-40, -10];   // south of the mid wall
      const SHOOTER = [-40, 2]; // north of it, 12 m away, no line of sight
      const ALLY = [-10, 20];   // 35 m from the shot, wall between it and the T
      // Far enough east that 2.5 s of sprinting west (~24 m) still ends
      // inside the mid wall's span (x >= -52.5): the runner must stay HIDDEN
      // for the whole window, or the bot could be reacting to sight.
      const WALKER = [-25, 2];
      // The crouch fixture stands closer, and deliberately so: the walking
      // radius is HALF the running one, so a crouch test run at the footstep
      // distances would be silent for the trivial reason that a walk could
      // not have been heard from there either. 6 m apart, still with the wall
      // between, keeps the whole 3 s well inside the 12 m a walk carries.
      const CREEP_BOT = [-40, -4], CREEPER = [-40, 2];
      for (const [label, [x, z]] of [['bot', BOT], ['shooter', SHOOTER], ['ally', ALLY], ['walker', WALKER],
                                     ['creep bot', CREEP_BOT], ['creeper', CREEPER]]) {
        if (blocked(x, z)) return { fail: `${label} spot (${x}, ${z}) is inside geometry` };
      }

      const t = cs.bots.find(b => b.team === 'T');
      const ct = cs.bots.find(b => b.team === 'CT');
      if (!t || !ct || cs.bots.length !== 2) return { fail: `expected one T and one CT, got ${cs.bots.length}` };

      /** Park a bot at a spot with every per-life field freshly reset. */
      const place = (bot, [x, z]) => {
        bot.respawn();               // also jumps its sound cursor to the present
        bot.mesh.position.set(x, 0, z);
        bot.vy = 0;
        bot.onGround = true;
        bot.path = [];
        bot.leg = 0;
      };

      cs.player.hp = 100000;
      cs.player.alive = true;
      cs.game.started = true;
      cs.game.locked = true;
      cs.game.pitch = 0;

      // ---- 1 + 2) a hostile gunshot through the wall ----------------------
      place(t, BOT);
      place(ct, ALLY);
      cs.player.pos.set(SHOOTER[0], 1.7, SHOOTER[1]);
      cs.player.vel.set(0, 0, 0);
      cs.game.yaw = Math.PI;   // forward +z: fire AWAY from the wall and both bots
      cs.weapon.mag = 30;
      cs.weapon.lastShot = -9;

      const magBefore = cs.weapon.mag;
      cs.game.shooting = true;
      const gFire = cs.gameTime.now();
      const wFire = performance.now();
      while (performance.now() - wFire < 3000 && cs.gameTime.now() - gFire < 0.4) await frame();
      cs.game.shooting = false;
      const rounds = magBefore - cs.weapon.mag;
      if (rounds === 0) return { fail: 'the player never fired: no gunshot to hear' };
      const shotAt = { x: cs.player.pos.x, z: cs.player.pos.z };

      // 2.5 s is deliberately short of the ~8 s it would take the T to round
      // the wall's west end, so "never graded shootable" is a claim about
      // hearing rather than about the bot not having arrived yet — and the
      // player stays ALIVE and a candidate throughout, so a leak in the wall
      // would show up as sight rather than passing quietly.
      let sawGoal = false, goalAfterS = null, graded = false;
      const startDist = planar(t.mesh.position, shotAt.x, shotAt.z);
      let bestDist = startDist;
      const allyModes = {}; let allyNearGoal = false;
      const gObs = cs.gameTime.now();
      const wObs = performance.now();
      while (performance.now() - wObs < 20000 && cs.gameTime.now() - gObs < 2.5) {
        await frame();
        if (t.targetInRange || t.targetLOS === true) graded = true;
        if (t.targetEye && (t.mode === 'route' || t.mode === 'search')
            && planar(t.targetEye, shotAt.x, shotAt.z) < 1.5) {
          if (!sawGoal) { sawGoal = true; goalAfterS = cs.gameTime.now() - gObs; }
        }
        bestDist = Math.min(bestDist, planar(t.mesh.position, shotAt.x, shotAt.z));
        // The ally is PINNED: a patrolling CT wanders, and a CT that wanders
        // into the T's line of sight turns this phase into a fight between
        // the two bots. Its claim needs it to hear the shot, not to walk.
        ct.mesh.position.set(ALLY[0], 0, ALLY[1]);
        ct.vy = 0;
        allyModes[ct.mode] = (allyModes[ct.mode] ?? 0) + 1;
        if (ct.targetEye && planar(ct.targetEye, shotAt.x, shotAt.z) < 6) allyNearGoal = true;
        if (cs.game.matchOver) return { fail: 'match ended during the gunshot phase' };
      }
      const closed = +(startDist - bestDist).toFixed(2);
      const shot = {
        rounds, sawGoal, graded, closed,
        goalAfterS: goalAfterS === null ? null : +goalAfterS.toFixed(2),
        mode: t.mode,
        inRange: t.targetInRange,
        los: t.targetLOS,
        playerHpLost: 100000 - cs.player.hp,
        allyModes, allyNearGoal,
      };
      if (!shot.sawGoal) return { fail: 'the T never pointed its intent at the gunshot it heard', shot };
      if (shot.graded) return { fail: 'a heard gunshot graded a shootable target', shot };
      if (shot.playerHpLost !== 0) return { fail: 'the bot fired on a position it had only heard', shot };
      if (shot.closed < 1) return { fail: 'the T never moved toward the noise', shot };
      if (shot.allyNearGoal) return { fail: 'the CT investigated an ALLIED gunshot', shot };
      if (Object.keys(allyModes).some(m => m !== 'hold' && m !== 'patrol')) {
        return { fail: 'the CT left hold/patrol over an allied gunshot', shot };
      }

      // ---- 3) footsteps ----------------------------------------------------
      // The ally has made its point and is now only a distraction: a live CT
      // is an ENEMY of the T under test, and one seen across the map would
      // put it in engage for reasons that have nothing to do with hearing.
      // Retired directly rather than through die(), which would schedule a
      // respawn six seconds later — inside the windows below.
      ct.alive = false;
      ct.mesh.visible = false;
      place(t, BOT);
      cs.player.pos.set(WALKER[0], 1.7, WALKER[1]);
      cs.player.vel.set(0, 0, 0);
      cs.game.yaw = Math.PI / 2;  // forward = -x: west, parallel to the wall
      cs.game.running = true;
      cs.game.crouching = false;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
      const runFrom = { x: cs.player.pos.x, z: cs.player.pos.z };
      let stepSaw = false, stepGraded = false;
      const gRun = cs.gameTime.now();
      const wRun = performance.now();
      while (performance.now() - wRun < 20000 && cs.gameTime.now() - gRun < 2.5) {
        await frame();
        // With the CT retired and the player behind the wall, the T has no
      // candidate it can see at all: any grading here would be a leak.
      if (t.targetInRange || t.targetLOS === true) stepGraded = true;
        if (t.targetEye && (t.mode === 'route' || t.mode === 'search')
            && planar(t.targetEye, cs.player.pos.x, cs.player.pos.z) < 5) stepSaw = true;
        if (cs.game.matchOver) return { fail: 'match ended during the footstep phase' };
      }
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
      cs.game.running = false;
      const ran = {
        moved: +planar(cs.player.pos, runFrom.x, runFrom.z).toFixed(2),
        heard: stepSaw,
        graded: stepGraded,
        mode: t.mode,
        dist: +planar(t.mesh.position, cs.player.pos.x, cs.player.pos.z).toFixed(1),
      };
      // Non-vacuity first: a player who never moved emits nothing, and every
      // claim below would pass for the wrong reason.
      if (ran.moved < 5) return { fail: 'the running player barely moved: no footsteps to hear', ran };
      if (ran.dist > 24) return { fail: 'the run left the 24 m running radius; the setup, not the bot, failed', ran };
      if (!ran.heard) return { fail: 'running footsteps through the wall were never investigated', ran };
      if (ran.graded) return { fail: 'a heard footstep graded a shootable target', ran };

      // ---- 4) the same path, crouched, is silent ---------------------------
      place(t, CREEP_BOT);
      cs.player.pos.set(CREEPER[0], 1.7, CREEPER[1]);
      cs.player.vel.set(0, 0, 0);
      cs.game.crouching = true;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
      const creepFrom = { x: cs.player.pos.x, z: cs.player.pos.z };
      let creepLos = false;
      const creepModes = {};
      const gCreep = cs.gameTime.now();
      const wCreep = performance.now();
      while (performance.now() - wCreep < 25000 && cs.gameTime.now() - gCreep < 3) {
        await frame();
        // Pinned every frame, because an UNPINNED bot patrols: a patrol leg
        // that happens to round the wall's west end acquires the player by
        // SIGHT, and the run then measures the fixture rather than the
        // silence. Holding it still costs the phase nothing — its claim is
        // about what the bot learns, not where it walks.
        t.mesh.position.set(CREEP_BOT[0], 0, CREEP_BOT[1]);
        t.vy = 0;
        creepModes[t.mode] = (creepModes[t.mode] ?? 0) + 1;
        if (t.targetLOS === true) creepLos = true;
        if (cs.game.matchOver) return { fail: 'match ended during the crouch phase' };
      }
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
      cs.game.crouching = false;
      const crept = {
        moved: +planar(cs.player.pos, creepFrom.x, creepFrom.z).toFixed(2),
        modes: creepModes,
        sawPlayer: creepLos,
        dist: +planar(t.mesh.position, cs.player.pos.x, cs.player.pos.z).toFixed(1),
      };
      // Two non-vacuity guards before the claim: a player who never moved
      // emits nothing, and one outside the WALKING radius would have been
      // inaudible even at a walk.
      if (crept.moved < 3) return { fail: 'the crouching player barely moved: silence proves nothing', crept };
      if (crept.dist > 12) return { fail: 'the crouch walk left the 12 m walking radius; silence proves nothing', crept };
      if (crept.sawPlayer) return { fail: 'the crouch fixture leaked line of sight', crept };
      // With no visual, no damage and a freshly respawned brain, route and
      // search are reachable ONLY from a heard position — patrol and its
      // one-second pause report `patrol`/`hold` and nothing else. So the mode
      // set alone carries the claim, with no endpoint arithmetic to argue with.
      const heardCrouch = Object.keys(crept.modes).filter(m => m !== 'hold' && m !== 'patrol');
      if (heardCrouch.length > 0) return { fail: `a crouched player was heard (modes ${heardCrouch.join(',')})`, crept };

      return { shot, ran, crept };
    });
    if (result.fail) throw new Error(`${result.fail} (${JSON.stringify(result)})`);
    console.log('[hearing] OK', JSON.stringify(result));
  } catch (e) {
    failures++;
    console.log(`[hearing] FAIL: ${e.message}`);
  }
  errors.push(...mapErrors.map(e => `[hearing] ${e}`));
  await page.close();
}

async function runBotClimbCheck() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const mapErrors = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') mapErrors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => mapErrors.push('PAGEERROR: ' + e.message));

  try {
    await page.goto(BASE + '/?map=elevation&tbots=1&ctbots=0&tweap=smg', { waitUntil: 'networkidle0', timeout: 20000 });
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
    await page.goto(BASE + '/?map=elevation&tbots=1&ctbots=0&tweap=smg', { waitUntil: 'networkidle0', timeout: 20000 });
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
//
// And the bot readout (hud.ts's #botDebug) riding the same flag: hidden until
// the first press, shown with text while up, hidden again after — and shown
// AGAIN on re-press, which pins the inactive path clearing hud.ts's string
// cache (an unchanged string must rewrite, not early-return against a hidden
// element).
//
// The overlay is a NON-INFLUENCING consumer of gameplay perception: it reads
// the already-computed result and controls neither its cost nor its timing.
// So instead of the pre-6a probe-count census (which assumed the raycast was
// gated on session.debugView), the phase captures the bot's gameplay-
// perception state — mode, targetLOS, targetInRange, intent endpoint —
// before, while on, after off, and after re-toggle, and asserts the bot
// stays visibly engaged and shootable across all four samples. Toggling the
// presentation must neither enable nor disable acquisition nor mutate its
// gates.
async function runDebugViewCheck() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const mapErrors = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') mapErrors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => mapErrors.push('PAGEERROR: ' + e.message));

  try {
    await page.goto(BASE + '/?map=elevation&tbots=1&ctbots=0&tweap=smg', { waitUntil: 'networkidle0', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1200));
    const result = await page.evaluate(async () => {
      const cs = window.__cs;
      cs.game.started = true;
      cs.game.locked = true;
      cs.player.hp = 100000;
      const frames = async n => { for (let i = 0; i < n; i++) await new Promise(r => requestAnimationFrame(r)); };
      // One T bot, no CTs: unrelated bot fights would make the perception
      // census noisy. North open ground on the elevation map: the two-story
      // building spans z [-12, 12], so both spots below sit clear of it.
      const blocked = (x, z) => cs.colliders.some(c =>
        x > c.min.x - 0.7 && x < c.max.x + 0.7 && z > c.min.z - 0.7 && z < c.max.z + 0.7);
      const BOT_SPOT = [0, 35], PLAYER_EYE = [0, 48];
      if (blocked(...BOT_SPOT) || blocked(...PLAYER_EYE)) {
        return { fail: `debug-view spot inside geometry: bot ${JSON.stringify(BOT_SPOT)}, player ${JSON.stringify(PLAYER_EYE)}` };
      }
      const bot = cs.bots.find(b => b.team === 'T' && b.alive);
      if (!bot) return { fail: 'no live T bot' };
      bot.mesh.position.set(BOT_SPOT[0], 0, BOT_SPOT[1]);
      bot.vy = 0;
      bot.onGround = true;
      bot.path = [];
      bot.leg = 0;
      cs.player.pos.set(PLAYER_EYE[0], 1.7, PLAYER_EYE[1]);
      cs.player.vel.set(0, 0, 0);
      // The T faces +z, straight at the player 13 m away in the open — the
      // acquisition must exist BEFORE any V press, on gameplay perception
      // alone (the overlay reads that result; it never creates it).
      let seen = false;
      const tSee = performance.now();
      while (performance.now() - tSee < 8000) {
        await frames(1);
        if (bot.targetLOS === true) { seen = true; break; }
      }
      if (!seen) {
        return {
          fail: 'bot never acquired the player before any V press',
          los: bot.targetLOS,
          mode: bot.mode,
        };
      }
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
      // hud.ts:updateBotDebug rides session.debugView, so the same keypresses
      // drive the text block. Text is only asserted non-empty — bots may die
      // mid-check and append " dead", which is fine.
      const readoutState = () => {
        const el = document.getElementById('botDebug');
        return el && { shown: getComputedStyle(el).display !== 'none', text: el.textContent };
      };
      // Gameplay-perception census: what the bot knows, independent of the
      // overlay's visibility. No probe counts, no debug-only raycast claims.
      const census = () => ({
        mode: bot.mode,
        los: bot.targetLOS,
        inRange: bot.targetInRange,
        endpoint: bot.targetEye !== null,
      });
      const before = wireframeCount();
      const roBefore = readoutState();
      const censusBefore = census();
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV' }));
      await frames(30);
      const on = wireframeCount();
      const roOn = readoutState();
      const censusOn = census();
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV' }));
      await frames(10);
      const off = wireframeCount();
      const roOff = readoutState();
      const censusOff = census();
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV' }));
      await frames(10);
      const roBackOn = readoutState();
      const censusBackOn = census();
      return { before, on, off, roBefore, roOn, roOff, roBackOn,
               censusBefore, censusOn, censusOff, censusBackOn };
    });
    if (result.fail) throw new Error(`${result.fail} (${JSON.stringify(result)})`);
    if (result.before === -1) throw new Error('no bot mesh to reach the scene through');
    if (result.before !== 0) throw new Error(`level geometry was already wireframed before the toggle: ${JSON.stringify(result)}`);
    if (result.on === 0) throw new Error(`toggling the debug view wireframed nothing — the x-ray is not wired: ${JSON.stringify(result)}`);
    if (result.off !== 0) throw new Error(`toggling the debug view off left ${result.off} materials wireframed: ${JSON.stringify(result)}`);
    for (const [label, census] of [['before', result.censusBefore], ['on', result.censusOn], ['off', result.censusOff], ['re-toggle', result.censusBackOn]]) {
      if (!census || census.mode !== 'engage' || census.los !== true || !census.inRange || !census.endpoint) {
        throw new Error(`debug-view toggling changed gameplay perception at "${label}" — the overlay must not enable or disable acquisition: ${JSON.stringify({ ...result, label })}`);
      }
    }
    if (!result.roBefore || result.roBefore.shown) throw new Error(`bot readout was visible before any V press: ${JSON.stringify(result)}`);
    if (!result.roOn || !result.roOn.shown || result.roOn.text === '') throw new Error(`bot readout did not show with text while the debug view was up: ${JSON.stringify(result)}`);
    if (!result.roOff || result.roOff.shown) throw new Error(`bot readout stayed visible after the debug view went down: ${JSON.stringify(result)}`);
    if (!result.roBackOn || !result.roBackOn.shown) throw new Error(`bot readout stayed hidden on re-toggle — the inactive path must clear hud.ts's string cache: ${JSON.stringify(result)}`);
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
      const frame = () => new Promise(r => requestAnimationFrame(r));
      const waitForShell = async fromMag => {
        const deadline = performance.now() + 8000;
        while (cs.weapon.reloading && cs.weapon.mag === fromMag
               && performance.now() < deadline) await frame();
      };
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
      await frame();
      cs.game.pitch = -1.4;
      cs.weapon.lastShot = -9; // the fire-rate gate must not eat the fresh deploy's first shell
      const holesBefore = cs.bulletHoles.length;
      const magBefore = cs.weapon.mag;
      window.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
      await new Promise(r => setTimeout(r, 300));
      window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
      const magAfterFirstShot = cs.weapon.mag;
      const holesAfterFirstShot = cs.bulletHoles.length;
      // Per-round reload: start R two shells down, poll until a shell lands,
      // then fire mid-reload — the shot must cancel the rest and go out.
      cs.weapon.mag = 2;
      const reserveBefore = cs.weapon.reserve;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR' }));
      await waitForShell(2);
      const mid = {
        mag: cs.weapon.mag,
        reserve: cs.weapon.reserve,
        reloading: cs.weapon.reloading,
      };
      window.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
      await new Promise(r => setTimeout(r, 300));
      window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
      const shotMag = cs.weapon.mag;
      const shotCancelledReload = !cs.weapon.reloading;

      // Start another per-round reload, allow shells to transfer, then begin
      // sprinting. The reload must stop and keep every landed shell.
      cs.weapon.mag = 2;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR' }));
      await waitForShell(2);
      const beforeSprintCancel = { mag: cs.weapon.mag, reloading: cs.weapon.reloading };
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
      await frame();
      const afterSprintCancel = { mag: cs.weapon.mag, reloading: cs.weapon.reloading };
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft' }));
      return {
        primary: cs.game.primary,
        secondary: cs.game.secondary,
        name: cs.weapon.name,
        fired: magAfterFirstShot === magBefore - 1,
        newHoles: holesAfterFirstShot - holesBefore,
        reloadMid: mid,
        loaded: mid.mag - 2,
        reserveUntouched: mid.reserve === reserveBefore, // range mode never drains the reserve
        shotMag,
        shotCancelledReload,
        beforeSprintCancel,
        afterSprintCancel,
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
    if (!result.beforeSprintCancel.reloading || result.beforeSprintCancel.mag <= 2) throw new Error(`per-round control did not load shells before sprint: ${JSON.stringify(result)}`);
    if (result.afterSprintCancel.reloading || result.afterSprintCancel.mag !== result.beforeSprintCancel.mag) throw new Error(`sprint did not preserve landed shells while cancelling reload: ${JSON.stringify(result)}`);
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
// ABSENCE of a knife card in the picker, and the damage model E2E: a FRONT
// strike at a teleported bot deals ordinary 55 (alive at 45), then a
// BACKSTAB — the bot rotated directly away — one-shots it from restored
// full HP through the x3 multiplier. Neither swing may touch ammo.
// Swapping back to a firearm must re-reveal the readout with FRESH numbers.
async function runKnifeCheck() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const mapErrors = [];
  page.on('pageerror', e => mapErrors.push('PAGEERROR: ' + e.message));
  try {
    await page.goto(BASE + '/?map=arena&tbots=1&ctbots=0&tweap=smg', { waitUntil: 'networkidle0', timeout: 20000 });
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

      // The damage model: a FRONT strike, then a BACKSTAB — which also pins
      // the x3 backstab multiplier E2E (issue #37). The bot is placed 1.4 m
      // ahead (inside the arc, out of the old head-premium range). Headless
      // frames advance game time slower than wall time (the sim's dt clamp),
      // so fixed sleeps under-run the 0.45 s cadence gate: the gate is
      // forced open before every trigger instead of waiting it out.
      cs.player.hp = 100000; // the bot shoots back; the swings are what matter
      const bot = cs.bots.find(b => b.team === 'T' && b.alive);
      if (!bot) return { fail: 'no live T bot' };
      cs.game.yaw = 0; // forward is -z, straight at the bot
      cs.game.pitch = 0; // torso sits inside the arc from here
      const pin = () => bot.mesh.position.set(cs.player.pos.x, 0, cs.player.pos.z - 1.4);
      const swingOnce = async () => {
        pin();
        cs.weapon.lastShot = -9; // the cadence gate must not eat a fresh swing
        window.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
        await new Promise(r => setTimeout(r, 120));
        window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
        await new Promise(r => setTimeout(r, 180));
      };
      // Strike 1 — FRONT: the player stands on the bot's +Z side (the bot
      // is at player z − 1.4), so yaw 0 points the bot's local +Z at the
      // player. Ordinary zone damage only: 100 − 55 = 45, alive.
      bot.mesh.rotation.y = 0;
      await swingOnce();
      const frontSwingHp = bot.hp;
      // Strike 2 — BACKSTAB: restore HP, keep the same strike point, and
      // rotate local +Z directly away from the player IMMEDIATELY before
      // the trigger — updateWeapon runs before updateBots (which would
      // otherwise re-face the bot every frame), so the swing observes that
      // yaw. 55 x 3 = 165: a full-health bot dies in one swing.
      bot.hp = 100;
      bot.mesh.rotation.y = Math.PI;
      await swingOnce();
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
        frontSwingHp,
        backstabKilled: !bot.alive,
        // Head/torso depends on which part took the killing swing, and the
        // respawn banner may prepend above either (one bot = an instant
        // wave reset) — so match anywhere in the feed.
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
    // Front strike: ordinary 55 damage, NO backstab premium — alive at
    // exactly 45. Lower means the multiplier leaked into front hits; higher
    // means damage regressed.
    if (result.frontSwingHp !== 45) throw new Error(`front swing must leave the bot alive at 45 hp, got ${result.frontSwingHp}`);
    if (!result.backstabKilled) throw new Error(`the backstab did not kill from restored full hp (front swing left ${result.frontSwingHp})`);
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

// Match end: BOTH win conditions must reach the score screen, with correct
// winner, counters and buttons. Runs twice on the arena — once per condition:
//
//   elimination — wipe the Ts via Bot.die (the same entry point bullets use),
//                 which must credit the PLAYER personally (killerName omitted)
//                 AND the CT team, end the match outright, and reveal the
//                 screen on endMatch's 600 ms wall-clock beat;
//   clock       — force roundTime to ~one frame with the T side ahead, which
//                 must freeze the readout at 0:00 and award the higher score.
//
// Pointer lock is faked (started/locked flags), as everywhere above — the
// browser never fires pointerlockchange here, so endMatch's exitPointerLock
// is a no-op and the pause-menu-suppression branch stays un-exercisable E2E.
async function runMatchEndCheck() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const mapErrors = [];
  page.on('pageerror', e => mapErrors.push('PAGEERROR: ' + e.message));
  try {
    // ---- Elimination: CT wins outright when the wave is wiped ----
    await page.goto(BASE + '/?map=arena&tbots=3&ctbots=0&time=30&tweap=smg', { waitUntil: 'networkidle0', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1200));
    await page.evaluate(() => {
      window.__cs.game.started = true;
      window.__cs.game.locked = true;
    });
    await page.evaluate(() => {
      for (const b of window.__cs.bots.filter(b => b.team === 'T')) b.die('torso');
    });
    await new Promise(r => setTimeout(r, 1000)); // endMatch's reveal beat is 600 ms wall time
    const elim = await page.evaluate(() => {
      const g = window.__cs.game;
      const rows = [...document.querySelectorAll('#scoreboardBody tr')];
      return {
        matchOver: g.matchOver,
        screenShown: document.getElementById('endScreen').style.display === 'flex',
        banner: document.getElementById('endTitle').textContent,
        bannerCtClass: document.getElementById('endTitle').classList.contains('ct'),
        feedElimLine: /All Ts eliminated/.test(document.getElementById('killfeed').textContent),
        rowCount: rows.length,
        youRow: rows.find(r => r.className.includes('you'))?.children[0].textContent ?? null,
        youKills: rows.find(r => r.className.includes('you'))?.children[1].textContent ?? null,
        teamCT: document.getElementById('endScoreCT').textContent,
        playerKillsState: g.playerKills,
      };
    });
    if (!elim.matchOver || !elim.screenShown) throw new Error(`elimination did not reach the score screen: ${JSON.stringify(elim)}`);
    if (elim.banner !== 'Counter-Terrorists Win' || !elim.bannerCtClass) throw new Error(`wrong winner banner: ${JSON.stringify(elim)}`);
    if (!elim.feedElimLine) throw new Error('killfeed missing the elimination line');
    if (elim.rowCount !== 4) throw new Error(`scoreboard should have You + 3 bots = 4 rows, got ${elim.rowCount}`);
    if (elim.youRow !== 'You' || elim.youKills !== '3' || elim.playerKillsState !== 3) {
      throw new Error(`player attribution wrong: ${JSON.stringify(elim)}`);
    }
    if (elim.teamCT !== 'CT 3') throw new Error(`team score wrong: ${elim.teamCT}`);

    // Rematch: reload with the SAME query, state back to fresh.
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 20000 }),
      page.click('#rematchBtn'),
    ]);
    await new Promise(r => setTimeout(r, 800));
    const rematch = await page.evaluate(() => ({
      matchOver: window.__cs.game.matchOver,
      hidden: document.getElementById('endScreen').style.display !== 'flex',
      urlTime: /[?&]time=30/.test(location.search),
    }));
    if (rematch.matchOver !== false) throw new Error(`rematch kept matchOver=true: ${JSON.stringify(rematch)}`);
    if (!rematch.hidden) throw new Error('end screen visible after rematch reload');
    if (!rematch.urlTime) throw new Error(`rematch lost the config query: ${location.search}`);

    // ---- Clock expiry: higher score wins, readout freezes at 0:00 ----
    await page.goto(BASE + '/?map=arena&tbots=2&ctbots=0&time=30&tweap=smg', { waitUntil: 'networkidle0', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1200));
    await page.evaluate(() => {
      const g = window.__cs.game;
      g.started = true;
      g.locked = true;
      g.scoreKills = 1;   // T side ahead: expiry must crown the Ts...
      g.scoreDeaths = 4;
      g.roundTime = 0.05; // ...about one simulated frame later
    });
    await new Promise(r => setTimeout(r, 1000));
    const clock = await page.evaluate(() => {
      const g = window.__cs.game;
      return {
        matchOver: g.matchOver,
        screenShown: document.getElementById('endScreen').style.display === 'flex',
        banner: document.getElementById('endTitle').textContent,
        bannerTClass: document.getElementById('endTitle').classList.contains('t'),
        timer: document.getElementById('timer').textContent,
        scoreCT: document.getElementById('endScoreCT').textContent,
        scoreT: document.getElementById('endScoreT').textContent,
      };
    });
    if (!clock.matchOver || !clock.screenShown) throw new Error(`clock expiry did not reach the score screen: ${JSON.stringify(clock)}`);
    if (clock.banner !== 'Terrorists Win' || !clock.bannerTClass) throw new Error(`expiry picked wrong winner: ${JSON.stringify(clock)}`);
    if (clock.timer !== '0:00') throw new Error(`timer did not freeze at 0:00: "${clock.timer}"`);
    if (clock.scoreCT !== 'CT 1' || clock.scoreT !== '4 T') throw new Error(`final score line wrong: ${JSON.stringify(clock)}`);
    console.log('[matchend] OK', JSON.stringify({ elim, clock }));
  } catch (e) {
    failures++;
    console.log(`[matchend] FAIL: ${e.message}`);
  }
  errors.push(...mapErrors.map(e => `[matchend] ${e}`));
  await page.close();
}

// Idle patrol and the mobile damage search (the 6a follow-up), end to end.
//
// The pure suite pins the brain/selector seams; this phase owns the WIRING
// through the real frame loop, staged on the arena's only clear ~90 m
// sightline — the x = 12 lane through the mid-wall gap (x ∈ (2.5, 15)):
//
//   A. unaware patrol: the player is a non-candidate, so a lone T bot holds
//      through its one-second stand-down, then patrols — travelling
//      materially, never grading a shootable target — and respawn()
//      restarts the cycle from hold.
//   B. damage advance from beyond the 80 m perception range: a real SMG hit
//      from 93 m starts a bearing search whose first seconds ADVANCE along
//      the incoming bearing while the scan headings keep turning. The bot
//      stays blind (range-gated) and never retaliates while hidden.
//   C. closing the distance: the player steps down the same bearing to ~60 m
//      and the bot acquires through the ordinary perception path — the
//      player's HP must be untouched up to that frame.
//
// The long shot is real SMG fire, so the punch-steered aim is kept honest
// with SHORT bursts: each burst's first rounds leave recoil nearly at rest,
// and standing fire's only spread is the weapon's inherent cone.
async function runPatrolCheck() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const mapErrors = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') mapErrors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => mapErrors.push('PAGEERROR: ' + e.message));
  try {
    await page.goto(BASE + '/?map=arena&tbots=1&ctbots=0&time=120&tweap=smg', { waitUntil: 'networkidle0', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1200));
    const result = await page.evaluate(async () => {
      const cs = window.__cs;
      const frame = () => new Promise(r => requestAnimationFrame(r));
      const blocked = (x, z) => cs.colliders.some(c =>
        x > c.min.x - 0.7 && x < c.max.x + 0.7 && z > c.min.z - 0.7 && z < c.max.z + 0.7);
      const clearLine = (a, b) => {
        for (let t = 0; t <= 1; t += 0.02) {
          const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
          if (cs.colliders.some(c =>
            x > c.min.x && x < c.max.x && z > c.min.z && z < c.max.z
            && c.max.y > 1.6 && c.min.y < 2)) return false;
        }
        return true;
      };
      const BOT_A = [-20, -25];      // scenario A: open south ground
      const BOT_B = [12, -45];       // scenario B: south end of the x=12 gap lane
      const PLAYER_FAR = [12, 48];   // ~93 m from BOT_B, clear LOS through the gap
      for (const [label, [x, z]] of [['patrol bot', BOT_A], ['hit bot', BOT_B], ['far player', PLAYER_FAR]]) {
        if (blocked(x, z)) return { fail: `${label} spot (${x}, ${z}) is inside geometry` };
      }
      if (!clearLine(BOT_B, PLAYER_FAR)) {
        return { fail: 'the 93 m firing line is not clear — the staging depends on it' };
      }
      cs.game.started = true;
      cs.game.locked = true;
      const simA0 = cs.gameTime.now();

      // A. Unaware patrol: no candidates at all.
      cs.player.alive = false;
      const bot = cs.bots.find(b => b.team === 'T' && b.alive);
      if (!bot || cs.bots.length !== 1) return { fail: `expected exactly one live T bot, got ${cs.bots.length}` };
      bot.mesh.position.set(BOT_A[0], 0, BOT_A[1]);
      bot.vy = 0;
      bot.onGround = true;
      bot.path = [];
      bot.leg = 0;
      let firstMode = null, sawPatrol = false, patrolAt = null, patrolDrift = 0, gradesOk = true;
      let anchor = null;
      // Budget, measured rather than guessed. A patrol candidate is drawn
      // uniformly from the WHOLE nav graph, and on arena 3663 of 16155 nodes
      // sit at y >= 3 — the tops of the walls and blocks (968 at y=8, 576 at
      // y=10, 400 at y=12). A ground bot cannot route to those, so ~28% of
      // candidates are rejected (300 sampled selections from this very spot:
      // 27% on main, 31% here — the same population), and EACH rejection
      // costs a fresh one-second patrolPause before the next draw.
      //
      // So "an idle bot patrols" is the invariant; "within one second" is a
      // property of the selector's luck, and the old 5 s / 25 s budget was
      // tight enough that a slow machine or an unlucky draw failed a phase
      // with nothing wrong (which is the load-sensitive flake docs/ai-plan.md
      // already recorded once and left alone). The wall clock is the give-up
      // bound only — lesson 26.
      const tA = performance.now();
      while (performance.now() - tA < 60000 && cs.gameTime.now() - simA0 < 8) {
        await frame();
        if (firstMode === null) firstMode = bot.mode;
        if (bot.mode === 'patrol') {
          if (!sawPatrol) { sawPatrol = true; patrolAt = cs.gameTime.now() - simA0; anchor = bot.mesh.position.clone(); }
          patrolDrift = Math.max(patrolDrift, bot.mesh.position.distanceTo(anchor));
        } else if (bot.mode !== 'hold') {
          return { fail: `unaware bot left hold/patrol (mode ${bot.mode})`, firstMode };
        }
        if (bot.targetInRange || bot.targetLOS === true) gradesOk = false;
        if (cs.game.matchOver) return { fail: 'match ended while patrolling' };
      }
      const patrol = {
        firstMode,
        sawPatrol,
        patrolAfterS: patrolAt === null ? null : +patrolAt.toFixed(2),
        patrolDrift: +patrolDrift.toFixed(2),
        gradesOk,
      };
      if (firstMode !== 'hold') return { fail: 'the unaware bot did not begin in the patrol pause (hold)', patrol };
      if (patrolAt === null) return { fail: 'the unaware bot never began patrolling', patrol };
      if (patrolAt < 0.85) return { fail: 'patrol began before the one-second pause elapsed', patrol };
      if (patrol.patrolDrift < 3) return { fail: 'patrol never travelled materially', patrol };
      if (!gradesOk) return { fail: 'patrol graded a shootable target', patrol };

      // Respawn drops the patrol state: back to hold, and a fresh pause
      // before a fresh leg.
      const respawnT = cs.gameTime.now();
      bot.respawn();
      bot.mesh.position.set(BOT_A[0], 0, BOT_A[1]);
      bot.vy = 0;
      bot.onGround = true;
      if (bot.mode !== 'hold') return { fail: 'respawn did not restore hold', mode: bot.mode };
      let rePatrol = null;
      const tR = performance.now();
      while (performance.now() - tR < 15000 && cs.gameTime.now() - respawnT < 4) {
        await frame();
        if (bot.mode === 'patrol') { rePatrol = cs.gameTime.now() - respawnT; break; }
        if (bot.mode !== 'hold') return { fail: 'respawned bot left hold unexpectedly', mode: bot.mode };
      }
      const respawn = { mode: bot.mode, rePatrolAfterS: rePatrol === null ? null : +rePatrol.toFixed(2) };
      if (rePatrol === null) return { fail: 'respawned bot never re-entered patrol', mode: bot.mode, respawn };
      if (rePatrol < 0.85) return { fail: 'respawn did not re-arm the patrol pause', respawn: { rePatrolAfterS: +rePatrol.toFixed(2) } };

      // B. A real SMG hit from beyond the 80 m perception range.
      cs.player.alive = true;
      cs.player.hp = 100000;
      cs.player.pos.set(PLAYER_FAR[0], 1.7, PLAYER_FAR[1]);
      cs.player.vel.set(0, 0, 0);
      cs.game.yaw = 0;   // forward is -z: down the x=12 gap lane, at the bot
      cs.game.pitch = 0;
      bot.respawn();     // fresh brain; then pin it at the lane's south end
      bot.mesh.position.set(BOT_B[0], 0, BOT_B[1]);
      bot.vy = 0;
      bot.onGround = true;
      bot.path = [];
      bot.leg = 0;
      const dist0 = cs.player.pos.distanceTo(bot.eyePos());
      if (dist0 <= 80) return { fail: `staging distance ${dist0} is not beyond the 80 m perception range` };
      cs.weapon.mag = 30;
      cs.weapon.lastShot = -9;
      const botHp0 = bot.hp;
      const tB = performance.now();
      while (performance.now() - tB < 20000 && bot.hp >= botHp0) {
        bot.mesh.position.set(BOT_B[0], 0, BOT_B[1]); // pin: patrol must not drag it off the firing line
        bot.vy = 0;
        bot.onGround = true;
        cs.game.shooting = true;
        const tBurst = performance.now();
        while (performance.now() - tBurst < 150 && bot.hp >= botHp0) {
          await frame();
          bot.mesh.position.set(BOT_B[0], 0, BOT_B[1]);
          bot.vy = 0;
        }
        cs.game.shooting = false;
        while (performance.now() - tBurst < 350) await frame();
      }
      cs.game.shooting = false;
      // The hit frame's decision has already run: it must be a bearing
      // search facing the victim-to-player bearing (+z), with no grades.
      const bear = { x: cs.player.pos.x - bot.mesh.position.x, z: cs.player.pos.z - bot.mesh.position.z };
      const bl = Math.hypot(bear.x, bear.z);
      bear.x /= bl; bear.z /= bl;
      const bfx = Math.sin(bot.mesh.rotation.y), bzf = Math.cos(bot.mesh.rotation.y);
      const bodyDot = bfx * bear.x + bzf * bear.z;
      const hitState = { dist: +dist0.toFixed(1), mode: bot.mode, bodyDot: +bodyDot.toFixed(3), botHp: bot.hp };
      if (bot.hp >= botHp0) return { fail: 'the SMG burst never landed at 93 m', hitState };
      if (hitState.mode !== 'search') return { fail: `the hit did not start a bearing search (mode ${hitState.mode})`, hitState };
      if (bodyDot < 0.99) return { fail: 'the damage frame did not face the incoming bearing', hitState };
      if (bot.targetLOS === true || bot.targetInRange) return { fail: 'a blind hit graded a shootable target', hitState };

      // The advance: normal-speed travel along the bearing while still
      // hidden, zero retaliation. Closing below the 80 m perception range
      // mid-advance is legitimate — ordinary perception takes over.
      const advStartZ = bot.mesh.position.z;
      let acquired = false, retaliated = false;
      const advT0 = cs.gameTime.now();
      const tAdv = performance.now();
      while (performance.now() - tAdv < 15000 && cs.gameTime.now() - advT0 < 3.0) {
        await frame();
        if (bot.targetLOS === true) { acquired = true; break; }
        if (bot.mode !== 'search') break;
        if (cs.player.hp < 100000) { retaliated = true; break; }
      }
      const advanceDz = bot.mesh.position.z - advStartZ;
      const advance = { acquired, advanceDz: +advanceDz.toFixed(2), retaliated, mode: bot.mode };
      if (retaliated) return { fail: 'the bot retaliated while still blind', advance };
      if (bot.targetLOS !== true && (bot.mode !== 'search' || advanceDz < 3)) {
        return { fail: 'the damage search did not advance materially along the bearing while hidden', advance };
      }
      if (bot.targetLOS !== true && cs.player.hp !== 100000) {
        return { fail: 'the bot retaliated before visual acquisition', advance };
      }

      // C. Closing the distance: the player steps down the same bearing to
      //    ~60 m; ordinary perception must acquire without any further hit.
      if (!acquired) {
        const closeSpot = [bot.mesh.position.x, bot.mesh.position.z + 60];
        if (blocked(closeSpot[0], closeSpot[1])) return { fail: 'the close-player spot is inside geometry', advance };
        cs.player.pos.set(closeSpot[0], 1.7, closeSpot[1]);
        cs.player.vel.set(0, 0, 0);
        const tD = performance.now();
        while (performance.now() - tD < 15000) {
          await frame();
          if (cs.player.hp < 100000 && bot.targetLOS !== true) return { fail: 'the bot fired before visual acquisition', advance };
          if (bot.targetLOS === true) { acquired = true; break; }
          if (cs.game.matchOver) return { fail: 'match ended before acquisition', advance };
        }
      }
      if (!acquired) return { fail: 'the bot never acquired the player after closing distance', advance };
      return {
        patrol,
        hit: { dist: +dist0.toFixed(1), bodyDot: +bodyDot.toFixed(3), modeAfterHit: hitState.mode },
        advance: { dz: +advanceDz.toFixed(2), gained: advanceDz > 3, mode: bot.mode },
        acquiredBy: 'ordinary perception',
        finalMode: bot.mode,
        hpLostBeforeVisual: 100000 - cs.player.hp === 0 ? 0 : 'dropped',
      };
    });
    if (result.fail) throw new Error(`${result.fail} (${JSON.stringify(result)})`);
    if (result.finalMode !== 'engage' && result.finalMode !== 'route') {
      throw new Error(`acquisition did not engage (mode ${result.finalMode}): ${JSON.stringify(result)}`);
    }
    console.log('[patrol] OK', JSON.stringify(result));
  } catch (e) {
    failures++;
    console.log(`[patrol] FAIL: ${e.message}`);
  }
  errors.push(...mapErrors.map(e => `[patrol] ${e}`));
  await page.close();
}


// [botWeapons] — a bot's weapon is a real catalog weapon, end to end.
//
// Every claim here is the SAME fixture with a different weapon, so the weapon
// is the only variable that can explain the difference. Fixture hygiene per
// lesson 29: one bot on the field, its position re-pinned every frame, the
// player's HP topped up so it cannot die mid-measurement and freeze the sim
// by releasing pointer lock. Nothing else alive can produce these signals.
//
// What is asserted, and what is deliberately only RECORDED:
//   - Trigger pulls are read from the MAGAZINE, not from damage. A pull is
//     deterministic once the bot is in range; whether it lands is a die roll,
//     and asserting a hit inside a budget would flake against a bot behaving
//     correctly (lesson 28's shape — pin the invariant, not the luck).
//   - Damage VALUES are asserted as set membership, which is exact: a landed
//     smg round can only ever be 26 / 19.5 / 52 (torso / legs / head), and no
//     revolver value can be in that set. So "damage comes from the catalog"
//     is provable without requiring any particular number of hits.
async function runBotWeaponsCheck() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const mapErrors = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') mapErrors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => mapErrors.push('PAGEERROR: ' + e.message));
  const CATALOG = ['smg', 'sniper', 'shotgun', 'pistol', 'revolver', 'knife'];
  // Zone damage each weapon can deal, from WEAPONS: torso, legs (x0.75), head
  // (x headshotMult). A shotgun pull sums pellets, so it is excluded from the
  // membership claim and gets the range claim instead.
  const ZONES = {
    smg: [26, 19.5, 52],
    revolver: [55, 41.25, 220],
  };
  try {
    // ---- A. 'mixed' arms a varied field, and may include a blade bot.
    await page.goto(BASE + '/?map=arena&tbots=8&ctbots=0&time=120&tweap=mixed', { waitUntil: 'networkidle0', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1200));
    const mixed = await page.evaluate(() => {
      const cs = window.__cs;
      const before = cs.bots.map(b => b.weapon);
      // A weapon is drawn once per MATCH, not per life: respawn must not
      // re-roll it, or a killfeed line could name a weapon the bot no longer
      // carries.
      cs.bots.forEach(b => b.respawn());
      return { before, after: cs.bots.map(b => b.weapon), mags: cs.bots.map(b => `${b.mag}/${b.magSize}`) };
    });
    // A mixed wave may contain a blade bot (tranche 7b): membership is over
    // the whole catalog, not the firearms alone.
    const unknown = mixed.before.filter(w => !CATALOG.includes(w));
    if (unknown.length) throw new Error(`mixed drew an unknown weapon: ${JSON.stringify(mixed.before)}`);
    if (String(mixed.after) !== String(mixed.before)) {
      throw new Error(`respawn re-rolled weapons: ${JSON.stringify(mixed)}`);
    }
    // Membership only, never "two different weapons appeared": a uniform draw
    // legitimately returns eight of a kind (p ~ 1/78000) and the phase must
    // not fail a correct outcome. The spread is recorded below as information.
    const spread = [...new Set(mixed.before)].length;

    // ---- Shared combat fixture: one bot, one player, a clear arena lane.
    const combat = async (weapon, botZ, playerZ, simSeconds) => page.evaluate(
      async (weapon, botZ, playerZ, simSeconds) => {
        const cs = window.__cs;
        const frame = () => new Promise(r => requestAnimationFrame(r));
        const LANE_X = 12;
        const blocked = (x, z) => cs.colliders.some(c =>
          x > c.min.x - 0.7 && x < c.max.x + 0.7 && z > c.min.z - 0.7 && z < c.max.z + 0.7);
        if (blocked(LANE_X, botZ)) return { fail: `bot spot (${LANE_X}, ${botZ}) is inside geometry` };
        if (blocked(LANE_X, playerZ)) return { fail: `player spot (${LANE_X}, ${playerZ}) is inside geometry` };
        cs.game.started = true;
        cs.game.locked = true;
        if (cs.bots.length !== 1) return { fail: `expected exactly one bot, got ${cs.bots.length}` };
        const bot = cs.bots[0];
        if (bot.weapon !== weapon) return { fail: `expected a ${weapon} bot, got ${bot.weapon}` };
        cs.player.pos.set(LANE_X, cs.player.eyeHeight, playerZ);
        cs.player.alive = true;
        const magSize = bot.magSize;
        let sawReload = false, refilled = false, minMag = magSize;
        let seen = false, inRange = false, outOfRange = false;
        const deltas = new Set();
        const t0 = cs.gameTime.now();
        const wall = performance.now();
        while (performance.now() - wall < 90000 && cs.gameTime.now() - t0 < simSeconds) {
          // Pin the bot: its bands would otherwise walk it out of the range
          // the claim is about. Yaw at the player so it stays in the FOV cone.
          bot.mesh.position.set(LANE_X, 0, botZ);
          bot.vy = 0; bot.onGround = true;
          bot.mesh.rotation.y = 0; // faces +z, toward the player down the lane
          const hpBefore = cs.player.hp;
          await frame();
          const lost = +(hpBefore - cs.player.hp).toFixed(2);
          if (lost > 0) deltas.add(lost);
          cs.player.hp = 100000; // never dies: a death frees the pointer lock
          if (bot.targetLOS === true) seen = true;
          if (bot.targetInRange) inRange = true;
          else if (bot.targetLOS === true) outOfRange = true;
          if (bot.mag < minMag) minMag = bot.mag;
          if (bot.reloading) sawReload = true;
          if (sawReload && !bot.reloading && bot.mag > minMag) refilled = true;
        }
        return {
          weapon, magSize, minMag, sawReload, refilled, seen, inRange, outOfRange,
          deltas: [...deltas], mode: bot.mode,
          simS: +(cs.gameTime.now() - t0).toFixed(1),
        };
      }, weapon, botZ, playerZ, simSeconds);

    const load = async (weapon) => {
      await page.goto(BASE + `/?map=arena&tbots=1&ctbots=0&time=600&tweap=${weapon}`, { waitUntil: 'networkidle0', timeout: 20000 });
      await new Promise(r => setTimeout(r, 1200));
    };

    // ---- B. Reach: the same 60 m sight line, opposite outcomes.
    // The sniper's engageRange is 80 m and the shotgun's is 12, so this is
    // decided by the weapon alone and not by any die.
    await load('sniper');
    const sniper = await combat('sniper', -15, 45, 14);
    if (sniper.fail) throw new Error(sniper.fail);
    await load('shotgun');
    const shotgun = await combat('shotgun', -15, 45, 14);
    if (shotgun.fail) throw new Error(shotgun.fail);

    if (!sniper.seen || !sniper.inRange) {
      throw new Error(`sniper did not reach 60 m: ${JSON.stringify(sniper)}`);
    }
    if (sniper.minMag >= sniper.magSize) {
      throw new Error(`sniper never pulled the trigger at 60 m: ${JSON.stringify(sniper)}`);
    }
    if (!shotgun.seen) throw new Error(`shotgun bot never saw the player: ${JSON.stringify(shotgun)}`);
    if (shotgun.inRange) throw new Error(`shotgun claimed 60 m as in range: ${JSON.stringify(shotgun)}`);
    if (shotgun.minMag !== shotgun.magSize || shotgun.deltas.length) {
      throw new Error(`shotgun fired at 60 m: ${JSON.stringify(shotgun)}`);
    }

    // ---- C. The magazine is real, and the damage is the catalog's.
    // Close enough that both weapons are inside their own engage range, so
    // the only difference is what they are holding.
    await load('smg');
    const smg = await combat('smg', -15, -7, 26);
    if (smg.fail) throw new Error(smg.fail);
    await load('revolver');
    const revolver = await combat('revolver', -15, -7, 26);
    if (revolver.fail) throw new Error(revolver.fail);

    for (const r of [smg, revolver]) {
      if (r.minMag !== 0) throw new Error(`${r.weapon} never emptied its magazine: ${JSON.stringify(r)}`);
      if (!r.sawReload) throw new Error(`${r.weapon} never reloaded: ${JSON.stringify(r)}`);
      if (!r.refilled) throw new Error(`${r.weapon} never got rounds back: ${JSON.stringify(r)}`);
      const bad = r.deltas.filter(d => !ZONES[r.weapon].includes(d));
      if (bad.length) {
        throw new Error(`${r.weapon} dealt damage no catalog zone can produce (${bad}): ${JSON.stringify(r)}`);
      }
    }
    // The two damage sets are disjoint by construction, so a landed hit could
    // only have come from the weapon the bot was actually carrying. Vacuous
    // if neither landed anything, which is why the magazine claims above
    // carry the weight.
    const overlap = smg.deltas.filter(d => revolver.deltas.includes(d));
    if (overlap.length) throw new Error(`weapons dealt identical damage (${overlap})`);

    console.log('[botWeapons] OK', JSON.stringify({
      mixed: { drawn: mixed.before, distinct: spread },
      sniper, shotgun, smg, revolver,
    }));
  } catch (e) {
    failures++;
    console.log(`[botWeapons] FAIL: ${e.message}`);
  }
  errors.push(...mapErrors.map(e => `[botWeapons] ${e}`));
  await page.close();
}

// [botKnife] — a bot's blade is GEOMETRY, and it holds no rounds.
//
// The knife is the one bot weapon whose hit is not a die roll: sim/melee.ts
// tests the blade's real reach and arc against the target's zone points, so
// the two claims here are decided by geometry alone and neither can flake on
// an unlucky draw.
//
//   - Reach. engageRange is 1.8 m, so at 60 m a knife bot SEES the player,
//     grades out of range and never touches them. Same fixture the sniper
//     clears at the same distance.
//   - Contact. Left unpinned, a knife bot's bands walk it ONTO the player and
//     the player bleeds. Every damage value it can deal comes from the
//     catalog knife (55 / 41.25 anywhere on the body, x3 for a backstab), and
//     it deals them while holding a weapon with NO magazine and NO reserve —
//     which is the claim that separates the melee path from every ranged one,
//     since a firearm bot dealing damage always has rounds to spend.
async function runBotKnifeCheck() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const mapErrors = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') mapErrors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => mapErrors.push('PAGEERROR: ' + e.message));
  // Knife zone damage from WEAPONS.knife: 55 anywhere on the body (its
  // headshotMult is 1 — a blade cuts the same at any height), legs x0.75, and
  // each x3 from within 60 degrees of directly behind (sim/melee.ts:isBackstab).
  const KNIFE_ZONES = [55, 41.25, 165, 123.75];
  try {
    await page.goto(BASE + '/?map=arena&tbots=1&ctbots=0&time=600&tweap=knife', { waitUntil: 'networkidle0', timeout: 20000 });
    await new Promise(r => setTimeout(r, 1200));

    // ---- A. Reach: 60 m of clear sight line, and nothing happens.
    const far = await page.evaluate(async () => {
      const cs = window.__cs;
      const frame = () => new Promise(r => requestAnimationFrame(r));
      const LANE_X = 12;
      cs.game.started = true;
      cs.game.locked = true;
      if (cs.bots.length !== 1) return { fail: `expected exactly one bot, got ${cs.bots.length}` };
      const bot = cs.bots[0];
      if (bot.weapon !== 'knife') return { fail: `expected a knife bot, got ${bot.weapon}` };
      cs.player.pos.set(LANE_X, cs.player.eyeHeight, 45);
      cs.player.alive = true;
      let seen = false, inRange = false, hurt = 0;
      const t0 = cs.gameTime.now();
      const wall = performance.now();
      while (performance.now() - wall < 60000 && cs.gameTime.now() - t0 < 12) {
        // Pinned, exactly as the sniper/shotgun reach claim pins its bot: the
        // bands would otherwise close the very distance the claim is about.
        bot.mesh.position.set(LANE_X, 0, -15);
        bot.vy = 0; bot.onGround = true;
        const hpBefore = cs.player.hp;
        await frame();
        hurt += hpBefore - cs.player.hp;
        cs.player.hp = 100000;
        if (bot.targetLOS === true) seen = true;
        if (bot.targetInRange) inRange = true;
      }
      return { seen, inRange, hurt: +hurt.toFixed(2), magSize: bot.magSize, reserve: bot.reserve };
    });
    if (far.fail) throw new Error(far.fail);
    if (!far.seen) throw new Error(`knife bot never saw the player at 60 m: ${JSON.stringify(far)}`);
    if (far.inRange) throw new Error(`knife bot claimed 60 m as in range: ${JSON.stringify(far)}`);
    if (far.hurt !== 0) throw new Error(`knife bot reached 60 m: ${JSON.stringify(far)}`);
    if (far.magSize !== 0 || far.reserve !== 0) {
      throw new Error(`a blade reported rounds: ${JSON.stringify(far)}`);
    }

    // ---- B. Contact: unpinned, it closes and cuts.
    const near = await page.evaluate(async () => {
      const cs = window.__cs;
      const frame = () => new Promise(r => requestAnimationFrame(r));
      const LANE_X = 12;
      const bot = cs.bots[0];
      cs.player.pos.set(LANE_X, cs.player.eyeHeight, -4);
      cs.player.alive = true;
      // Placed once, then left alone: closing the distance is the behaviour
      // under test, not something the fixture may do for it.
      bot.mesh.position.set(LANE_X, 0, -12);
      bot.vy = 0; bot.onGround = true;
      let minDist = Infinity, sawReload = false;
      const deltas = new Set();
      const t0 = cs.gameTime.now();
      const wall = performance.now();
      while (performance.now() - wall < 90000 && cs.gameTime.now() - t0 < 20) {
        const hpBefore = cs.player.hp;
        await frame();
        const lost = +(hpBefore - cs.player.hp).toFixed(2);
        if (lost > 0) deltas.add(lost);
        cs.player.hp = 100000; // never dies: a death frees the pointer lock
        if (bot.reloading) sawReload = true;
        const d = Math.hypot(
          bot.mesh.position.x - cs.player.pos.x, bot.mesh.position.z - cs.player.pos.z);
        if (d < minDist) minDist = d;
      }
      return {
        minDist: +minDist.toFixed(2), sawReload, deltas: [...deltas], mode: bot.mode,
        mag: bot.mag, magSize: bot.magSize, reserve: bot.reserve,
        simS: +(cs.gameTime.now() - t0).toFixed(1),
      };
    });
    if (near.minDist > 2.2) throw new Error(`knife bot never closed to contact: ${JSON.stringify(near)}`);
    if (!near.deltas.length) throw new Error(`knife bot reached the player and did nothing: ${JSON.stringify(near)}`);
    const bad = near.deltas.filter(d => !KNIFE_ZONES.includes(d));
    if (bad.length) {
      throw new Error(`blade dealt damage no knife zone can produce (${bad}): ${JSON.stringify(near)}`);
    }
    if (near.mag !== 0 || near.magSize !== 0 || near.reserve !== 0 || near.sawReload) {
      throw new Error(`a blade spent or held rounds: ${JSON.stringify(near)}`);
    }

    console.log('[botKnife] OK', JSON.stringify({ far, near }));
  } catch (e) {
    failures++;
    console.log(`[botKnife] FAIL: ${e.message}`);
  }
  errors.push(...mapErrors.map(e => `[botKnife] ${e}`));
  await page.close();
}

try {
  await runMap('warehouse2', '/?map=warehouse2&tweap=smg&ctweap=smg', {
    botCheck: true,
    stairsCheck: STAIRS.warehouse2,
    liftCheck: true,
  });
  await runMap('arena', '/?tweap=smg&ctweap=smg', { configCheck: true, botCheck: true, stairsCheck: STAIRS.arena });
  await runConfigCheck();
  await runAllyCheck();
  await runFlatRouteCheck();
  await runVisionAwarenessCheck();
  await runPatrolCheck();
  await runBotWeaponsCheck();
  await runBotKnifeCheck();
  await runHearingCheck();
  await runMap('elevation', '/?map=elevation&tweap=smg&ctweap=smg', { configCheck: true, botCheck: true, stairsCheck: STAIRS.elevation });
  await runBotClimbCheck();
  await runNavGraphCheck();
  await runWedgeCheck();
  await runDebugViewCheck();
  await runMap('warehouse1', '/?map=warehouse1&tweap=smg&ctweap=smg', { botCheck: true, stairsCheck: STAIRS.warehouse1 });

  await runMap('range', '/?map=range', { sprintCheck: true });
  await runShotgunCheck();
  await runKnifeCheck();
  await runMatchEndCheck();
} finally {
  await browser.close();
}

console.log('console/page errors:', errors.length ? JSON.stringify(errors, null, 2) : 'none');
process.exit(failures > 0 || errors.length > 0 ? 1 : 0);
