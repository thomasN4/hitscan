// bots.ts — bot bodies and effectors: meshes, collision-gated movement,
// probabilistic shots, death/respawn. Both teams (enemy wave and the player's
// allied side) are instances of this one class; behavior comes from sim/botBrains.ts.
//
// Division of labor with sim/botBrains.ts: a BotBrain DECIDES, Bot EXECUTES.
// Each frame update() runs ONE visual acquisition (sim/perception.ts) over
// the opposing candidates, hands the brain a passive BrainView around its
// zero-or-one observation (own feet and facing, movement feedback, a lazy
// route thunk), then realizes the BrainIntent: attempt the returned step
// against world geometry through the SAME feet-aware gates the player uses
// (slideMoveXZ + resolveVertical, so bots climb stairs and land off edges),
// report rejection back as moveBlocked, face the intent's facing, aim the
// barrel at its lookAt, and loose a shot only when the frame's observation
// agrees with the intent's focus. Behavior tuning lives in two places, and
// neither is here: BrainParams / brain classes for policy, and
// sim/botWeapons.ts:BOT_WEAPON_TUNING for everything a WEAPON decides — its
// accuracy curve, cadence, burst discipline and the chase bands it wants to
// fight at. This file holds no policy numbers; the held weapon is
// presentation — a third-person mount of the same authored model the player
// holds (core/botWeaponModels.ts), whose muzzle marker positions the flash —
// and aiming it at the intent's lookAt is execution, not tuning.
//
// Shot gating contract (realized by the default brain): fire only when a
// cooldown expires AND the bot currently SEES its focus — the observation is
// the LOS proof, so a bot that sees nothing holds instead of shooting
// through walls. On sight loss it pursues the FROZEN last-known position
// (brain-owned memory) and scans on arrival — except a bot HOLDING a
// domination objective, which drops the ghost and walks back to its flag
// instead (sim/botBrains.ts documents the exception); the executor keeps
// its route cache only while it still belongs to the same active goal.
//
// Hit zones: each body part is its own mesh with `userData.bot` pointing at
// this instance — weapons.ts raycasts against head/torso/legs directly and
// multiplies damage by zone.
import * as THREE from 'three';
import { createCelMaterial } from './core/materials';
import { scene, camera } from './core/engine';
import { bots, score, session, gameTime, soundEvents, playerFeet, opposing, creditKill, BOT_SPAWNS, WEAPONS, dom, type Bot as BotShape, type BotPrimaryId, type BotSecondaryChoice, type BotSidearmId, type BotWeaponChoice, type BotWeaponId, type DomObjective, type HitZone, type PlayerState, type Team } from './core/state';
import { solids, colliders, liftPads, elevators, elevatorCarry } from './world';
import { elevatorSupports } from './sim/elevator';
import { elevatorTravel, committedTrip, type ElevatorTrip } from './sim/elevatorTravel';
import { slideMoveXZ, resolveVertical, hasLineOfSight, findFreeSpawn, collidesAt, standableAt, supportedAt, HEAD_HEIGHT } from './collision';
import { GRAVITY } from './sim/movement';
import { launchFrom } from './sim/lift';
import { damagePlayer, damageBot, checkRoundEnd } from './combat';
import { sfxEnemyAttack } from './audio';
import { spawnImpact } from './effects';
import { addKillfeed, botKillTag, updateScore } from './hud';
import { DEFAULT_BRAIN_PARAMS, DefaultBrain, type BrainMode, type BrainParams } from './sim/botBrains';
import {
  makeBotLoadout, resolveBotSecondary, resolveBotWeapon,
} from './sim/botWeapons';
import { meleeSwing, isBackstab, type MeleeCandidate } from './sim/melee';
import { damageForPart } from './sim/damage';
import { acquireVisual, type PerceptionId } from './sim/perception';
import { assignDomObjectives, countFlagBodies, holderRanks, isBodyInRing, DISPATCH_INTERVAL_S, type DomBody } from './sim/domination';
import { pickDomRespawn } from './domSpawns';
import { GUNSHOT_RADIUS_M, withinEarshot, type HeardSound } from './sim/soundEvents';
import { NAV_RADIUS, transportRoute, navGrid } from './nav';
import { nearestNode, navNode, pickPatrolNode, type RouteWaypoint } from './sim/navGrid';
import { consumeReached, furthestWalkable, shouldAbandonRoute } from './sim/routeFollow';
import { approach } from './sim/smoothing';
import { botShotKick, createBotWeaponRig, pickBotShoulderOffset, poseBotWeaponRig, type BotWeaponRig } from './core/botWeaponModels';

/**
 * Half-width of a bot's collision box — shared by the move gate and spawn
 * placement, and by the navigation graph, which owns it (nav.ts:NAV_RADIUS).
 * The graph samples what fits through gaps at this width, so a bot wider than
 * the value its routes were built against would be promised gaps it jams in.
 */
const BOT_RADIUS = NAV_RADIUS;

/**
 * What each weapon looks like in a bot's hands: the SAME authored GLB model
 * the player holds, mounted third-person on the aim hinge
 * (core/botWeaponModels.ts). There is deliberately no per-weapon table here:
 * widening the catalog fails to compile in the asset seam's own mechanism
 * table instead, which is the one place that must say how a new model moves.
 */

/**
 * Ceiling on how far a bot's aim tips to track a target (rad, ~69°).
 * Presentation only — a bot's shot is probability, not a ray from the muzzle.
 * Wide enough to read as "aiming up at the deck" from underneath, short of
 * vertical so the barrel never disappears into the bot's own silhouette.
 */
const MAX_AIM_PITCH = 1.2;

/**
 * Blend rate (1/s) toward the reload displacement — ~6 closes most of the gap
 * in a quarter second, so the magazine seats promptly while the brain's fire
 * controller reports reloading. The return trip is NOT blended: the pose snaps
 * to rest the frame reloading clears (issue #123), so the first shootable
 * frame never fires through a still-displaced magazine or cylinder.
 */
const RELOAD_BLEND_RATE = 6;

/**
 * Forward thrust (m) of the knife mount on a swing. The blade has no firing
 * mechanism to kick, so the swing itself is the motion: a quick jab along the
 * hinge's forward axis that decays with the same envelope as the gun kicks.
 */
const KNIFE_JAB = 0.18;

/**
 * How close (m) a bot must get to a waypoint before the next one is offered.
 * One nav cell: the path's own resolution, so a bot never chases a point it
 * has effectively already stood on.
 */
const WAYPOINT_REACHED = 1;

/** Seconds between route recomputes while pursuing a moving goal. */
const ROUTE_INTERVAL = 1;

/**
 * How far ahead (m) the route shortcut may look for a walkable line past the
 * next node — ~3 polyline joints on the 1 m graph. Short on purpose: the
 * clearance-priced graph already rides off the walls, and this only irons the
 * joint waggle rather than replanning the line.
 */
export const LOOKAHEAD_DISTANCE = 3;

/** Per-instance tuning and optional measurement hooks for repeatable movement trials. */
export interface BotOptions {
  brainParams?: BrainParams;
  lookaheadDistance?: number;
  onMovement?: (intended: number, realized: number) => void;
  onRouteBuild?: () => void;
}

/**
 * How far (m) off its own path a bot may drift before the route is thrown
 * away and rebuilt — it fell, was shoved, or respawned somewhere else.
 */
const ROUTE_ABANDON = 6;

/**
 * Zone fractions of the eye height for a target with no part meshes: the
 * player's eye IS their head (1.0), and torso/legs mirror the bot mesh's own
 * 1.63 / 1.18 / 0.425 offsets over its 1.6 m eye.
 */
const PLAYER_ZONE_FRACTION: Record<HitZone, number> = {
  head: 1.0,
  torso: 0.74,
  legs: 0.27,
};

/**
 * At most one A* per frame across ALL bots.
 *
 * A route costs ~4 ms on the elevation map's 17k-node graph, so a dozen bots
 * recomputing on the same frame is a ~50 ms spike — a dropped frame, in a
 * loop whose dt clamp then discards the overrun as game time. Bots that miss
 * their turn keep walking the route they already have and ask again next
 * frame; a path one frame stale is not a problem, a stutter is. Reset once
 * per frame in updateBots.
 */
let routeBudget = 1;

/** Reused walkability probe for the route shortcut — allocation in the frame loop is the thing to avoid here. */
const shortcutProbe = new THREE.Vector3();

/** Reused feeler probe for the brain's travel wall-sense, for the same reason. */
const senseProbe = new THREE.Vector3();

