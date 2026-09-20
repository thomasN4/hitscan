// sim/botWeapons.ts — how a BOT shoots one catalog weapon.
//
// Pure and engine-free, like the rest of sim/. The weapon's mechanical stats
// arrive as a WeaponDef PARAMETER rather than through a runtime import of
// core/state.ts. sim/validateWeapons.ts also receives the catalog through that
// seam, but separately imports its shared numeric caps from state at runtime;
// this module's dependency is stricter. BotWeaponId, WeaponDef and HitZone come
// in type-only, as Team does in soundEvents.ts and HitZone does in melee.ts.
//
// The division this file owns: a BotBrain decides WHETHER to shoot; a
// FireController owns everything about WHAT is being shot — cadence, burst
// discipline, the magazine and its reload, the hit die and the hit zone. The
// brain asks ready() and calls pull(); the executor calls resolve() with the
// post-move distance and routes the damage. All of a bot's dice still come
// from the brain's own rng stream, which is why the controller is handed it
// rather than reaching for Math.random.
import type { BotPrimaryId, BotSecondaryChoice, BotSidearmId, BotWeaponChoice, BotWeaponId, HitZone, WeaponDef } from '../core/state';
import { SWAP_DELAY } from './weaponSwap';
import { isLowAmmo, planReload, roundInterval, roundTransfer } from './ammo';
import { damageForPart } from './damage';
import type { BrainParams } from './botBrains';

/**
 * Spawn-stagger bounds (seconds) for a bot's FIRST shot of a life: min plus
 * rng()*span. Deliberately NOT per-weapon — the stagger exists so a fresh wave
 * does not volley in unison, which is a property of the wave rather than of
 * what it is holding. These are the numbers BrainParams.firstDelayMin/Span
 * carried before the weapon tranche, kept exactly so respawn cadence is
 * unchanged.
 */
export const FIRST_SHOT_DELAY_MIN = 1;
export const FIRST_SHOT_DELAY_SPAN = 2;

/**
 * What every bot weapon has, blade or firearm: how a bot MOVES and PACES with it.
 */
export interface BotWeaponPosture {
  /**
   * Seconds from a burst's LAST shot to the next pull: min + rng()*span.
   * Within a burst the interval is the def's own fireRate exactly and takes no
   * draw. burstPauseMin must be at least fireRate — a shorter pause would let
   * a bot out-shoot the catalog weapon it is holding — and the test suite
   * asserts that over the real table.
   */
  burstPauseMin: number;
  burstPauseSpan: number;
  /** Closer than this (3D): back off. Overrides BrainParams.nearBand. */
  nearBand: number;
  /** Farther than this (3D): approach. Overrides BrainParams.farBand. */
  farBand: number;
  /** Never shoot beyond this 3D range. Overrides BrainParams.engageRange. */
  engageRange: number;
  /** Perpendicular drift weight. Overrides BrainParams.strafeFactor. */
  strafeFactor: number;
}

/**
 * Bot-only tuning for one catalog FIREARM: how a BOT shoots and positions
 * with it. Everything mechanical — fireRate, magSize, reserveMax, reloadTime,
 * perRound, damage, headshotMult, pellets — comes from the WeaponDef beside
 * it and is NOT restated here. Two sources for one number is the thing this
 * split exists to avoid.
 */
export interface BotRangedTuning extends BotWeaponPosture {
  kind: 'ranged';
  /** Per-RAY hit chance at point blank. */
  hitChanceNear: number;
  /** Per-ray falloff divisor: chance = near - dist / this. */
  hitChanceDivisor: number;
  /**
   * Per-ray floor. Zero is legal and load-bearing: it is what gives the
   * shotgun a hard cliff instead of a long tail of lucky pellets, and it is
   * the only way a weapon can be genuinely harmless at range.
   */
  hitChanceMin: number;
  /** Probability a landed ray strikes the head. */
  headChance: number;
  /** Probability a landed ray strikes the legs; the remainder is torso. */
  legChance: number;
  /**
   * Rounds committed to one trigger commitment before the pause. 1 means every
   * shot is its own decision — every semi-auto, and the shotgun.
   */
  burst: number;
}

