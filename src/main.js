// main.js — entry point: builds the world, wires all input, owns the game loop.
//
// Flow: import modules (side effects create renderer/scene) -> buildMap +
// spawnBots -> register input/pointer-lock handlers -> start the render loop.
// The loop only simulates (player, bots, timer) while pointer lock is held;
// rendering and effect updates run always so pause screens stay visible.
import { renderer, scene, camera, clock, game, keys, player, weapon } from './core.js';
import { buildMap } from './map.js';
import { updatePlayer } from './player.js';
import { spawnBots, updateBots } from './bots.js';
import { tryReload } from './weapons.js';
import { updateEffects } from './effects.js';
import { respawn } from './combat.js';
import { updateHUD, setTimer, hudEl } from './hud.js';

// ---------- World ----------
buildMap();
spawnBots();

// ---------- Input ----------
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'KeyR') tryReload();
});
addEventListener('keyup', e => keys[e.code] = false);

const SENS = 0.0022; // radians per pixel of mouse movement
document.addEventListener('mousemove', e => {
  if (!game.locked || !player.alive) return;
  game.yaw -= e.movementX * SENS;
  game.pitch -= e.movementY * SENS;
  // Clamp pitch so the player can't flip over backwards
  game.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, game.pitch));
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
document.getElementById('respawnBtn').onclick = () => { deathScreen.style.display = 'none'; respawn(); lock(); };
renderer.domElement.addEventListener('click', () => { if (!game.locked && player.alive && game.started) lock(); });

document.addEventListener('pointerlockchange', () => {
  game.locked = document.pointerLockElement === renderer.domElement;
  hudEl.style.display = game.locked ? 'block' : 'none';
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
    updateBots(dt, player);

    // Round timer: counts down and resets — no round-end consequence yet
    game.roundTime -= dt;
    if (game.roundTime <= 0) game.roundTime = 115;
    setTimer(game.roundTime);

    updateHUD();
  }

  // Effects keep fading while paused so impacts don't freeze on screen
  updateEffects(dt);
  renderer.render(scene, camera);
}
animate();

// Debug/testing hook: inspect live state from devtools (`__cs.game`, ...)
// or from scripts/smoke-test.mjs.
window.__cs = { game, weapon, player };