/**
 * The sound sequence every bot reads through THIS frame, captured once in
 * updateBots before any bot runs. It is what makes hearing independent of
 * registry order: a gunshot emitted mid-frame lands beyond the snapshot and
 * reaches every bot together on the next one.
 */
let soundHighWater = 0;

/** Serial source for Bot ids; 1-based per match, unique across teams. */
let nextBotId = 1;
/** Per-team display-name counters: names are `T-1…` and `CT-1…` independently. */
const teamSerials: Record<Team, number> = { T: 0, CT: 0 };

/**
 * DEV-only lifecycle trace (issue #17): makes the pause-freeze of the
 * scheduled revival observable from devtools — kill a bot, note the death
 * line, wait past 6 s wall-clock behind the pause menu, confirm the respawn
 * line only appears after resuming. Statically dead in production builds.
 */
function debugLog(msg: string): void {
  if (import.meta.env.DEV) console.debug(`[bot] ${msg}`);
}

// Shared geometries/materials — one allocation for all bots. Two palettes:
// T tan/brown, CT blue-gray, so sides read at a glance. ~1.75 m overall
// with adult-like ratios: legs 0–0.85 m (~49%), head 0.24 m (~14%).
const botGeo = {
  torso:  new THREE.BoxGeometry(0.62, 0.66, 0.36),
  head:   new THREE.BoxGeometry(0.24, 0.24, 0.24),
  legs:   new THREE.BoxGeometry(0.55, 0.85, 0.32),
};
const palettes: Record<Team, { body: THREE.MeshToonMaterial; head: THREE.MeshToonMaterial; legs: THREE.MeshToonMaterial }> = {
  T: {
    body: createCelMaterial({ color: 0x8a6b2e }),
    head: createCelMaterial({ color: 0xd8c39a }),
    legs: createCelMaterial({ color: 0x4d4436 }),
  },
  CT: {
    body: createCelMaterial({ color: 0x4a5a78 }),
    head: createCelMaterial({ color: 0xc9d2df }),
    legs: createCelMaterial({ color: 0x2f3646 }),
  },
};

/**
 * The ONE cast bridging raycast hits back to the bot that owns a mesh.
 *
 * @types/three types userData as Record<string, any>, so every direct read
 * of `userData.bot` would leak `any` into consumer code and trip the
 * no-unsafe-* rules. This accessor is the only place that reads it; call
 * sites handle the undefined return instead of asserting.
 */
export function botFor(obj: THREE.Object3D): BotShape | undefined {
  return obj.userData.bot as BotShape | undefined;
}

/**
 * One entity this bot may fight, carrying its stable perception identity.
 * The player and bot targets differ in where shot damage is routed.
 *
 * `feet` is the target's FEET on both arms (see VisualCandidate) — the
 * player's own `pos` is its EYE (core/state.ts), so the player arm uses the
 * shared `playerFeet()` conversion rather than passing the state vector
 * straight through. `eye` is the LOS endpoint: the camera for the player,
 * the bot's eyePos().
 */
type Target =
  | { kind: 'player'; id: PerceptionId; feet: THREE.Vector3; eye: THREE.Vector3; alive: boolean }
  | { kind: 'bot'; id: PerceptionId; feet: THREE.Vector3; eye: THREE.Vector3; alive: boolean; bot: BotShape };

/** Concrete Bot: implements the structural `Bot` shape core/state.ts declares for the registry. */
export class Bot implements BotShape {
  mesh = new THREE.Group();
  torso: THREE.Mesh;
  head: THREE.Mesh;
  legs: THREE.Mesh;
  /** Hinge carrying the aim barrel; pitched at the target each frame. */
  readonly aim = new THREE.Group();
  hp = 100;
  alive = true;
  /** Scoreboard counters for the end screen (state.ts:Bot docs). */
  kills = 0;
  deaths = 0;
  /** Stable identity for debug logs and killfeed attribution. */
  id = nextBotId++;
  /** Which side this bot fights for; drives targeting, spawns and scoring. */
  team: Team;
  name: string;
  /** Varied per bot so they spread out. */
  speed = 3.2 + Math.random() * 1.4;
  respawnPoint = new THREE.Vector3();
  /**
   * The catalog weapon this bot is holding RIGHT NOW, which changes within a
   * life as positions run dry. Written here alone: resynced from the brain's
   * weapon after decide() returns, so a swap inside decide() is reflected in
   * this frame's attack, audio and held model.
   */
  weapon: BotWeaponId;
  /**
   * This bot's policy and the weapon it fights with. Both are per-bot state;
   * the brain's whole stimulus ladder is weapon-independent, and everything
   * that differs between an smg bot and a sniper bot is either a BrainParams
   * number or something the composed loadout owns.
   */
  private readonly brain: DefaultBrain;
  /**
   * The authored-model mount hanging on the aim hinge, for the weapon held
   * RIGHT NOW. Rebuilt by rebuildAimGroup() on construction, respawn and dry
   * swap — never mutated across weapons, so a swap cannot leak one model's
   * pose into another's. Null only before the constructor's rebuild runs;
   * every reader narrows rather than asserting.
   */
  private rig: BotWeaponRig | null = null;
  /** Game time of the last attack, for the firing kick / knife jab envelope. */
  private lastShotAt = -Infinity;
  /** Smoothed reload displacement, driven toward the brain's reloading flag. */
  private reloadBlend = 0;
  /**
   * Fair-rotation cursor for the per-frame visual acquisition: the index the
   * next scan starts from when the brain's tracked identity is not cheaply
   * eligible. Advanced by acquisition only (see sim/perception.ts); reset
   * with the rest of the per-life state on respawn.
   */
  private perceptionCursor = 0;
  /**
   * Sequence of the last sound event this bot has been offered. Advances to
   * the frame's high-water mark every living update, whether or not anything
   * survived the team and earshot filters — an event this bot could not hear
   * is still an event it has now been past.
   *
   * A corpse's update() early-returns, so a dead bot's cursor stands still;
   * respawn() jumps it to the present rather than replaying the firefight it
   * missed.
   */
  private soundCursor = 0;
  /**
   * Whether last frame's intended step was rejected by world collision.
   *
   * Public because it is part of the structural Bot shape in core/state.ts:
   * with no pathfinding, this flag plus `onGround` is the whole story of what
   * a bot is doing against geometry, and hud.ts's elevation readout shows it
   * live. Written here only — treat it as read-only from outside.
   */
  moveBlocked = false;
  /** Vertical velocity — bots resolve support like the player does (stairs). */
  vy = 0;
  /** Grounded state fed back to resolveVertical so stair descents stick. */
  onGround = true;
  /**
   * What this bot's brain is doing, for hud.ts's DEV readout.
   *
   * Public for the same reason moveBlocked is: it is part of the structural
   * Bot shape and the readout renders it. Written here only.
   */
  mode: BrainMode = 'hold';
  /** Waypoints the bot is currently walking, nav-graph order; empty when none. */
  private path: THREE.Vector3[] = [];
  private transportPath: RouteWaypoint[] = [];
  private elevatorTrip: ElevatorTrip | null = null;
  private elevatorRequested = false;
  /** How far along `path` the bot has got. */
  private leg = 0;
  /**
   * The furthest leg the shortcut steered at last frame — the bound on which
   * legs proximity may consume (sim/routeFollow.ts:consumeReached). Reset
   * with `leg` whenever the path is replaced.
   */
  private aimed = 0;
  /**
   * World-space point the brain's intent looks at (a copy of the observed
   * eye), for debugView.ts's intent line; null when the brain has nothing
   * to look at (hold).
   *
   * Public for the same reason `mode` is: part of the structural Bot shape,
   * rendered by a DEV view, written here only.
   */
  targetEye: THREE.Vector3 | null = null;
  /**
   * Shot-gate readout for debugView.ts's intent line (issue #46): whether
   * this bot could actually FIRE at its current focus, split into the two
   * gates the trigger applies — range, and sight.
   *
   * Public for the same reason `targetEye` is: part of the structural Bot
   * shape, rendered by a DEV view, written here only. Sight here is the
   * frame's own observation (acquisition spent the frame's ray), so no
   * extra probe is paid for the readout; it is fresh every frame. The key
   * binding is DEV-only, but the debug facade may enable the flag explicitly
   * in a production preview for smoke-test diagnostics.
   */
  targetInRange = false;
  targetLOS: boolean | null = null;
  /** Seconds until this bot may spend the frame's route budget again. */
  private routeCooldown = 0;
  /**
   * Which pursuit the cached route belongs to — 'v' (current-visual) or 'm'
   * (memory) pursuit, plus the focus id — or 'p' for a patrol leg. A
   * remembered goal must not inherit a path computed for a different pursuit
   * or a different target: the key is checked on every route request and the
   * cache dropped on any change.
   */
  private routeKey: string | null = null;
  /**
   * World-space patrol node this bot is walking toward, or null when idle in
   * the patrol pause. Selection is LAZY: the node is drawn (pure selector
   * under the graph's rng contract) only when the brain's pause ends, and it
   * is accepted only when the budgeted A* produces a route — an unreachable
   * candidate is discarded and a fresh one is picked after the brain's next
   * one-second pause. Cleared by any interrupt (visual, damage, hold) and by
   * respawn.
   */
  private patrolGoal: THREE.Vector3 | null = null;

