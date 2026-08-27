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
import type { BrainMode } from '../sim/botBrains';

// ---------- Domain vocabulary ----------
/**
 * Picker column / loadout position a weapon belongs in. `melee` is NOT a
 * picker column — the knife is always carried and never picked — but the
 * catalog classes every def so the picker's card builder can route/skip.
 */
export type WeaponClass = 'primary' | 'secondary' | 'melee';

/** Catalog ids — stable strings; the loadout slice and the picker use them. */
export type WeaponId = 'smg' | 'sniper' | 'shotgun' | 'pistol' | 'revolver' | 'knife';

/**
 * Static stats for one weapon, shaped like the WEAPONS entries below.
 *
 * The optional fields are per-weapon extras — the sniper's scope gate /
 * semi-auto / unscope-on-shot trio and the shotgun's pellets count. Every
 * consumer must tolerate their absence (the smg has no scope gate, fires
 * full-auto, does not kick you out of iron sights, and fires one ray).
 */
export interface WeaponDef {
  name: string;
  /** Which picker column / loadout position this weapon may occupy. */
  class: WeaponClass;
  magSize: number;
  reserveMax: number;
  /** Seconds between shots (0.075 = 800 RPM for the smg). */
  fireRate: number;
  reloadTime: number;
  /**
   * Damage per body hit per RAY; legs x0.75, head x headshotMult. With
   * pellets > 1 several rays land per trigger pull, so `damage` is per pellet.
   */
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
  /** Hitscan rays fired per trigger pull, each sampled in the live cone.
   *  Absent means a single ray. Shotgun only. */
  pellets?: number;
  /**
   * Fixed mutual spread of a multi-ray trigger pull (radians) — the choke.
   * Sampled INDEPENDENTLY of stance: ADS/crouch/movement move where the
   * pattern's CENTER points (the situational cone) but never tighten or open
   * the pattern itself. Required whenever `pellets` is present; shotgun only.
   */
  pelletCone?: number;
  /**
   * Exaggeration applied when projecting this weapon's cone into the
   * crosshair gap (sim/accuracy.ts:crosshairGapPx). Absent means the shared
   * CROSSHAIR_GAIN (6) — the readability gain that keeps stance/movement
   * deltas visible at hip-fire spreads, at the cost of arms far wider than
   * the real group. A weapon whose cone is already large opts into 1 (the
   * literal scatter bound) instead: the shotgun does, because 6x on its
   * fixed pelletCone pushed the arms ~6x past the actual group and read as
   * broken next to the other weapons' few-pixel gaps (playtest round 3).
   * validateWeapons floors this at 1 — arms inside the true scatter would
   * claim pellets land tighter than they do.
   */
  crosshairGain?: number;
  /**
   * Reload spends `reloadTime` moving rounds ONE AT A TIME (shotgun shells,
   * revolver chambers): one round transfers every reloadTime/magSize seconds,
   * and firing cancels the remainder CS-style — you shoot whatever is already
   * chambered. Absent means the classic whole-mag swap: nothing moves until
   * the timer completes.
   */
  perRound?: boolean;
  /** Recoil below which a fresh RMB press may enter the scope. Sniper only. */
  scopeGate?: number;
  /** One shot per LMB press; holding does nothing. Sniper only. */
  semiAuto?: boolean;
  /** Firing kicks you out of the scope (re-press RMB). Sniper only. */
  unscopeOnShot?: boolean;
  /**
   * Melee weapon: swings instead of firing — no ammo, no reload, no cone —
   * and the trigger path branches to a short-range arc test (sim/melee.ts).
   * Absent means a firearm. RMB is inert while held.
   */
  melee?: boolean;
  /**
   * Reach of a melee swing, in metres from the eye. Required whenever
   * `melee` is present and meaningless otherwise — the same pairing rule
   * as pellets/pelletCone (validateWeapons owns both directions of it).
   */
  range?: number;
  /**
   * Total apex angle (radians) of the swing cone: a strike point connects
   * when its angular offset from the view direction is at most arcRad/2.
   * Required whenever `melee` is present.
   */
  arcRad?: number;
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
  /** Kills credited to this bot this match (any opposing casualty it dealt) — scoreboard only. */
  kills: number;
  /** Times this bot died this match — scoreboard only. */
  deaths: number;
  /** Resting on support this frame; false while airborne. Written by the executor's vertical stage. */
  onGround: boolean;
  /** Whether LAST frame's step was rejected by world collision — the brain's obstacle feedback. */
  moveBlocked: boolean;
  /** What the bot's brain is doing, for the DEV readout. Display only. */
  mode: BrainMode;
  /** Waypoints of the route the bot is walking, nav-graph order; empty when it is steering directly. Display only. */
  readonly navPath: readonly THREE.Vector3[];
  /** How far along `navPath` the bot has got — waypoints before this are consumed. Display only. */
  readonly navLeg: number;
  /** Eye position of whatever the bot is currently targeting, or null when it has none. Display only. */
  readonly targetEye: THREE.Vector3 | null;
  /** Whether that target sits inside the brain's engage range. Display only. */
  readonly targetInRange: boolean;
  /**
   * Result of a line-of-sight probe against the current target this frame,
   * or null when none was taken (overlay off, or no live target). Display
   * only — the probe itself is DEV-gated; see bots.ts.
   */
  readonly targetLOS: boolean | null;
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
 * Which weapon POSITION is live: 0 = primary, 1 = secondary, 2 = knife.
 * What positions 0/1 hold comes from `loadout` (see equippedId below);
 * position 2 is the always-carried knife — never picked, so `SLOTS`
 * covers only the two positions the picker fills.
 */
export type WeaponSlot = 0 | 1 | 2;

/** The PICKED positions, for iterating both without widening the index to `number`. */
export const SLOTS: readonly WeaponSlot[] = [0, 1];

/**
 * The full weapon catalog, keyed by id. A Record over the WeaponId union
 * keeps the no-miss-indexing property the tuple used to provide: every key
 * exists statically, so `WEAPONS[id]` is a plain WeaponDef under
 * noUncheckedIndexedAccess. Static stats only — the live mutable copy is
 * `weapon` below. zoomFovs are the scoped FOV targets cycled with the mouse
 * wheel while aiming (single-entry weapons have one "iron sights" step);
 * spreadMul is the ADS cone multiplier; inherent is the weapon's resting
 * shot cone in radians, before any stance/movement/spray.
 */
export const WEAPONS: Record<WeaponId, WeaponDef> = {
  smg: {
    name: 'SMG',
    class: 'primary',
    magSize: 30, reserveMax: 90,
    fireRate: 0.075, // seconds between shots — 800 RPM (~13.3 rounds/sec)
    reloadTime: 2.2,
    damage: 26,      // per body shot (4 to kill); legs x0.75,
    headshotMult: 2, // head x2 -> TWO headshots to kill (playtest round 1:
                     // one-tap smg heads were too free at this fire rate)
    zoomFovs: [55],  // iron sights
    spreadMul: 0.3,
    inherent: 0.0031, // rest-cone rad — ADS crouched ≈ 2" @ 50 m; hip ≈ 6.7" @ 50 m
    sprayKick: 0.06, recoilKick: 1,
    sprayCap: 4,       // hard ceiling on the multiplier (rested = 1). Sustained
                       // fire alone tops out near 1.9 (see sprayRecover), so in
                       // practice this only ever bites via switchWeapon's
                       // re-clamp of spray carried in from the other slot
    sprayRecover: 0.29, // multiplier units/s — MUST stay below sustained-fire input
                        // (13.3 shots/s × sprayKick = 0.8/s), or the drain outpaces
                        // accumulation and sprays never bloom at all. Necessary but
                        // NOT sufficient: decay runs DURING fire, so what actually
                        // accumulates is (sprayKick − sprayRecover × fireRate) per
                        // shot = 0.0383 here. A full 30-round mag therefore peaks at
                        // spray ≈ 2.15 — about +50% on the standing hip cone — and
                        // settles back in ~4 s.
    recoilRecover: 6, // recoil units/s — MUST stay below the sustained-fire input
                      // (13.3 shots/s × kick 1 = 13.3/s), or the drain outpaces
                      // accumulation and spray never climbs (it just vibrates).
                      // Net ≈ +0.55 unit/shot → full 6-unit climb in ~11 rounds
                      // (~0.82 s) of sustained fire, ~1 s settle-back
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
                       // the drain per shot interval (0.5 × 0.075 = 0.038) vs the
                       // MEAN kick (yawKick/2 = 0.2). Draining faster than that
                       // returns recoilYaw to 0 before the next shot and no bullet
                       // is ever displaced — only the camera twitches.
                       // 0.5 → a typical mag-end walk clears in well under a second
    scopedOverlay: false,
  },
  sniper: {
    name: 'SNIPER',
    class: 'primary',
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
  shotgun: {
    name: 'SHOTGUN',
    class: 'primary',
    magSize: 7, reserveMax: 28,
    fireRate: 0.9,   // pump-action pacing (~1.1 shots/sec)
    reloadTime: 3.2,
    damage: 13,      // PER PELLET × pellets: 8 body hits = 104 — the point-blank
                     // one-tap that decays hard with range as the cone spreads
                     // pellets off target; legs x0.75, head x4 = 52/pellet
    headshotMult: 4,
    pellets: 8,      // independent hitscan rays per trigger pull
    pelletCone: 0.06, // rad — THE fixed pattern (the choke): sampled the same in
                      // every stance, so ADS/crouch steady WHERE the pattern
                      // points without shrinking it. Playtest round 2 balance:
                      // 3x the shipped 0.02 — ~1.2 m group at 20 m (half-angle
                      // 0.03 rad), so mid-range pulls whiff hard.
    zoomFovs: [60],  // bead sight
    spreadMul: 0.6,  // steadies the AIM layer only — see pelletCone for why the
                     // pattern itself must not tighten
    inherent: 0.002, // rad — aim-wobble floor only; the PATTERN lives in
                     // pelletCone above (playtest round 1: pellets used to ride
                     // inside wpn.spread, so aiming/crouching shrank the whole
                     // group — unrealistically sniper-like)
    crosshairGain: 1, // draw the LITERAL pattern bound: the shared 6x gain on
                      // the big pelletCone put the arms ~91 px out at 720p vs
                      // ~15 px of real scatter — ~6x past the group, which
                      // playtesters read as broken next to the other weapons'
                      // few-pixel gaps (playtest round 3). The aim layer is
                      // tiny next to the pattern, so little readability is
                      // lost; movement still blooms the arms ~2x.
    sprayKick: 0.15, recoilKick: 5,
    sprayCap: 3,
    sprayRecover: 0.08, // sustained-fire input bound = 0.15/0.9 ≈ 0.167/s — clears
                        // it; semiAuto exempts the recoil rates but NEVER the
                        // spray accumulator (validateWeapons header)
    recoilRecover: 7,   // full settle inside the ~0.9 s pump cycle, bolt-action style;
                        // semiAuto exemption like the sniper's
    punchRad: 0.016,    // rad/unit — one meaty shoulder hit ≈ 3.4°, ~5.5° max climb
    yawKick: 1.2,       // pumps kick crooked
    yawRecover: 7,      // deliberate over-drain like the sniper: a per-shot jolt,
                        // not a walk — settled before the next pump stroke lands
    scopedOverlay: false,
    semiAuto: true,     // one trigger pull = one shell; holding does nothing
    perRound: true,     // shell-by-shell reload; firing cancels the rest (playtest round 2)
  },
  pistol: {
    name: 'PISTOL',
    class: 'secondary',
    magSize: 12, reserveMax: 36,
    fireRate: 0.1,   // semi-auto pacing — 600 RPM click ceiling (playtest round 2:
                     // the old 0.17 capped clickers near 350 RPM; nothing else
                     // gates refire, so this constant IS the ceiling)
    reloadTime: 1.8,
    damage: 34,      // three torso shots to kill; legs x0.75
    headshotMult: 2, // head x2 -> TWO headshots to kill (playtest round 1,
                     // matching the smg's rebalance)
    zoomFovs: [58],  // iron sights
    spreadMul: 0.35,
    inherent: 0.0033, // rest-cone rad — a touch looser than the smg's; hip ≈ 7.1" @ 50 m
    sprayKick: 0.08, recoilKick: 2,
    sprayCap: 3,
    sprayRecover: 0.15, // input ≈ 10 shots/s × 0.08 = 0.8/s at the new ceiling — clears the
                        // sustained-fire bound (the ONLY accumulator rule semiAuto does NOT
                        // exempt); net ≈ +0.065/shot so a full 12-round mag peaks near spray 1.75
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
  revolver: {
    name: 'REVOLVER',
    class: 'secondary',
    magSize: 6, reserveMax: 24,
    fireRate: 0.45,  // semi-auto pacing (~2.2 shots/sec click ceiling)
    reloadTime: 3.0, // moon-clip style: slower than the pistol, hits far harder
    damage: 55,      // two torso shots to kill; head x4 one-taps with room to spare
    headshotMult: 4,
    zoomFovs: [56],  // iron sights
    spreadMul: 0.3,
    inherent: 0.0035, // rest-cone rad — a touch looser than the pistol's
    sprayKick: 0.12, recoilKick: 4,
    sprayCap: 3,
    sprayRecover: 0.12, // input ≈ 2.2 shots/s × 0.12 = 0.267/s — clears the sustained-fire
                        // bound; net ≈ +0.066/shot so a six-shot string peaks near spray 1.4
    recoilRecover: 9,   // tap-fire settle; exempt from the sustained-fire bound as a
                        // semiAuto weapon (see validateWeapons header)
    punchRad: 0.02,     // rad/unit — a heavy ~2.6° jolt per shot, ~6.9° over the cap climb
    yawKick: 0.9,
    yawRecover: 9,      // same semiAuto exemption as recoilRecover — per-shot jolts,
                        // not a walk, and the slow pacing lets each settle
    scopedOverlay: false,
    semiAuto: true,     // one shot per LMB press; holding does nothing
    perRound: true,     // chamber-by-chamber reload; firing cancels the rest (playtest round 2)
  },
  knife: {
    name: 'KNIFE',
    class: 'melee',  // not a picker column — always carried (key 3), never picked
    magSize: 0, reserveMax: 0, // a blade holds no rounds — melee is exempt from the
                               // ammo bounds in validateWeapons, and this zero IS
                               // the contract rather than broken tuning
    fireRate: 0.45,  // swing cadence (~2.2 swings/sec click ceiling)
    reloadTime: 0,   // never reloads; tryReload() no-ops on a melee def
    damage: 55,      // two swings to kill ANYWHERE on the body; legs x0.75
    headshotMult: 1, // NO head premium. The arc strikes the NEAREST part, and
                     // point-blank that is usually the head — with x4 every
                     // close swing one-tapped (the smoke phase measured -120
                     // hp), making the free fallback out-gun the revolver in
                     // its own niche. A blade cuts the same at any height.
    zoomFovs: [70],  // placeholder for the non-empty-zoomFovs invariant; RMB is
                     // inert while melee (updateWeapon gates adsLerp off)
    spreadMul: 1,    // unused: a swing samples no cone
    inherent: 0.002, // feeds only the resting crosshair gap
    sprayKick: 0.05, recoilKick: 0.35,
    sprayCap: 1.5,
    sprayRecover: 0.1, // input = 0.05/0.45 ≈ 0.111/s — clears the bound (it applies to
                       // every weapon, semiAuto included). Spray moves nothing here but
                       // the crosshair gap.
    recoilRecover: 8,
    punchRad: 0.008,   // rad/unit — ~1° lunge per swing, ~2.7° at the cap: the swing
                       // reads through the viewmodel kick (recoil channel), with just
                       // enough camera nudge to feel physical
    yawKick: 0.2,
    yawRecover: 8,     // semiAuto exemption as the other semi weapons; each swing's
                       // jolt settles long before the next
    scopedOverlay: false,
    semiAuto: true,    // one swing per LMB press
    melee: true,
    range: 2.0,        // metres from the eye a strike reaches
    arcRad: 0.6,       // rad (~34°) total apex angle — forgiving CS-style arc
  },
};

/** Per-position saved ammo, so switching weapons doesn't magically refill mags. */
export interface AmmoStore {
  mag: number;
  reserve: number;
}

/**
 * Per-POSITION saved ammo (not per weapon): swapping slots swaps whatever is
 * loaded in each position. Rebuilt from the equipped defs by armLoadout() —
 * position 2 (the knife) holds no rounds and armLoadout leaves it at zero.
 */
export const ammoStore: [AmmoStore, AmmoStore, AmmoStore] = [
  { mag: WEAPONS.smg.magSize, reserve: WEAPONS.smg.reserveMax },
  { mag: WEAPONS.pistol.magSize, reserve: WEAPONS.pistol.reserveMax },
  { mag: 0, reserve: 0 },
];

/**
 * Live state of the ACTIVE weapon. Stat fields are copied from
 * WEAPONS[equippedId(wpn.slot)] by switchWeapon() in weapons.ts; HUD/combat
 * read this
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
  /**
   * Game time the NEXT per-round reload transfer lands at (perRound weapons
   * only; inert while not reloading). Advanced by weapons.ts:updateWeapon per
   * transferred round — unlike reloadEnd it has no completion meaning, it is
   * purely the shell/chamber scheduler.
   */
  nextRoundAt: number;
  damage: number;
  headshotMult: number;
  recoilRecover: number;
}

// ---------- Loadout ----------
/**
 * Which catalog weapon occupies each loadout POSITION (0 primary,
 * 1 secondary). Written ONLY by setLoadout() — the picker's Deploy — and
 * read everywhere through equippedId().
 */
export interface LoadoutState {
  primary: WeaponId;
  secondary: WeaponId;
}

export const loadout: LoadoutState = { primary: 'smg', secondary: 'pistol' };

/** The most recently DEPLOYED loadout; the picker pre-fills from it. */
export const lastLoadout: LoadoutState = { primary: 'smg', secondary: 'pistol' };

/**
 * Weapon id held in loadout position `slot`. Positions 0/1 resolve through
 * the loadout slice; position 2 is always the knife — the one weapon the
 * picker never touches.
 */
export function equippedId(slot: WeaponSlot): WeaponId {
  return slot === 0 ? loadout.primary : slot === 1 ? loadout.secondary : 'knife';
}

/** Live state of the ACTIVE weapon. Initialized to the default loadout's primary. */
export const weapon: LiveWeapon = {
  name: WEAPONS.smg.name,
  magSize: WEAPONS.smg.magSize, mag: WEAPONS.smg.magSize, reserve: WEAPONS.smg.reserveMax,
  fireRate: WEAPONS.smg.fireRate,
  lastShot: 0,
  reloading: false, reloadTime: WEAPONS.smg.reloadTime, reloadEnd: 0, nextRoundAt: 0,
  damage: WEAPONS.smg.damage,
  headshotMult: WEAPONS.smg.headshotMult,
  recoilRecover: WEAPONS.smg.recoilRecover,
};

/**
 * Refill both positions' ammo from their equipped defs and mirror the PRIMARY
 * weapon into the live `weapon` object. The ONE place "make ammo and the live
 * weapon match the loadout" happens — boot, Deploy and respawn all land here.
 */
export function armLoadout(): void {
  SLOTS.forEach(i => {
    const def = WEAPONS[equippedId(i)];
    ammoStore[i].mag = def.magSize;
    ammoStore[i].reserve = def.reserveMax;
  });
  const primary = WEAPONS[loadout.primary];
  Object.assign(weapon, {
    name: primary.name,
    magSize: primary.magSize, mag: primary.magSize, reserve: primary.reserveMax,
    fireRate: primary.fireRate, reloadTime: primary.reloadTime,
    damage: primary.damage, headshotMult: primary.headshotMult,
    recoilRecover: primary.recoilRecover,
    reloading: false,
    nextRoundAt: 0,
  });
}

/**
 * Commit a picked loadout: validate the class split (a corrupted caller is a
 * named crash here rather than silently swapped stats), remember it as the
 * next picker's pre-fill, and arm it immediately. Deploy in menu.ts's handler
 * (via main.ts) is the only writer.
 */
export function setLoadout(primary: WeaponId, secondary: WeaponId): void {
  if (WEAPONS[primary].class !== 'primary') throw new Error(`${primary} is not a primary weapon`);
  if (WEAPONS[secondary].class !== 'secondary') throw new Error(`${secondary} is not a secondary weapon`);
  loadout.primary = primary;
  loadout.secondary = secondary;
  lastLoadout.primary = primary;
  lastLoadout.secondary = secondary;
  armLoadout();
}

function isWeaponId(v: string): v is WeaponId {
  return v in WEAPONS;
}

/**
 * Validate untrusted persisted data (sessionStorage JSON) into a
 * LoadoutState, or undefined when anything at all is off. Pure — the storage
 * IO lives in menu.ts; this only decides what may be applied.
 */
export function sanitizeLoadout(v: unknown): LoadoutState | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const { primary, secondary } = o;
  if (typeof primary !== 'string' || typeof secondary !== 'string') return undefined;
  if (!isWeaponId(primary) || !isWeaponId(secondary)) return undefined;
  if (WEAPONS[primary].class !== 'primary' || WEAPONS[secondary].class !== 'secondary') return undefined;
  return { primary, secondary };
}

/** Maps selectable from the start menu (the ?map= part of the config query). */
export type MapName = 'arena' | 'range' | 'elevation' | 'warehouse1' | 'warehouse2';

/**
 * A map's sky, fog and lighting.
 *
 * Lighting used to be four colour literals inlined in `initEngine()`, which
 * made every map share the arena's desert sun — fine while every map WAS a
 * sunlit desert, wrong the moment one is a steel warehouse. The table lives
 * here rather than in `core/engine.ts` because it is pure data over MapName:
 * that keeps it unit-testable (engine.ts is browser-only and banned from the
 * test suite by eslint's no-restricted-imports) and puts it beside the other
 * per-map Records the compiler already polices.
 */
export interface Ambience {
  /** Scene background AND fog colour — they must match or the horizon banding shows. */
  background: number;
  /** Distance (m) at which fog starts. */
  fogNear: number;
  /** Distance (m) at which fog is total. Keep under the camera's far plane (300). */
  fogFar: number;
  /** Directional "sun" colour. */
  sunColor: number;
  /** Hemisphere light sky colour (lights upward-facing surfaces). */
  hemiSky: number;
  /** Hemisphere light ground colour (bounce onto downward-facing surfaces). */
  hemiGround: number;
  /**
   * Directional "sun" intensity.
   *
   * Here rather than hardcoded in initEngine for the same reason the colours
   * are: maps/warehouse2.ts has a ROOF, so its interior gets no sun at all and
   * has to be lit by the hemisphere alone. A map that changes what light
   * reaches it has to be able to say so.
   */
  sunIntensity: number;
  /** Hemisphere light intensity — the only light under a roof. */
  hemiIntensity: number;
}

/**
 * The dusty outdoor look every map shipped with before ambience was per-map.
 * These are the exact values `initEngine()` used to hardcode, so the three
 * maps that reference it render identically to before (pinned in state.test.ts).
 */
export const DESERT_AMBIENCE: Ambience = {
  background: 0xbfae8f,
  fogNear: 40,
  fogFar: 140,
  sunColor: 0xffeecc,
  hemiSky: 0xfff3e0,
  hemiGround: 0x8a7a5c,
  sunIntensity: 1.4,
  hemiIntensity: 0.85,
};

/**
 * Per-map ambience. A full Record for the same reason as BUILDERS / SPAWN_Z /
 * SUBTITLES: adding a MapName must fail to compile until the new map says what
 * it looks like, rather than silently inheriting the desert.
 */
export const AMBIENCE: Record<MapName, Ambience> = {
  arena: DESERT_AMBIENCE,
  range: DESERT_AMBIENCE,
  elevation: DESERT_AMBIENCE,
  // Overcast daylight through a shed roof: cool grey-blue rather than sand.
  // Fog starts at 60 rather than 40 because a racking aisle runs the better
  // part of 90 m and the far end has to stay readable; 200 is still well
  // inside the camera's far plane.
  warehouse1: {
    background: 0x9aa3ad,
    fogNear: 60,
    fogFar: 200,
    sunColor: 0xf2f4f8,
    hemiSky: 0xdfe6ee,
    // Bright for a "ground" colour, and deliberately so: this is the only
    // light reaching faces the sun does not, and a concrete floor bounces a
    // lot. Taken down to a realistic dark grey it renders every shaded face
    // — parapets, stair risers, the dock lip — as a black silhouette you
    // cannot read the shape of.
    hemiGround: 0x7a828b,
    // Unchanged from when initEngine hardcoded them, so warehouse1 renders
    // exactly as it did before intensities became per-map.
    sunIntensity: 1.4,
    hemiIntensity: 0.85,
  },
  // Roofed shed inside a fenced yard. The sky colour is what you see over the
  // fence, so it stays an outdoor overcast; fog is tighter than warehouse1's
  // because the whole level fits in a 111 m diagonal rather than a 90 m aisle.
  //
  // The intensities are the point of this entry. The roof blocks the
  // directional sun over the entire interior, so indoors is lit by the
  // hemisphere ALONE — no direction, no shadows. Raising hemiIntensity past
  // the outdoor 0.85 is what stops the shell reading as a black box, and the
  // sun is kept at full strength because the yard is still open to it.
  warehouse2: {
    background: 0x8e99a6,
    fogNear: 45,
    fogFar: 170,
    sunColor: 0xf4f6fa,
    hemiSky: 0xd6dfe8,
    // Same argument as warehouse1's, and stronger: under a roof EVERY
    // interior face is a shaded face, so this colour is doing all the work.
    hemiGround: 0x848d97,
    sunIntensity: 1.4,
    hemiIntensity: 2.4,
  },
};

/**
 * The box a team's bots are drawn from when they enter or re-enter the world.
 *
 * `y` is what makes this more than the hardcoded band it replaces: it is the
 * FEET height of the zone, so a zone can sit on a catwalk rather than the
 * floor. maps/warehouse2.ts spawns one whole team five metres up, which is the
 * reason this type exists.
 *
 * The box must lie entirely over standable surface. Nothing here checks that —
 * bots.ts rejection-samples against `colliders`, which catches a candidate
 * INSIDE geometry but not one over thin air, and a zone hanging over a void
 * simply drops its bots.
 */
export interface SpawnZone {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Feet height of the zone's floor. 0 is open ground. */
  y: number;
}

/**
 * Where each team enters, per map.
 *
 * bots.ts used to draw every spawn from one hardcoded band — x ±45, |z| 20..55
 * — for every map, which is why maps/warehouse1.ts had to adopt the arena's
 * exact 120 x 120 footprint rather than the footprint it wanted
 * (maps/warehouse1.ts:25-27). A map smaller than that band strands bots
 * outside its own geometry.
 *
 * A full Record for the same reason as BUILDERS / SPAWN_Z / AMBIENCE: adding a
 * MapName must fail to compile until the new map says where its bots start.
 *
 * The first four entries reproduce that old band exactly — `x ∈ [-45, 45]`,
 * `|z| ∈ [20, 55]`, Ts on -z away from the player spawn and CTs mirrored —
 * so making this per-map changed nothing about the maps that predate it.
 * state.test.ts pins that.
 */
export const BOT_SPAWNS: Record<MapName, Record<Team, SpawnZone>> = {
  arena: {
    T:  { minX: -45, maxX: 45, minZ: -55, maxZ: -20, y: 0 },
    CT: { minX: -45, maxX: 45, minZ:  20, maxZ:  55, y: 0 },
  },
  range: {
    T:  { minX: -45, maxX: 45, minZ: -55, maxZ: -20, y: 0 },
    CT: { minX: -45, maxX: 45, minZ:  20, maxZ:  55, y: 0 },
  },
  elevation: {
    T:  { minX: -45, maxX: 45, minZ: -55, maxZ: -20, y: 0 },
    CT: { minX: -45, maxX: 45, minZ:  20, maxZ:  55, y: 0 },
  },
  warehouse1: {
    T:  { minX: -45, maxX: 45, minZ: -55, maxZ: -20, y: 0 },
    CT: { minX: -45, maxX: 45, minZ:  20, maxZ:  55, y: 0 },
  },
  // The asymmetric one, and the reason the table has a `y`. CTs muster in the
  // +z yard between the shell and the fence and have to come THROUGH a
  // doorway; Ts start already on the catwalk ring's -z band, five metres up.
  // Bounds are inset from the geometry by more than NAV_RADIUS so no draw
  // straddles an edge: the yard band stops short of the fence at z = 34 and
  // the shell wall at z = 20.5, the catwalk band short of the wall at
  // z = -19.5 and the void lip at z = -12.
  warehouse2: {
    T:  { minX: -28, maxX: 28, minZ: -19, maxZ: -13, y: 5.1 },
    CT: { minX: -26, maxX: 26, minZ:  23, maxZ:  32, y: 0 },
  },
};

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
 * main.ts at startup (parsed from the committed query string); locked/started
 * are written by main.ts's pointer-lock events, matchOver once by
 * combat.ts:endMatch, and `debugView` by debugView.ts's toggle.
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
  /**
   * Developer-facing bot-observation flag. The wireframe overlay, V binding,
   * and HUD readout are DEV-only, but the unconditional window.__cs facade may
   * set this in a production preview so smoke tests can activate diagnostic
   * LOS reads. Do not infer its value from the build mode alone.
   */
  debugView: boolean;
  /** The match has ended (clock expiry or elimination); written once by combat.ts:endMatch. */
  matchOver: boolean;
}