/**
 * Bot-only tuning for the catalog BLADE. A knife bot closes to contact and
 * swings through sim/melee.ts instead of rolling the per-ray hit die, so it
 * has no per-ray chance, no falloff divisor and no zone weights — only the
 * shared posture: how it moves and how it paces its swings.
 */
export interface BotMeleeTuning extends BotWeaponPosture {
  kind: 'melee';
}

export type BotWeaponTuning = BotRangedTuning | BotMeleeTuning;

/**
 * How each catalog weapon is fought with.
 *
 * The tuning rule these numbers were chosen against: expected damage per
 * second at 10 m stays in roughly 6-12, where the pre-weapon bot sat at 6.1
 * (0.525 hit chance x 15 mean damage / 1.3 s cadence). The tranche changes bot
 * CHARACTER, not bot lethality — character comes from the shape of each curve,
 * not its height, which is why the divisors differ by an order of magnitude
 * while the resulting dps barely does.
 *
 * A full Record keyed by BotWeaponId, like every other per-weapon table in the
 * repo (VIEWMODELS, SHOT_SFX, AMBIENCE): widening WeaponId fails to compile
 * here until the new weapon says how a bot uses it. The knife row is a melee
 * posture — no hit die, only how the blade closes and paces — because a melee
 * bot swings through sim/melee.ts (bots.ts:swing) rather than rolling
 * resolve() below.
 */
