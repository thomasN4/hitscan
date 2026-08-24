// player.ts — first-person controller: movement, crouch, footsteps, camera.
//
// The player is a capsule-ish box (core/state.ts `player`) moved on the XZ
// plane with a shared axis-separated slide gate (collision.ts:slideMoveXZ),
// so sliding along walls feels smooth; Y is gravity/jump resolved against
// the support surface beneath the player (collision.ts:resolveVertical),
// which is what makes stairs climbable and platforms stand-on-able: risers
// up to STEP_HEIGHT read as floor, not wall. Physics snaps to support
// instantly; the CAMERA rides an eased blend of it (motion.groundSmoothY)
// so climbing doesn't jitter. Crouch and aim modify speed; crouch also
// lowers the camera and silences footsteps.
//
// The three exports here are ORDERED stages of one frame, sequenced by
// main.ts: updateMovement -> (updateWeapon) -> updateCamera -> updateViewmodel.
// The order is load-bearing in both directions: updateMovement writes
// camera.position, which shoot() rays from, so it must run BEFORE updateWeapon;
// updateCamera and updateViewmodel read post-decay recoil, so they must run
// AFTER it. Speed tiers and the moveLerp math live in sim/movement.ts; the
// blends use sim/smoothing.ts.
import * as THREE from 'three';
import { camera } from './core/engine';
import { player, input, aim, wpn, motion, keys, gameTime } from './core/state';
import { slideMoveXZ, resolveVertical } from './collision';
import { colliders } from './world';
import { sfxFootstep } from './audio';
import { gunGroup, currentAimPitch, currentAimYaw } from './weapons';
import { crosshair } from './hud';
import { speedFor, measuredMoveLerp, GRAVITY } from './sim/movement';
import { approach, deadZone } from './sim/smoothing';

const JUMP_VEL = 8;    // initial jump velocity -> ~1.45m apex

/** Blend rate (1/s) for moveLerp and crouchLerp; ~100 ms to settle. */
const BLEND_RATE = 10;
/** Sprint ramp time constant (s) — ~0.2 s from standstill to full speed. */
const SPRINT_RAMP = 0.2;
/** How far the camera drops at full crouch (m). */
const CROUCH_DROP = 0.7;
/** Airborne blend rate (1/s); ~100-200 ms to ease the jump penalty in and out. */
const AIR_BLEND_RATE = 12;
/**
 * Camera ground-height blend rate (1/s) — ~80 ms to settle onto a new
 * support height. Fast enough that stairs read as one continuous climb,
 * slow enough to hide the per-riser physics snap.
 */
const GROUND_BLEND_RATE = 12;

/**
 * Read one keyboard slot as a plain boolean. `keys` is
 * Record<string, boolean | undefined> — written from event handlers, so the
 * undefined case is real and this is where it collapses.
 */
function key(code: string): boolean {
  return keys[code] === true;
}

/**
 * Stage 1 — movement, stance, footsteps, camera position.
 *
 * Writes player.pos/vel and the blends the accuracy model reads
 * (moveLerp, crouchLerp, runLerp, bobAmt). Must run BEFORE updateWeapon,
 * which consumes those blends to compute spread.
 *
 * Also writes camera.position (with the crouch drop), and that too must
 * land before updateWeapon: shoot() builds its ray from
 * camera.getWorldPosition(), so a position written later in the frame would
 * fire every shot from the PREVIOUS frame's eye — metres behind you at
 * sprint speed, and at the old spot on the first frame after respawn().
 */
