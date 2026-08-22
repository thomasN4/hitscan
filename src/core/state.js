// core/state.js — pure shared game state. NO browser APIs, NO renderer.
//
// This module must stay importable in plain Node (that is what makes the
// simulation unit-testable): it may use THREE's math classes (Vector3,
// Box3...) but must never touch `document`, `window`, `location`, or
// construct a WebGLRenderer. Engine singletons live in core/engine.js
// instead — and browser-derived values (the ?map= param) are written in by
// main.js at startup rather than read here.
//
// All mutable cross-module game state lives here: if you need to share new
// state between systems (player, bots, weapons, HUD...), add it here rather
// than reaching across modules.
import * as THREE from 'three';

// ---------- Shared collections ----------
// Level geometry registries (`solids`, `colliders`) live in world.js, which
// owns the one path by which geometry is registered.
/** All Bot instances (see bots.js). */
export const bots = [];
/** Short-lived bullet impact puffs (see effects.js). */
export const impacts = [];
/** Persistent wall decals (see effects.js); FIFO-capped, oldest recycled. */
export const bulletHoles = [];

// ---------- Shared mutable game state ----------
/**
 * Player entity. `pos` is the EYE position (not feet); physics uses
 * `eyeHeight` as the ground-rest y value. Crouch only offsets the camera,
 * not `pos` itself.
 */
export const player = {
  pos: new THREE.Vector3(0, 1.7, 48),
  vel: new THREE.Vector3(),
  onGround: true,
  hp: 100,
  alive: true,
  radius: 0.45,
  eyeHeight: 1.7,
};

/**
 * Ceiling on accumulated recoil units, applied in `weapons.js:shoot()` when a
 * shot adds its kick. Decay rate (`recoilRecover`) and scope gating
 * (`scopeGate`) are per-weapon and independent of this — the cap only bounds
 * the climb. Each weapon's `punchRad` comment quotes its max angle at this cap.
 */
export const RECOIL_CAP = 6;
/** Ceiling on accumulated spread bloom (radians), applied alongside RECOIL_CAP. */
export const BLOOM_CAP = 0.25;
/** Base (hip-fire) vertical FOV in degrees; every zoom target sits below this. */
export const BASE_FOV = 75;

/**
 * Weapon definitions (slot order = switch order via keys 1/2). Static stats
 * only — the live mutable copy is `weapon` below. zoomFovs are the scoped
 * FOV targets cycled with the mouse wheel while aiming (rifle has one
 * "iron sights" step); spreadMul is the ADS cone multiplier.
 */
export const WEAPONS = [
  {
    name: 'RIFLE',
    magSize: 30, reserveMax: 90,
    fireRate: 0.105, // seconds between shots (~9.5 rounds/sec, rifle-like)
    reloadTime: 2.2,
    damage: 26,      // per body shot; legs x0.75, head x4 -> one-tap kill
    headshotMult: 4,
    zoomFovs: [55],  // iron sights
    spreadMul: 0.3,
    bloomKick: 0.02, recoilKick: 1,
    recoilRecover: 6, // recoil units/s — MUST stay below the sustained-fire input
                      // (~9.5 shots/s × recoilKick = 9.5/s), or the drain outpaces
                      // accumulation and spray never climbs (it just vibrates).
                      // 6 → full 6-unit climb in ~1.3 s, ~1 s settle-back
    bloomRecover: 0.13, // spread bloom units/s — MUST stay below the sustained-fire
                        // input (~9.5 shots/s × bloomKick ≈ 0.19/s), or the drain
                        // outpaces accumulation and sprays never bloom at all.
                        // 0.13 clears full bloom ~2 s after stopping (was 0.06 → ~4 s)
    punchRad: 0.012,   // radians of aim climb per recoil unit — sustained spray
                       // climbs toward ~4° at RECOIL_CAP, pull down to compensate
    scopedOverlay: false,
  },
  {
    name: 'SNIPER',
    magSize: 10, reserveMax: 30,
    fireRate: 1.1,   // semi-auto pacing (~0.9 shots/sec)
    reloadTime: 3.2,
    damage: 60,      // two torso shots to kill; head x4 = one-tap, legs x0.75
    headshotMult: 4,
    zoomFovs: [25, 12.5, 6.25], // ≈ 3x / 6x / 12x on the 75° BASE_FOV
    spreadMul: 0.05, // near-laser when scoped and still
    bloomKick: 0.09, recoilKick: 4,
    recoilRecover: 13, // slow settle (~0.3 s) — bolt-action feel; also gates re-scoping
    punchRad: 0.02,    // radians of aim climb per recoil unit — one meaty ~4.6°
                       // kick per shot that settles slowly with the recoil
    bloomRecover: 0.06, // spread bloom units/s — slow settle matches the bolt-action feel
    scopeGate: 0.5,    // RMB re-scope is blocked until recoil decays below this
    scopedOverlay: true, // full-screen scope reticle replaces the viewmodel
    semiAuto: true,      // one shot per LMB press; holding does nothing
    unscopeOnShot: true, // firing kicks you out of the scope (re-press RMB)
  },
];

