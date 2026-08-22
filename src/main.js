import { renderer, scene, camera, clock, game, keys, player } from './core.js';
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

const SENS = 0.0022;
document.addEventListener('mousemove', e => {
  if (!game.locked || !player.alive) return;
  game.yaw -= e.movementX * SENS;
  game.pitch -= e.movementY * SENS;
  game.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, game.pitch));
});

addEventListener('mousedown', e => {
  if (e.button === 0 && game.locked && player.alive) game.shooting = true;
  if (e.button === 2 && game.locked && player.alive) game.aiming = true;
});
addEventListener('mouseup', e => {
  if (e.button === 0) game.shooting = false;
  if (e.button === 2) game.aiming = false;
});
addEventListener('contextmenu', e => e.preventDefault());

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
  const dt = Math.min(clock.getDelta(), 0.05);

  if (game.locked && game.started) {
    updatePlayer(dt);
    updateBots(dt, player);

    // Round timer
    game.roundTime -= dt;
    if (game.roundTime <= 0) game.roundTime = 115;
    setTimer(game.roundTime);

    updateHUD();
  }

  updateEffects(dt);
  renderer.render(scene, camera);
}
animate();
