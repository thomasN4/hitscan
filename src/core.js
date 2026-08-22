// core.js — single source of truth for shared state and engine singletons.
//
// Every other module imports from here; nothing imports back into the
// modules that use it (no dependency cycles). All mutable cross-module
// game state lives in this file: if you need to share new state between
// systems (player, bots, weapons, HUD...), add it here rather than
// reaching across modules.
import * as THREE from 'three';

// ---------- Renderer / scene / camera ----------
export const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0xbfae8f); // dusty haze
scene.fog = new THREE.Fog(0xbfae8f, 40, 140);

export const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 300);
// FOV is animated by weapons.js when aiming (75 hip-fire -> per-weapon
// zoom targets, down to ~6° at full sniper zoom).

scene.add(new THREE.HemisphereLight(0xfff3e0, 0x8a7a5c, 0.85));
const sun = new THREE.DirectionalLight(0xffeecc, 1.4);
sun.position.set(40, 60, 25);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -80; sun.shadow.camera.right = 80;
sun.shadow.camera.top = 80; sun.shadow.camera.bottom = -80;
scene.add(sun);

export const clock = new THREE.Clock();

// ---------- Shared collections ----------
/** Meshes (walls, crates, ground) that block bullets AND bot line-of-sight. */
export const solids = [];
/** AABBs derived from `solids` boxes, used for cheap movement collision. */
export const colliders = [];
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
 * Weapon definitions (slot order = switch order via keys 1/2). Static stats
 * only — the live mutable copy is `weapon` below. zoomFovs are the scoped
 * FOV targets cycled with the mouse wheel while aiming (the smg has one
 * "iron sights" step); spreadMul is the ADS cone multiplier; inherent is the
 * weapon's resting shot cone in radians before any stance/movement/spray.
 */
export const WEAPONS = [
  {
    name: 'SMG',
    magSize: 30, reserveMax: 90,
    fireRate: 0.105, // seconds between shots (~9.5 rounds/sec, smg-like)
    reloadTime: 2.2,
    damage: 26,      // per body shot; legs x0.75, head x4 -> one-tap kill
    headshotMult: 4,
    zoomFovs: [55],  // iron sights
    spreadMul: 0.3,
    inherent: 0.0031, // rest-cone rad — ADS crouched ≈ 2" @ 50 m; hip ≈ 6.7"
    sprayKick: 0.06, recoilKick: 1,
    sprayCap: 4,       // max spray multiplier (rested = 1) after a long burst
    sprayRecover: 0.45, // multiplier units/s — MUST stay below sustained-fire input
                        // (~9.5 shots/s × sprayKick = 0.57/s), or the drain outpaces
                        // accumulation and sprays never bloom at all.
                        // 0.45 clears a full-mag spray (30×0.06 = 1.8) in ~4 s
    recoilRecover: 6, // recoil units/s — MUST stay below the sustained-fire input
                      // (~9.5 shots/s × recoilKick = 9.5/s), or the drain outpaces
                      // accumulation and spray never climbs (it just vibrates).
                      // 6 → full 6-unit climb in ~1.3 s, ~1 s settle-back
                      // (also decays the horizontal component, see recoilYaw)
    punchRad: 0.012,   // radians of aim climb per recoil unit — sustained spray
                       // climbs toward ~4° (cap 6), pull down to compensate
    yawKick: 0.4,      // ± horizontal recoil units per shot (random walk, cap ±3):
                       // typical full-mag drift ~1-1.5° via punchRad, compensable
    scopedOverlay: false,
  },
  {
    name: 'SNIPER',
    magSize: 10, reserveMax: 30,
    fireRate: 1.1,   // semi-auto pacing (~0.9 shots/sec)
    reloadTime: 3.2,
    damage: 60,      // two torso shots to kill; head x4 = one-tap, legs x0.75
    headshotMult: 4,
    zoomFovs: [25, 12.5, 6.25], // ≈ 3x / 6x / 12x on the 75° base FOV
    spreadMul: 0.03, // near-laser when scoped and still (~0.19" @ 50 m crouched)
    inherent: 0.0029, // rest-cone rad — hip-fire ≈ 6.3" @ 50 m, like the smg's
    sprayKick: 0.25, recoilKick: 4,
    sprayCap: 3,
    recoilRecover: 13, // slow settle (~0.3 s) — bolt-action feel; also gates re-scoping
    punchRad: 0.02,    // radians of aim climb per recoil unit — one meaty ~4.6°
                       // kick per shot that settles slowly with the recoil
    yawKick: 0.8,      // ± horizontal recoil units per shot — up to ~±0.55° of
                       // sideways jump on the big punch, real guns kick crooked
    sprayRecover: 0.08, // slow settle matches the bolt-action feel (input ≈ 0.9 shots/s × 0.25)
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
  map: new URLSearchParams(location.search).get('map') === 'range' ? 'range' : 'arena',
  locked: false,   // pointer lock active (Esc/menu releases it)
  started: false,  // first Play click happened; distinguishes pause from pre-game
  shooting: false, // LMB held
  aiming: false,   // RMB held (iron sights)
  running: false,  // double-tapped W and still holding it (sprint)
  runLerp: 0,      // 0..1 sprint acceleration blend; ~0.2 s ramp to full speed
  yaw: 0,          // 0 = facing -z; Math.PI would face the arena's rear wall
  pitch: 0,
  spread: 0.001,   // CURRENT total shot cone (radians); recomputed each frame
                   // in weapons.js from (stance + movement) × spray + inherent,
                   // all × ADS. Do not add to it directly — kick `spray` instead.
  spray: 1,        // spray cone multiplier, 1 at rest: +sprayKick per shot up
                   // to sprayCap, decays toward 1 at weapon.sprayRecover/s
  moveLerp: 0,     // smoothed actual speed ÷ walk speed (idle 0, walk 1, run 1.5);
                   // drives the movement accuracy penalty
  recoil: 0,       // drives viewmodel kick; decays at weapon.recoilRecover/s.
                   // While above WEAPONS[slot].scopeGate, a new RMB press
                   // can't enter the scope (main.js)
  recoilYaw: 0,    // signed HORIZONTAL recoil (same units as `recoil`): each
                   // shot adds up to ±yawKick — a random walk the player
                   // steers against. Decays toward 0 at recoilRecover/s and
                   // converts to radians via punchRad (see weapons.aimYaw).
   crouchLerp: 0,
   adsLerp: 0,
   slot: 0,         // active weapon index into WEAPONS (0 smg, 1 sniper)
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
