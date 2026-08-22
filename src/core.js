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
// FOV is animated by weapons.js when aiming (75 hip-fire -> 55 iron sights).

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

/** Rifle state. Tuning notes inline; damage model lives in weapons.js. */
export const weapon = {
  magSize: 30, mag: 30, reserve: 90,
  fireRate: 0.105, // seconds between shots (~9.5 rounds/sec, rifle-like)
  lastShot: 0,
  reloading: false, reloadTime: 2.2, reloadEnd: 0,
  damage: 26,       // per body shot; legs x0.75, head x4 -> one-tap kill
  headshotMult: 4,
};

/**
 * Misc per-frame / transient flags. Grouped here because they are touched
 * by several systems (input in main.js, consumed in player.js/weapons.js).
 *
 * Lerp values (`crouchLerp`, `adsLerp`) are smoothed 0..1 blends updated
 * every frame; never set them directly from input.
 */
export const game = {
  locked: false,   // pointer lock active (Esc/menu releases it)
  started: false,  // first Play click happened; distinguishes pause from pre-game
  shooting: false, // LMB held
  aiming: false,   // RMB held (iron sights)
  yaw: Math.PI,
  pitch: 0,
  spread: 0.001,   // radians of cone half-angle-ish bloom; grows per shot
  recoil: 0,       // drives viewmodel kick, decays fast
  crouchLerp: 0,
  adsLerp: 0,
  stepTimer: 0.2,  // countdown to next footstep sound
  bobAmt: 0,       // current view-bob amplitude, computed in player.js
  scoreKills: 0,   // shown as "CT" score
  scoreDeaths: 0,  // shown as "T" score
  roundTime: 115,  // seconds; resets to 1:55 when it expires
};

/** Raw keyboard state by `event.code`. Written in main.js, read in player.js. */
export const keys = {};