export const BOT_WEAPON_TUNING: Record<BotWeaponId, BotWeaponTuning> = {
  ak47: {
    kind: 'ranged',
    // SMG hit odds and burst pacing, with rifle stand-off distance.
    hitChanceNear: 0.30, hitChanceDivisor: 70, hitChanceMin: 0.05,
    headChance: 0.12, legChance: 0.20,
    burst: 3, burstPauseMin: 0.9, burstPauseSpan: 0.6,
    nearBand: 12, farBand: 24, engageRange: 55, strafeFactor: 0.5,
  },
  smg: {
    kind: 'ranged',
    // Sprays and closes: three-round bursts, a mediocre per-ray chance, and a
    // falloff that still leaves it useful across an arena.
    hitChanceNear: 0.30, hitChanceDivisor: 70, hitChanceMin: 0.05,
    headChance: 0.12, legChance: 0.20,
    burst: 3, burstPauseMin: 0.9, burstPauseSpan: 0.6,
    // Bands, engage range and drift are DELIBERATELY the shipped
    // DEFAULT_BRAIN_PARAMS values (7 / 14 / 45 / 0.7) rather than tuned: the
    // smg is what every existing bot smoke phase is re-pinned to, so its
    // movement must be bit-identical to the bot those phases were written
    // against. Tune the other four; leave this row alone.
    nearBand: 7, farBand: 14, engageRange: 45, strafeFactor: 0.7,
  },
  sniper: {
    kind: 'ranged',
    // Reaches: the divisor is nearly 3x anything else's, so its curve is close
    // to flat and it is the only weapon that threatens across the whole map.
    // engageRange matches perception.ts's PERCEPTION_RANGE_M on purpose —
    // anything a sniper bot can SEE, it can shoot at.
    //
    // headChance is deliberately BELOW every other weapon's despite this being
    // the precise one: headshotMult 4 on damage 60 is a 240-damage instant
    // kill from anywhere inside 80 m, and one lucky draw a playtester never
    // saw coming reads as broken rather than as skill.
    hitChanceNear: 0.30, hitChanceDivisor: 200, hitChanceMin: 0.12,
    headChance: 0.08, legChance: 0.16,
    burst: 1, burstPauseMin: 1.4, burstPauseSpan: 0.6,
    // Holds its range instead of closing, and drifts less while it does.
    nearBand: 25, farBand: 45, engageRange: 80, strafeFactor: 0.25,
  },
  shotgun: {
    kind: 'ranged',
    // A cliff, not a curve: hitChanceMin 0 with a divisor of 24 means the
    // curve genuinely REACHES zero at 10.1 m, which is what makes a shotgun
    // bot safe to walk away from rather than merely unlikely to hit. It is
    // the only weapon in the table that hits exactly nothing at range, and
    // that trade is what buys it ~34 dps at contact against ~18 for the smg.
    //
    // headChance is 0.05 — less than half the others — and that is the fix
    // the dps gate forced. Eight pellets each rolling a x4 headshot put this
    // weapon at 57 dps point blank, four times any other. A shot pattern
    // lands on a body; letting every pellet roll for the skull models a
    // volley of aimed rounds, which is not what a choke does.
    hitChanceNear: 0.42, hitChanceDivisor: 24, hitChanceMin: 0,
    headChance: 0.05, legChance: 0.20,
    burst: 1, burstPauseMin: 1.2, burstPauseSpan: 0.4,
    nearBand: 2, farBand: 7, engageRange: 12, strafeFactor: 0.9,
  },
  pistol: {
    kind: 'ranged',
    // Taps and closes. The player's 0.1 s fire rate is a click ceiling, not a
    // pace anything should sustain; a bot taps at roughly two-thirds of a
    // second, which is what keeps 34-damage torso hits fair.
    hitChanceNear: 0.30, hitChanceDivisor: 80, hitChanceMin: 0.05,
    headChance: 0.12, legChance: 0.20,
    burst: 1, burstPauseMin: 0.5, burstPauseSpan: 0.4,
    nearBand: 5, farBand: 12, engageRange: 30, strafeFactor: 0.7,
  },
  revolver: {
    kind: 'ranged',
    // Slow and heavy: the lowest hit chance in the table paired with the
    // second-highest damage, so it lands rarely and hurts when it does — and
    // its headshotMult 4 on 55 one-taps.
    hitChanceNear: 0.25, hitChanceDivisor: 90, hitChanceMin: 0.03,
    headChance: 0.12, legChance: 0.20,
    burst: 1, burstPauseMin: 0.8, burstPauseSpan: 0.4,
    nearBand: 6, farBand: 14, engageRange: 35, strafeFactor: 0.7,
  },
  knife: {
    // Closes and STAYS closed: nearBand 0 means no band ever pushes a knife
    // bot back off a target, and farBand keeps it approaching until it is
    // inside its own reach.
    //
    // engageRange sits INSIDE WEAPONS.knife.range (2.0 m) on purpose. The
    // brain's gate measures eye-to-eye 3D distance while the swing measures
    // eye to a PART, and a torso point sits ~0.55 m off that line — so a gate
    // set at the reach itself would order swings that sim/melee.ts then has to
    // refuse. 1.8 m is the reach minus that slack.
    kind: 'melee',
    burstPauseMin: 0.45, burstPauseSpan: 0.25,
    nearBand: 0, farBand: 1.2, engageRange: 1.8, strafeFactor: 0.5,
  },
};

/**
 * Every PRIMARY a bot may be handed, in a stable order. Listed rather than
 * derived from BOT_WEAPON_TUNING's keys because Object.keys erases the union
 * back to string[]; botWeapons.test.ts asserts the primaries agree with the
 * tuning table's primary rows, so a weapon added to one but not the other
 * fails the suite rather than quietly changing the mixed draw. The mixed draw
 * covers primaries only — sidearms arrive via the secondary position and the
 * blade via the fallback every loadout already carries.
 */
export const BOT_PRIMARY_IDS: readonly BotPrimaryId[] =
  ['smg', 'sniper', 'shotgun', 'ak47'];

/**
 * Turn a menu/URL bot-primary setting into the weapon ONE bot carries.
 * `'mixed'` draws uniformly over BOT_PRIMARY_IDS and spends one draw; a named
 * id spends none, so a forced-weapon match consumes no randomness at all and
 * a smoke phase pinning a weapon perturbs nothing else.
 */