  /**
   * The domination flag this bot is assigned to, or null outside dom matches
   * (and whenever the dispatcher has nothing to give). Written by
   * updateBots' dispatcher via assignObjective(); read once per frame as
   * BrainView.objective. The position is the flag's own — it never moves, so
   * sharing the reference is safe, and the view clones it on the way in.
   * Teammate cover (`cappingMates`, `holdRank`) is computed per frame in
   * update() from the ring census updateBots keeps.
   */
  private domObjective: DomObjective | null = null;

  /**
   * Take (or clear) the dispatcher's flag assignment. The brain consumes it
   * as BrainView.objective on the next update; a mid-life reassignment
   * simply retargets the route cache through the existing owner-key change.
   */
  assignObjective(o: DomObjective | null): void {
    this.domObjective = o;
  }

  /**
   * Read-only exposure of the assignment for the ring census, which ranks
   * holders per flag and must exclude every bot that was sent somewhere else
   * (see refreshDomCensus). Undefined with no assignment.
   */
  get objectiveId(): string | undefined {
    return this.domObjective?.id;
  }

  private readonly options: BotOptions;

  constructor(team: Team = 'T', weapon: BotPrimaryId = 'smg', secondary: BotSidearmId = 'pistol', options: BotOptions = {}) {
    // Plain assignments, not parameter properties: the `name` derivation must
    // see the team, and field initializers run before constructor-body
    // parameter-property writes would. The brain is the same case for a
    // sharper reason — it needs the weapon, which a field initializer cannot
    // see at all.
    this.team = team;
    this.name = `${team}-${++teamSerials[team]}`;
    this.weapon = weapon;
    this.options = options;
    this.brain = new DefaultBrain(
      options.brainParams ?? DEFAULT_BRAIN_PARAMS,
      Math.random,
      makeBotLoadout(weapon, secondary, id => WEAPONS[id], Math.random),
    );

    // Build the ragdoll-ish stack: legs / torso / head as separate meshes so
    // raycasts can distinguish hit zones. All parts share this group's transform.
    const palette = palettes[team];
    this.torso = new THREE.Mesh(botGeo.torso, palette.body);
    this.torso.name = 'bot-torso';
    this.torso.position.y = 1.18;
    this.head = new THREE.Mesh(botGeo.head, palette.head);
    this.head.name = 'bot-head';
    this.head.position.y = 1.63;
    this.legs = new THREE.Mesh(botGeo.legs, palette.legs);
    this.legs.position.y = 0.425;
    [this.torso, this.head, this.legs].forEach(p => { p.castShadow = true; this.mesh.add(p); });
    const parts = { torso: this.torso, head: this.head, legs: this.legs };
    // Tag every part with its owner so bullet raycasts can attribute hits.
    for (const part of Object.values(parts)) part.userData.bot = this;

    // Aim pivot: the held model on a shoulder-height hinge, so PITCH is
    // visible. Rotating the head cube in place was not — a featureless box
    // turning about its own centre shows nothing, which a playtest confirmed
    // (docs/ai-plan.md, lesson 25). A barrel that swings has a direction.
    //
    // Deliberately NOT tagged with userData.bot, and deliberately not a field
    // weapons.ts knows about: its raycast targets are an explicit allowlist
    // (`bot.head, bot.torso, bot.legs`), so this stays decorative by
    // construction. It has to — sim/damage.ts:partForMesh falls through to
    // 'torso' for any mesh it does not recognize, so a model that ever
    // reached that list would silently become a torso hit rather than error.
    // Bot LOS rays against `solids` only, so it never blocks sight either.
    // Handedness is per-bot identity, rolled once here so it survives
    // respawn: ~9:1 right-shoulder (-X; the bot faces +Z) to left (+X).
    // Pure pick in core/botWeaponModels.ts; Math.random matches the speed
    // roll and brain rng stream already drawn directly in this constructor.
    this.aim.position.set(pickBotShoulderOffset(Math.random), 1.35, 0);
    // The held model itself goes through the same helper a dry swap uses, so
    // construction and swapping share ONE definition rather than two that drift.
    this.rebuildAimGroup();
    this.mesh.add(this.aim);

    this.spawnAtRandom();
    scene.add(this.mesh);
  }

  /**
   * Place inside this team's spawn zone for this map (core/state.ts:BOT_SPAWNS).
   * Rejection-sampled against `colliders` — a blind draw lands inside a
   * corner block or crate ~20% of the time, and a bot spawned inside
   * geometry is stuck there for life (the move gate only blocks entering).
   *
   * The zone's `y` is passed through to findFreeSpawn as the candidate's FEET,
   * not left at the floor: maps/warehouse2.ts spawns Ts on the catwalk, and
   * testing those against the ground-floor geometry beneath the ring would
   * reject the good draws and keep the bad ones.
   *
   * In domination matches RESPAWNS pass a director-chosen point (an owned-flag
   * ring or the home zone at equal shares — see domSpawns.ts) instead of a
   * zone draw. The
   * initial wave never does: construction always samples the zone, so match
   * openings stay exactly as before. A director point that fails the same
   * collision test falls back to the zone draw rather than spawning walled.
   */
  spawnAtRandom(at?: THREE.Vector3): void {
    this.elevatorTrip = null;
    this.clearRouteCache();
    const zone = BOT_SPAWNS[session.map][this.team];
    let p: THREE.Vector3;
    if (at && !collidesAt(at, BOT_RADIUS, at.y, colliders)) {
      p = at.clone();
    } else {
      p = findFreeSpawn(
        () => new THREE.Vector3(
          zone.minX + Math.random() * (zone.maxX - zone.minX),
          zone.y,
          zone.minZ + Math.random() * (zone.maxZ - zone.minZ),
        ),
        BOT_RADIUS,
        colliders,
        32,
        zone.y,
      );
    }
    this.respawnPoint.copy(p);
    this.mesh.position.copy(p);
    // Spawn facing is a team convention, not a gameplay input: Ts look toward
    // +z and CTs toward -z. The first perception frame reads its facing basis
    // off this yaw.
    this.mesh.rotation.y = this.team === 'T' ? 0 : Math.PI;
    // The zone is standable by construction: clear vertical state carried from
    // that just ended rather than relying on resolveVertical to self-heal it.
    this.vy = 0;
    this.onGround = true;
  }

  /**
   * Direction-only "shot came from this way" stimulus, forwarded to the
   * brain. The bearing is a normalized planar victim-to-attacker direction;
   * no attacker identity, distance or destination passes through here.
   */
  onIncomingFire(bearing: THREE.Vector3): void {
    this.brain.onIncomingFire(bearing);
  }

