// core/state.ts — pure shared game state. NO browser APIs, NO renderer.
//
// This module must stay importable in plain Node (that is what makes the
// simulation unit-testable): it may use THREE's math classes (Vector3,
// Box3...) but must never touch `document`, `window`, `location`, or
// construct a WebGLRenderer. Engine singletons live in core/engine.ts
// instead — and browser-derived values (the ?map= param) are written in by
// main.ts at startup rather than read here.
//
// All mutable cross-module game state lives here: if you need to share new
// state between systems (player, bots, weapons, HUD...), add it here rather
// than reaching across modules.
import * as THREE from 'three';
import { GameClock } from '../sim/gameClock';

// ---------- Domain vocabulary ----------
/**
 * Static stats for one weapon, shaped like the WEAPONS entries below.
 *
 * The three optional fields are sniper-only; every consumer must tolerate
 * their absence (the smg has no scope gate, fires full-auto, and does not
 * kick you out of iron sights).
 */
export interface WeaponDef {
  name: string;
  magSize: number;
  reserveMax: number;
  /** Seconds between shots (~9.5 rounds/sec for the smg). */
  fireRate: number;
  reloadTime: number;
  /** Per body shot; legs x0.75, head x headshotMult. */
  damage: number;
  headshotMult: number;
  /** Scoped FOV targets cycled with the mouse wheel while aiming. */
  zoomFovs: number[];
  /** ADS cone multiplier: 1 hip-firing, else spreadMul. */
  spreadMul: number;
  /** Resting shot cone in radians, before any stance/movement/spray. */
  inherent: number;
  sprayKick: number;
  recoilKick: number;
  sprayCap: number;
  sprayRecover: number;
  recoilRecover: number;
  punchRad: number;
  yawKick: number;
  yawRecover: number;
  scopedOverlay: boolean;
  /** Recoil below which a fresh RMB press may enter the scope. Sniper only. */
  scopeGate?: number;
  /** One shot per LMB press; holding does nothing. Sniper only. */
  semiAuto?: boolean;
  /** Firing kicks you out of the scope (re-press RMB). Sniper only. */
  unscopeOnShot?: boolean;
}

/** Hit zones, resolved by sim/damage.ts from which bot mesh a ray hit. */
export type HitZone = 'head' | 'torso' | 'legs';

/** Structural shape of one enemy (see bots.ts for the concrete class). */
export interface Bot {
  mesh: THREE.Group;
  head: THREE.Mesh;
  torso: THREE.Mesh;
  legs: THREE.Mesh;
  hp: number;
  alive: boolean;
  update(dt: number, player: PlayerState): void;
  eyePos(): THREE.Vector3;
  die(part: HitZone): void;
  spawnAtRandom(): void;
}

/** One transient impact puff tracked by effects.ts. */
export interface Impact {
  mesh: THREE.Mesh;
  /** Remaining lifetime in seconds. */
  t: number;
}

// ---------- Shared collections ----------
// Level geometry registries (`solids`, `colliders`) live in world.ts, which
// owns the one path by which geometry is registered.
/** All Bot instances (see bots.ts). */
export const bots: Bot[] = [];
/** Short-lived bullet impact puffs (see effects.ts). */
export const impacts: Impact[] = [];
/** Persistent wall decals (see effects.ts); FIFO-capped, oldest recycled. */
export const bulletHoles: THREE.Mesh[] = [];

// ---------- Game time ----------
/**
 * THE gameplay epoch. Seconds of simulated time, advanced once per frame from
 * main.ts's simulation block ONLY — which is what makes pausing structural:
 * everything measured against this clock (weapon.lastShot, weapon.reloadEnd,
 * bot respawn delays) freezes when the loop pauses and resumes where it
 * stopped.
 *
 * Gameplay timestamps MUST read gameTime.now(), never clock.elapsedTime or
 * performance.now(): those bases keep running through pause (THREE.Clock's
 * getDelta is called even for render-only frames) and disagree on their zero
 * point besides. Wall-clock time stays correct only for input-layer state
 * that must work before lock (main.ts's double-tap-W window) and cosmetic
 * DOM fades (hud.ts).
 */
