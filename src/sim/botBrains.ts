// botBrains.ts — bot decision policies as an engine-free seam.
//
// Division of labor with the concrete Bot (bots.ts): a BotBrain DECIDES,
// the Bot EXECUTES. Each frame the executor runs ONE visual acquisition
// (sim/perception.ts) over the opposing candidates and hands the brain a
// passive BrainView — own feet and facing, the frame's zero-or-one visual
// observation, movement feedback — then realizes the returned BrainIntent:
// applies the movement step under world collision, turns the body to the
// intent facing, aims the barrel at the intent lookAt, and realizes a shot
// only when the frame's observation agrees with the intent's focus. Nothing
// in here may import the engine, world, audio or DOM — that is what keeps
// the policies unit-testable in plain Node (botBrains.test.ts), the same
// seam pattern as recoil.ts:convertOnSwap.
//
// The default policy: with a current visual observation, engage — approach
// beyond farBand, back off inside nearBand, drift perpendicular with random
// jukes and a debounced wall-sense flip, sidestepping a sustained wedge
// without leaving engage, route when the observation sits a level up or band
// steering demonstrably cannot close, fire on cooldown. Sideways motion (drift,
// juke, jam slides) and the back-off are footing-guarded — a leg that would
// leave the ground is dropped rather than walked off an edge (#127); only the
// approach may drop off a deck on purpose. A direction-only incoming-fire
// bearing outranks everything for one frame and starts a damage-armed search
// where the shot came from. On sight loss WITHOUT standing orders the LAST
// KNOWN position is pursued: the brain routes to the frozen remembered feet,
// and on arrival (or a confirmed dead end) switches to a three-heading scan
// (`search`) that forgets after `forgetTime`. A bot HOLDING a domination
// objective skips that whole ghost chain — the flag outranks ordinary scans
// and remembered positions — and walks back to its point. Against LIVE
// stimuli the teammate cover decides: the designated holder (rank 0 among
// the same-team bots standing its point) works the point — drifting inside
// it, dodging bearings along it, shooting at a current visual on the move —
// rather than leaving to fight any of them, while higher ranks escort, free
// to leave the ring after live contact; a pusher walking to an UNCOVERED
// flag walks on through potshots the same way; only an escort (a mate
// already holding) still hunts bearings and visuals. Only a CURRENT
// visible observation can order a shot — memory, search and damage reactions
// never fire — and a capture shot is still gated on one, through the same
// executor agreement.
//
// STEERING IS PLANAR, RANGING IS NOT. The steering basis derived from the
// observation's feet is y-stripped because a step only ever moves in x/z —
// the executor's shared vertical resolver owns height. But every RANGE
// decision (the bands, engageRange) reads the true 3D numbers, `dist3` and
// `rise`. Mixing those up is what made a target on a deck overhead read as
// "in my face at dist ~ 0" and pushed bots away from the stairs that reach it.
import * as THREE from 'three';
import type { PerceptionId, VisualObservation } from './perception';
import type { HeardSound } from './soundEvents';
import type { FireController, ShotOutcome } from './botWeapons';
import { CAPTURE_HOLD_FRACTION, isHoldingPoint } from './domination';
import type { BotWeaponId, ObjectiveView } from '../core/state';

/** Shared +Y axis for the scan rotation (Three.js positive-Y convention). */
const UP_Y = new THREE.Vector3(0, 1, 0);

/**
 * Height above a bot's own feet that a look-at point takes when nothing
 * observed supplies one — a scan bearing, a patrol waypoint, a heard
 * position. Matches the executor's bot eye convention (bots.ts:eyePos), so
 * the barrel tips level rather than at the floor.
 */
const LOOK_EYE_HEIGHT = 1.6;

/**
 * Fraction of travel speed a capping bot drifts at: weight-shifting inside
 * the ring, not pacing — a statue-still holder reads broken in playtests,
 * but the point owns the feet, so the drift stays small and leashed.
 */
const CAPTURE_DRIFT_FRACTION = 0.35;

/**
 * Seconds a holder's dodge sidestep runs after an incoming-fire bearing:
 * long enough to read as a reaction (~2 m at full speed), short enough to
 * stay a flinch rather than a repositioning. The ring leash bounds it
 * whatever the geometry does.
 */
const DODGE_TIME_S = 0.5;

/** Tunables of a reactive policy. Lengths in metres, times in seconds. */
export interface BrainParams {
  /** Closer than this (3D): back off. */
  nearBand: number;
  /** Farther than this (3D): approach. */
  farBand: number;
  /** Perpendicular drift weight vs the radial band blend. */
  strafeFactor: number;
  /** Mean strafe-direction flips per second (the juke). */
  jukeRate: number;
  /** Never shoot beyond this 3D range. */
  engageRange: number;
  /**
   * Rise (m) above which a target counts as on ANOTHER LEVEL rather than
   * merely up a kerb — above what the executor's feet-aware step-up
   * (collision.ts:STEP_HEIGHT) resolves by walking into it. Gates the
   * back-off suppression below, and entry into route mode.
   */
  climbThreshold: number;
  /**
   * Rise (m) at which routing stops. Deliberately far below climbThreshold:
   * a bot partway up a flight has already closed most of the gap, and exiting
   * at the entry threshold drops it back to band steering with a metre still
   * to climb — which is precisely where bots used to stall, one step short of
   * the deck.
   */
  climbExit: number;
  /**
   * Seconds of sustained step rejection before a routing bot decides it is
   * jammed rather than brushing past something.
   */
  stuckTime: number;
  /** Seconds a jammed bot commits to sliding one way along whatever blocks it. */
  commitTime: number;
  /**
   * Feeler reach (m) for the travel wall-sense: diagonal probes at
   * heading·range ± perp·range through the view's standability probe. ~1 m
   * looks a quarter-second ahead at bot speed — far enough to pre-steer,
   * near enough that a doorway still reads open on both feelers.
   */
  wallProbeRange: number;
  /**
   * Outward bias weight vs the waypoint heading when exactly one feeler is
   * blocked. Half the heading's weight eases off the wall without abandoning
   * the line; both feelers blocked (a doorway) holds the line instead.
   */
  wallPush: number;
  /**
   * Refractory period (s) between wall-sense strafe flips while engaged. The
   * contact edge stays ungated as the blind-spot backstop; the feelers must
   * not chatter faster than the sidestep commit below can make progress.
   */
  wallSenseCooldown: number;
  /**
   * Seconds a bot may fail to CLOSE on its target beyond farBand before it
   * stops trusting band steering and routes on the flat — the flat analogue
   * of climbThreshold's job: evidence gathered, not anticipation.
   */
  noProgressTime: number;
  /**
   * Closure (m), measured against where distance stood when the stall timer
   * last reset, that counts as progress. Deliberately several frames' worth:
   * real approach shrinks dist by selfSpeed·dt each frame (~0.06 m), and a
   * per-frame test would demand an epsilon below that and jitter would arm
   * the timer mid-approach.
   */
  noProgressEpsilon: number;
  /**
   * Growth (m) beyond that same baseline read as the GOAL FLEEING rather
   * than as stagnation: re-baseline and give steering a fresh chance.
   * Without it, chasing anything faster latches routing permanently even
   * though nothing is blocked.
   */
  fleeReset: number;
  /**
   * Planar distance (m) at which a memory pursuit counts as ARRIVED: the
   * search begins here without asking the graph again. Inclusive boundary.
   */
  memoryArrivalRadius: number;
  /** Seconds per heading of the three-phase search scan. */
  scanPhase: number;
  /** Seconds a search runs from ENTRY before the memory is dropped (hold). */
  forgetTime: number;
  /**
   * Seconds a bot stands still before requesting (or resuming) a patrol:
   * on spawn, respawn, search expiry, patrol arrival and failed patrol
   * selection. The pause keeps a patrol graph selection from being re-requested
   * every frame after a dead end.
   */
  patrolPause: number;
  /**
   * Seconds an incoming-fire search ADVANCES along the newest bearing at
   * normal travel speed before it scans in place. A blocked advance stops
   * permanently for that search; a later hit starts a fresh window.
   */
  damageAdvance: number;
}

/** The shipped bot behavior. */
export const DEFAULT_BRAIN_PARAMS: BrainParams = {
  nearBand: 7,
  farBand: 14,
  strafeFactor: 0.7,
  jukeRate: 0.5,
  engageRange: 45,
  climbThreshold: 1.5, // ≈ 5 risers; well clear of STEP_HEIGHT's 0.3
  climbExit: 0.45,     // just over one riser — keep routing to the last step
  stuckTime: 0.1,    // catch a tenth-second wedge; single-frame brushes still reset
  commitTime: 2,     // sustain the escape around a corner; see docs/bot-movement-tuning.md
  wallProbeRange: 1, // retained after sweeps: shorter feelers regressed backing away from walls
  wallPush: 0.5,     // half the heading's weight: ease off, don't abandon the line
  wallSenseCooldown: 0.5, // sense flips at most twice a second; the contact edge stays ungated
  noProgressTime: 1.5,   // ~2 juke swings would be 4 s; 1.5 s is already patient
  noProgressEpsilon: 0.25, // ≈ 4 frames of full-speed closure
  fleeReset: 2,          // a target 2 m farther than the best seen is running, not stalling
  memoryArrivalRadius: 1, // planar; reached the remembered spot → scan here
  scanPhase: 0.75,        // per heading; the full sweep repeats every 2.25 s
  forgetTime: 8,          // drop the memory 8 s after the search began
  patrolPause: 1,         // stand down one second between patrol legs
  damageAdvance: 3,       // advance toward the shot for 3 s, then scan in place
};