  /**
   * Full-life reset: revive, replace, and drop every per-life state — body
   * (hp/visibility/vertical state), placement, brain policy state (stagger,
   * focus, memory, scan, damage reaction), perception cursor, cached route
   * and its cooldown, mode/intent target/DEV gates, movement-blocked state
   * and aim pitch. BOTH scheduled revival paths (die()'s six-second
   * self-revival and combat.ts's 2.5-second wave reset) route through here,
   * so neither can revive a bot halfway.
   */
  respawn(): void {
    this.hp = 100;
    this.alive = true;
    this.mesh.visible = true;
    // Domination respawns come through the director (owned-flag rings and the
    // home zone at equal shares); every other match — and every initial wave,
    // which never passes through here — keeps the zone draw.
    if (session.mode === 'dom' && dom.flags.length > 0) {
      this.spawnAtRandom(pickDomRespawn(this.team));
    } else {
      this.spawnAtRandom();
    }
    // The brain outlived the body: re-arm its spawn stagger and drop the
    // corpse's attention, memory and reactions — a new life inherits nothing.
    this.brain.onRespawn();
    // arm() put the loadout back on its primary, so the BODY must follow in
    // this same call rather than at the next frame's resync in update(). A
    // respawn is a full-life reset, and a bot that stands up carrying the
    // model — and the killfeed name — of the weapon it died holding is
    // exactly the stale display this method exists to clear. It also cannot
    // wait for a frame that may not come: the loop only simulates under
    // pointer lock, so a respawn scheduled across a pause would otherwise
    // show the wrong barrel for as long as the menu is up.
    this.weapon = this.brain.weapon;
    this.rebuildAimGroup();
    // A new life inherits no reload pose: the loadout's load() cleared any
    // reload in flight, and the fresh rig starts at rest — carrying the
    // corpse's blend into a render before the next update would displace it.
    this.reloadBlend = 0;
    this.perceptionCursor = 0;
    // The present, not zero: six seconds of combat happened while this bot
    // was a corpse and none of it is news.
    this.soundCursor = soundEvents.latestSeq;
    this.clearRouteCache();
    this.patrolGoal = null;
    // The dispatcher's next run reassigns the new life; until then the corpse's
    // flag is dead — routing to it would walk a fresh spawn back to old orders.
    this.domObjective = null;
    this.routeCooldown = 0;
    this.mode = 'hold';
    this.targetEye = null;
    this.targetInRange = false;
    this.targetLOS = null;
    this.moveBlocked = false;
    this.aim.rotation.x = 0;
  }

  /**
   * Per-frame executor pass: run one visual acquisition, build the view,
   * take the brain's intent, realize it. No policy decisions live here.
   * @param dt delta time (s)
   * @param player the player entity
   */
  update(dt: number, player: PlayerState): void {
    if (!this.alive) return;
    this.mesh.position.y += elevatorCarry({ x: this.mesh.position.x, z: this.mesh.position.z,
      feetY: this.mesh.position.y, radius: BOT_RADIUS, height: HEAD_HEIGHT, grounded: this.onGround });
    // Input on the previous frame can have crossed onto the deck. Commit
    // that actual support before this frame's brain can interrupt the route.
    if (this.elevatorTrip?.phase === 'board') {
      const deck = elevators.find(e => e.spec.id === this.elevatorTrip?.id);
      if (deck && elevatorSupports({ x: this.mesh.position.x, z: this.mesh.position.z,
        feetY: this.mesh.position.y, radius: BOT_RADIUS, height: HEAD_HEIGHT, grounded: this.onGround },
      deck.collider, colliders)) this.elevatorTrip.phase = 'ride';
    }

    // Opposing entities as STABLE CANDIDATES — no positional selection here.
    // Perception owns acquisition; the brain only ever learns about the one
    // candidate the frame's single ray successfully looked at. Bots opposing
    // the player's side fight the player and every allied bot; allied bots
    // fight every enemy. The player is listed even
    // while dead — a dead candidate is a cheap rejection, so the bot holds
    // rather than chasing the corpse position.
    const enemies: Target[] = [];
    if (this.team !== session.playerTeam) {
      enemies.push({
        kind: 'player',
        id: 'player',
        // Feet, not the eye that `player.pos` holds: rise and the planar
        // closure measure compare these against bot feet, and passing the
        // eye through would hand every bot 1.6 m of phantom height.
        feet: playerFeet(player),
        eye: camera.position,
        alive: player.alive,
      });
    }
    for (const b of bots) {
      if (b === this || b.team === this.team) continue;
      enemies.push({ kind: 'bot', id: b.id, feet: b.mesh.position, eye: b.eyePos(), alive: b.alive, bot: b });
    }
    // ONE acquisition per living update: the brain's tracked identity is
    // probed first, else the cursor rotates fairly. Only its observation —
    // never the candidate list — reaches the brain.
    const selfEye = this.eyePos();
    const selfFacing = new THREE.Vector3(
      Math.sin(this.mesh.rotation.y), 0, Math.cos(this.mesh.rotation.y),
    );
    const acquisition = acquireVisual(
      { eye: selfEye, feet: this.mesh.position, facing: selfFacing },
      enemies,
      this.brain.focusId,
      this.perceptionCursor,
      (from, to) => hasLineOfSight(from, to, solids),
    );
    this.perceptionCursor = acquisition.cursor;

    // Everything audible since this bot last looked, filtered down to what it
    // is entitled to have heard. Team filtering drops allied noise AND its
    // own by the same test, since a bot shares a team with itself. The
    // reduced HeardSound is what crosses the seam: the brain gets a place and
    // a kind, never the emitter's identity.
    const heard: HeardSound[] = [];
    for (const ev of soundEvents.since(this.soundCursor, soundHighWater)) {
      if (ev.team === this.team) continue;
      if (!withinEarshot(ev, this.mesh.position)) continue;
      heard.push({ seq: ev.seq, t: ev.t, kind: ev.kind, pos: ev.pos.clone() });
    }
    this.soundCursor = soundHighWater;

    // Clamped, not free-running: a bot that spends minutes not routing would
    // otherwise drift the timer arbitrarily negative for no benefit, and the
    // first request after a lull should fire immediately either way.
    this.routeCooldown = Math.max(0, this.routeCooldown - dt);

    this.elevatorRequested = false;
    const intent = this.brain.decide(
      {
        selfFeet: this.mesh.position,
        facing: selfFacing,
        visual: acquisition.observation,
        onGround: this.onGround,
        selfSpeed: this.speed,
        moveBlocked: this.moveBlocked,
        heard,
        // The travel wall-sense's feeler, answered by the same feet-aware
        // gate the step below obeys: standable here means the step survives.
        canStandAt: (x, z) =>
          !collidesAt(senseProbe.set(x, 0, z), BOT_RADIUS, this.mesh.position.y, colliders),
        // The footing guard's probe: ground within one riser under the point,
        // walls ignored (those are canStandAt's). See DefaultBrain.hasFooting.
        hasFootingAt: (x, z) =>
          supportedAt(senseProbe.set(x, 0, z), this.mesh.position.y, colliders),
        // Lazy on purpose: pathfinding is the expensive thing here, so it is
        // only paid when the policy has already decided it wants to travel
        // rather than fight where it stands. The pursuit flag keys the route
        // cache: a frame WITH an observation routes at what it sees; a frame
        // WITHOUT one (memory pursuit) routes at the frozen remembered feet.
        nextWaypoint: (goal) => this.waypointToward(goal, acquisition.observation !== null),
        // The patrol analogue: lazily selects a map-wide patrol node and
        // routes to it under the same one-A-star-per-frame budget. Only paid
        // when the brain has already decided it has nothing better to do.
        nextPatrolWaypoint: () => this.nextPatrolWaypoint(),
        // The dispatcher's flag assignment plus live teammate cover, cloned
        // on the way in: the flag never moves, but the view contract is
        // copies, never live state. The mates are bare counts, never
        // identities or positions — flag states are broadcast anyway.
        objective: this.domObjective === null ? null : {
          id: this.domObjective.id,
          pos: this.domObjective.pos.clone(),
          radius: this.domObjective.radius,
          cappingMates: cappingMatesFor(this, this.domObjective.id),
          holdRank: holdRankFor(this, this.domObjective.id),
        },
      },
      dt,
    );

    // Route-cache ownership: whenever the intent leaves route/engage — a
    // search or hold of any kind (arrival, dead end, damage reaction,
    // forget, patrol pause) — drop the cached path so a later, unrelated
    // goal cannot inherit it. Objective and capture intents keep theirs like
    // route and engage do; only search and hold clear. And whenever the
    // intent leaves patrol — a visual, damage reaction, search or hold
    // interrupted it — the patrol goal is dead: drop it (and any
    // patrol-owned path) so a later leg cannot inherit a stale destination.
    if (intent.mode === 'search' || intent.mode === 'hold') this.clearRouteCache();
    if (intent.mode !== 'patrol') this.clearPatrolGoal();

    // A swap that happened inside decide() is reflected in this frame's
    // attack, audio and held model — resync before the shot is realized.
    if (this.brain.weapon !== this.weapon) {
      this.weapon = this.brain.weapon;
      this.rebuildAimGroup();
    }

    // Transport is movement execution: the brain can still aim and fire.
    // An unboarded trip is cancelled when its route is no longer requested.
    if (this.elevatorTrip && !committedTrip(this.elevatorTrip) && !this.elevatorRequested) this.elevatorTrip = null;
    let movementStep = intent.step;
    if (this.elevatorTrip) {
      const elevator = elevators.find(e => e.spec.id === this.elevatorTrip?.id);
      if (!elevator) this.elevatorTrip = null;
      else {
        const spec = elevator.spec;
        const result = elevatorTravel(this.elevatorTrip, {
          feet: this.mesh.position, grounded: this.onGround,
          supported: elevatorSupports({ x: this.mesh.position.x, z: this.mesh.position.z,
            feetY: this.mesh.position.y, radius: BOT_RADIUS, height: HEAD_HEIGHT, grounded: this.onGround },
          elevator.collider, colliders),
          dock: elevator.dock, lowerLanding: spec.lowerLanding, upperLanding: spec.upperLanding,
          center: new THREE.Vector3(spec.x, elevator.collider.max.y, spec.z),
          lowerY: spec.lowerY, upperY: spec.upperY,
        }, this.speed * dt);
        this.elevatorTrip = result.trip;
        movementStep = result.step;
        if (!result.trip) this.clearRouteCache();
      }
    }

    // Horizontal gate: the SAME axis-separated slide the player uses, with
    // feet-aware blocking — risers within STEP_HEIGHT don't stop a bot.
    const prevFeet = this.mesh.position.y;
    const preX = this.mesh.position.x, preZ = this.mesh.position.z;
    const intended = movementStep.length();
    slideMoveXZ(this.mesh.position, movementStep.x, movementStep.z, BOT_RADIUS, prevFeet, colliders);
    // Report rejection for NEXT frame's brain. DefaultBrain consumes the
    // contact's leading edge to reverse once; sustained rejection preserves
    // that committed drift until the bot clears the geometry.
    const realized = Math.hypot(this.mesh.position.x - preX, this.mesh.position.z - preZ);
    this.moveBlocked = realized < intended * 0.25;
    this.options.onMovement?.(intended, realized);

    // Vertical: same swept support resolution as the player, so bots climb
    // stairs mid-chase and land when they walk off an edge.
    this.vy -= GRAVITY * dt;
    const vert = resolveVertical(prevFeet, this.vy, dt,
      this.mesh.position.x, this.mesh.position.z, BOT_RADIUS, colliders, this.onGround);
    this.mesh.position.y = vert.feetY;
    this.vy = vert.velY;
    this.onGround = vert.onGround;

    // Launch pad. AFTER the resolve, because it keys off the grounded state
    // this frame actually produced, and it overwrites that state rather than
    // feeding into it. The launch begins after this frame's resolve; later
    // rising frames still pass through resolveVertical's ceiling sweep.
    const lift = launchFrom(this.mesh.position.x, this.mesh.position.z, vert.feetY,
      this.onGround, BOT_RADIUS, liftPads);
    if (lift !== null) {
      this.vy = lift;
      this.onGround = false;
    }

    this.mode = intent.mode;

    // Face where the brain looked, and tip the aim barrel at it so a bot
    // firing up at a deck visibly aims up. The mesh yaw puts local +z on the
    // intent facing, and a positive x-rotation tips that forward axis DOWN —
    // hence the negation. A holding bot exposes no lookAt, so the last
    // barrel pose is kept.
    this.mesh.rotation.y = Math.atan2(intent.facing.x, intent.facing.z);
    if (intent.lookAt) {
      const planar = Math.hypot(intent.lookAt.x - selfEye.x, intent.lookAt.z - selfEye.z);
      const pitch = Math.atan2(intent.lookAt.y - selfEye.y, Math.max(planar, 1e-6));
      this.aim.rotation.x = -THREE.MathUtils.clamp(pitch, -MAX_AIM_PITCH, MAX_AIM_PITCH);
    }
    this.targetEye = intent.lookAt;

    // DEV overlay readout of the shot gates (issue #46): the trigger is
    // range-gated AND sight-gated, and the overlay exists to say which
    // state a bot is in — shootable (`rs`, a current observation inside
    // engage range) or not (`--`; `-s` when the seen target sits beyond
    // engageRange). The gates are written only when the SAME frame's
    // observation agrees with the intent's focus, so a memory or damage
    // search stays dim even if acquisition happened to see something on a
    // damage-priority frame — the brain discarded that look. Sight here is
    // the frame's own observation (acquisition already spent the frame's
    // ray), so the readout costs no extra probe and is fresh every frame.
    const obs = acquisition.observation;
    const focusSeen = obs !== null && obs.id === intent.focusId;
    this.targetInRange = focusSeen && this.brain.inRange(obs.dist3);
    this.targetLOS = focusSeen ? true : acquisition.attempted !== null ? false : null;

    if (intent.wantShoot && obs && obs.id === intent.focusId
        && this.brain.inRange(obs.dist3)) {
      // Identity agreement first: the intent's focus must be the SAME frame's
      // observation. Only then does the id resolve back to the stable
      // candidate. Keep this executor-owned lookup rather than returning a
      // live Target from perception: observations cross that seam as copies
      // plus stable identity, never entity references. The die rolls from the
      // ACTUAL post-move distance (see sim/botWeapons.ts:botHitChance).
      const target = enemies.find(e => e.id === obs.id);
      if (target) this.shoot(this.eyePos().distanceTo(obs.eye), target);
    }

    // Third-person weapon presentation, every living frame: the mount answers
    // the same fire/reload signals the first-person viewmodel does — a kick
    // on each shot, the magazine seating while the fire controller reloads —
    // while the aim hinge above already carries this frame's yaw and pitch,
    // so the matrices the pose reads through are this frame's.
    const rig = this.rig;
    if (!rig) throw new Error(`Bot ${this.name}: weapon mount missing for ${this.weapon}`);
    // Issue #123: the pose must agree with shootability on the SAME frame the
    // logic completes. ready() goes true the frame advanceReload() finishes
    // (whole-mag) or pull() cancels the remainder (per-round interrupt), so a
    // blended return would let the next decide() fire through a magazine that
    // is still visibly out or a cylinder still swung out. Snap shut instead.
    if (this.brain.reloading) {
      this.reloadBlend = approach(this.reloadBlend, 1, dt, RELOAD_BLEND_RATE);
    } else {
      this.reloadBlend = 0;
    }
    const shotAge = gameTime.now() - this.lastShotAt;
    poseBotWeaponRig(rig, { shotAge, reloadBlend: this.reloadBlend });
    // The blade has no mechanism to kick, so the swing is the motion: a quick
    // forward jab of the whole mount on the attack envelope.
    rig.mount.position.z = this.weapon === 'knife' ? KNIFE_JAB * botShotKick(shotAge) : 0;
  }