export const gameTime = new GameClock();

// ---------- Shared mutable game state ----------
/** Player entity shape — see `player` below for the live instance. */
export interface PlayerState {
  /** EYE position (not feet); physics uses eyeHeight as ground-rest y. */
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  onGround: boolean;
  hp: number;
  alive: boolean;
  radius: number;
  eyeHeight: number;
}

/**
 * Player entity. `pos` is the EYE position (not feet); physics uses
 * `eyeHeight` as the ground-rest y value. Crouch only offsets the camera,
 * not `pos` itself.
 */
export const player: PlayerState = {
  pos: new THREE.Vector3(0, 1.7, 48),
  vel: new THREE.Vector3(),
  onGround: true,
  hp: 100,
  alive: true,
  radius: 0.45,
  eyeHeight: 1.7,
};

/**
 * Ceiling on accumulated recoil units, applied in `weapons.ts:shoot()` when a
 * shot adds its kick. Decay rate (`recoilRecover`) and scope gating
 * (`scopeGate`) are per-weapon and independent of this — the cap only bounds
 * the climb. Each weapon's `punchRad` comment quotes its max angle at this cap.
 */
export const RECOIL_CAP = 6;
/**
 * Ceiling on the horizontal recoil random walk, in the same units as
 * RECOIL_CAP. Symmetric: `recoilYaw` lives in [-RECOIL_YAW_CAP, +RECOIL_YAW_CAP].
 * At the smg's punchRad that is roughly ±2° of sideways wander — a safety bound,
 * not a tuning knob: the mean-zero walk peaks around a third of it in play, so
 * `yawRecover` is what actually shapes the wander.
 */
export const RECOIL_YAW_CAP = 3;
/** Base (hip-fire) vertical FOV in degrees; every zoom target sits below this. */
export const BASE_FOV = 75;

/**
 * Weapon definitions (slot order = switch order via keys 1/2). Static stats
 * only — the live mutable copy is `weapon` below. zoomFovs are the scoped
 * FOV targets cycled with the mouse wheel while aiming (the smg has one
 * "iron sights" step); spreadMul is the ADS cone multiplier; inherent is the
 * weapon's resting shot cone in radians, before any stance/movement/spray.
 */
/**
 * Which weapon slot is live. A two-entry union, not `number`, because the
 * table below is statically populated and every consumer already branches on
 * `=== 0` / `=== 1`. Indexing a TUPLE by this union is exempt from
 * noUncheckedIndexedAccess, so `WEAPONS[wpn.slot]` is a plain WeaponDef and
 * the misses simply cannot happen rather than being guarded for.
 */
export type WeaponSlot = 0 | 1;

/** The slots, for iterating both without widening the index back to `number`. */
export const SLOTS: readonly WeaponSlot[] = [0, 1];

