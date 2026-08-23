// main.ts — entry point: builds the world, wires all input, owns the game loop.
//
// Flow: initEngine() (imports have no engine/DOM side effects) -> buildMap +
// spawnBots -> register input/pointer-lock handlers -> start the render loop.
// The loop only simulates (player, bots, timer) while pointer lock is held;
// rendering and effect updates run always so pause screens stay visible.
// Game time (core/state.ts:gameTime) advances only inside that simulated
// window too — see GameClock in sim/gameClock.ts for why everything
// gameplay-related measures against it.
//
// The per-frame stage order lives in animate() at the bottom of this file
// and is load-bearing — see the comment there before reordering anything.
import type { GameState, LiveWeapon, PlayerState } from './core/state';
import { initEngine, renderer, scene, camera, clock } from './core/engine';
import { session, input, game, keys, player, weapon, gameTime, bulletHoles, WEAPONS } from './core/state';
import { colliders } from './world';
import { buildMap } from './map';
import { buildRange } from './range';
import { updateMovement, updateCamera, updateViewmodel } from './player';
import { spawnBots, updateBots } from './bots';
import { tryReload, switchWeapon, initWeaponViewmodels, updateWeapon } from './weapons';
import { updateEffects } from './effects';
import { respawn } from './combat';
import { updateHUD, setTimer, hudEl, setScopeOverlay, initHUD, requireEl } from './hud';
import { sfxZoom } from './audio';
import { validateWeapons } from './sim/validateWeapons';

// ---------- Startup ----------
// Order matters and is deliberately explicit: initEngine() creates the
// renderer/scene/camera that everything below reaches for, so nothing may
// touch those singletons at module scope. Each init* function is safe to
// call exactly once, here.
// core/state.ts stays free of browser globals, so the ?map= param is read
// here and written into the shared state before anything reads session.map.
session.map = new URLSearchParams(location.search).get('map') === 'range' ? 'range' : 'arena';
const RANGE = session.map === 'range';

// Loud, not fatal: this runs before initEngine(), so throwing would blank
// the page and hide the message behind a broken app. A violation is a
// mis-tuned constant — the console names weapon, field and consequence,
// and the game still runs.
if (import.meta.env.DEV) {
  for (const v of validateWeapons(WEAPONS)) console.error(v);
}

initEngine();
initHUD();
initWeaponViewmodels();  // needs camera/scene
if (RANGE) {
  buildRange();
} else {
  buildMap();
  spawnBots();
}
respawn(); // place player at the map's spawn with fresh HP/ammo/yaw

// ---------- Input ----------
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// Double-tap-W sprint detector: two W presses within 300 ms start a run;
// the run lasts only while W stays held. Timestamp is module-local — it is
// input-layer state, not shared game state — and WALL-clock on purpose:
// keydowns arrive before lock and during pause, where game time is frozen.
const RUN_TAP_WINDOW_MS = 300;
let lastWTapTime = -Infinity;

addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'KeyR') tryReload();
  if (e.code === 'Digit1') switchWeapon(0);
  if (e.code === 'Digit2') switchWeapon(1);
  // e.repeat guards against OS key-repeat re-triggering the double tap
  if (e.code === 'KeyW' && !e.repeat) {
    const now = performance.now();
    if (now - lastWTapTime < RUN_TAP_WINDOW_MS) input.running = true;
    lastWTapTime = now;
  }
});
addEventListener('keyup', e => {
  keys[e.code] = false;
  if (e.code === 'KeyW') input.running = false; // sprint requires W held
});

const SENS = 0.0022; // radians per pixel of mouse movement
document.addEventListener('mousemove', e => {
  if (!session.locked || !player.alive) return;
  // zoomScale shrinks toward the FOV ratio while scoped (weapons.ts), so
  // aiming stays controllable at 12x instead of flinging across the sky.
  game.yaw -= e.movementX * SENS * game.zoomScale;
  game.pitch -= e.movementY * SENS * game.zoomScale;
  // Clamp pitch so the player can't flip over backwards
  game.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, game.pitch));
});

// Wheel = scope zoom steps, only while scoped with the sniper (slot 1).
// Scroll up zooms in, scroll down zooms out, wrapping through the levels.
addEventListener('wheel', e => {
  if (!session.locked || !player.alive || game.slot !== 1 || !input.aiming) return;
  const n = WEAPONS[1].zoomFovs.length; // tuple index — slot 1 exists by type
  game.zoomLevel = (game.zoomLevel + (e.deltaY < 0 ? 1 : -1) + n) % n;
  sfxZoom();
});