  /**
   * Planar vector to the next waypoint on a route to `goal`, with a
   * three-way outcome: a waypoint when a (cached or fresh) path exists,
   * `undefined` when the shared one-A-star-per-frame budget deferred the
   * request, `null` when the graph confirmed there is no route.
   *
   * Mechanism, not policy: this keeps and refreshes the path and decides which
   * waypoint is "next", while the brain decides whether to walk it at all —
   * and only ever names the goal. Three kinds of goal reach it: what the brain
   * currently SEES, what it last remembered (a lost sighting or a heard
   * noise), and — since domination — the assigned flag, which
   * botBrains.ts:objectiveIntent routes to through this same
   * BrainView.nextWaypoint callback. Same split as the old seeTarget: the
   * executor owns the raycast and the graph, the brain owns the trigger and
   * the route decision.
   */
  private waypointToward(goal: THREE.Vector3, visualPursuit: boolean): THREE.Vector3 | undefined | null {
    // A remembered goal must not inherit a path computed for a different
    // pursuit ('v' vs 'm') or a different target (focus id): key the cache
    // and drop it on any mismatch.
    // A heard goal carries no focus id to key on (a noise identifies nobody),
    // so it keys on the GOAL itself, rounded to a decimetre. Without that,
    // two successive noises would share the owner `m:*` and the second would
    // walk the first one's cached path until ROUTE_INTERVAL happened to
    // expire. An objective goal keys the same way, and for the same reason: a
    // flag is a place, so objectiveIntent holds no focus while it routes to
    // one (botBrains.ts) and the coordinates own the key.
    const owner = this.brain.focusId ?? `${goal.x.toFixed(1)},${goal.y.toFixed(1)},${goal.z.toFixed(1)}`;
    const key = `${visualPursuit ? 'v' : 'm'}:${owner}`;
    return this.waypointOnRoute(goal, key, false);
  }