export const WEAPONS: readonly [WeaponDef, WeaponDef] = [
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
    sprayCap: 4,       // hard ceiling on the multiplier (rested = 1). Sustained
                       // fire alone tops out near 1.9 (see sprayRecover), so in
                       // practice this only ever bites via switchWeapon's
                       // re-clamp of spray carried in from the other slot
    sprayRecover: 0.29, // multiplier units/s — MUST stay below sustained-fire input
                        // (~9.5 shots/s × sprayKick = 0.57/s), or the drain outpaces
                        // accumulation and sprays never bloom at all. Necessary but
                        // NOT sufficient: decay runs DURING fire, so what actually
                        // accumulates is (sprayKick − sprayRecover × fireRate) per
                        // shot = 0.0296 here. A full 30-round mag therefore peaks at
                        // spray ≈ 1.9 — +39% on the standing hip cone — and settles
                        // back in ~3.1 s. At 0.45 the net was 0.0128/shot: a mag
                        // reached only 1.28 and sustained fire cost ~12%.
    recoilRecover: 6, // recoil units/s — MUST stay below the sustained-fire input
                      // (~9.5 shots/s × recoilKick = 9.5/s), or the drain outpaces
                      // accumulation and spray never climbs (it just vibrates).
                      // 6 → full 6-unit climb in ~1.3 s, ~1 s settle-back
                      // (vertical only; the horizontal walk has its own
                      // yawRecover — draining it at THIS rate zeroed it between
                      // every shot, which is how horizontal recoil shipped inert)
    punchRad: 0.012,   // radians of aim climb per recoil unit — sustained spray
                       // climbs toward ~4° at RECOIL_CAP, pull down to compensate
    yawKick: 0.4,      // ± horizontal recoil units per shot — a ZERO-MEAN random
                       // walk (capped at RECOIL_YAW_CAP), so its drift grows with
                       // √shots, not shots: simulated over a mag the offset at
                       // fire time is ~0.22° typical, ~0.6° worst, ~1° in the tail
    yawRecover: 0.5,   // horizontal units/s — separate from recoilRecover because
                       // the walk is mean-zero: what must stay below the input is
                       // the drain per shot interval (0.5 × 0.105 = 0.053) vs the
                       // MEAN kick (yawKick/2 = 0.2). Draining faster than that
                       // returns recoilYaw to 0 before the next shot and no bullet
                       // is ever displaced — only the camera twitches.
                       // 0.5 → a typical mag-end walk clears in well under a second
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
    spreadMul: 0.03, // near-laser when scoped and still (~0.19" @ 50 m crouched)
    inherent: 0.0029, // rest-cone rad — hip-fire ≈ 6.3" @ 50 m, like the smg's
    sprayKick: 0.25, recoilKick: 4,
    sprayCap: 3,
    recoilRecover: 13, // slow settle (~0.3 s) — bolt-action feel; also gates re-scoping
    punchRad: 0.02,    // radians of aim climb per recoil unit — one meaty ~4.6°
                       // kick per shot that settles slowly with the recoil
    yawKick: 0.8,      // ± horizontal recoil units per shot — up to ~±0.92° of
                       // sideways jump on the big punch, real guns kick crooked
    yawRecover: 13,    // matches recoilRecover: like the vertical climb, the walk
                       // settles FULLY inside the 1.1 s bolt cycle, so every shot
                       // leaves from a centred aim point. Deliberate over-drain —
                       // the same semiAuto exemption AGENTS.md records for
                       // recoilRecover; the kick is a per-shot jolt, not a walk.
    sprayRecover: 0.08, // slow settle matches the bolt-action feel (input ≈ 0.9 shots/s × 0.25)
    scopeGate: 0.5,    // RMB re-scope is blocked until recoil decays below this
    scopedOverlay: true, // full-screen scope reticle replaces the viewmodel
    semiAuto: true,      // one shot per LMB press; holding does nothing
    unscopeOnShot: true, // firing kicks you out of the scope (re-press RMB)
  },
];

/** Per-slot saved ammo, so switching weapons doesn't magically refill mags. */
export interface AmmoStore {
  mag: number;
  reserve: number;
}

/** Per-slot saved ammo, so switching weapons doesn't magically refill mags. */
export const ammoStore: [AmmoStore, AmmoStore] = [
  { mag: WEAPONS[0].magSize, reserve: WEAPONS[0].reserveMax },
  { mag: WEAPONS[1].magSize, reserve: WEAPONS[1].reserveMax },
];

/**
 * Live state of the ACTIVE weapon. Stat fields are copied from
 * WEAPONS[wpn.slot] by switchWeapon() in weapons.ts; HUD/combat read this
 * object only. A subset of WeaponDef plus mutable ammo/reload bookkeeping —
 * deliberately NOT a WeaponDef, since Object.assign in switchWeapon copies
 * only the fields listed here.
 */
export interface LiveWeapon {
  name: string;
  magSize: number;
  mag: number;
  reserve: number;
  fireRate: number;
  lastShot: number;
  reloading: boolean;
  reloadTime: number;
  reloadEnd: number;
  damage: number;
  headshotMult: number;
  recoilRecover: number;
}