/** Per-slot saved ammo, so switching weapons doesn't magically refill mags. */
export const ammoStore = WEAPONS.map(w => ({ mag: w.magSize, reserve: w.reserveMax }));

/**
 * Live state of the ACTIVE weapon. Stat fields are copied from
 * WEAPONS[game.slot] by switchWeapon() in weapons.js; HUD/combat read this
 * object only. Initialized to slot 0.
 */
export const weapon = {
  name: WEAPONS[0].name,
  magSize: WEAPONS[0].magSize, mag: WEAPONS[0].magSize, reserve: WEAPONS[0].reserveMax,
  fireRate: WEAPONS[0].fireRate,
  lastShot: 0,
  reloading: false, reloadTime: WEAPONS[0].reloadTime, reloadEnd: 0,
  damage: WEAPONS[0].damage,
  headshotMult: WEAPONS[0].headshotMult,
  recoilRecover: WEAPONS[0].recoilRecover,
};

/** Reset both slots' ammo and mirror slot 0 into `weapon`. Used on respawn. */
export function resetAmmo() {
  WEAPONS.forEach((w, i) => { ammoStore[i].mag = w.magSize; ammoStore[i].reserve = w.reserveMax; });
  const w = WEAPONS[0];
  weapon.name = w.name;
  weapon.magSize = w.magSize; weapon.mag = w.magSize; weapon.reserve = w.reserveMax;
  weapon.fireRate = w.fireRate; weapon.reloadTime = w.reloadTime;
  weapon.damage = w.damage; weapon.headshotMult = w.headshotMult;
  weapon.recoilRecover = w.recoilRecover;
  weapon.reloading = false;
}

/**
 * Misc per-frame / transient flags. Grouped here because they are touched
 * by several systems (input in main.js, consumed in player.js/weapons.js).
 *
 * Lerp values (`crouchLerp`, `adsLerp`) are smoothed 0..1 blends updated
 * every frame; never set them directly from input.
 */
export const game = {
  // Map is chosen at page load via ?map=range (start-menu buttons trigger a
  // full reload); there is deliberately no hot-swapping of scenes at runtime.
  // main.js overwrites this from the URL at startup — reading `location` here
  // would break this module's importability in Node.
  map: 'arena',
  locked: false,   // pointer lock active (Esc/menu releases it)
  started: false,  // first Play click happened; distinguishes pause from pre-game
  shooting: false, // LMB held
  aiming: false,   // RMB held (iron sights)
  running: false,  // double-tapped W and still holding it (sprint)
  runLerp: 0,      // 0..1 sprint acceleration blend; ~0.2 s ramp to full speed
  yaw: 0,          // 0 = facing -z; Math.PI would face the arena's rear wall
  pitch: 0,
  spread: 0.001,   // CURRENT total shot cone (radians); recomputed each frame
                   // in weapons.js from stance + movement + bloom. Do not add
                   // to it directly — kick `bloom` instead.
  bloom: 0,        // recoil spread kick: +0.02 per shot, decays ~0.06/s
  moveLerp: 0,     // smoothed actual speed ÷ walk speed (idle 0, walk 1, run 1.5);
                   // drives the movement accuracy penalty
  recoil: 0,       // drives viewmodel kick; decays at weapon.recoilRecover/s.
                   // While above WEAPONS[slot].scopeGate, a new RMB press
                   // can't enter the scope (main.js)
  crouchLerp: 0,
  adsLerp: 0,
  slot: 0,         // active weapon index into WEAPONS (0 rifle, 1 sniper)
  zoomLevel: 0,    // scoped zoom step: index into WEAPONS[slot].zoomFovs
  zoomScale: 1,    // mouse-sensitivity multiplier; <1 while zoomed so aiming
                   // doesn't get twitchy at 12x (computed in weapons.js)
  stepTimer: 0.2,  // countdown to next footstep sound
  bobAmt: 0,       // current view-bob amplitude, computed in player.js
  scoreKills: 0,   // shown as "CT" score
  scoreDeaths: 0,  // shown as "T" score
  roundTime: 115,  // seconds; resets to 1:55 when it expires
};

/** Raw keyboard state by `event.code`. Written in main.js, read in player.js. */
export const keys = {};