export const session: SessionState = {
  ...SESSION_DEFAULTS,
  locked: false,
  started: false,
  debugView: false,
  matchOver: false,
};

/**
 * Raw button state (LMB/RMB/sprint/crouch). Written by main.ts's event
 * handlers — plus two weapons.ts writes (`shoot()` clears `aiming` on
 * unscopeOnShot, and `tryReload()` clears it when a reload starts while the
 * sights are up: one motion at a time) — and read by player/weapons/hud.
 * Tracked as state rather than one-shot events because firing is continuous
 * in updateWeapon.
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
  /** Active loadout POSITION (0 primary, 1 secondary); the weapon itself is
   *  WEAPONS[equippedId(slot)] from the loadout slice. */
  slot: WeaponSlot;
  /** Position held immediately before `slot`: the target of the Q quick-swap.
   *  switchWeapon records the outgoing position here; combat.ts's respawn()
   *  resets it alongside `slot`. */
  lastSlot: WeaponSlot;
  /** Scoped zoom step: index into WEAPONS[equippedId(slot)].zoomFovs. */
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
                   // While above the live weapon's scopeGate, a new RMB press
                   // can't enter the scope (main.ts)
  recoilYaw: 0,    // SIGNED horizontal recoil, same units as `recoil`. Each shot
                   // adds up to ±yawKick — a random walk, clamped to
                   // ±RECOIL_YAW_CAP, that the player steers against. Decays
                   // toward 0 at the weapon's own yawRecover/s — NOT at
                   // recoilRecover, which drains fast enough to zero the walk
                   // between shots.
  adsLerp: 0,
  slot: 0,         // active loadout POSITION (0 primary, 1 secondary)
  lastSlot: 0,     // position held before `slot`, the Q swap target; respawn()
                   // pins it to the SECONDARY so the first Q works immediately
  zoomLevel: 0,    // scoped zoom step: index into WEAPONS[equippedId(slot)].zoomFovs
  zoomScale: 1,    // mouse-sensitivity multiplier; <1 while zoomed so aiming
                   // doesn't get twitchy at 12x (computed in weapons.ts)
};