export function updateMovement(dt: number): void {
  if (!player.alive) return;

  // Speed tiers: crouch < aim < normal < run. Crouch and aim take precedence
  // over sprint (no sprint-scoping). Crouch requires ground contact so you
  // can't crouch mid-air to shrink the camera.
  const crouching = input.crouching && player.onGround;
  const running = input.running && !crouching && !input.aiming;
  const speed = speedFor({ crouching, aiming: input.aiming, running, runLerp: motion.runLerp });

  const forward = new THREE.Vector3(-Math.sin(aim.yaw), 0, -Math.cos(aim.yaw));
  // Right = forward rotated -90° about Y (cross of forward x up)
  const right = new THREE.Vector3(-forward.z, 0, forward.x);

  const move = new THREE.Vector3();
  if (key('KeyW')) move.add(forward);
  if (key('KeyS')) move.sub(forward);
  if (key('KeyD')) move.add(right);
  if (key('KeyA')) move.sub(right);
  if (move.lengthSq() > 0) move.normalize().multiplyScalar(speed * dt);

  // Horizontal movement: the shared slide-along-walls gate (collision.ts),
  // shared with bots so both entity types handle geometry identically.
  // Risers within STEP_HEIGHT of the feet do not block — resolveVertical
  // below lifts the feet onto them this same frame.
  const feetY = player.pos.y - player.eyeHeight;
  const preX = player.pos.x, preZ = player.pos.z;
  slideMoveXZ(player.pos, move.x, move.z, player.radius, feetY, colliders);

  // Movement-accuracy input: MEASURED displacement, so being blocked by a
  // wall doesn't count as moving. Smoothed ~100 ms for gradual crosshair
  // transitions.
  const target = measuredMoveLerp(player.pos.x - preX, player.pos.z - preZ, dt);
  motion.moveLerp = deadZone(approach(motion.moveLerp, target, dt, BLEND_RATE));

  // Jump / gravity / support. resolveVertical owns onGround: rising frames
  // are airborne, falling frames land on the highest swept surface (which is
  // also how step-up works — the riser ahead is within STEP_HEIGHT of the
  // feet, so its top catches them as the feet dip a hair below it).
  if (key('Space') && player.onGround) player.vel.y = JUMP_VEL;
  player.vel.y -= GRAVITY * dt;
  const vert = resolveVertical(feetY, player.vel.y, dt, player.pos.x, player.pos.z, player.radius, colliders);
  player.pos.y = vert.feetY + player.eyeHeight;
  player.vel.y = vert.velY;
  player.onGround = vert.onGround;

  const pressingMove = move.lengthSq() > 0;
  // Grounded motion only: gates footsteps and view bob.
  const moving = pressingMove && player.onGround;

  // Sprint acceleration ramp: ~0.2 s to full speed (exponential ease-in).
  // Decays when not running so releasing W eases out the same way. The
  // target ignores ground contact: a sprint-jump must carry its speed
  // through the arc (~0.73 s airtime drains runLerp ~97% otherwise), not
  // land at walk pace and rebuild the ramp from zero.
  motion.runLerp = deadZone(
    approach(motion.runLerp, running && pressingMove ? 1 : 0, dt, 1 / SPRINT_RAMP));

  // Crouch camera offset (smooth): lerp toward the target so crouching
  // eases down/up over ~0.2s rather than snapping.
  motion.crouchLerp = approach(motion.crouchLerp, crouching ? 1 : 0, dt, BLEND_RATE);

  // Airborne blend for the accuracy model. Written HERE, in stage 1, because
  // updateWeapon reads it to compute spread — deferring it to a later stage
  // would price every mid-air shot off the previous frame's stance. It also
  // has to follow the gravity block above, which is what sets player.onGround.
  motion.airLerp = deadZone(
    approach(motion.airLerp, player.onGround ? 0 : 1, dt, AIR_BLEND_RATE));

  motion.groundSmoothY = approach(motion.groundSmoothY, vert.feetY, dt, GROUND_BLEND_RATE);
  camera.position.set(
    player.pos.x,
    // The eased ground height, not the physics one: stairs snap the feet up
    // to 0.3 m per riser; the camera blends across them instead.
    motion.groundSmoothY + player.eyeHeight - CROUCH_DROP * motion.crouchLerp,
    player.pos.z,
  );

  // Footsteps: timed by distance-run (stepTimer), silent while crouching or
  // airborne. Timer is pre-charged when stopping so the first step after a
  // pause comes quickly but not instantly.
  if (moving && !crouching) {
    motion.stepTimer -= dt;
    if (motion.stepTimer <= 0) { sfxFootstep(); motion.stepTimer = speed > 8 ? 0.3 : speed > 5 ? 0.38 : 0.55; }
  } else {
    motion.stepTimer = Math.min(motion.stepTimer, 0.2);
  }

  // View bob (applied to the weapon viewmodel); heavier while sprinting
  motion.bobAmt = moving ? (crouching ? 0.008 : 0.02 + 0.01 * motion.runLerp) : 0;
}

/**
 * Stage 3 — camera orientation. (Position is written in updateMovement, which
 * must run before updateWeapon; see that stage's note.)
 *
 * MUST run after updateWeapon: pitch and yaw come from currentAimPitch() /
 * currentAimYaw(), the same expressions shoot() uses for bullet direction, so
 * the crosshair (screen center) always marks where bullets go on average —
 * horizontally as well as vertically. Reading them before the frame's recoil
 * decay would aim the camera a frame ahead of the bullets.
 *
 * Note this is the VIEW yaw only. Movement (updateMovement's forward vector)
 * and mouse input stay on the base aim.yaw, or the recoil walk would steer
 * the player's legs and fight the mouse.
 */
export function updateCamera(): void {
  if (!player.alive) return;
  camera.rotation.set(currentAimPitch(), currentAimYaw(), 0, 'YXZ');
}

/**
 * Stage 4 — weapon viewmodel transform and crosshair styling.
 *
 * MUST run after updateWeapon: the kick reads wpn.recoil and the ADS blend
 * reads wpn.adsLerp, both written there this frame.
 */
export function updateViewmodel(): void {
  if (!player.alive) return;

  // Blend hip-fire offset -> centered iron sights with adsLerp; add bob and
  // recoil kick on top.
  gunGroup.position.x = -0.25 * wpn.adsLerp;
  // Bob phase runs on game time so a pause doesn't snap the weapon to an
  // arbitrary point of the cycle on resume.
  gunGroup.position.y = 0.14 * wpn.adsLerp + Math.sin(gameTime.now() * 10) * motion.bobAmt;
  gunGroup.position.z = wpn.recoil * 0.012 + 0.06 * wpn.adsLerp; // ADS pulls gun slightly closer
  gunGroup.rotation.x = wpn.recoil * 0.015; // small: recoil accumulates to RECOIL_CAP,
                                             // so a full climb must stay a nudge, not a tilt
  gunGroup.rotation.y = -wpn.recoilYaw * 0.01; // subtle sideways pull matching the walk

  // Crosshair tightens/fades when aiming (sight picture takes over);
  // arm gap itself is driven by the accuracy model in weapons.ts
  crosshair.style.transform = `scale(${1 - 0.35 * wpn.adsLerp})`;
  // style properties are CSS strings; a bare number only worked via coercion
  crosshair.style.opacity = String(1 - 0.4 * wpn.adsLerp);
}