export function resolveBotWeapon(choice: BotWeaponChoice, rng: () => number): BotPrimaryId {
  if (choice !== 'mixed') return choice;
  const i = Math.min(BOT_PRIMARY_IDS.length - 1, Math.floor(rng() * BOT_PRIMARY_IDS.length));
  // Bound-guarded read: i is clamped into range above, so the index cannot
  // miss (AGENTS.md's rule on dynamic index reads).
  return BOT_PRIMARY_IDS[i]!;
}

/** One realized trigger pull, already resolved to damage. */
export interface ShotOutcome {
  /** Summed damage over every landed ray. Zero is a clean miss. */
  damage: number;
  /**
   * Zone to attribute the kill to: head if ANY ray headed, else torso if any
   * torso, else legs; null on a clean miss. A multi-ray pull gets ONE zone for
   * the same reason weapons.ts gives the player one hitmarker per trigger pull
   * reddened by any head pellet — the killfeed reports the pull, not a pellet.
   */
  zone: HitZone | null;
  /** Rays fired this pull (the def's pellets, or 1). Record only. */
  rays: number;
  /** Rays that landed. Record only. */
  hits: number;
}

/**
 * The weapon half of a bot: cadence, magazine and ballistics for one catalog
 * weapon. A brain composes one; it never subclasses for a weapon.
 */
export interface FireController {
  readonly weapon: BotWeaponId;
  /** Rounds chambered. Display only. */
  readonly mag: number;
  /** Magazine capacity, straight from the catalog def. Display only. */
  readonly magSize: number;
  /** Rounds held in reserve. Display only. */
  readonly reserve: number;
  /** A reload is running. Display only. */
  readonly reloading: boolean;
  /**
   * How the executor must realize a pull. 'ranged' resolves through resolve()
   * below; 'melee' means the hit is GEOMETRY — bots.ts swings through
   * sim/melee.ts and never asks this controller for damage.
   */
  readonly resolution: 'ranged' | 'melee';
  /**
   * Movement policy for the ACTIVE weapon, laid over the shipped base — bands,
   * engage range and drift. Everything else in BrainParams is
   * weapon-independent and passes through untouched. Takes no draws.
   */
  params(base: BrainParams): BrainParams;
  /**
   * Per-life reset: full magazine and reserve, no reload in flight, a fresh
   * burst, and ONE draw for the spawn stagger.
   *
   * Called from DefaultBrain's constructor and onRespawn(), never from this
   * class's own constructor — and that is load-bearing rather than fussy. The
   * brain's documented construction draw order is [strafeDir, stagger]; a
   * controller that drew in its constructor would have to be built before the
   * brain that owns its rng, putting the stagger first and silently shifting
   * every scripted rng sequence in the suite by one.
   */
  arm(): void;
  /**
   * Advance the cadence and any running reload, and start one when policy
   * allows. Called once per decide() in EVERY mode, so a reload finishes while
   * the bot searches, routes or patrols rather than only while it is shooting.
   * Takes no draws.
   * @param engaged the bot is in a firefight right now — a partial magazine is
   *   topped up only in a lull, never mid-engagement unless it is empty
   */
  tick(dt: number, engaged: boolean): void;
  /** Cadence elapsed, a round chambered, and no reload in the way. */
  ready(): boolean;
  /**
   * Commit one trigger pull: spend the round, restart the cadence, and take
   * the burst-pause draw if this shot ended the burst. Ordering a pull that
   * ready() refused is a caller bug; the round is spent regardless, exactly as
   * the pre-weapon cooldown was.
   */
  pull(): void;
  /**
   * Resolve the pull the executor is realizing, at post-move eye-to-eye
   * `dist`: one hit draw per ray, then one zone draw per LANDED ray.
   */
  resolve(dist: number): ShotOutcome;
  /** Per-ray hit probability at `dist`. The curve itself — no draw. */
  hitChance(dist: number): number;
}

/**
 * Per-ray hit probability at eye-to-eye `dist`: a linear falloff from
 * hitChanceNear, floored. Pure and exported for its own pins — the shape is
 * the whole difference between a sniper and a shotgun.
 */
export function botHitChance(dist: number, tuning: BotRangedTuning): number {
  return Math.max(tuning.hitChanceMin, tuning.hitChanceNear - dist / tuning.hitChanceDivisor);
}