  /**
   * Lazy patrol leg: select a map-wide patrol node (pure, cheap) when none is
   * active, then route to it under the SAME cached-path/budget machinery the
   * combat pursuits use — with a distinct `'p'` route-owner key so changing
   * owners clears stale paths.
   *
   * A candidate is accepted only when the budgeted A* produces a route; an
   * unreachable one is discarded (the brain restarts its one-second pause and
   * the next request picks a fresh node). Reaching the final node ends the
   * leg: the goal and route are cleared and null is returned, which restarts
   * the brain's one-second pause. A deferred budget keeps the candidate and
   * returns undefined — the brain waits in `patrol` and asks again.
   */
  private nextPatrolWaypoint(): THREE.Vector3 | undefined | null {
    const grid = navGrid();
    if (grid === undefined || grid.count === 0) return null;
    if (this.patrolGoal === null) {
      const current = nearestNode(grid, this.mesh.position);
      const idx = pickPatrolNode(grid, this.mesh.position, current, Math.random);
      if (idx < 0) return null;
      const n = navNode(grid, idx);
      this.patrolGoal = new THREE.Vector3(n.x, n.y, n.z);
      this.clearRouteCache();
    }
    const result = this.waypointOnRoute(this.patrolGoal, 'p', true);
    if (result === null) {
      // Arrival at the final patrol node, or a confirmed-unreachable
      // candidate: either way the goal is spent — the brain's one-second
      // pause runs, and the next request selects a fresh node.
      this.clearPatrolGoal();
    }
    return result;
  }

  /**
   * Shared route realization for every pursuit that walks the graph: key the
   * cache by `key` (dropping stale paths on owner change), abandon drifted
   * paths, recompute under the one-A-star-per-frame budget, then hand back
   * the relative planar waypoint — or `null` (no route / zero-length leg) or
   * `undefined` (budget deferred). Moving pursuit goals refresh periodically;
   * an immutable patrol goal keeps its valid path until arrival or abandon.
   *
   * `patrolArrival` extends the one-metre waypoint threshold to the FINAL
   * node: standing within it ends the patrol (clear route, return null)
   * instead of pushing into the goal forever.
   */
  private waypointOnRoute(
    goal: THREE.Vector3,
    key: string,
    patrolArrival: boolean,
  ): THREE.Vector3 | undefined | null {
    const here = this.mesh.position;
    if (this.elevatorTrip) {
      if (!committedTrip(this.elevatorTrip) && this.routeKey !== key) {
        this.elevatorTrip = null;
        this.clearRouteCache();
      } else {
        this.elevatorRequested = true;
        return undefined;
      }
    }
    if (this.routeKey !== key) {
      this.routeKey = key;
      this.path = [];
      this.leg = 0;
      this.aimed = 0;
    }
    // Drop a path the bot is no longer on: it fell off an edge, got shoved,
    // or respawned across the map still holding last life's route. The
    // decision consults the previous waypoint too — a leg just inherited by
    // consuming its predecessor is not ground truth about where the bot
    // should be, and abandoning against it livelocks on link-edge hops
    // (docs/warehouse2-bot-playtest.md section 4). See sim/routeFollow.ts.
    if (this.path.length > 0 && shouldAbandonRoute(this.path, this.leg, here, ROUTE_ABANDON)) {
      this.path = [];
      this.leg = 0;
      this.aimed = 0;
    }
    const wantsRecompute = this.path.length === 0
      || (!patrolArrival && this.routeCooldown <= 0);
    let recomputed = false;
    if (wantsRecompute && routeBudget > 0) {
      // One A* per frame across all bots; whoever misses out keeps walking
      // whatever it already has.
      routeBudget--;
      recomputed = true;
      this.routeCooldown = ROUTE_INTERVAL;
      const found = transportRoute(here, goal);
      this.options.onRouteBuild?.();
      if (found) {
        this.transportPath = found;
        this.path = found.map(w => w.point);
        this.leg = 0;
        this.aimed = 0;
      } else {
        // A failed recompute must not keep walking a stale path.
        this.path = [];
        this.leg = 0;
        this.aimed = 0;
      }
    }
    if (this.path.length === 0) {
      // Deferred (budget spent elsewhere) vs confirmed dead end — the brain
      // waits on the first and starts searching on the second.
      return recomputed ? null : undefined;
    }

    // Consume waypoints already stood on, planar — the step is planar too.
    // Any leg up to the one the shortcut aimed at counts, not only the
    // current one in strict order: a corner cut or a shove can carry the
    // bot past `path[leg]` outside the reach radius, and a frozen leg would
    // starve the abandon check below and never reach a boarding leg.
    this.leg = consumeReached(this.path, this.transportPath, this.leg, this.aimed, here, WAYPOINT_REACHED);
    const w = this.path[this.leg]!;
    const elevatorId = this.transportPath[this.leg]?.elevatorId;
    if (elevatorId) {
      const elevator = elevators.find(e => e.spec.id === elevatorId);
      if (elevator) {
        this.elevatorTrip = { id: elevatorId,
          destination: Math.abs(w.y - elevator.spec.upperY) < 0.3 ? 'upper' : 'lower', phase: 'approach' };
        this.elevatorRequested = true;
        return undefined;
      }
    }
    const to = new THREE.Vector3(w.x - here.x, 0, w.z - here.z);
    // A patrol's FINAL node within the one-metre threshold IS the arrival:
    // the leg is over, the goal and route die, and the brain stands down.
    if (patrolArrival && this.leg === this.path.length - 1 && to.length() <= WAYPOINT_REACHED) {
      this.clearRouteCache();
      return null;
    }
    // Shortcut smoothing: steer at the furthest walkable line within a few
    // metres rather than turning at every 1 m joint. Aiming past a leg does
    // not mark it reached; consumption above does, by proximity, for legs up
    // to the one aimed at — so the abandon decision keeps its ground truth
    // and elevator boardings (which return before this line) are never aimed
    // past. Samples are gated on collision AND support, the pair the step
    // itself obeys: between nav nodes there is no floor guarantee, and a
    // chord across a deck's concave corner samples clear over the drop
    // (collision.test.ts:standableAt). See sim/routeFollow.ts.
    this.aimed = furthestWalkable(
      this.path,
      this.transportPath,
      this.leg,
      here,
      this.options.lookaheadDistance ?? LOOKAHEAD_DISTANCE,
      (x, z) => !standableAt(shortcutProbe.set(x, 0, z), BOT_RADIUS, here.y, colliders),
    );
    const target = this.path[this.aimed]!;
    to.set(target.x - here.x, 0, target.z - here.z);
    return to.lengthSq() < 1e-8 ? null : to;
  }

  /** Drop the cached route: path, leg and goal key. */
  private clearRouteCache(): void {
    this.path = [];
    this.transportPath = [];
    this.leg = 0;
    this.aimed = 0;
    this.routeKey = null;
  }

  /**
   * End the current patrol leg: the goal dies, and any path cached for the
   * patrol owner ('p') with it. Called when an intent leaves patrol — a
   * visual or damage reaction, a search, a hold, a respawn — and when the
   * leg itself ends (arrival or a confirmed-unreachable candidate).
   */
  private clearPatrolGoal(): void {
    this.patrolGoal = null;
    if (this.routeKey === 'p') this.clearRouteCache();
  }

  /**
   * Read-only views of the route state for debugView.ts.
   *
   * `path`/`leg` stay private — the overlay reads them, nothing outside writes
   * them — so these are getters rather than a widened field.
   */
  get navPath(): readonly THREE.Vector3[] { return this.path; }
  get navLeg(): number { return this.leg; }

  /**
   * Magazine state for the DEV readout, delegated to the brain's weapon.
   * Getters for the same reason as the route views above: the fire controller
   * owns these numbers, and mirroring them into fields would be a second copy
   * to keep in sync every frame.
   */
  get mag(): number { return this.brain.mag; }
  get magSize(): number { return this.brain.magSize; }
  get reserve(): number { return this.brain.reserve; }
  get reloading(): boolean { return this.brain.reloading; }

  /** World-space eye position used for LOS checks (~head height, 1.6 m over the feet). */
  eyePos(): THREE.Vector3 {
    return new THREE.Vector3(this.mesh.position.x, this.mesh.position.y + 1.6, this.mesh.position.z);
  }

  /**
   * World-space muzzle, for the muzzle flash: the authored Muzzle marker's
   * composed position, so the flash leaves the model's own barrel tip
   * whatever the weapon's length.
   *
   * Flushes the group's world matrix first: update() has already written this
   * frame's yaw and pitch, but nothing has composed them yet — the renderer
   * does that later. Called only on firing frames, so the flush is paid at
   * the bot's cooldown rate rather than per frame. The knife never reaches
   * here — the melee path returns before the flash — so a missing marker is
   * corrupted state and throws rather than inventing a position.
   */
  private muzzlePos(): THREE.Vector3 {
    this.mesh.updateMatrixWorld(true);
    const muzzle = this.rig?.muzzle;
    if (!muzzle) throw new Error(`Bot ${this.name}: no muzzle marker for ${this.weapon}`);
    return muzzle.getWorldPosition(new THREE.Vector3());
  }

