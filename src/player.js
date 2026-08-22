// player.js — first-person controller: movement, crouch, footsteps, camera.
//
// The player is a capsule-ish box (core.player) moved on the XZ plane with
// axis-separated collision tests so sliding along walls feels smooth; Y is
// only gravity/jump. Crouch and aim modify speed; crouch also lowers the
// camera and silences footsteps.
import * as THREE from 'three';
import { player, camera, clock, game, keys } from './core.js';
import { collidesAt } from './collision.js';
import { sfxFootstep } from './audio.js';
import { gunGroup, updateWeapon } from './weapons.js';
import { crosshair } from './hud.js';

const GRAVITY = 22;    // m/s^2; tuned so jump arc feels snappy at 60fps+
const JUMP_VEL = 8;    // initial jump velocity -> ~1.45m apex

/**
 * Per-frame player update. Also drives the weapon viewmodel transform
 * (bob + ADS position) and the crosshair state, since all three depend on
 * movement data computed here. Calls updateWeapon(dt) internally.
 */
export function updatePlayer(dt) {
  if (!player.alive) return;

  // Speed tiers: crouch < aim < run. Crouching requires ground contact so
  // you can't crouch mid-air to shrink the camera.
  const crouching = keys['ShiftLeft'] && player.onGround;
  let speed = 6.5;
  if (crouching) speed = 2.4;
  else if (game.aiming) speed = 3.8;

  const forward = new THREE.Vector3(-Math.sin(game.yaw), 0, -Math.cos(game.yaw));
  // Right = forward rotated -90° about Y (cross of forward x up)
  const right = new THREE.Vector3(-forward.z, 0, forward.x);

  const move = new THREE.Vector3();
  if (keys['KeyW']) move.add(forward);
  if (keys['KeyS']) move.sub(forward);
  if (keys['KeyD']) move.add(right);
  if (keys['KeyA']) move.sub(right);
  if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed * dt);

  // Horizontal movement with slide-along-walls: test each axis separately,
  // so moving into a wall while pressing along it keeps you sliding instead
  // of sticking.
  const nx = player.pos.x + move.x;
  const testX = new THREE.Vector3(nx, player.eyeHeight, player.pos.z);
  if (!collidesAt(testX, player.radius)) player.pos.x = nx;
  const nz = player.pos.z + move.z;
  const testZ = new THREE.Vector3(player.pos.x, player.eyeHeight, nz);
  if (!collidesAt(testZ, player.radius)) player.pos.z = nz;

  // Jump / gravity
  if (keys['Space'] && player.onGround) { player.vel.y = JUMP_VEL; player.onGround = false; }
  player.vel.y -= GRAVITY * dt;
  player.pos.y += player.vel.y * dt;
  if (player.pos.y <= player.eyeHeight) { player.pos.y = player.eyeHeight; player.vel.y = 0; player.onGround = true; }

  // Crouch camera offset (smooth): lerp toward the target so crouching
  // eases down/up over ~0.2s rather than snapping.
  game.crouchLerp += ((crouching ? 1 : 0) - game.crouchLerp) * Math.min(1, dt * 10);
  camera.position.copy(player.pos);
  camera.position.y -= 0.7 * game.crouchLerp;
  camera.rotation.set(game.pitch, game.yaw, 0, 'YXZ');

  // Footsteps: timed by distance-run (stepTimer), silent while crouching or
  // airborne. Timer is pre-charged when stopping so the first step after a
  // pause comes quickly but not instantly.
  const moving = move.lengthSq() > 0 && player.onGround;
  if (moving && !crouching) {
    game.stepTimer -= dt;
    if (game.stepTimer <= 0) { sfxFootstep(); game.stepTimer = speed > 5 ? 0.38 : 0.55; }
  } else {
    game.stepTimer = Math.min(game.stepTimer, 0.2);
  }

  // View bob (applied to the weapon viewmodel)
  game.bobAmt = moving ? (crouching ? 0.008 : 0.02) : 0;

  updateWeapon(dt);

  // Viewmodel transform: blend hip-fire offset -> centered iron sights with
  // adsLerp; add bob and recoil kick on top.
  gunGroup.position.x = -0.25 * game.adsLerp;
  gunGroup.position.y = 0.14 * game.adsLerp + Math.sin(clock.elapsedTime * 10) * game.bobAmt;
  gunGroup.position.z = game.recoil * 0.03 + 0.06 * game.adsLerp; // ADS pulls gun slightly closer
  gunGroup.rotation.x = game.recoil * 0.05;

  // Crosshair tightens/fades when aiming (sight picture takes over)
  crosshair.style.transform = `translate(-50%,-50%) scale(${1 - 0.35 * game.adsLerp})`;
  crosshair.style.opacity = 1 - 0.4 * game.adsLerp;
}