/**
 * The movement policy for a weapon: the shipped defaults with this weapon's
 * bands, engage range and drift applied over them. Everything else a brain
 * uses — climb gates, the stall latch, scan cadence, patrol pause, damage
 * advance — is weapon-independent and stays exactly as DEFAULT_BRAIN_PARAMS
 * has it.
 */
export function botBrainParams(tuning: BotWeaponPosture, base: BrainParams): BrainParams {
  return {
    ...base,
    nearBand: tuning.nearBand,
    farBand: tuning.farBand,
    engageRange: tuning.engageRange,
    strafeFactor: tuning.strafeFactor,
  };
}

/**
 * What one position of a loadout must offer. It is `FireController` plus what
 * only the loadout needs.
 */
export interface FirePosition extends FireController {
  /** This position's own tuning, so the loadout can derive the active BrainParams. */
  readonly tuning: BotWeaponTuning;
  /**
   * No rounds anywhere: this position is spent for the rest of the life.
   * A firearm is dry when its magazine AND reserve are empty and no reload is
   * running; a blade never is.
   */
  readonly dry: boolean;
  /** Refill to a full magazine and reserve, cancelling any reload. Takes NO draws. */
  load(): void;
  /**
   * Hold the trigger for exactly `seconds` — the spawn stagger, or a swap.
   * Takes NO draws, and SETS the wait rather than extending it.
   *
   * Absolute on purpose. arm() holds every position for the drawn stagger but
   * tick() advances only the active one, so an untouched position's cooldown
   * is frozen at its spawn value however long the primary fought. Taking the
   * max here made a late swap serve out that stale 1-3 s stagger instead of
   * SWAP_DELAY; the position being switched TO is precisely the one whose
   * clock is meaningless.
   */
  waitFor(seconds: number): void;
}

/** The shipped FireController: one catalog firearm, fought by the table above. */
export class WeaponFireController implements FirePosition {
  readonly weapon: BotWeaponId;
  private rounds: number;
  private held: number;
  /** Seconds until the next pull is allowed. */
  private cooldown = 0;
  /** Rounds left in the current burst commitment. */
  private burstLeft: number;
  private inReload = false;
  /** Seconds left of a whole-magazine swap; unused while perRound. */
  private reloadLeft = 0;
  /** Seconds to the next per-round transfer; unused while whole-magazine. */
  private nextRoundIn = 0;

  constructor(
    weapon: BotWeaponId,
    private readonly def: WeaponDef,
    readonly tuning: BotRangedTuning,
    private readonly rng: () => number,
  ) {
    this.weapon = weapon;
    // No draws here: arm() owns them, and the brain calls it. See arm().
    this.rounds = def.magSize;
    this.held = def.reserveMax;
    this.burstLeft = tuning.burst;
  }

  get mag(): number { return this.rounds; }
  get magSize(): number { return this.def.magSize; }
  get reserve(): number { return this.held; }
  get reloading(): boolean { return this.inReload; }
  readonly resolution = 'ranged' as const;

  arm(): void {
    this.load();
    this.waitFor(FIRST_SHOT_DELAY_MIN + this.rng() * FIRST_SHOT_DELAY_SPAN);
  }