// WEAPONS is a tuple, so this needs no assertion — slot 0 exists by type.
const SMG = WEAPONS[0];

/** Live state of the ACTIVE weapon. Initialized to slot 0. */
export const weapon: LiveWeapon = {
  name: SMG.name,
  magSize: SMG.magSize, mag: SMG.magSize, reserve: SMG.reserveMax,
  fireRate: SMG.fireRate,
  lastShot: 0,
  reloading: false, reloadTime: SMG.reloadTime, reloadEnd: 0,
  damage: SMG.damage,
  headshotMult: SMG.headshotMult,
  recoilRecover: SMG.recoilRecover,
};

/** Reset both slots' ammo and mirror slot 0 into `weapon`. Used on respawn. */
export function resetAmmo(): void {
  SLOTS.forEach(i => { ammoStore[i].mag = WEAPONS[i].magSize; ammoStore[i].reserve = WEAPONS[i].reserveMax; });
  weapon.name = SMG.name;
  weapon.magSize = SMG.magSize; weapon.mag = SMG.magSize; weapon.reserve = SMG.reserveMax;
  weapon.fireRate = SMG.fireRate; weapon.reloadTime = SMG.reloadTime;
  weapon.damage = SMG.damage; weapon.headshotMult = SMG.headshotMult;
  weapon.recoilRecover = SMG.recoilRecover;
  weapon.reloading = false;
}

/** Maps selectable from the start menu (?map= URL param). */
export type MapName = 'arena' | 'range';

// ---------- Owner-scoped slices ----------
// The old single `game` bag, split by owning system. Each slice documents its
// WRITER(S); every other module reads. The slices still live here in the
// shared-state home — the split is about ownership clarity, not new module
// homes. window.__cs.game keeps its historical flat shape through a
// delegation-only facade built at the debug hook in main.ts; gameplay code
// imports slices directly.

/** Session-level flags. Written by main.ts (startup ?map= read, pointer-lock events). */
export interface SessionState {
  // Map is chosen at page load via ?map=range (start-menu buttons trigger a
  // full reload); there is deliberately no hot-swapping of scenes at runtime.
  // main.ts overwrites this from the URL at startup — reading `location` here
  // would break this module's importability in Node.
  map: MapName;
  /** Pointer lock active (Esc/menu releases it). */
  locked: boolean;
  /** First Play click happened; distinguishes pause from pre-game. */
  started: boolean;
}

export const session: SessionState = {
  map: 'arena',
  locked: false,
  started: false,
};

/**
 * Raw button state (LMB/RMB/sprint). Written by main.ts's event handlers —
 * plus one weapons.ts write (`shoot()` clears `aiming` on unscopeOnShot) —
 * and read by player/weapons/hud. Tracked as state rather than one-shot
 * events because firing is continuous in updateWeapon.
 */
export interface InputState {
  /** LMB held. */
  shooting: boolean;
  /** RMB held (iron sights). */
  aiming: boolean;
  /** Double-tapped W and still holding it (sprint). */
  running: boolean;
}

export const input: InputState = {
  shooting: false,
  aiming: false,
  running: false,
};

/**
 * Look angles, in radians. Written by main.ts's mousemove handler (pitch
 * clamped there) and combat.ts's respawn; read by player.ts's movement
 * forward vector and by weapons.ts's currentAimPitch/currentAimYaw — the
 * shared source for both camera and shot direction.
 *
 * These are the BASE angles. Recoil punch is added on top per read
 * (sim/recoil.ts), never folded in here — routing the view punch into the
 * base would steer the player's legs and fight the mouse.
 */
export interface AimState {
  /** Look yaw; 0 = facing -z, Math.PI would face the arena's rear wall. */
  yaw: number;
  pitch: number;
}

export const aim: AimState = {
  yaw: 0,
  pitch: 0,
};

/**
 * Weapon DYNAMICS — the live accuracy/recoil/ADS state driven by firing and
 * per-frame upkeep. Written by weapons.ts (shoot, switchWeapon, updateWeapon);
 * combat.ts's respawn() resets it to round-start values; main.ts and hud.ts
 * read it (scope gate, wheel zoom, zoom label).
 *
 * Lerp values (`adsLerp`) are smoothed 0..1 blends updated every frame;
 * never set them directly from input.
 */
