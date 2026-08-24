// core/state.ts — pure shared game state. NO browser APIs, NO renderer.
//
// This module must stay importable in plain Node (that is what makes the
// simulation unit-testable): it may use THREE's math classes (Vector3,
// Box3...) but must never touch `document`, `window`, `location`, or
// construct a WebGLRenderer. Engine singletons live in core/engine.ts
// instead — and browser-derived values (the match-config query string) are
// written in by main.ts at startup rather than read here.
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

/** Sides. The player is implicitly CT-side; Ts are the enemy wave. */
export type Team = 'T' | 'CT';

/** Structural shape of one bot (see bots.ts for the concrete class). */
export interface Bot {
  /** Per-match serial (1-based), stamped at construction — stable across deaths. */
  id: number;
  /** Debug-log/killfeed display name derived from team + per-team serial, e.g. 'T-3'. */
  name: string;
  /** Which side this bot fights for; drives targeting, spawns and scoring. */
  team: Team;
  mesh: THREE.Group;
  head: THREE.Mesh;
  torso: THREE.Mesh;
  legs: THREE.Mesh;
  hp: number;
  alive: boolean;
  update(dt: number, player: PlayerState): void;
  eyePos(): THREE.Vector3;
  /** @param killerName display name of a bot killer; omitted for player kills */
  die(part: HitZone, killerName?: string): void;
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
 * point besides. Wall-clock time stays correct only for cosmetics that run
 * behind menus (hud fades, muzzle-flash cleanup) and combat.ts's
 * death-screen delay, which fires DURING pause.
 */
export const gameTime = new GameClock();

// ---------- Shared mutable game state ----------
/** Player entity shape — see `player` below for the live instance. */
export interface PlayerState {
  /**
   * EYE position (not feet); feet height = pos.y − eyeHeight. Feet rest on
   * the support surface beneath them (collision.ts:supportHeightAt) — only
   * flat y = 0 away from elevated geometry. Crouch offsets the camera,
   * not `pos` itself.
   */
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  onGround: boolean;
  hp: number;
  alive: boolean;
  radius: number;
  eyeHeight: number;
}

/**
 * Player entity. `pos` is the EYE position (not feet); the feet ride at
 * pos.y − eyeHeight and rest on whatever surface is beneath them — on open
 * ground exactly y = 0, on stairs/platforms higher. Crouch only offsets the
 * camera, not `pos` itself.
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
 * Weapon definitions (slot order = switch order via keys 1/2/3). Static stats
 * only — the live mutable copy is `weapon` below. zoomFovs are the scoped
 * FOV targets cycled with the mouse wheel while aiming (the smg has one
 * "iron sights" step); spreadMul is the ADS cone multiplier; inherent is the
 * weapon's resting shot cone in radians, before any stance/movement/spray.
 */
/**
 * Which weapon slot is live. A three-entry union, not `number`, because the
 * table below is statically populated and every consumer already branches on
 * `=== 0` / `=== 1` / `=== 2`. Indexing a TUPLE by this union is exempt from
 * noUncheckedIndexedAccess, so `WEAPONS[wpn.slot]` is a plain WeaponDef and
 * the misses simply cannot happen rather than being guarded for.
 */
export type WeaponSlot = 0 | 1 | 2;

/** The slots, for iterating all without widening the index back to `number`. */
export const SLOTS: readonly WeaponSlot[] = [0, 1, 2];

export const WEAPONS: readonly [WeaponDef, WeaponDef, WeaponDef] = [
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
  {
    name: 'PISTOL',
    magSize: 12, reserveMax: 36,
    fireRate: 0.17,  // semi-auto pacing (~5.9 shots/sec click ceiling)
    reloadTime: 1.8,
    damage: 34,      // three torso shots to kill; head x4 = one-tap
    headshotMult: 4,
    zoomFovs: [58],  // iron sights
    spreadMul: 0.35,
    inherent: 0.0033, // rest-cone rad — a touch looser than the smg's; hip ≈ 7.1" @ 50 m
    sprayKick: 0.08, recoilKick: 2,
    sprayCap: 3,
    sprayRecover: 0.15, // input ≈ 5.9 shots/s × 0.08 = 0.47/s — clears the sustained-fire
                        // bound (the ONLY accumulator rule semiAuto does NOT exempt); net
                        // ≈ +0.054/shot so a full 12-round mag peaks near spray 1.65
    recoilRecover: 8,   // fast settle suits tap-fire; exempt from the sustained-fire bound
                        // as a semiAuto weapon (see validateWeapons header)
    punchRad: 0.016,    // rad of aim climb per unit — a snappy ~2° jolt per shot that
                        // settles in ~0.25 s; ~5.5° over the full RECOIL_CAP climb
    yawKick: 0.5,
    yawRecover: 6,      // same semiAuto exemption as recoilRecover — per-shot jolts, not
                        // a walk, and tap-fire pacing lets each settle before the next
    scopedOverlay: false,
    semiAuto: true,     // one shot per LMB press; holding does nothing
  },
];

/** Per-slot saved ammo, so switching weapons doesn't magically refill mags. */
export interface AmmoStore {
  mag: number;
  reserve: number;
}

/** Per-slot saved ammo, so switching weapons doesn't magically refill mags. */
export const ammoStore: [AmmoStore, AmmoStore, AmmoStore] = [
  { mag: WEAPONS[0].magSize, reserve: WEAPONS[0].reserveMax },
  { mag: WEAPONS[1].magSize, reserve: WEAPONS[1].reserveMax },
  { mag: WEAPONS[2].magSize, reserve: WEAPONS[2].reserveMax },
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

/** Maps selectable from the start menu (the ?map= part of the config query). */
export type MapName = 'arena' | 'range';

/**
 * Match-config defaults: what a bare URL (no params) means, and what every
 * garbage/out-of-range ?tbots=/?ctbots=/?time= value falls back to
 * (see core/sessionConfig.ts for the parser). The start-menu form initializes
 * from these too, so they are the single source for all of it.
 */
export const SESSION_DEFAULTS: Readonly<{
  map: MapName;
  botsT: number;
  botsCt: number;
  roundSeconds: number;
}> = {
  map: 'arena',
  botsT: 6,
  botsCt: 0,
  roundSeconds: 120,
};

// ---------- Owner-scoped slices ----------
// The old single `game` bag, split by owning system. Each slice documents its
// WRITER(S); every other module reads. The slices still live here in the
// shared-state home — the split is about ownership clarity, not new module
// homes. window.__cs.game keeps its historical flat shape through a
// delegation-only facade built at the debug hook in main.ts; gameplay code
// imports slices directly.

/**
 * Session-level configuration + flags. The config fields are written ONCE by
 * main.ts at startup (parsed from the committed query string); the flags are
 * written by main.ts's pointer-lock events.
 */
export interface SessionState {
  // Match settings are chosen pre-game in the start menu and committed as ONE
  // query string (?map=&tbots=&ctbots=&time=) via a full page reload — map
  // switching is a reload and there is deliberately no hot-swapping of scenes
  // at runtime. main.ts overwrites all four from core/sessionConfig.ts's parse
  // of the URL at startup — reading `location` here would break this module's
  // importability in Node.
  map: MapName;
  /** Enemy (T-side) bot count, clamped to 1..12 by the parser. */
  botsT: number;
  /** Allied (CT-side) bot count, 0..12 — stored only; allies don't exist yet. */
  botsCt: number;
  /** Round length in seconds. score.roundTime starts here AND resets here. */
  roundSeconds: number;
  /** Pointer lock active (Esc/menu releases it). */
  locked: boolean;
  /** First Play click happened; distinguishes pause from pre-game. */
  started: boolean;
}

export const session: SessionState = {
  ...SESSION_DEFAULTS,
  locked: false,
  started: false,
};

/**
 * Raw button state (LMB/RMB/sprint/crouch). Written by main.ts's event
 * handlers — plus one weapons.ts write (`shoot()` clears `aiming` on
 * unscopeOnShot) — and read by player/weapons/hud. Tracked as state rather
 * than one-shot events because firing is continuous in updateWeapon.
 */
export interface InputState {
  /** LMB held. */
  shooting: boolean;
  /** RMB held (iron sights). */
  aiming: boolean;
  /** Shift held, either side (sprint). */
  running: boolean;
  /** Crouch toggled by a Ctrl/C tap; effective only on ground. */
  crouching: boolean;
}

export const input: InputState = {
  shooting: false,
  aiming: false,
  running: false,
  crouching: false,
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
 * per-frame upkeep. Written by weapons.ts (shoot, switchWeapon, updateWeapon)
 * plus one main.ts write — its wheel handler steps zoomLevel while scoped;
 * combat.ts's respawn() resets it to round-start values; main.ts and hud.ts
 * read it (sensitivity scaling and scope gate, zoom label).
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
  /** Slot held immediately before `slot`: the target of the Q quick-swap.
   *  switchWeapon records the outgoing slot here; combat.ts's respawn()
   *  resets it alongside `slot`. */
  lastSlot: WeaponSlot;
  /** Scoped zoom step: index into WEAPONS[slot].zoomFovs. */
  zoomLevel: number;
  zoomScale: number;
}

/**
 * Movement/stance blends and feedback timers. Written by player.ts's
 * updateMovement (stage 1); combat.ts's respawn() resets the stance blends
 * so you don't respawn mid-air or mid-crouch; weapons.ts reads them to feed
 * the accuracy model and the sprint FOV kick.
 *
 * Every `*Lerp` here is a smoothed 0..1 blend updated each frame — never set
 * one directly from input.
 */
export interface MotionState {
  /** 0..1 sprint acceleration blend; ~0.2 s ramp to full speed. */
  runLerp: number;
  /** Smoothed actual speed ÷ walk speed (idle 0, walk 1, run 1.5). */
  moveLerp: number;
  crouchLerp: number;
  /** 0..1 airborne blend; see updateMovement for why it is written in stage 1. */
  airLerp: number;
  /**
   * Smoothed ground height the CAMERA rides (m). Physics snaps the feet to
   * support instantly — including 0.3 m step-ups on stairs — so the view
   * eases toward the true feet height instead of jittering per riser.
   * Camera y = groundSmoothY + eyeHeight − crouch drop.
   */
  groundSmoothY: number;
  stepTimer: number;
  bobAmt: number;
}

export const motion: MotionState = {
  runLerp: 0,      // 0..1 sprint acceleration blend; ~0.2 s ramp to full speed
  moveLerp: 0,     // smoothed actual speed ÷ walk speed (idle 0, walk 1, run 1.5);
                   // drives the movement accuracy penalty
  crouchLerp: 0,
  airLerp: 0,      // 0..1 airborne blend; eases the jump accuracy penalty in and
                   // out over ~100-200 ms so it doesn't snap on takeoff/landing
  groundSmoothY: 0, // camera's eased ground height; physics feet snap instantly,
                    // this blend hides the per-riser steps (see player.ts)
  stepTimer: 0.2,  // countdown to next footstep sound
  bobAmt: 0,       // current view-bob amplitude, computed in player.ts
};

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
  slot: 0,         // active weapon index into WEAPONS (0 smg, 1 sniper, 2 pistol)
  lastSlot: 0,     // slot held before `slot`, the Q swap target; respawn pins
                   // both to the smg so Q can't yank you across a death
  zoomLevel: 0,    // scoped zoom step: index into WEAPONS[slot].zoomFovs
  zoomScale: 1,    // mouse-sensitivity multiplier; <1 while zoomed so aiming
                   // doesn't get twitchy at 12x (computed in weapons.ts)
};

/**
 * Match bookkeeping. Three writers: bots.ts increments scoreKills on a
 * CT-side kill (player or ally) and scoreDeaths when a T downs a CT,
 * combat.ts increments scoreDeaths when the player dies, main.ts's loop
 * counts roundTime down (arena only). hud.ts renders.
 */
export interface ScoreState {
  /** Shown as the CT score: player kills plus ally kills of Ts. */
  scoreKills: number;
  /** Shown as the T score: T-side kills — the player's deaths plus CT allies'. */
  scoreDeaths: number;
  /** Seconds left in the round; initialized from session.roundSeconds by
   *  main.ts and reset there when it expires (expiry handling itself is a
   *  known placeholder — see the roadmap). */
  roundTime: number;
}

export const score: ScoreState = {
  scoreKills: 0,
  scoreDeaths: 0,
  roundTime: SESSION_DEFAULTS.roundSeconds,
};

/** Raw keyboard state by `event.code`. Written in main.ts, read in player.ts. */
export const keys: Record<string, boolean | undefined> = {};