  /**
   * Realize a shot the brain ordered. Hits stay probabilistic (no
   * projectile): each of the weapon's rays rolls against a chance that falls
   * off linearly with the eye-to-eye distance, so distant bots are mostly
   * noise. What a landed ray is WORTH comes from the catalog — a rolled hit
   * zone through sim/damage.ts:damageForPart — so a bot victim can take a
   * head-multiplied 220 from a revolver as readily as a 26 from an smg, and
   * 'flat torso' damage no longer exists on this path.
   *
   * One damage call per trigger pull whatever the ray count, attributed to
   * the best zone any ray struck; see the summing comment below. Every die
   * (per-ray hit, per-landed-ray zone) comes from the brain's rng stream.
   */
  private shoot(dist: number, target: Target): void {
    // Audible either way — a swing that misses is exactly as loud as one that
    // lands, like every other attack on this path. Stamps the attack time for
    // the model's firing kick (or the knife's jab) either way.
    sfxEnemyAttack(this.mesh.position, this.weapon);
    this.lastShotAt = gameTime.now();
    if (this.brain.resolution === 'melee') {
      this.swing(target);
      return;
    }
    const muzzle = this.muzzlePos();
    spawnImpact(muzzle); // cheap muzzle flash, from the barrel tip
    // Emitted BEFORE the hit die, so a miss is exactly as audible as a hit —
    // hearing reports that a trigger was pulled, not that it landed. At the
    // FEET rather than the muzzle, for the reason weapons.ts states: a heard
    // position is a routing goal, and nearestNode's height weighting would
    // send a listener to the deck overhead.
    //
    // A blade stays BELOW this emit: it is SILENT to 6b's hearing, so a knife
    // bot cannot summon investigators by attacking. That mirrors the player's
    // own melee path, which returns from weapons.ts:shoot before its emit.
    soundEvents.emit({
      kind: 'gunshot',
      sourceId: this.id,
      team: this.team,
      pos: this.mesh.position,
      radius: GUNSHOT_RADIUS_M,
      t: gameTime.now(),
    });

    // One resolution per trigger pull, and ONE damage call from it however
    // many rays landed. A shotgun's eight pellets are one event to the
    // victim: damagePlayer flashes the vignette and plays sfxHurt per CALL,
    // so routing them separately would be eight grunts in a single frame.
    // The zone is the best any ray struck, the same rule weapons.ts uses when
    // it reddens one hitmarker for a whole pattern.
    const shot = this.brain.resolveShot(dist);
    if (shot.zone === null) return;
    if (target.kind === 'player') damagePlayer(shot.damage, this.name);
    else damageBot(target.bot, shot.damage, shot.zone, this.name);
  }

  /**
   * Realize a melee swing the brain ordered.
   *
   * Unlike a bot's gunfire, this is not probabilistic: sim/melee.ts tests the
   * blade's real reach and arc against the target's own zone points, the nearest
   * part wins, and a strike from behind multiplies by the catalog's backstab
   * bonus. The brain already chose WHO; this decides whether the swing connects
   * and where — so a bot that has not finished turning genuinely whiffs.
   */
  private swing(target: Target): void {
    // The bot's ACTUAL aim pose: flush with the same updateMatrixWorld the
    // muzzle path pays, for the same reason — the frame's yaw and pitch are
    // written but not composed. The aim group's world +Z is the barrel axis.
    // The eye→target vector is NOT used: it is always perfectly aligned and
    // would make the arc test meaningless.
    this.mesh.updateMatrixWorld(true);
    const dir = this.aim.getWorldDirection(new THREE.Vector3());
    const origin = this.eyePos();
    const def = WEAPONS[this.weapon];
    // Documented pairing (validateWeapons): range/arcRad exist exactly when melee.
    const range = def.range ?? 0;
    const arcRad = def.arcRad ?? 0;
    // Candidates are the ONE focused target's three zone points, not the
    // field. For a bot: the world positions of its own part meshes. For the
    // player, who has no part meshes: synthesized from the target's own feet
    // and eye at fractions of the eye height.
    const candidates: MeleeCandidate<Target>[] = [];
    if (target.kind === 'bot') {
      const b = target.bot;
      candidates.push(
        { payload: target, zone: 'head', at: b.head.getWorldPosition(new THREE.Vector3()) },
        { payload: target, zone: 'torso', at: b.torso.getWorldPosition(new THREE.Vector3()) },
        { payload: target, zone: 'legs', at: b.legs.getWorldPosition(new THREE.Vector3()) },
      );
    } else {
      const eyeH = target.eye.y - target.feet.y;
      for (const zone of ['head', 'torso', 'legs'] as const) {
        candidates.push({
          payload: target,
          zone,
          at: new THREE.Vector3(
            target.feet.x, target.feet.y + eyeH * PLAYER_ZONE_FRACTION[zone], target.feet.z),
        });
      }
    }
    const hit = meleeSwing(origin, dir, range, arcRad, candidates);
    if (!hit) return;
    // Backstab is classified only AFTER the range/arc winner is chosen — it
    // scales that hit, it never steers selection (the same ordering
    // weapons.ts:swingMelee documents).
    //
    // The two victims report their facing differently and neither may be
    // open-coded: a bot's is its group's local +Z (Bot.update maintains that
    // invariant), and the player's is the camera's −Z view direction, which is
    // the convention every shot is built from in sim/ballistics.ts:directed.
    // Rebuilding the player's from aim.yaw by hand is how the sign gets
    // inverted and backstabs land on the wrong side.
    const victimPos = target.kind === 'bot' ? target.bot.mesh.position : target.feet;
    const victimForward = target.kind === 'bot'
      ? target.bot.mesh.getWorldDirection(new THREE.Vector3())
      : camera.getWorldDirection(new THREE.Vector3());
    let dmg = damageForPart(def, hit.part);
    if (isBackstab(origin, victimPos, victimForward)) dmg *= def.backstabMult ?? 1;
    // ONE damage call per swing, routed exactly as the ranged path does.
    if (target.kind === 'player') damagePlayer(dmg, this.name);
    else damageBot(target.bot, dmg, hit.part, this.name);
  }

  /**
   * Death: hide, attribute the kill, then self-respawn after 6 s of GAME
   * time — a paused match doesn't respawn bots behind the menu.
   * @param killerPart zone that landed the kill
   * @param killerName display name of the shooting bot; omitted when the
   *   PLAYER pulled the trigger
   */
  die(killerPart: HitZone, killerName?: string): void {
    this.alive = false;
    this.elevatorTrip = null;
    this.mesh.visible = false;
    this.deaths++;
    // Team scores are side-fixed (creditKill): scoreKills is the CT score,
    // scoreDeaths the T score — in TDM; the call is a no-op in domination,
    // where kills are worth nothing. Credit the killer's side for an opposing
    // casualty only — a player kill counts for the player's side, whatever
    // it is.
    const killer = killerName === undefined
      ? undefined
      : bots.find(b => b.name === killerName);
    const killerTeam = killer?.team ?? session.playerTeam;
    if (killerTeam === opposing(this.team)) creditKill(killerTeam);
    // Scoreboard attribution: the player's own kills get a personal counter;
    // a bot killer is resolved by display name (unique per team serial).
    // Hoisted out of the counter branch because the killfeed needs it too:
    // a bot killer names the weapon it did it with.
    if (killerName === undefined) score.playerKills++;
    else if (killer) killer.kills++;
    updateScore();
    // A bot-dealt kill can finally say 'headshot'. Before the hit zone was
    // rolled, the executor passed a hardcoded 'torso' for every bot shot, so
    // the wording existed but no bot could ever reach it.
    addKillfeed(killerName === undefined
      ? `You ${killerPart === 'head' ? '☠ headshot' : 'killed'} ${this.name}`
      : `${killerName}${botKillTag(killer)}` +
        ` ${killerPart === 'head' ? '☠ headshot-killed' : 'killed'} ${this.name}`);
    debugLog(`${this.name} died (${killerPart}) t=${gameTime.now().toFixed(1)}s`);
    checkRoundEnd();
    gameTime.schedule(6, () => {
      // The wave reset (combat.ts, 2.5 s) may already have revived this bot
      // via respawn(); guard so a later callback does not teleport an
      // already-revived bot a second time.
      if (this.alive) return;
      this.respawn();
      debugLog(`${this.name} respawned t=${gameTime.now().toFixed(1)}s`);
    });
  }