  tick(dt: number, engaged: boolean): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.inReload) this.advanceReload(dt);
    else this.considerReload(engaged);
  }

  ready(): boolean {
    if (this.cooldown > 0 || this.rounds <= 0) return false;
    // A per-round reload is interruptible: the weapon is shootable mid-reload
    // with whatever has already transferred, and pull() cancels the rest —
    // the CS-style behavior weapons.ts gives the player's shotgun and
    // revolver. A whole-magazine swap is not.
    return !this.inReload || this.def.perRound === true;
  }

  pull(): void {
    // Cancelling the logic is only half of a per-round interrupt (issue #123):
    // flipping inReload also drops the executor's reload pose on the same
    // frame, via its snap to rest while not reloading (bots.ts).
    if (this.inReload && this.def.perRound === true) {
      this.inReload = false;
      this.nextRoundIn = 0;
    }
    this.rounds = Math.max(0, this.rounds - 1);
    this.burstLeft--;
    // The burst ends when it runs out OR the magazine does; either way the
    // pause is drawn exactly once, so the draw count per pull is a function of
    // the burst position alone and never of how the burst happened to end.
    if (this.burstLeft <= 0 || this.rounds <= 0) {
      this.burstLeft = this.tuning.burst;
      this.cooldown = this.tuning.burstPauseMin + this.rng() * this.tuning.burstPauseSpan;
    } else {
      this.cooldown = this.def.fireRate;
    }
  }

  resolve(dist: number): ShotOutcome {
    const rays = this.def.pellets ?? 1;
    const chance = this.hitChance(dist);
    let hits = 0;
    let damage = 0;
    let headed = false;
    let torsoed = false;
    for (let i = 0; i < rays; i++) {
      if (this.rng() >= chance) continue;
      hits++;
      const zone = this.rollZone();
      damage += damageForPart(this.def, zone);
      if (zone === 'head') headed = true;
      else if (zone === 'torso') torsoed = true;
    }
    const zone: HitZone | null = hits === 0 ? null : headed ? 'head' : torsoed ? 'torso' : 'legs';
    return { damage, zone, rays, hits };
  }

  hitChance(dist: number): number {
    return botHitChance(dist, this.tuning);
  }

  params(base: BrainParams): BrainParams {
    return botBrainParams(this.tuning, base);
  }

  load(): void {
    this.rounds = this.def.magSize;
    this.held = this.def.reserveMax;
    this.burstLeft = this.tuning.burst;
    this.inReload = false;
    this.reloadLeft = 0;
    this.nextRoundIn = 0;
    this.cooldown = 0;
  }

  waitFor(seconds: number): void {
    this.cooldown = seconds;
  }

  get dry(): boolean {
    return this.rounds <= 0 && this.held <= 0 && !this.inReload;
  }

  /** One draw: head, else legs, else torso. */
  private rollZone(): HitZone {
    const draw = this.rng();
    if (draw < this.tuning.headChance) return 'head';
    if (draw < this.tuning.headChance + this.tuning.legChance) return 'legs';
    return 'torso';
  }

  /**
   * Reload when dry, or when low and NOT in a firefight. isLowAmmo is the same
   * per-weapon third-of-a-magazine rule the player's HUD hint uses, which also
   * means a weapon whose full magazine is 10 (the sniper) never chases a
   * top-up it does not need.
   */
  private considerReload(engaged: boolean): void {
    const wants = this.rounds <= 0 || (!engaged && isLowAmmo(this.rounds, this.def.magSize));
    if (!wants) return;
    // A bot is only ticked while alive and in a live match, and it never aims
    // down sights or sprints — those player-state gates are constants here.
    // The gate that matters (partial magazine, rounds available) is shared.
    const { start } = planReload({
      started: true, alive: true, reloading: this.inReload,
      mag: this.rounds, magSize: this.def.magSize, reserve: this.held,
      aiming: false, sprinting: false,
    });
    if (!start) return;
    this.inReload = true;
    if (this.def.perRound === true) {
      this.nextRoundIn = roundInterval(this.def.reloadTime, this.def.magSize);
    } else {
      this.reloadLeft = this.def.reloadTime;
    }
  }

  private advanceReload(dt: number): void {
    if (this.def.perRound === true) {
      const interval = roundInterval(this.def.reloadTime, this.def.magSize);
      this.nextRoundIn -= dt;
      while (this.inReload && this.nextRoundIn <= 0) {
        const moved = roundTransfer(this.rounds, this.def.magSize, this.held);
        this.rounds = moved.mag;
        this.held = moved.reserve;
        if (moved.done) this.inReload = false;
        else this.nextRoundIn += interval;
      }
      return;
    }
    this.reloadLeft -= dt;
    if (this.reloadLeft > 0) return;
    const take = Math.min(this.def.magSize - this.rounds, this.held);
    this.rounds += take;
    this.held -= take;
    this.inReload = false;
  }
}