/** What a brain may know about the world this frame — all executor-supplied. */
export interface BrainView {
  /**
   * This bot's own world-space FEET position. Read-only basis: the planar
   * steering vector and closure measure are derived from it and the
   * observation; the brain must not mutate it.
   */
  selfFeet: THREE.Vector3;
  /**
   * This bot's own normalized planar facing (its mesh yaw basis). The
   * degenerate-vector fallback for an intent facing, and the facing a
   * holding bot preserves.
   */
  facing: THREE.Vector3;
  /**
   * The frame's visual observation, or null when nothing was seen this
   * frame. This is the ONLY target knowledge a brain gets — no positions,
   * distances or liveness for anything the bot did not just look at.
   */
  visual: VisualObservation | null;
  /**
   * Resting on support this frame; false while airborne. Read by the jam
   * recovery below, which must not fire mid-fall: a falling bot's steps are
   * refused for reasons no amount of sliding sideways will fix.
   */
  onGround: boolean;
  /** Movement speed (m/s) the executor can realize this frame. */
  selfSpeed: number;
  /** Whether LAST frame's step was rejected by world collision. */
  moveBlocked: boolean;
  /**
   * Whether a body may stand at (x, z) at this bot's OWN feet height — the
   * wall-sense feeler. Executor-backed by the same feet-aware gate the step
   * obeys (collision.ts:collidesAt at the bot's own radius), so a
   * "standable" answer means the intended step would survive there too.
   * Travel reads diagonal feelers; engaged strafing reads the lateral pair.
   */
  canStandAt(x: number, z: number): boolean;
  /**
   * Whether (x, z) has ground within one riser below this bot's OWN feet —
   * the footing guard's probe (collision.ts:supportedAt). Walls are ignored:
   * canStandAt and the contact edge already own them, and a wall tripping
   * this too would re-tune every wall slide. canStandAt, conversely, reads
   * true over a void — air has no collider — which is how strafes and
   * back-offs used to carry bots off flights and out of windows (#127).
   */
  hasFootingAt(x: number, z: number): boolean;
  /**
   * Hostile noises heard SINCE the last frame — already filtered by the
   * executor for team and earshot, so an entry here is by construction
   * something this bot is entitled to have heard. Usually empty.
   *
   * A heard entry is a place and a kind, never an identity: acting on one
   * yields a null focus, and the executor's shot agreement then makes firing
   * on it structurally impossible, exactly as it does for memory.
   */
  heard: readonly HeardSound[];
  /**
   * Planar vector to the next waypoint on the executor's route toward
   * `goal`, with a THREE-way outcome so a policy can tell waiting from a
   * dead end without any extra pathfinding:
   *
   * - a `Vector3`: the next relative waypoint — walk it;
   * - `undefined`: the shared one-A-star-per-frame budget DEFERRED the
   *   request — nothing is known about the route, wait and ask again next
   *   frame;
   * - `null`: the graph was asked and confirmed there is NO route.
   *
   * The answer is relative to the bot's own feet: although `selfFeet` gives
   * the brain its position and `goal` is world-space, the executor exposes
   * only the direction and distance of the next leg — never its route graph.
   */
  nextWaypoint(goal: THREE.Vector3): THREE.Vector3 | undefined | null;
  /**
   * The dispatcher's flag assignment plus live teammate cover, or null
   * outside domination matches (and whenever the dispatcher has nothing to
   * give). A COPY of HUD-public state — flag states are broadcast to both
   * teams, so routing here reveals nothing a scoreboard wouldn't, and the
   * mates are bare counts, never identities or positions. Outranks
   * ghost-chasing (ordinary scans, remembered positions, fresh noises);
   * against live stimuli the cover decides: the designated holder (rank 0)
   * holds through everything and shoots in place, higher ranks escort, an
   * uncovered pusher walks on through potshots, and only an escort (cover
   * present) still hunts bearings and visuals; see decide(). "Cover" is
   * `cappingMates` — mates anywhere in the RING, which is what the capture
   * census counts — while "holder" is the narrower rank-0 seat inside the
   * hold circle; the two are not the same body.
   */
  objective: ObjectiveView | null;
  /**
   * Lazy patrol waypoint request — the patrol analogue of `nextWaypoint`,
   * same three-way contract and the same lazy on purpose: pathfinding still
   * obeys the shared one-A-star-per-frame budget, so the callback is only
   * invoked when the brain has actually decided to patrol.
   *
   * - a `Vector3`: the next relative waypoint of a patrol route — walk it at
   *   normal travel speed;
   * - `undefined`: the route computation was DEFERRED (budget unavailable) —
   *   nothing is known about the route, remain `patrol` without moving;
   * - `null`: no usable patrol route or goal (nothing selected, a selected
   *   node confirmed unreachable, or the final patrol node reached) — the
   *   brain returns to its one-second pause and a fresh selection is made
   *   after it.
   */
  nextPatrolWaypoint(): THREE.Vector3 | undefined | null;
}

/**
 * What a brain is doing this frame, in one word.
 *
 * `engage` and `route` are the two active modes; `search` scans in place
 * from a remembered position's arrival, a routing dead end, or a
 * direction-only incoming-fire bearing (the damage search advances for its
 * first seconds); `objective` walks the domination flag the dispatcher
 * assigned, and `capture` holds inside its ring watching for contact;
 * `patrol` walks a map-wide route with no target knowledge
 * at all; `hold` stands still on forget, on plain sight loss (pre-memory),
 * or inside the one-second patrol pause. Reported for OBSERVABILITY, not
 * consumed by the executor: hud.ts renders it in the DEV bot readout,
 * because "why is that bot doing that" is otherwise only answerable by
 * pausing in devtools.
 */
export type BrainMode = 'hold' | 'search' | 'route' | 'engage' | 'patrol' | 'objective' | 'capture';

/** What a brain wants done this frame. */
export interface BrainIntent {
  /** World-space displacement to attempt (already includes selfSpeed·dt). */
  step: THREE.Vector3;
  /** Loose a shot THIS frame; the executor owes it when true. */
  wantShoot: boolean;
  /** What the brain thinks it is doing; display only. */
  mode: BrainMode;
  /**
   * The identity the brain's attention is on — the observed one when a
   * visual exists, else the retained focus across temporary sight loss.
   * The executor only realizes a shot when the SAME frame's observation
   * carries this id.
   */
  focusId: PerceptionId | null;
  /**
   * World-space point to look at (a copy), or null when the brain has
   * nothing to look at — a holding bot exposes none and the executor keeps
   * the last barrel pose.
   */
  lookAt: THREE.Vector3 | null;
  /**
   * Normalized planar direction the body should face this frame: toward the
   * visible point when one exists, else the bot's own facing preserved.
   */
  facing: THREE.Vector3;
}

/** The decision half of a bot. Instances own per-bot state; executors are stateless shells. */
export interface BotBrain {
  decide(view: BrainView, dt: number): BrainIntent;
  /**
   * Direction-only "the shot came from this way" stimulus: `bearing` is a
   * planar victim-to-attacker direction, copied and normalized on receipt.
   * It becomes the NEXT decision's highest-priority stimulus — outranking a
   * same-frame visual — and starts a search at that bearing. No identity,
   * distance or destination travels with it; a zero planar vector is
   * ignored defensively.
   */
  onIncomingFire(bearing: THREE.Vector3): void;
  /**
   * Clear per-life policy state.
   *
   * Brains outlive their bodies: the executor holds ONE brain per bot and
   * revives the mesh around it, so without this a respawned bot inherits
   * whatever shot cooldown its corpse was carrying. The staggered first shot
   * — the thing that stops a wave volleying in unison — then applies exactly
   * once per match, at construction, and never again.
   */
  onRespawn(): void;
  /**
   * The brain's current focus identity, read-only: which perceivable entity
   * its attention is on (null before the first observation of a life). The
   * executor feeds it back as acquisition's focus so a tracked identity is
   * probed first.
   */
  readonly focusId: PerceptionId | null;
  /**
   * The catalog weapon this brain fires. Display, audio and mesh selection;
   * the executor never uses it to compute damage — see resolveShot.
   */
  readonly weapon: BotWeaponId;
  /** Rounds chambered, magazine capacity, reserve and reload state. Display only. */
  readonly mag: number;
  readonly magSize: number;
  readonly reserve: number;
  readonly reloading: boolean;
  /**
   * How the executor must realize a pull: 'ranged' resolves through
   * resolveShot below; 'melee' means the executor swings instead — a melee
   * brain never reaches resolveShot.
   */
  readonly resolution: 'ranged' | 'melee';
  /** Hit probability for ONE ray at eye-to-eye 3D `dist` under this weapon. */
  hitChance(dist: number): number;
  /**
   * Resolve the trigger pull the executor is realizing, at post-move
   * eye-to-eye `dist`: every ray's hit die and every landed ray's hit zone,
   * summed into one damage figure and one attribution zone.
   *
   * ALL of a bot's dice come from the brain's own rng stream — never a
   * global — which is why this is the brain's to draw and not the
   * executor's, even though the executor is what asked for the shot. A melee
   * brain never reaches this; the executor swings instead.
   */
  resolveShot(dist: number): ShotOutcome;
  /**
   * Whether a target at eye-to-eye 3D `dist` passes this brain's engage
   * gate — the same exclusive comparison decide()'s trigger applies before
   * it orders a shot. Exposed so the executor can require intent/observation
   * agreement before realizing one, and so a display-only consumer can
   * report "would fire" without reading params.
   */
  inRange(dist: number): boolean;
}