// LMB = fire (held), RMB = iron sights (held). Buttons are tracked as state
// rather than one-shot events because firing is continuous in updateWeapon.
addEventListener('mousedown', e => {
  if (e.button === 0 && session.locked && player.alive) input.shooting = true;
  // A fresh RMB press can't enter the scope while recoil is still settling
  // (sniper bolt-action feel); a press already held is unaffected.
  if (e.button === 2 && session.locked && player.alive) {
    const gate = WEAPONS[game.slot].scopeGate; // undefined = no gate (smg)
    if (gate === undefined || game.recoil < gate) input.aiming = true;
  }
});
addEventListener('mouseup', e => {
  if (e.button === 0) input.shooting = false;
  if (e.button === 2) input.aiming = false;
});
addEventListener('contextmenu', e => e.preventDefault()); // RMB must not open the menu

// ---------- Pointer lock / menus ----------
const startMenu = requireEl('startMenu');
const deathScreen = requireEl('deathScreen');
const menuBlurb = startMenu.querySelector('p');
if (!menuBlurb) throw new Error('missing <p> inside #startMenu — index.html markup changed?');

function lock(): void { void renderer.domElement.requestPointerLock(); }
requireEl('playBtn').onclick = lock;
// Map switch is a full page reload (?map=...) — scenes are never hot-swapped.
const rangeBtn = requireEl('rangeBtn');
rangeBtn.textContent = RANGE ? 'Play Arena' : 'Shooting Range';
rangeBtn.onclick = () => { location.search = RANGE ? '' : '?map=range'; };
if (RANGE) {
  menuBlurb.textContent = 'Practice your aim \u2014 silhouettes with bullseyes at 10\u201360 m';
}
requireEl('respawnBtn').onclick = () => { deathScreen.style.display = 'none'; respawn(); lock(); };
renderer.domElement.addEventListener('click', () => { if (!session.locked && player.alive && session.started) lock(); });

document.addEventListener('pointerlockchange', () => {
  session.locked = document.pointerLockElement === renderer.domElement;
  hudEl.style.display = session.locked ? 'block' : 'none';
  // updateWeapon stops running when the loop pauses; make sure a held scope
  // can't stay stuck on screen across pause/death.
  if (!session.locked) setScopeOverlay(false);
  if (session.locked) {
    session.started = true;
    deathScreen.style.display = 'none';
  }
  // Losing lock while alive means Esc was pressed -> show pause menu.
  // Losing lock while dead is handled by damagePlayer's death screen.
  if (!session.locked && session.started && player.alive) {
    menuBlurb.textContent = 'Paused \u2014 click Play to resume';
    requireEl('playBtn').textContent = 'Resume';
    startMenu.style.display = 'flex';
  } else {
    startMenu.style.display = 'none';
  }
});

// ---------- Game loop ----------
function animate(): void {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05); // clamp: tab-switch spikes shouldn't teleport entities

  if (session.locked && session.started) {
    // Stage 0 — advance game time. Every stage below measures against this
    // epoch (fire-rate gates, reloads, respawn timers), and keeping the
    // advance inside the sim block is what makes them all pausable. dt is
    // already clamped, so a tab-switch spike can't fast-forward the
    // scheduler.
    gameTime.advance(dt);

    // Stage order is load-bearing, which is why it lives here rather than
    // nested inside updateMovement. It is pinned from both sides:
    //   - updateMovement writes camera.position, and shoot() (called from
    //     inside updateWeapon) rays from camera.getWorldPosition() — so the
    //     position must be written BEFORE updateWeapon, or every shot leaves
    //     from last frame's eye.
    //   - updateWeapon decays game.recoil and recomputes game.spread from the
    //     blends updateMovement just wrote; updateCamera and updateViewmodel
    //     then read that post-decay recoil, so they must run AFTER it and the
    //     camera, the viewmodel kick and the bullets all agree within a frame.
    // Moving updateWeapon after updateCamera aims the camera one frame ahead
    // of the shots (see `5e004a5`).
    updateMovement(dt);
    updateWeapon(dt);
    updateCamera();
    updateViewmodel();
    if (!RANGE) updateBots(dt, player);

    // Round timer: arena only — meaningless on the range, so freeze it there
    if (!RANGE) {
      game.roundTime -= dt;
      if (game.roundTime <= 0) game.roundTime = 115;
      setTimer(game.roundTime);
    }

    updateHUD();
  }

  // Effects keep fading while paused so impacts don't freeze on screen
  updateEffects(dt);
  renderer.render(scene, camera);
}
animate();

// Debug/testing hook: inspect live state from devtools (`__cs.game`, ...)
// or from scripts/smoke-test.mjs.
declare global {
  interface Window {
    __cs: {
      game: GameState;
      weapon: LiveWeapon;
      player: PlayerState;
      bulletHoles: typeof bulletHoles;
      colliders: typeof colliders;
    };
  }
}
window.__cs = { game, weapon, player, bulletHoles, colliders };