/**
 * The blade half of a bot: cadence for one catalog knife, fought by the
 * posture of its tuning row. A blade holds no rounds, so there is no
 * magazine, no reserve and no reload — mag, magSize and reserve are 0 and
 * reloading is false, mirroring WEAPONS.knife's own zeroed ammo fields.
 *
 * Draw discipline matches a burst-of-one firearm exactly — one draw in arm()
 * for the spawn stagger, one draw per pull() for the pause — so the brain's
 * per-frame draw contract is identical for a blade bot and no scripted rng
 * sequence in botBrains.test.ts moves.
 */
export class MeleeFireController implements FirePosition {
  readonly weapon: BotWeaponId;
  /** Seconds until the next swing is allowed. */
  private cooldown = 0;

  constructor(
    weapon: BotWeaponId,
    readonly tuning: BotMeleeTuning,
    private readonly rng: () => number,
  ) {
    this.weapon = weapon;
    // No draws here: arm() owns them, and the brain calls it. See arm().
  }

  get mag(): number { return 0; }
  get magSize(): number { return 0; }
  get reserve(): number { return 0; }
  get reloading(): boolean { return false; }
  readonly resolution = 'melee' as const;

  arm(): void {
    this.load();
    this.waitFor(FIRST_SHOT_DELAY_MIN + this.rng() * FIRST_SHOT_DELAY_SPAN);
  }

  load(): void {
    this.cooldown = 0;
  }

  waitFor(seconds: number): void {
    this.cooldown = seconds;
  }

  get dry(): boolean {
    return false;
  }

  params(base: BrainParams): BrainParams {
    return botBrainParams(this.tuning, base);
  }

  /** `engaged` is not taken at all: there is no reload for it to gate. */
  tick(dt: number): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
  }

  ready(): boolean {
    // Nothing else: there is no magazine to be empty and no reload to be in
    // the way.
    return this.cooldown <= 0;
  }

  pull(): void {
    this.cooldown = this.tuning.burstPauseMin + this.rng() * this.tuning.burstPauseSpan;
  }

  /**
   * A blade fires no rays, so rays: 0 is an honest record rather than a
   * fabricated miss — and the safe no-op for a caller that failed to branch on
   * resolution first. `dist` is not taken: nothing here depends on it.
   */
  resolve(): ShotOutcome {
    return { damage: 0, zone: null, rays: 0, hits: 0 };
  }

  /** A blade has no per-ray chance, at any distance. */
  hitChance(): number {
    return 0;
  }
}

/**
 * Build the controller one catalog weapon needs: the tuning row's own kind
 * decides, so a weapon that changes shape changes it in ONE place. Takes no
 * draws — arm() owns them, for the construction-order reason it documents.
 */
export function makeFireController(
  weapon: BotWeaponId,
  def: WeaponDef,
  tuning: BotWeaponTuning,
  rng: () => number,
): FirePosition {
  return tuning.kind === 'melee'
    ? new MeleeFireController(weapon, tuning, rng)
    : new WeaponFireController(weapon, def, tuning, rng);
}

/**
 * Seconds a swap costs before the next position can fire — bots AND the
 * player (sim/weaponSwap.ts:SWAP_DELAY, issue #15). Fixed, and it takes NO
 * draw: every random draw a bot makes is positionally scripted by
 * botBrains.test.ts.
 *
 * Re-exported here so existing importers keep working; the constant lives in
 * weaponSwap.ts because the player's switchWeapon/main.ts gates read it too.
 * It exists because a swap that cost nothing would let a bot fire its sidearm
 * in the same frame its rifle ran out, which reads as a second weapon
 * appearing rather than as a bot reaching for one.
 */
export { SWAP_DELAY } from './weaponSwap';

/**
 * One bot's whole weapon ladder: an ordered list of POSITIONS that delegates
 * the whole FireController surface to whichever is active. When a position
 * runs out of rounds entirely it is spent for the life, and the loadout falls
 * to the next one. The blade at the bottom never runs out.
 */
export class BotLoadout implements FireController {
  private i = 0;