/**
 * Match bookkeeping. Team counters have three writers: bots.ts increments
 * scoreKills on a CT-side kill (player or ally) and scoreDeaths when a T
 * downs a CT, combat.ts increments scoreDeaths when the player dies,
 * main.ts's loop counts roundTime down (arena only). The player counters
 * are the scoreboard's "You" row: bots.ts bumps playerKills on the player's
 * own kills and combat.ts bumps playerDeaths when the player dies. hud.ts
 * renders the top bar; menu.ts renders the end screen.
 */
export interface ScoreState {
  /** Shown as the CT score: player kills plus ally kills of Ts. */
  scoreKills: number;
  /** Shown as the T score: T-side kills — the player's deaths plus CT allies'. */
  scoreDeaths: number;
  /** Kills credited to YOU personally (excludes ally kills). */
  playerKills: number;
  /** Times YOU died personally (excludes ally deaths). */
  playerDeaths: number;
  /** Seconds left in the round; initialized from session.roundSeconds by
   *  main.ts. Expiry ends the match via combat.ts:endMatch — it is clamped
   *  at 0 rather than reset. */
  roundTime: number;
}

export const score: ScoreState = {
  scoreKills: 0,
  scoreDeaths: 0,
  playerKills: 0,
  playerDeaths: 0,
  roundTime: SESSION_DEFAULTS.roundSeconds,
};

/** Raw keyboard state by `event.code`. Written in main.ts, read in player.ts. */
export const keys: Record<string, boolean | undefined> = {};