/**
 * Which of this frame's noises to investigate: a gunshot over any footstep,
 * the NEAREST gunshot among gunshots, and the newest footstep when no
 * gunshot exists.
 *
 * Gunshots win because they mean a fight rather than a walk. Among gunshots
 * NEAREST wins because a sound chosen as a place to walk to is a lead, not
 * an identity — 6a's ban on ranking by position is about identifying a
 * target, where nearest would reintroduce omniscience by another name, and
 * does not apply to picking which of several already-audible noises to
 * approach. Distance is the 3D squared distance from the event's copied
 * position to the listener's feet, the same point-distance ordering
 * `withinEarshot` gates audibility on, squared to skip the root; an exact
 * distance tie falls back to the newest sequence so the choice stays
 * deterministic. Footsteps keep newest-wins: with no fight to locate,
 * freshness is the only ordering left. Neither an event nor its position is
 * ever mutated.
 *
 * Exported for its own unit pins; it is policy, so it lives with the brain
 * rather than with the ring.
 */
export function pickHeardLead(heard: readonly HeardSound[], listenerFeet: THREE.Vector3): HeardSound | null {
  let best: HeardSound | null = null;
  let bestDistSq = Infinity;
  for (const h of heard) {
    if (best === null) {
      best = h;
      bestDistSq = h.kind === 'gunshot' ? h.pos.distanceToSquared(listenerFeet) : Infinity;
      continue;
    }
    if (h.kind !== best.kind) {
      if (h.kind === 'gunshot') {
        best = h;
        bestDistSq = h.pos.distanceToSquared(listenerFeet);
      }
    } else if (h.kind === 'footstep') {
      if (h.seq > best.seq) best = h;
    } else {
      const dSq = h.pos.distanceToSquared(listenerFeet);
      if (dSq < bestDistSq || (dSq === bestDistSq && h.seq > best.seq)) {
        best = h;
        bestDistSq = dSq;
      }
    }
  }
  return best;
}

/** The shipped bot policy, parameterized for future variants. */
export class DefaultBrain implements BotBrain {
  private params: BrainParams;
  private held: BotWeaponId;
  private strafeDir: 1 | -1;
  /** True while following the executor's route rather than steering at the target. */
  private routing = false;
  /** Seconds of CONSECUTIVE refused steps while routing; any frame that moves resets it. */
  private blockedFor = 0;
  /** Seconds left on a committed sideways slide past whatever is jamming us. */
  private commitLeft = 0;
  /** Refractory seconds left before the engage wall-sense may flip again. */
  private senseCooldown = 0;
  /** Which way the last slide went; the next one takes the other. */
  private slideDir: 1 | -1 = 1;
  /**
   * Planar distance to the target when the stall tracker last reset — the
   * baseline closure is measured against. Infinity until a real reading
   * adopts it, so the first frame of any life counts as progress.
   */
  private stallBase = Infinity;
  /** Seconds spent beyond farBand without closing on that baseline. */
  private stalledFor = 0;
  /**
   * The flat-routing latch, raised when stalledFor reaches noProgressTime
   * and held until dist3 comes back inside farBand — the same
   * evidence-then-hand-over shape as the climb gate's hysteresis, with the
   * band boundary doing what climbExit does there.
   */
  private flatRouted = false;
  /**
   * Whether LAST frame's step was rejected by geometry. The drift reversal
   * is EDGE-triggered on this (#43): a level-triggered flip re-reverses
   * every frame a bot rests against a wall, and ~60 reversals a second
   * cancel the perpendicular component to zero while the radial term keeps
   * pushing in — the wall-grind playtesters watched.
   */
  private wasBlocked = false;
  /**
   * True when the previous frame's intent was engage. Jam timers are shared
   * by routed travel and engaged strafing, but a patrol-armed commit must not
   * steer an unrelated firefight: entering engage from any non-engage mode
   * restarts the timers (and the wall-sense cooldown) instead of inheriting
   * geometry the bot already left behind. Continuing engage frames preserve
   * them, so a sustained wedge still commits.
   */
  private wasEngage = false;
  /**
   * The identity this brain's attention is on: the last observed id, held
   * across temporary sight loss so acquisition probes it first when the
   * look could plausibly succeed again. Cleared by onRespawn — a new life
   * does not inherit the corpse's attention.
   */
  private focus: PerceptionId | null = null;
  /**
   * The place this brain is investigating: cloned feet and eye from the most
   * recent visual observation, or a heard position with a null `eye` (a noise
   * gives a spot on the ground, not a pair of eyes). COPIES, never a live
   * reference — the observation is the executor's and the target moves.
   * Pursued on sight loss or on a noise; dropped by the search expiry and
   * onRespawn. A heard goal is distinguishable by `focus === null`, and that
   * null is what makes it unshootable.
   */
  private memory: { feet: THREE.Vector3; eye: THREE.Vector3 | null } | null = null;
  /** True while an active search owns the bot (the forget timer runs). */
  private searching = false;
  /** Normalized planar base bearing of the active search; null when none. */
  private scanBase: THREE.Vector3 | null = null;
  /** Seconds since the active search began. */
  private scanElapsed = 0;
  /**
   * Copied normalized planar victim-to-attacker bearing awaiting the next
   * decision, or null. Set by onIncomingFire, consumed by the next decide().
   */
  private pendingBearing: THREE.Vector3 | null = null;
  /**
   * Seconds still owed of the one-second stand-down before a patrol
   * waypoint may be requested. Seeded at construction (spawn), reset by
   * onRespawn, search expiry, patrol arrival and failed patrol selection.
   */
  private patrolPause = 0;
  /**
   * Whether the active search came from a damage bearing and therefore owns
   * the `damageAdvance` window along its base bearing. Memory-arrival and
   * dead-end searches scan in place. Reset by the next enterSearch and
   * dropped by the forget expiry and onRespawn.
   */
  private advanceArmed = false;
  /**
   * True once the armed advance has been cut short by a blocked step — the
   * advance stops permanently for THAT search (no replanning); a later hit
   * re-arms it through enterSearch.
   */
  private advanceCancelled = false;
  /**
   * Whether the LAST requested movement step was an advance step of the
   * current damage search. `moveBlocked` reports on that PREVIOUS step, so
   * only a block arriving while this is set may cancel the advance — a block
   * inherited from a patrol/combat step taken before the hit says nothing
   * about the new advance, and must not cut it on the entry frame.
   */
  private advanceRequested = false;
  /**
   * Watch-rotation angle (radians) of an active flag capture. Advanced while
   * holding inside the objective ring so a capping bot surveys rather than
   * staring one way; reset by onRespawn with the rest of the per-life state.
   */
  private objectiveHeading = 0;
  /**
   * Normalized planar dodge direction of a holder reacting to incoming fire,
   * or null when not dodging. Armed from the bearing by the flag-hold (a
   * sidestep, never a departure — the ring leash keeps it on the point) and
   * expired by the clock or a blocked step. Spent ONLY on the hold path, so
   * the clock only ticks there: decide() clears it on every frame that is not
   * this bot holding its point, which is what keeps it short-lived even when
   * the bot stops holding mid-dodge. onRespawn clears it with the rest of the
   * per-life state; the investigation stack never owns it.
   */
  private dodgeDir: THREE.Vector3 | null = null;
  /** Seconds left on the current dodge; arms DODGE_TIME_S per bearing. */
  private dodgeLeft = 0;
  /**
   * Whether the LAST requested movement step was a dodge step of the current
   * dodge. Same contract as advanceRequested: `moveBlocked` reports on the
   * PREVIOUS step, so only a block arriving while this is set may cancel the
   * dodge — a block inherited from the step before the hit must not cut the
   * entry sidestep.
   */
  private dodgeRequested = false;

  /**
   * @param base the weapon-independent policy. The per-weapon bands, engage
   *   range and drift are derived from whatever the loadout is HOLDING, and
   *   re-derived when a dry swap changes it — so the caller passes the shipped
   *   defaults rather than a weapon's own row.
   * @param fire this brain's weapon. Required rather than defaulted: bots.ts
   *   is the only production construction site, and a defaulted controller
   *   would let a wiring failure ship silently as a bot that never shoots.
   */
  constructor(
    private readonly base: BrainParams,
    private rng: () => number,
    private readonly fire: FireController,
  ) {
    this.strafeDir = this.rng() < 0.5 ? -1 : 1;
    // arm() takes the staggered-first-shot draw, so a fresh wave doesn't
    // volley in unison. It is called HERE, after the strafe draw, rather than
    // in the controller's own constructor: the documented construction draw
    // order is [strafeDir, stagger], and a controller that drew when it was
    // built would have to be built first, silently shifting every scripted
    // rng sequence in the suite by one.
    this.fire.arm();
    this.params = this.fire.params(this.base);
    this.held = this.fire.weapon;
    // Spawn counts as a pause: the first patrol request waits one second.
    this.patrolPause = this.params.patrolPause;
  }

  /** Read-only focus exposure for the executor's acquisition call. */
  get focusId(): PerceptionId | null {
    return this.focus;
  }