  /**
   * Rebuild the aim group's held model for the current weapon: a fresh clone
   * of the authored asset, so per-bot posing never moves another bot's
   * mechanisms. Clearing drops the old mount without disposing anything —
   * geometry and materials are shared with the loaded asset (clone shares
   * them), so disposing would blank the whole field. Also resets the
   * presentation envelopes, so a swap or respawn never inherits a kick or a
   * half-seated magazine from the previous weapon/life.
   */
  private rebuildAimGroup(): void {
    this.aim.clear();
    this.rig = createBotWeaponRig(this.weapon);
    this.aim.add(this.rig.mount);
    this.lastShotAt = -Infinity;
    this.reloadBlend = 0;
  }
}

/**
 * Create a starting wave of one team. Called from main.ts with the
 * menu-configured counts (the parser clamps the enemy wave to >= 1 and the
 * allied wave to >= 0 — which physical field gets which range depends on
 * the player's side, see botLimits() in sessionConfig) and
 * that team's weapon settings.
 *
 * Both choices are resolved PER BOT, so 'mixed' gives a varied wave in
 * either position while a named weapon arms every bot on the side
 * identically — which is what lets a smoke phase or a playtest hold the
 * weapon still and vary something else. The primary draws over
 * BOT_PRIMARY_IDS (smg/ak47/sniper/shotgun); the secondary draws over
 * BOT_SIDEARM_IDS (pistol/revolver/sawnOff).
 */
export function spawnBots(count: number, team: Team, choice: BotWeaponChoice = 'smg', secondaryChoice: BotSecondaryChoice = 'pistol'): void {
  for (let i = 0; i < count; i++) {
    bots.push(new Bot(
      team,
      resolveBotWeapon(choice, Math.random),
      resolveBotSecondary(secondaryChoice, Math.random),
    ));
  }
}

/** Advance all bot AI. Called once per frame from the main loop. */
export function updateBots(dt: number, player: PlayerState): void {
  // One route per frame, shared out first-come: see routeBudget.
  routeBudget = 1;
  // ONE hearing snapshot for the whole frame, captured BEFORE any bot runs.
  // Without it, a shot fired by an early bot would be audible to the bots
  // after it in this array and not to the ones before — hearing would depend
  // on registry order. With it, every bot hears it on the next frame.
  soundHighWater = soundEvents.latestSeq;
  // Domination assignments refresh on a slow tick, not per frame: the pure
  // dispatcher is sticky across runs, and re-running it per frame would
  // churn the route cache owner keys for nothing.
  domDispatchIn -= dt;
  if (domDispatchIn <= 0) {
    domDispatchIn = DISPATCH_INTERVAL_S;
    dispatchDomObjectives();
  }
  // Domination ring census, EVERY frame (unlike the 1 s dispatch above):
  // cover is a live fact — a mate stepping onto or off the point must reach
  // the brains this frame, not after the next dispatch. It runs AFTER the
  // dispatch because the holder ladders are keyed by assignment: censusing
  // first would rank a just-reassigned bot on the flag it was dealt last
  // second, for the one frame the brains read it.
  refreshDomCensus(player);
  bots.forEach(b => b.update(dt, player));
}

/**
 * Live per-flag body counts for the brains' teammate cover. Refreshed once
 * per frame in updateBots (before any bot runs, like the hearing snapshot);
 * each bot reads its own team's count minus itself when it stands inside.
 * Bodies mirror domination.ts's updater — the player counted as the teammate
 * they are, so a bot pushing a flag its player already holds knows it is
 * covered. Empty outside dom matches, so TDM bots never see a cover fact.
 */
const domCensus = new Map<string, { t: number; ct: number }>();

/**
 * Holder rank per flag per bot id (see sim/domination.ts:holderRanks).
 * Refreshed with the census above; read per bot through holdRankFor. Empty
 * outside dom matches with it.
 */
const domHolders = new Map<string, Map<number, number>>();

function refreshDomCensus(player: PlayerState): void {
  domCensus.clear();
  domHolders.clear();
  if (session.mode !== 'dom' || dom.flags.length === 0) return;
  const bodies: DomBody[] = [];
  if (player.alive) {
    const feet = playerFeet(player);
    bodies.push({ team: session.playerTeam, x: feet.x, feetY: feet.y, z: feet.z });
  }
  for (const b of bots) {
    if (!b.alive) continue;
    bodies.push({ team: b.team, x: b.mesh.position.x, feetY: b.mesh.position.y, z: b.mesh.position.z });
  }
  // Ranked bodies are bots only: the player counts toward the census above
  // but never takes a rank (see holderRanks).
  const ranked = bots
    .filter(b => b.alive)
    .map(b => ({
      id: b.id,
      team: b.team,
      x: b.mesh.position.x,
      feetY: b.mesh.position.y,
      z: b.mesh.position.z,
      objective: b.objectiveId,
    }));
  for (const f of dom.flags) {
    domCensus.set(f.id, countFlagBodies(f, bodies));
    // Only bots ASSIGNED here may take a rank on this ladder. Rank 0 is a
    // designation the brain acts on, and it acts on it only for its OWN
    // objective — so a bot ranked on a flag it was not sent to can never
    // hold that flag, while its lower id still demotes the bot that WAS sent
    // (to rank 1, an escort that leaves on the first bearing or visual),
    // leaving a point two bodies are standing on with nobody holding it. A
    // freshly respawned bot has no objective until the next dispatch and is
    // excluded by the same test.
    domHolders.set(f.id, holderRanks(f, ranked.filter(r => r.objective === f.id)));
  }
}

/**
 * Live same-team bodies inside `flagId`'s RING, excluding `bot` itself — the
 * cover half of BrainView.objective. The ring, not the narrower hold circle
 * the holder ladder ranks: the question this answers is "is my flag being
 * worked without me", and the capture census counts the whole ring, so a mate
 * in the outer annulus is contributing to the capture even though it is not
 * standing the point. The gap is deliberate but real — such a mate is cover
 * that no brain has designated as the holder, so it may leave on its own
 * first contact. Zero with no census or no live flag of that id (flags never
 * leave mid-match; the guard is what proves it to noUncheckedIndexedAccess).
 */
function cappingMatesFor(bot: Bot, flagId: string): number {
  const counts = domCensus.get(flagId);
  const flag = dom.flags.find(f => f.id === flagId);
  if (counts === undefined || flag === undefined) return 0;
  const total = bot.team === 'T' ? counts.t : counts.ct;
  const feet = bot.mesh.position;
  const selfIn = isBodyInRing(flag, { team: bot.team, x: feet.x, feetY: feet.y, z: feet.z });
  return Math.max(0, total - (selfIn ? 1 : 0));
}

/**
 * This bot's holder rank on `flagId`'s ladder (0 designates the holder).
 * Absent — no census, no live flag, or the bot outside the hold circle —
 * reads as 0, which is exactly "nobody ahead of me" and is only ever read
 * while the brain is capping anyway.
 */
function holdRankFor(bot: Bot, flagId: string): number {
  return domHolders.get(flagId)?.get(bot.id) ?? 0;
}

/**
 * Last dispatcher run's bot-id → flag-id map. The pure assignment takes it
 * as the stickiness input; dead bots keep their entries until the next run
 * drops them (only alive bots are fed in), and respawn() clears the per-bot
 * side immediately so a new life never walks old orders.
 */
const domAssignments = new Map<number, string>();
let domDispatchIn = 0;

/**
 * Run the domination dispatcher and deal the results to every bot. Outside
 * dom matches (or with no flags live) every hand stays empty: brains read
 * null objectives and the whole ladder below behaves exactly as TDM.
 */
function dispatchDomObjectives(): void {
  if (session.mode !== 'dom' || dom.flags.length === 0) return;
  const alive = bots.filter(b => b.alive);
  const assigned = assignDomObjectives(
    alive.map(b => ({
      id: b.id,
      team: b.team,
      x: b.mesh.position.x,
      z: b.mesh.position.z,
    })),
    dom.flags.map(f => ({ id: f.id, x: f.pos.x, z: f.pos.z, owner: f.owner, challenger: f.challenger })),
    domAssignments,
  );
  domAssignments.clear();
  for (const [id, flagId] of assigned) domAssignments.set(id, flagId);
  for (const b of bots) {
    const flagId = b.alive ? domAssignments.get(b.id) : undefined;
    const flag = flagId === undefined ? undefined : dom.flags.find(f => f.id === flagId);
    b.assignObjective(flag ? { id: flag.id, pos: flag.pos, radius: flag.radius } : null);
  }
}