  constructor(
    private readonly positions: FirePosition[],
    private readonly rng: () => number,
  ) {
    if (positions.length === 0) throw new Error('a bot loadout needs at least one position');
  }

  private get active(): FirePosition {
    return this.positions[this.i]!;
  }

  get weapon(): BotWeaponId { return this.active.weapon; }
  get mag(): number { return this.active.mag; }
  get magSize(): number { return this.active.magSize; }
  get reserve(): number { return this.active.reserve; }
  get reloading(): boolean { return this.active.reloading; }
  get resolution(): 'ranged' | 'melee' { return this.active.resolution; }

  params(base: BrainParams): BrainParams {
    return this.active.params(base);
  }

  arm(): void {
    for (const p of this.positions) p.load();     // no draws
    this.i = 0;
    // Exactly ONE draw, applied to every position so a swap during the
    // stagger cannot bypass it. The random-draw contract in the plan: three
    // positions each taking their own stagger draw would shift every scripted
    // rng sequence in botBrains.test.ts by two.
    const stagger = FIRST_SHOT_DELAY_MIN + this.rng() * FIRST_SHOT_DELAY_SPAN;
    for (const p of this.positions) p.waitFor(stagger);
  }

  tick(dt: number, engaged: boolean): void {
    this.active.tick(dt, engaged);
    // The dry swap. A spent position stays spent for the life — the ladder
    // only descends, and the blade at the bottom is never dry. Ticking only
    // the active position is deliberate: the ones below it are full and have
    // nothing to reload, and the ones above are finished.
    while (this.i < this.positions.length - 1 && this.active.dry) {
      this.i++;
      this.active.waitFor(SWAP_DELAY);
    }
  }

  ready(): boolean {
    return this.active.ready();
  }

  pull(): void {
    this.active.pull();
  }

  resolve(dist: number): ShotOutcome {
    return this.active.resolve(dist);
  }

  hitChance(dist: number): number {
    return this.active.hitChance(dist);
  }
}

/**
 * Every SECONDARY a bot may be handed, in a stable order. Listed rather than
 * derived for the same reason as BOT_PRIMARY_IDS: Object.keys erases the
 * union. Primaries are not in the pool — they belong to the primary position
 * — and neither is the blade, which is already every loadout's last position.
 */
export const BOT_SIDEARM_IDS: readonly BotSidearmId[] =
  ['pistol', 'revolver'];

/**
 * Turn a menu/URL secondary setting into the sidearm ONE bot carries there.
 * Every bot always carries one. `'mixed'` draws uniformly over
 * BOT_SIDEARM_IDS and spends one draw; a named id spends none, like
 * resolveBotWeapon.
 */
export function resolveBotSecondary(choice: BotSecondaryChoice, rng: () => number): BotSidearmId {
  if (choice !== 'mixed') return choice;
  const i = Math.min(BOT_SIDEARM_IDS.length - 1, Math.floor(rng() * BOT_SIDEARM_IDS.length));
  // Bound-guarded read: i is clamped into range above, so the index cannot
  // miss (AGENTS.md's rule on dynamic index reads).
  return BOT_SIDEARM_IDS[i]!;
}

/**
 * Build one bot's loadout: [primary, secondary, knife]. The blade is ALWAYS
 * the last position — it is the one weapon that cannot run out, which is what
 * makes the ladder terminate. The positions are disjoint by type (a primary
 * can never equal a sidearm or the blade), so there is no dedupe to do.
 *
 * `defOf` is a lookup rather than a runtime import of core/state.ts's catalog —
 * the same seam WeaponFireController takes its WeaponDef through.
 */
export function makeBotLoadout(
  primary: BotPrimaryId,
  secondary: BotSidearmId,
  defOf: (id: BotWeaponId) => WeaponDef,
  rng: () => number,
): BotLoadout {
  const ids: BotWeaponId[] = [primary, secondary, 'knife'];
  const positions = ids.map(id => makeFireController(id, defOf(id), BOT_WEAPON_TUNING[id], rng));
  return new BotLoadout(positions, rng);
}