  /**
   * Re-arm the spawn stagger from this brain's own rng, like the constructor
   * does. One draw, taken outside decide() so the per-frame draw sequence
   * the tests script against is untouched.
   */
  onRespawn(): void {
    // Re-arms the stagger from this brain's rng, refills the magazine and
    // cancels any reload the corpse was running — one draw, taken outside
    // decide() so the per-frame sequence the tests script against is
    // untouched.
    this.fire.arm();
    this.held = this.fire.weapon;
    this.params = this.fire.params(this.base);
    this.routing = false;
    this.blockedFor = 0;
    this.commitLeft = 0;
    this.senseCooldown = 0;
    this.flatRouted = false;
    this.stalledFor = 0;
    this.stallBase = Infinity;
    this.wasBlocked = false;
    this.wasEngage = false;
    this.focus = null;
    this.memory = null;
    this.searching = false;
    this.scanBase = null;
    this.scanElapsed = 0;
    this.pendingBearing = null;
    this.patrolPause = this.params.patrolPause;
    this.advanceArmed = false;
    this.advanceCancelled = false;
    this.advanceRequested = false;
    this.objectiveHeading = 0;
    this.clearDodge();
  }

  /** See BotBrain.onIncomingFire. The bearing is copied and planar-normalized. */
  onIncomingFire(bearing: THREE.Vector3): void {
    const planar = new THREE.Vector3(bearing.x, 0, bearing.z);
    // Zero planar vector (or an all-vertical one): no direction to remember.
    if (planar.lengthSq() === 0) return;
    this.pendingBearing = planar.normalize();
  }

  /** Drop the routing/jam/stall machinery shared by the pursue and search handovers. */
  private clearPursuitState(): void {
    this.routing = false;
    this.blockedFor = 0;
    this.commitLeft = 0;
    this.flatRouted = false;
    this.stalledFor = 0;
    this.stallBase = Infinity;
    this.wasBlocked = false;
  }

  /** Begin a scan at `base`: elapsed zero, every pursuit state dropped. */
  private enterSearch(base: THREE.Vector3, advance = false): void {
    this.searching = true;
    this.scanBase = base.clone();
    this.scanElapsed = 0;
    this.advanceArmed = advance;
    this.advanceCancelled = false;
    // A fresh search re-arms the block tracking: the pre-hit step whose
    // feedback may still be in flight belonged to whatever came before.
    this.advanceRequested = false;
    this.clearPursuitState();
  }

  /**
   * Whether this frame's view has the bot standing its point: an assigned
   * objective with own feet inside the capture hold, planar AND vertical.
   * Delegates to domination.ts:isHoldingPoint — the same gate behind
   * objectiveIntent's arrival below and the holder ladder — so the brain,
   * the arrival and the rank can never disagree about who is "on" a flag.
   * A bot under Elevation's deck flag is planar-inside but a floor away: it
   * must keep routing to the stairs, not sit in the holder branch. A
   * capping bot holds through live stimuli; see decide.
   */
  private isCapping(view: BrainView): boolean {
    const obj = view.objective;
    if (obj === null) return false;
    return isHoldingPoint(obj, {
      x: view.selfFeet.x,
      feetY: view.selfFeet.y,
      z: view.selfFeet.z,
    });
  }

  /**
   * Arm a holder's dodge from an incoming-fire bearing: a full-speed
   * sidestep perpendicular to the shot line, side from the strafe direction
   * (which the juke keeps flipping, so repeated hits weave rather than
   * march). A sidestep, never a departure — objectiveIntent's leash keeps it
   * on the point. Re-arming refreshes the window; the bearing is already
   * planar-normalized by onIncomingFire, so no degenerate direction arrives.
   */
  /**
   * Drop any live dodge. Called by decide() on every non-holding frame and
   * by onRespawn; expiry inside dodgeStep clears the same three fields.
   */
  private clearDodge(): void {
    this.dodgeDir = null;
    this.dodgeLeft = 0;
    this.dodgeRequested = false;
  }

  private startDodge(bearing: THREE.Vector3): void {
    const side = this.strafeDir;
    this.dodgeDir = new THREE.Vector3(-bearing.z * side, 0, bearing.x * side);
    this.dodgeLeft = DODGE_TIME_S;
    // A fresh dodge re-arms the block tracking for the same reason a fresh
    // search does: the pre-hit step whose feedback may still be in flight
    // belonged to whatever the bot was doing before the hit.
    this.dodgeRequested = false;
  }

  /**
   * This frame's dodge step, or null when no dodge is owed: full-speed along
   * the stored sidestep while its window runs. A blocked step cancels the
   * remainder permanently for this dodge — drift the rest — but only when
   * the blocked report describes a step this dodge itself requested: the
   * entry frame must move even if the step before the hit was refused.
   */
  private dodgeStep(view: BrainView, dt: number): THREE.Vector3 | null {
    if (this.dodgeDir === null || this.dodgeLeft <= 0) {
      this.dodgeRequested = false;
      return null;
    }
    if (this.dodgeRequested && view.moveBlocked) {
      this.dodgeRequested = false;
      this.dodgeDir = null;
      this.dodgeLeft = 0;
      return null;
    }
    this.dodgeRequested = true;
    this.dodgeLeft -= dt;
    const step = this.dodgeDir.clone().multiplyScalar(view.selfSpeed * dt);
    if (this.dodgeLeft <= 0) {
      this.dodgeDir = null;
      this.dodgeRequested = false;
    }
    return step;
  }

  /**
   * Leash a capture step to the hold circle: drift and dodge own the feet,
   * but the point owns the leash. A step landing inside passes through; one
   * reaching outside keeps only its tangential part, so motion slides along
   * the inside of the circle instead of sticking on it. Holding can never
   * flap itself out of capping by walking.
   */
  private leashStep(step: THREE.Vector3, view: BrainView): THREE.Vector3 {
    const obj = view.objective!;
    const holdR = obj.radius * CAPTURE_HOLD_FRACTION;
    const nx = view.selfFeet.x + step.x - obj.pos.x;
    const nz = view.selfFeet.z + step.z - obj.pos.z;
    if (nx * nx + nz * nz <= holdR * holdR) return step;
    const len = Math.hypot(nx, nz);
    const radial = new THREE.Vector3(nx / len, 0, nz / len);
    const outward = step.dot(radial);
    if (outward <= 0) return step;
    return step.clone().addScaledVector(radial, -outward);
  }

  /**
   * Where to look while pursuing the investigation goal: the frozen eye when
   * sight put it there, else eye height above the goal itself. A heard
   * position has no eye to remember — inventing one at the listener's own
   * height would tip the barrel at the floor over long distances.
   */
  private goalLookAt(mem: { feet: THREE.Vector3; eye: THREE.Vector3 | null }): THREE.Vector3 {
    if (mem.eye !== null) return mem.eye.clone();
    return new THREE.Vector3(mem.feet.x, mem.feet.y + LOOK_EYE_HEIGHT, mem.feet.z);
  }

  /**
   * Adopt a heard noise as the investigation goal.
   *
   * Called only for a bot with NO existing commitment — no remembered visual
   * position and no active search — so there is nothing older to weigh
   * against. The focus goes to NULL — a noise identifies nobody — and that
   * is what makes the resulting pursuit unshootable, through the same
   * executor agreement memory already relies on.
   */
  private adoptHeard(h: HeardSound): void {
    this.focus = null;
    this.memory = { feet: h.pos.clone(), eye: null };
    this.searching = false;
    this.scanBase = null;
    this.scanElapsed = 0;
    this.advanceArmed = false;
    this.advanceCancelled = false;
    this.advanceRequested = false;
    this.clearPursuitState();
  }

  /** Heading for the current scan phase: base, base+120°, base−120°, repeating. */
  private scanHeading(): THREE.Vector3 {
    const phase = Math.floor(this.scanElapsed / this.params.scanPhase) % 3;
    if (phase === 0) return this.scanBase!.clone();
    const offset = phase === 1 ? (2 * Math.PI) / 3 : -(2 * Math.PI) / 3;
    return this.scanBase!.clone().applyAxisAngle(UP_Y, offset);
  }

  /**
   * This frame's search step: normal-speed travel along the stored base
   * bearing while the damage advance window is open, zero once it is closed.
   * A blocked step cuts the advance permanently for this search — finish the
   * scan in place rather than replanning — but only when the blocked report
   * describes a step this advance itself requested: the first damage frame
   * must move even if the step before the hit was refused.
   */
  private advanceStep(view: BrainView, dt: number): THREE.Vector3 {
    const step = new THREE.Vector3();
    if (!this.advanceArmed || this.advanceCancelled) return step;
    if (this.advanceRequested && view.moveBlocked) {
      this.advanceRequested = false;
      this.advanceCancelled = true;
      return step;
    }
    if (this.scanElapsed >= this.params.damageAdvance) {
      this.advanceRequested = false;
      return step;
    }
    this.advanceRequested = true;
    return this.scanBase!.clone().setY(0).normalize().multiplyScalar(view.selfSpeed * dt);
  }

  /**
   * Intent for a search frame: face `heading` and look along it, with the
   * damage advance (if armed and still inside its window) added on top of the
   * standing scan. The lookAt point rides the FROZEN eye height while memory
   * exists; a direction-only damage search (memory already cleared) uses the
   * bot eye convention off the bot's own feet.
   */
  private searchFrameIntent(view: BrainView, heading: THREE.Vector3, step = new THREE.Vector3()): BrainIntent {
    const mem = this.memory;
    const eyeY = mem !== null && mem.eye !== null ? mem.eye.y : view.selfFeet.y + LOOK_EYE_HEIGHT;
    const lookAt = new THREE.Vector3(view.selfFeet.x + heading.x, eyeY, view.selfFeet.z + heading.z);
    return {
      step,
      wantShoot: false,
      mode: 'search',
      focusId: this.focus,
      lookAt,
      facing: heading.clone(),
    };
  }

