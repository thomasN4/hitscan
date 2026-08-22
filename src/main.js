// main.js — entry point: builds the world, wires all input, owns the game loop.
//
// Flow: import modules (side effects create renderer/scene) -> buildMap +
// spawnBots -> register input/pointer-lock handlers -> start the render loop.
// The loop only simulates (player, bots, timer) while pointer lock is held;
// rendering and effect updates run always so pause screens stay visible.
import { renderer, scene, camera, clock, game, keys, player, weapon, bulletHoles, WEAPONS } from './core.js';
import { buildMap } from './map.js';
import { buildRange } from './range.js';
import { updatePlayer } from './player.js';
import { spawnBots, updateBots } from './bots.js';
import { tryReload, switchWeapon } from './weapons.js';
import { updateEffects } from './effects.js';
import { respawn } from './combat.js';
import { updateHUD, setTimer, hudEl, setScopeOverlay } from './hud.js';
import { sfxZoom } from './audio.js';

// ---------- World ----------
const RANGE = game.map === 'range';
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
// input-layer state, not shared game state.
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
    if (now - lastWTapTime < RUN_TAP_WINDOW_MS) game.running = true;
    lastWTapTime = now;
  }
});
addEventListener('keyup', e => {
  keys[e.code] = false;
  if (e.code === 'KeyW') game.running = false; // sprint requires W held
});

const SENS = 0.0022; // radians per pixel of mouse movement
document.addEventListener('mousemove', e => {
  if (!game.locked || !player.alive) return;
  // zoomScale shrinks toward the FOV ratio while scoped (weapons.js), so
  // aiming stays controllable at 12x instead of flinging across the sky.
  game.yaw -= e.movementX * SENS * game.zoomScale;
  game.pitch -= e.movementY * SENS * game.zoomScale;
  // Clamp pitch so the player can't flip over backwards
  game.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, game.pitch));
});

// Wheel = scope zoom steps, only while scoped with the sniper (slot 1).
// Scroll up zooms in, scroll down zooms out, wrapping through the levels.
addEventListener('wheel', e => {
  if (!game.locked || !player.alive || game.slot !== 1 || !game.aiming) return;
  const n = WEAPONS[1].zoomFovs.length;
  game.zoomLevel = (game.zoomLevel + (e.deltaY < 0 ? 1 : -1) + n) % n;
  sfxZoom();
});

// LMB = fire (held), RMB = iron sights (held). Buttons are tracked as state
// rather than one-shot events because firing is continuous in updateWeapon.
addEventListener('mousedown', e => {
  if (e.button === 0 && game.locked && player.alive) game.shooting = true;
  if (e.button === 2 && game.locked && player.alive) game.aiming = true;
});
addEventListener('mouseup', e => {
  if (e.button === 0) game.shooting = false;
  if (e.button === 2) game.aiming = false;
});
addEventListener('contextmenu', e => e.preventDefault()); // RMB must not open the menu

// ---------- Pointer lock / menus ----------
const startMenu = document.getElementById('startMenu');
const deathScreen = document.getElementById('deathScreen');

function lock() { renderer.domElement.requestPointerLock(); }
document.getElementById('playBtn').onclick = lock;
// Map switch is a full page reload (?map=...) — scenes are never hot-swapped.
const rangeBtn = document.getElementById('rangeBtn');
rangeBtn.textContent = RANGE ? 'Play Arena' : 'Shooting Range';
rangeBtn.onclick = () => { location.search = RANGE ? '' : '?map=range'; };
if (RANGE) {
  document.querySelector('#startMenu p').textContent = 'Practice your aim — silhouettes with bullseyes at 10\u201360 m';
}
document.getElementById('respawnBtn').onclick = () => { deathScreen.style.display = 'none'; respawn(); lock(); };
renderer.domElement.addEventListener('click', () => { if (!game.locked && player.alive && game.started) lock(); });

document.addEventListener('pointerlockchange', () => {
  game.locked = document.pointerLockElement === renderer.domElement;
  hudEl.style.display = game.locked ? 'block' : 'none';
  // updateWeapon stops running when the loop pauses; make sure a held scope
  // can't stay stuck on screen across pause/death.
  if (!game.locked) setScopeOverlay(false);
  if (game.locked) {
    game.started = true;
    deathScreen.style.display = 'none';
  }
  // Losing lock while alive means Esc was pressed -> show pause menu.
  // Losing lock while dead is handled by damagePlayer's death screen.
  if (!game.locked && game.started && player.alive) {
    startMenu.querySelector('p').textContent = 'Paused — click Play to resume';
    document.getElementById('playBtn').textContent = 'Resume';
    startMenu.style.display = 'flex';
  } else {
    startMenu.style.display = 'none';
  }
});

// ---------- Game loop ----------
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05); // clamp: tab-switch spikes shouldn't teleport entities

  if (game.locked && game.started) {
    updatePlayer(dt);
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
window.__cs = { game, weapon, player, bulletHoles };