export interface WeaponDynamics {
  /** CURRENT total shot cone (radians), recomputed each frame in weapons.ts. */
  spread: number;
  /** Shot-cone MULTIPLIER, 1 at rest (not 0 — it multiplies). */
  spray: number;
  recoil: number;
  recoilYaw: number;
  adsLerp: number;
  /** Active weapon index into WEAPONS (0 smg, 1 sniper). */
  slot: WeaponSlot;
  /** Scoped zoom step: index into WEAPONS[slot].zoomFovs. */
  zoomLevel: number;
  zoomScale: number;
}

export const wpn: WeaponDynamics = {
  spread: 0.001,   // CURRENT total shot cone (radians); recomputed each frame
                   // in weapons.ts from (stance + movement + air) × spray,
                   // plus the weapon's inherent cone, all × ADS. Do not add
                   // to it directly — kick `spray` instead.
  spray: 1,        // shot-cone MULTIPLIER, 1 at rest (not 0 — it multiplies).
                   // +sprayKick per shot up to the weapon's sprayCap, decaying
                   // back toward 1 at sprayRecover/s. Scales only the
                   // situational terms; `inherent` is unaffected by it.
  recoil: 0,       // drives viewmodel kick; decays at weapon.recoilRecover/s.
                   // While above WEAPONS[slot].scopeGate, a new RMB press
                   // can't enter the scope (main.ts)
  recoilYaw: 0,    // SIGNED horizontal recoil, same units as `recoil`. Each shot
                   // adds up to ±yawKick — a random walk, clamped to
                   // ±RECOIL_YAW_CAP, that the player steers against. Decays
                   // toward 0 at the weapon's own yawRecover/s — NOT at
                   // recoilRecover, which drains fast enough to zero the walk
                   // between shots.
  adsLerp: 0,
  slot: 0,         // active weapon index into WEAPONS (0 smg, 1 sniper)
  zoomLevel: 0,    // scoped zoom step: index into WEAPONS[slot].zoomFovs
  zoomScale: 1,    // mouse-sensitivity multiplier; <1 while zoomed so aiming
                   // doesn't get twitchy at 12x (computed in weapons.ts)
};

/** Misc per-frame / transient flags — see the slices above/below. */
export interface GameState {
  /** 0..1 sprint acceleration blend; ~0.2 s ramp to full speed. */
  runLerp: number;
  moveLerp: number;
  crouchLerp: number;
  airLerp: number;
  stepTimer: number;
  bobAmt: number;
  scoreKills: number;
  scoreDeaths: number;
  roundTime: number;
}

/**
 * Remaining unowned-yet fields of the old `game` bag — shrinks as each slice
 * (see above) absorbs its fields. Deleted when the last one leaves.
 *
 * Lerp values (`crouchLerp`, `adsLerp`) are smoothed 0..1 blends updated
 * every frame; never set them directly from input.
 */
export const game: GameState = {
  runLerp: 0,      // 0..1 sprint acceleration blend; ~0.2 s ramp to full speed
  moveLerp: 0,     // smoothed actual speed ÷ walk speed (idle 0, walk 1, run 1.5);
                   // drives the movement accuracy penalty
  crouchLerp: 0,
  airLerp: 0,      // 0..1 airborne blend; eases the jump accuracy penalty in and
                   // out over ~100-200 ms so it doesn't snap on takeoff/landing
  stepTimer: 0.2,  // countdown to next footstep sound
  bobAmt: 0,       // current view-bob amplitude, computed in player.ts
  scoreKills: 0,   // shown as "CT" score
  scoreDeaths: 0,  // shown as "T" score
  roundTime: 115,  // seconds; resets to 1:55 when it expires
};

/** Raw keyboard state by `event.code`. Written in main.ts, read in player.ts. */
export const keys: Record<string, boolean | undefined> = {};