  get weapon(): BotWeaponId { return this.fire.weapon; }
  get mag(): number { return this.fire.mag; }
  get magSize(): number { return this.fire.magSize; }
  get reserve(): number { return this.fire.reserve; }
  get reloading(): boolean { return this.fire.reloading; }
  get resolution(): 'ranged' | 'melee' { return this.fire.resolution; }

  hitChance(dist: number): number {
    return this.fire.hitChance(dist);
  }

  resolveShot(dist: number): ShotOutcome {
    return this.fire.resolve(dist);
  }

  inRange(dist: number): boolean {
    return dist < this.params.engageRange;
  }

  /**
   * Walk the route: straight at the waypoint, with an explicit recovery when
   * geometry keeps refusing the step.
   *
   * NO perpendicular drift here, unlike engage. Measured on the elevation map
   * over four start positions: steering at waypoints with the shipped 0.7
   * drift jams approaching the external stair, 0.15–0.2 jams on the internal
   * flight's west edge, and only ~0.1 cleared every route — a single magic
   * value holding by luck. Drift is combat maneuvering that happens to
   * unstick things; it is not a recovery, and leaning on it as one is what
   * made the working value so narrow.
   *
   * The designed recovery is below: sustained rejection commits the bot to
   * sliding one way along whatever blocks it, alternating side between
   * attempts. With it, all four routes complete at zero drift.
   */
  /**
   * Shared jam accumulation for routed travel and engaged strafing: a brush
   * (isolated rejections) never arms, sustained rejection commits a sideways
   * slide alternating side between attempts. Returns whether a committed
   * slide owns this frame's step — the caller steers it along its own axis.
   * Takes no draws.
   */
  private updateJam(view: BrainView, dt: number): boolean {
    if (view.moveBlocked) this.blockedFor += dt;
    else this.blockedFor = 0;

    if (this.commitLeft > 0) {
      this.commitLeft -= dt;
    } else if (this.blockedFor >= this.params.stuckTime && view.onGround) {
      // Airborne is excluded: a falling bot's steps are refused for reasons
      // sliding sideways cannot fix.
      this.commitLeft = this.params.commitTime;
      this.slideDir = this.slideDir === 1 ? -1 : 1;
    }
    return this.commitLeft > 0;
  }

  /**
   * The footing guard (#127): whether a step component `dir` (a planar
   * direction, any length) scaled to this frame's full step still lands on
   * ground. Probing only the destination is enough: the probe is
   * centre-strict (collision.ts:supportedAt) and a frame's step is far
   * shorter than the body's radius, so a passing destination cannot drop the
   * body even when the executor's slide realizes one axis of it. Guards the
   * sideways moves and the back-off only — the approach may drop off a deck
   * on purpose, and a route heading is the graph's call. Takes no draws.
   */
  private hasFooting(view: BrainView, dir: THREE.Vector3, dt: number): boolean {
    const len = Math.hypot(dir.x, dir.z);
    if (len < 1e-9) return true;
    const reach = (view.selfSpeed * dt) / len;
    return view.hasFootingAt(view.selfFeet.x + dir.x * reach, view.selfFeet.z + dir.z * reach);
  }

  /**
   * A committed jam slide, footing-guarded: a slide that would leave the
   * ground reverses side instead — the other way along the same obstacle —
   * and stands still for this frame. Returns the (unscaled) slide direction,
   * or a zero vector for the standing frame.
   */
  private guardedSlide(view: BrainView, axisX: number, axisZ: number, dt: number): THREE.Vector3 {
    const slide = new THREE.Vector3(axisX * this.slideDir, 0, axisZ * this.slideDir);
    if (this.hasFooting(view, slide, dt)) return slide;
    this.slideDir = this.slideDir === 1 ? -1 : 1;
    return slide.set(0, 0, 0);
  }

  private travel(step: THREE.Vector3, waypoint: THREE.Vector3, view: BrainView, dt: number): void {
    const committed = this.updateJam(view, dt);

    const heading = waypoint.clone().setY(0).normalize();
    if (committed) {
      step.copy(this.guardedSlide(view, -heading.z, heading.x, dt));
    } else {
      step.copy(heading);
      // Wall-sense: diagonal feelers a step ahead through the view's
      // standability probe. A wall on ONE side eases the step away before
      // contact grinds speed off in the executor's slide gate; both sides
      // blocked (a doorway) holds the line rather than picking a side. Takes
      // no draws — the per-frame juke sequence is untouched.
      const range = this.params.wallProbeRange;
      const px = -heading.z, pz = heading.x;
      const leftBlocked = !view.canStandAt(
        view.selfFeet.x + (heading.x + px) * range,
        view.selfFeet.z + (heading.z + pz) * range,
      );
      const rightBlocked = !view.canStandAt(
        view.selfFeet.x + (heading.x - px) * range,
        view.selfFeet.z + (heading.z - pz) * range,
      );
      if (leftBlocked !== rightBlocked) {
        const side = leftBlocked ? -1 : 1;
        step.x += px * side * this.params.wallPush;
        step.z += pz * side * this.params.wallPush;
      }
    }
    step.normalize().multiplyScalar(view.selfSpeed * dt);
  }

  decide(view: BrainView, dt: number): BrainIntent {
    // One juke draw per frame, whatever the mode — the draw contract the
    // tests script against. (Drawn up front so every path below consumes it.)
    const jukeDraw = this.rng();

    // Advance the weapon on EVERY path, not just the shooting one: the
    // magazine and the reload clock belong to the bot, not to the mode it
    // happens to be in, so a bot that breaks contact and routes away must
    // arrive loaded. Takes no draws.
    //
    // "Engaged" is this frame's own evidence of a firefight — a shootable
    // visual that no incoming-fire bearing outranks — and it gates only the
    // opportunistic top-up: a dry magazine reloads regardless of it.
    const shootable = view.visual;
    this.fire.tick(
      dt,
      this.pendingBearing === null && shootable !== null && this.inRange(shootable.dist3),
    );
    // The dry swap happens inside tick(): a bot that just fell back to its
    // sidearm fights at the SIDEARM's bands, and one that reached the blade
    // closes to contact. Recomputed only on a change, and it takes no draws.
    //
    // This frame's `engaged` argument above was computed against the OUTGOING
    // weapon's engage range — one frame of staleness on an opportunistic reload
    // gate, and the alternative is asking the controller to swap before it has
    // ticked.
    if (this.fire.weapon !== this.held) {
      this.held = this.fire.weapon;
      this.params = this.fire.params(this.base);
    }

    // Flag-hold: the designated holder (rank 0 on its ring's ladder) never
    // leaves its point — not for a bearing, not for a visual, not for an
    // ongoing damage search. A bearing arms a leashed dodge rather than a
    // search (a flinch, not a departure — presence is what ticks the
    // capture, and stepping out to chase a bearing hands the point over); a
    // live visual is shot at while drifting by objectiveIntent rather than
    // engaged, so the trigger still runs through the executor's focus
    // agreement. Ghosts are dropped with the same call priority 5 uses.
    // wasEngage is cleared so the next real firefight elsewhere re-enters
    // fresh. Higher ranks skip all of this and fall through to the normal
    // ladder as escorts: covered (a rank-0 mate holds the point), so bearings
    // and visuals own them until the fight is over.
    const holding = view.objective !== null && this.isCapping(view)
      && view.objective.holdRank === 0;
    // A dodge is spent only on the hold path, so its clock only runs there:
    // any frame that is not this bot holding its point ends the dodge outright
    // rather than freezing it. Without this a holder that stops holding
    // mid-dodge — stepping off the point, losing rank 0 to a mate, being
    // dispatched elsewhere — parks a live dodge indefinitely and fires the
    // leftover sidestep the next time it caps, in a direction taken from a
    // bearing arbitrarily far in the past.
    if (!holding) this.clearDodge();
    if (holding) {
      if (this.searching || this.memory !== null) this.clearInvestigation(false);
      if (this.pendingBearing !== null) {
        this.startDodge(this.pendingBearing);
        this.pendingBearing = null;
      }
      this.wasEngage = false;
      return this.objectiveIntent(view, dt, jukeDraw);
    }

    // Priority 1: a pending incoming-fire bearing — even over a same-frame
    // visual. The shot's direction is ALL that is known: no identity, no
    // distance, no destination. Drop the focus and any remembered position,
    // and search where it came from; a later ordinary visual observation
    // replaces this normally. The search ADVANCES along the bearing for its
    // first seconds (the damage frame itself included) while still facing the
    // scan headings.
    //
    // Exception: an uncovered pusher — walking to a flag no mate is working,
    // anywhere in its ring — is not kited off the push by potshots. The
    // bearing is dropped and the bot walks on; a live visual below still
    // outranks, and an escort (cover present) keeps the damage search. Facing
    // stays on the push: the point is the destination, not the bearing.
    if (this.pendingBearing !== null) {
      const bearing = this.pendingBearing;
      this.pendingBearing = null;
      if (view.objective !== null && view.objective.cappingMates === 0) {
        if (this.searching || this.memory !== null) this.clearInvestigation(false);
        this.wasEngage = false;
        return this.objectiveIntent(view, dt, jukeDraw);
      }
      this.focus = null;
      this.memory = null;
      this.enterSearch(bearing, true);
      if (jukeDraw < dt * this.params.jukeRate) {
        this.strafeDir = this.strafeDir === 1 ? -1 : 1;
      }
      this.wasEngage = false;
      return this.searchFrameIntent(view, this.scanHeading(), this.advanceStep(view, dt));
    }

    const vis = view.visual;
    if (vis) {
      // Priority 2: something is actually in sight. Ordinary sound never
      // pulls a bot off an opponent it can see, so this frame's noises go
      // unread — the executor has already advanced the cursor past them.
      // visualIntent owns the wasEngage latch (entry vs continuation).
      return this.visualIntent(view, vis, dt, jukeDraw);
    }
    // No visual this frame: every path below is non-engage, so the next
    // visual frame re-enters engage fresh. Timers are preserved (a patrol
    // wedge frozen through hold resumes), only the latch flips.
    this.wasEngage = false;

    // Priority 3: a newly heard hostile noise — only when nothing is already
    // committed. A pending bearing and a current visual (the two returns
    // above) both keep their existing precedence; here a visual-memory
    // pursuit, a previously heard goal, and any active scan/search outrank a
    // fresh sound, because a bot already travelling toward a target or
    // scanning a position holds better evidence than a new place to look.
    // Hold and patrol carry no such commitment, so hearing may still
    // interrupt them. This priority is the tranche 6b follow-up REVERSAL of
    // 6b's original ladder (fresh noise above memory/search); see the 6b
    // follow-up record in docs/ai-plan.md. Adopting sets the goal and falls
    // through to the pursuit below, so hearing reuses the
    // route → arrival → scan → forget pipeline rather than growing a second.
    //
    // Note what the damage branch above therefore does: a bearing frame
    // returns before this line, so that frame's noises are dropped with the
    // cursor already past them. That is what keeps "damage reveals a
    // DIRECTION, not a position" true even though the attacker's own gunshot
    // is sitting in the ring. Later sounds during that scan are discarded as
    // well; only a sound arriving after the search commitment has cleared can
    // establish a new place to investigate.
    //
    // Ignored sounds are NOT queued: the executor cursor has already consumed
    // them, so a noise that arrives mid-pursuit is simply discarded. An
    // assigned objective counts as a commitment like memory and search: flag
    // states are fresher evidence than a stale footstep, so hearing never
    // pulls a bot off its flag — only hold and patrol stay interruptible.
    if (this.memory === null && !this.searching && view.objective === null) {
      const lead = pickHeardLead(view.heard, view.selfFeet);
      if (lead !== null) this.adoptHeard(lead);
    }

    // Priority 4: a damage-armed scan continues. Being shot at owns the bot
    // even over standing orders (priority 5): the advance runs its window
    // along the bearing, then the scan tails to the forget timer. Ordinary
    // scans — memory arrivals, dead ends — do NOT run here; the objective
    // preempts them below, so a bot with a flag walks back to its point
    // instead of sweeping where a ghost was. The one exception is the
    // uncovered pusher from priority 1: with no mate working its flag's ring
    // the scan is dropped and the push resumes, while an escort (cover
    // present) serves the search normally.
    if (this.searching && this.advanceArmed) {
      if (view.objective !== null && view.objective.cappingMates === 0) {
        this.clearInvestigation(false);
        return this.objectiveIntent(view, dt, jukeDraw);
      }
      if (jukeDraw < dt * this.params.jukeRate) {
        this.strafeDir = this.strafeDir === 1 ? -1 : 1;
      }
      this.scanElapsed += dt;
      if (this.scanElapsed >= this.params.forgetTime) {
        // Forget: drop memory and every pursuit/scan state, hold facing —
        // and stand down one second before the next patrol request.
        this.clearInvestigation(true);
        return {
          step: new THREE.Vector3(),
          wantShoot: false,
          mode: 'hold',
          focusId: null,
          lookAt: null,
          facing: view.facing.clone(),
        };
      }
      return this.searchFrameIntent(view, this.scanHeading(), this.advanceStep(view, dt));
    }

    // Priority 5: the assigned domination flag — above ghost-chasing. What
    // still outranks it depends on the cover: an escort (a mate already
    // holding — an en-route pusher with cover, or a non-holder standing the
    // ring) hunts bearings (priorities 1 and 4) and visuals (priority 2)
    // like a TDM bot, while an uncovered pusher walks on through bearings
    // and only visuals divert it. Only the designated holder never reaches
    // this line — the flag-hold above returns first. A lost sighting or an
    // ordinary scan never diverts either way — the remembered ghost is
    // dropped here and the bot walks back to its point (the assignment is
    // sticky across fights).
    if (view.objective !== null) {
      if (this.searching || this.memory !== null) this.clearInvestigation(false);
      return this.objectiveIntent(view, dt, jukeDraw);
    }

    // Priority 6: an ordinary scan continues — never shoot, age the forget
    // timer (which started only at search ENTRY, so route walks and deferred
    // frames never aged the memory), and advance along the bearing while the
    // damage search's window is open. Reached only with no objective: a bot
    // holding one was already returned above.
    if (this.searching) {
      if (jukeDraw < dt * this.params.jukeRate) {
        this.strafeDir = this.strafeDir === 1 ? -1 : 1;
      }
      this.scanElapsed += dt;
      if (this.scanElapsed >= this.params.forgetTime) {
        // Forget: drop memory and every pursuit/scan state, hold facing —
        // and stand down one second before the next patrol request.
        this.clearInvestigation(true);
        return {
          step: new THREE.Vector3(),
          wantShoot: false,
          mode: 'hold',
          focusId: null,
          lookAt: null,
          facing: view.facing.clone(),
        };
      }
      return this.searchFrameIntent(view, this.scanHeading(), this.advanceStep(view, dt));
    }

    // Priority 7: an investigation goal — sight lost with a remembered
    // position, or a noise just adopted above. Pursue it. Reached only with
    // no objective: a bot holding one dropped this memory at priority 5.
    if (this.memory !== null) {
      return this.memoryIntent(view, dt, jukeDraw);
    }

    // Priority 8 — strictly lowest: nothing seen, nothing remembered, no
    // live search, no objective. Patrol. The pause gates the request: hold for
    // `patrolPause` seconds first (spawn, respawn, search expiry, patrol
    // arrival and failed selection all land here), then ask the executor for
    // a patrol waypoint — lazily, so the shared route budget is untouched
    // until the brain has actually decided to walk.
    return this.patrolIntent(view, dt, jukeDraw);
  }

  /**
   * Drop the whole investigation stack — active scan, remembered position,
   * damage-reaction state and pursuit machinery.
   *
   * Both the forget-expiry path and the objective-preemption path land here.
   * Forgetting pauses patrol afterwards (the stand-down before the next
   * patrol request); preemption does not (the flag owns the next frame, not
   * the patrol selector — and pausing would only delay the walk back).
   */
  private clearInvestigation(pausePatrol: boolean): void {
    this.focus = null;
    this.memory = null;
    this.searching = false;
    this.scanBase = null;
    this.scanElapsed = 0;
    this.advanceArmed = false;
    this.advanceCancelled = false;
    this.advanceRequested = false;
    this.clearPursuitState();
    if (pausePatrol) this.patrolPause = this.params.patrolPause;
  }

  /**
   * Priority 8 — strictly lowest: patrol. After the one-second pause the
   * brain asks the executor for a patrol waypoint: a vector means travel at
   * normal speed (mode `patrol`, never shoot, null focus, looking one metre
   * along the next waypoint at eye height); `undefined` means the route
   * computation was deferred — wait without moving, still `patrol`; `null`
   * means no usable route or goal — restart the pause and hold. Any visual,
   * damage or newly heard stimulus outranks all of this and interrupts from
   * the branches above.
   */
  private patrolIntent(view: BrainView, dt: number, jukeDraw: number): BrainIntent {
    if (this.patrolPause > 0) {
      this.patrolPause -= dt;
      if (this.patrolPause > 0) {
        return this.holdIntent(view);
      }
      // The pause just ended: fall through to the first patrol request.
    }
    const waypoint = view.nextPatrolWaypoint();
    if (waypoint === null) {
      // No usable route or goal (or the patrol node was just reached):
      // restart the pause; the executor picks a fresh candidate after it.
      this.patrolPause = this.params.patrolPause;
      return this.holdIntent(view);
    }
    if (jukeDraw < dt * this.params.jukeRate) {
      this.strafeDir = this.strafeDir === 1 ? -1 : 1;
    }
    if (waypoint === undefined) {
      // Route computation deferred: wait without moving, remaining patrol.
      return {
        step: new THREE.Vector3(),
        wantShoot: false,
        mode: 'patrol',
        focusId: null,
        lookAt: null,
        facing: view.facing.clone(),
      };
    }
    // A real waypoint: walk it with the shared route walker (jam recovery
    // included), looking one metre along the next waypoint at eye height.
    const heading = waypoint.clone().setY(0).normalize();
    const lookAt = new THREE.Vector3(
      view.selfFeet.x + heading.x,
      view.selfFeet.y + LOOK_EYE_HEIGHT,
      view.selfFeet.z + heading.z,
    );
    const step = new THREE.Vector3();
    this.travel(step, waypoint, view, dt);
    return {
      step,
      wantShoot: false,
      mode: 'patrol',
      focusId: null,
      lookAt,
      facing: heading,
    };
  }

  /** The standing-down intent: no lookAt, no shot, facing preserved. */
  private holdIntent(view: BrainView): BrainIntent {
    return {
      step: new THREE.Vector3(),
      wantShoot: false,
      mode: 'hold',
      focusId: this.focus,
      lookAt: null,
      facing: view.facing.clone(),
    };
  }

  /**
   * Priority 2: a current visual observation. Refreshes the focus and the
   * cloned feet/eye memory, exits any active search, then runs the existing
   * visible engage/route policy — collision recovery, stagnation, juke,
   * fire cadence — unchanged.
   */
  private visualIntent(view: BrainView, vis: VisualObservation, dt: number, jukeDraw: number): BrainIntent {
    // Entering engage from any non-engage mode restarts the jam machinery —
    // a patrol-armed commit must not steer this firefight. Continuing engage
    // preserves it, so a sustained wedge still commits.
    const prevEngage = this.wasEngage;
    this.focus = vis.id;
    // Freeze the last-known position: COPIES of the observation's geometry —
    // the observation belongs to the executor and the target moves.
    this.memory = { feet: vis.feet.clone(), eye: vis.eye.clone() };
    // A look exits any active scan.
    this.searching = false;
    this.scanBase = null;
    this.scanElapsed = 0;

    // Planar steering basis, derived from the observation — the only target
    // geometry the brain has. STEERING is planar (a step only ever moves in
    // x/z); ranging reads the observation's true 3D numbers instead.
    const toTarget = new THREE.Vector3(vis.feet.x - view.selfFeet.x, 0, vis.feet.z - view.selfFeet.z);
    const dist = toTarget.length();
    const dir = dist > 1e-9 ? toTarget.clone().multiplyScalar(1 / dist) : new THREE.Vector3();
    const dist3 = vis.dist3;
    const rise = vis.rise;

    // Collision feedback from LAST frame's application: bumped geometry
    // reverses the drift, starting with this frame's step (the original
    // flipped between frames, not within one). EDGE-triggered (#43): a run
    // of blocked frames is ONE contact event and flips once — flipping per
    // frame re-reverses ~60×/s against a wall face and the perpendicular
    // component cancels itself out while the radial term keeps pushing in.
    // One flip gives a committed direction to clear the obstacle in, the
    // same principle travel()'s slide commits use for routing bots.
    if (view.moveBlocked && !this.wasBlocked) this.strafeDir = this.strafeDir === 1 ? -1 : 1;
    this.wasBlocked = view.moveBlocked;

    // Route when the target is a level up and the executor has a way there.
    // Hysteresis is wide on purpose: entry needs climbThreshold, but exit
    // waits for climbExit, because a bot partway up a flight still reads a
    // rise of a metre or so and dropping it back to band steering there is
    // exactly the stall this replaces — orbiting one step short of the deck.
    const climbWants = this.routing
      ? rise > this.params.climbExit
      : rise > this.params.climbThreshold;

    // The flat analogue (issue #44): band steering has no representation of
    // obstacles, so when it demonstrably cannot close — pacing beyond
    // farBand with planar distance pinned against a baseline — hand the
    // problem to the graph. Tracking is gated on being OUTSIDE farBand:
    // in-band pacing at constant radius is engagement, not failure (#45's
    // pure-strafe hold), and arming here would route-mode every firefight.
    // Closure is measured over several frames' worth of movement
    // (noProgressEpsilon) rather than per frame, so ordinary approach never
    // reads as stalled; growth past fleeReset re-baselines instead of
    // arming, because a fleeing goal is not stagnation.
    if (this.flatRouted) {
      if (!climbWants && dist3 <= this.params.farBand) {
        // Back inside the band: steering owns the problem again. Re-baseline
        // so a fresh wedge has to earn a fresh latch.
        this.flatRouted = false;
        this.stalledFor = 0;
        this.stallBase = dist;
      }
    } else if (!climbWants) {
      if (dist3 <= this.params.farBand || dist <= this.stallBase - this.params.noProgressEpsilon) {
        this.stallBase = dist;
        this.stalledFor = 0;
      } else if (dist >= this.stallBase + this.params.fleeReset) {
        this.stallBase = dist;
        this.stalledFor = 0;
      } else {
        this.stalledFor += dt;
        if (this.stalledFor >= this.params.noProgressTime) {
          this.flatRouted = true;
          this.stalledFor = 0;
          this.stallBase = dist;
        }
      }
    }

    const wantRoute = climbWants || this.flatRouted;
    const requested = wantRoute ? view.nextWaypoint(vis.feet) : null;
    // undefined (budget deferred) falls back to band steering at the VISIBLE
    // target — the observation is fresh, so steering at it is never worse
    // than standing still. null keeps the existing no-route fallback.
    const waypoint = requested === undefined ? null : requested;
    this.routing = waypoint !== null;

    const step = new THREE.Vector3();
    if (this.routing) {
      this.travel(step, waypoint!, view, dt);
    } else if (prevEngage && this.updateJam(view, dt)) {
      // Sustained wedge while engaged: sidestep decisively along the strafe
      // axis without leaving engage — the band, the facing and the trigger
      // below all still run, only the steering is overridden. Same
      // brush-vs-jam timers and alternating sides as travel(). Gated on
      // continuing engage: the entry frame below restarts instead of sliding
      // on patrol geometry the bot already left behind.
      step.copy(this.guardedSlide(view, -toTarget.z, toTarget.x, dt))
        .normalize().multiplyScalar(view.selfSpeed * dt);
    } else {
      if (!prevEngage) {
        // First engage frame after patrol/hold/search/route: zero the shared
        // timers (and the feeler cooldown) rather than inheriting them.
        this.blockedFor = 0;
        this.commitLeft = 0;
        this.senseCooldown = 0;
      }
      // Strafe wall-sense, ahead of the blend: flip away from a walled side
      // while the other reads open, before contact grinds. Pure lateral
      // feelers — the radial leg is band policy and owns its own slides.
      // Debounced so the feelers cannot chatter; the contact edge above stays
      // the blind-spot backstop. Takes no draws.
      this.senseCooldown = Math.max(0, this.senseCooldown - dt);
      const ax = -toTarget.z, az = toTarget.x;
      const axisLen = Math.hypot(ax, az);
      if (this.senseCooldown <= 0 && axisLen > 1e-9) {
        const reach = this.params.wallProbeRange / axisLen;
        const towardBlocked = !view.canStandAt(
          view.selfFeet.x + ax * this.strafeDir * reach,
          view.selfFeet.z + az * this.strafeDir * reach,
        );
        const awayBlocked = !view.canStandAt(
          view.selfFeet.x - ax * this.strafeDir * reach,
          view.selfFeet.z - az * this.strafeDir * reach,
        );
        if (towardBlocked && !awayBlocked) {
          this.strafeDir = this.strafeDir === 1 ? -1 : 1;
          this.senseCooldown = this.params.wallSenseCooldown;
        }
      }
      // Movement blend: radial band preference plus a perpendicular drift
      // component, normalized and scaled to the realized speed.
      //
      // The band reads dist3, not the planar dist: a target on a deck 3.6 m up
      // is 3.6 m away even when standing on your head, and ranging it as 0
      // is what made bots retreat from the building they needed to enter.
      // Back-off is suppressed outright while the target is a level above —
      // you cannot reverse away from something overhead, and trying only
      // widens the gap to whatever flight reaches it.
      //
      // Footing guard (#127): each leg is probed on its own, so a strafe
      // along an edge survives a back-off that points off it and vice versa.
      // A footless strafe is dropped and reversed for the next frame; a
      // footless back-off is dropped (hold the radius — nothing to reverse).
      // The approach is never guarded: dropping off a deck toward a target
      // below is a legitimate way to close.
      const overhead = rise > this.params.climbThreshold;
      if (dist3 > this.params.farBand || overhead) step.add(dir);
      else if (dist3 < this.params.nearBand && this.hasFooting(view, dir.clone().negate(), dt)) step.sub(dir);
      const strafe = new THREE.Vector3(-toTarget.z, 0, toTarget.x)
        .normalize()
        .multiplyScalar(this.strafeDir * this.params.strafeFactor);
      if (this.hasFooting(view, strafe, dt)) step.add(strafe);
      else this.strafeDir = this.strafeDir === 1 ? -1 : 1;
      step.normalize().multiplyScalar(view.selfSpeed * dt);
    }

    // Random juke (~jukeRate flips/sec). The draw was hoisted to the top of
    // decide() (one draw per frame in every mode); the FLIP lands after this
    // frame's step, the original statement order, so it steers from the NEXT
    // frame on.
    if (jukeDraw < dt * this.params.jukeRate) {
      this.strafeDir = this.strafeDir === 1 ? -1 : 1;
    }

    // Trigger: weapon-gated, range-gated. There is NO LOS probe here — the
    // observation IS this frame's successful look (acquisition spent the
    // frame's one ray), so a visible target inside engage range fires when
    // the cooldown expires, and the old blocked-sight retry path is gone: a
    // target that stops being seen stops being engaged (hold), not re-probed.
    // Cadence, magazine and reload are the FireController's; the brain only
    // decides that this is a frame worth spending a round on. The eye-to-eye
    // distance rides along so spray-capable weapons (issue #135) can gate the
    // next burst on this burst's closing range.
    let wantShoot = false;
    if (dist3 < this.params.engageRange && this.fire.ready()) {
      this.fire.pull(dist3);
      wantShoot = true;
    }

    // Face what the bot sees. The normalized planar direction to the visible
    // point, falling back to the body's own facing when the point is
    // degenerate (zero planar offset).
    const facing = dist > 1e-9 ? dir.clone() : view.facing.clone();

    this.wasEngage = !this.routing;
    return {
      step,
      wantShoot,
      mode: this.routing ? 'route' : 'engage',
      focusId: this.focus,
      lookAt: vis.eye.clone(),
      facing,
    };
  }

  /**
   * Priority 7: pursue the investigation goal. Route to the remembered or
   * heard FEET — never a candidate's live position — face that point, and
   * NEVER shoot: neither a memory nor a noise is sight, and no ray was spent
   * to confirm anything is still there. A deferred route waits in `route`
   * with zero step (and does not age the forget timer, which starts only at
   * search entry); a confirmed dead end and the inclusive arrival radius
   * hand over to a search, with the arrival direction as its base bearing.
   */
  private memoryIntent(view: BrainView, dt: number, jukeDraw: number): BrainIntent {
    const mem = this.memory!;
    const toMem = new THREE.Vector3(mem.feet.x - view.selfFeet.x, 0, mem.feet.z - view.selfFeet.z);
    const dist = toMem.length();
    const toward = dist > 1e-9 ? toMem.clone().multiplyScalar(1 / dist) : view.facing.clone();

    // Arrived (inclusive boundary): scan here without asking the graph again.
    if (dist <= this.params.memoryArrivalRadius) {
      this.enterSearch(toward);
      if (jukeDraw < dt * this.params.jukeRate) {
        this.strafeDir = this.strafeDir === 1 ? -1 : 1;
      }
      return this.searchFrameIntent(view, toward);
    }

    const waypoint = view.nextWaypoint(mem.feet);
    if (waypoint === undefined) {
      // Budget deferred: wait in place. Zero step, forget timer untouched —
      // only a search ages the memory.
      return {
        step: new THREE.Vector3(),
        wantShoot: false,
        mode: 'route',
        focusId: this.focus,
        lookAt: this.goalLookAt(mem),
        facing: toward.clone(),
      };
    }
    if (waypoint === null) {
      // The graph confirmed there is no way there: search where we stand.
      this.enterSearch(toward);
      if (jukeDraw < dt * this.params.jukeRate) {
        this.strafeDir = this.strafeDir === 1 ? -1 : 1;
      }
      return this.searchFrameIntent(view, toward);
    }
    // A real waypoint: raise the routing latch BEFORE travel() so the climb
    // hysteresis (climbExit, not climbThreshold) survives into the next
    // visible frame — without it, a mid-flight reacquisition re-enters at
    // climbThreshold and stalls one step short, the stall routing exists to
    // prevent.
    this.routing = true;
    const step = new THREE.Vector3();
    this.travel(step, waypoint, view, dt);
    return {
      step,
      wantShoot: false,
      mode: 'route',
      focusId: this.focus,
      lookAt: this.goalLookAt(mem),
      facing: toward.clone(),
    };
  }

  /**
   * Priority 5 (and the flag-hold): walk the assigned domination flag, then
   * hold its ring.
   *
   * Travel reuses the shared route walker under the executor's pursuit cache:
   * the flag is a static goal with no focus id, so it keys on its own
   * coordinates and never inherits a memory route (memory is null on every
   * path that reaches here). The routing latch is raised like a memory
   * pursuit's, so the climb hysteresis survives into the next visible frame
   * on the way up to the deck flag.
   *
    * Arrival (inside the hold fraction of the ring, on the flag's level)
    * is `capture`, not a search: the bot works the point — drifting inside
   * along it — and advances its watch rotation. With no current visual
   * nothing shoots — there is no observation behind the trigger, exactly
   * like a memory pursuit — but a visual inside engage range IS shot at on
   * the move: the hold owns the leash, the trigger owns the round, and
   * stepping out to engage would hand the point over. A
   * confirmed-unreachable flag holds facing it rather than searching: a
   * search would age out and patrol away from the assignment.
   *
   * The focus lives exactly as long as the sighting that set it: every entry
   * drops it and only a live visual takes it back (see below). Unlike a
   * memory pursuit there is nothing here for a tracked identity to outlive
   * the look FOR — the bot is going nowhere either way.
   */
  private objectiveIntent(view: BrainView, dt: number, jukeDraw: number): BrainIntent {
    const obj = view.objective!;
    // The objective is a PLACE, not an identity: no path here tracks an enemy
    // across frames, so the only focus that may survive this frame is the live
    // visual the capture branch re-sets below. Dropping it FIRST is what makes
    // that true. Without the drop a focus set while capturing outlives its
    // sighting, and the executor spends its one LOS ray per frame on the
    // focused candidate and probes nobody else when that look fails
    // (perception.ts:acquireVisual) — a holder whose target steps behind cover
    // would go blind to every other attacker. It also keeps the travel
    // branch's cache key honest: bots.ts:waypointToward keys on
    // `focusId ?? goal coordinates`, and a flag is a coordinate goal.
    this.focus = null;
    const toObj = new THREE.Vector3(obj.pos.x - view.selfFeet.x, 0, obj.pos.z - view.selfFeet.z);
    const dist = toObj.length();
    const toward = dist > 1e-9 ? toObj.clone().multiplyScalar(1 / dist) : view.facing.clone();
    // Same gate as isCapping above (domination.ts:isHoldingPoint): planar-only
    // arrival would capture-spot a bot standing a floor below the flag and
    // strand it there instead of routing it up the stairs.
    if (isHoldingPoint(obj, {
      x: view.selfFeet.x,
      feetY: view.selfFeet.y,
      z: view.selfFeet.z,
    })) {
      this.routing = false;
      if (jukeDraw < dt * this.params.jukeRate) {
        this.strafeDir = this.strafeDir === 1 ? -1 : 1;
      }
      this.objectiveHeading += dt * 0.6;
      const heading = new THREE.Vector3(
        Math.sin(this.objectiveHeading), 0, Math.cos(this.objectiveHeading),
      );
      // Feet: a fresh dodge first, else the idle drift — both leashed to the
      // hold circle, so holding can never walk itself out of capping. Facing
      // stays independent: the watch rotation, or the visual when one owns
      // the trigger.
      const raw = this.dodgeStep(view, dt) ?? new THREE.Vector3(
        -heading.z * this.strafeDir, 0, heading.x * this.strafeDir,
      ).multiplyScalar(view.selfSpeed * CAPTURE_DRIFT_FRACTION * dt);
      const step = this.leashStep(raw, view);
      // Contact while holding: shoot it on the move. The focus is the
      // observed identity either way (so acquisition keeps probing the
      // threat and the executor's agreement can pass); the round only goes
      // when the range gate and the weapon agree, exactly like engage —
      // including the eye-to-eye distance spray-capable weapons gate on.
      const vis = view.visual;
      if (vis !== null) {
        this.focus = vis.id;
        const toVis = new THREE.Vector3(vis.feet.x - view.selfFeet.x, 0, vis.feet.z - view.selfFeet.z);
        const visDist = toVis.length();
        const visDir = visDist > 1e-9 ? toVis.clone().multiplyScalar(1 / visDist) : view.facing.clone();
        let wantShoot = false;
        if (this.inRange(vis.dist3) && this.fire.ready()) {
          this.fire.pull(vis.dist3);
          wantShoot = true;
        }
        return {
          step,
          wantShoot,
          mode: 'capture',
          focusId: this.focus,
          lookAt: vis.eye.clone(),
          facing: visDir,
        };
      }
      return {
        step,
        wantShoot: false,
        mode: 'capture',
        focusId: null,
        lookAt: new THREE.Vector3(
          view.selfFeet.x + heading.x,
          view.selfFeet.y + LOOK_EYE_HEIGHT,
          view.selfFeet.z + heading.z,
        ),
        facing: heading,
      };
    }

    const waypoint = view.nextWaypoint(obj.pos);
    if (waypoint === undefined) {
      // Budget deferred: wait in place, still `objective` — the goal is not
      // going anywhere, unlike a fleeing memory.
      return {
        step: new THREE.Vector3(),
        wantShoot: false,
        mode: 'objective',
        focusId: null,
        lookAt: new THREE.Vector3(
          obj.pos.x, obj.pos.y + LOOK_EYE_HEIGHT, obj.pos.z,
        ),
        facing: toward.clone(),
      };
    }
    if (waypoint === null) {
      // The graph confirmed there is no way there: hold facing the flag.
      // Searching would forget the assignment and patrol away from it.
      if (jukeDraw < dt * this.params.jukeRate) {
        this.strafeDir = this.strafeDir === 1 ? -1 : 1;
      }
      return {
        step: new THREE.Vector3(),
        wantShoot: false,
        mode: 'objective',
        focusId: null,
        lookAt: new THREE.Vector3(
          obj.pos.x, obj.pos.y + LOOK_EYE_HEIGHT, obj.pos.z,
        ),
        facing: toward.clone(),
      };
    }
    this.routing = true;
    const step = new THREE.Vector3();
    this.travel(step, waypoint, view, dt);
    return {
      step,
      wantShoot: false,
      mode: 'objective',
      focusId: null,
      lookAt: new THREE.Vector3(
        view.selfFeet.x + toward.x,
        view.selfFeet.y + LOOK_EYE_HEIGHT,
        view.selfFeet.z + toward.z,
      ),
      facing: toward.clone(),
    };
  }
}
