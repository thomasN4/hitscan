// bots.ts — bot bodies and effectors: meshes, collision-gated movement,
// probabilistic shots, death/respawn. Both teams (T enemies, CT allies) are
// instances of this one class; behavior comes from sim/botBrains.ts.
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
// agrees with the intent's focus. All tuning of behavior lives in
// BrainParams / brain classes; this file holds no policy numbers.
//
// Shot gating contract (realized by the default brain): fire only when a
// cooldown expires AND the bot currently SEES its focus — the observation is
// the LOS proof, so a bot that sees nothing holds instead of shooting
// through walls. On sight loss it pursues the FROZEN last-known position
// (brain-owned memory) and scans on arrival; the executor keeps its route
// cache only while it still belongs to the same active goal.
//
// Hit zones: each body part is its own mesh with `userData.bot` pointing at
// this instance — weapons.ts raycasts against head/torso/legs directly and
// multiplies damage by zone.
import * as THREE from 'three';
import { scene, camera } from './core/engine';
import { bots, score, gameTime, playerFeet, type Bot as BotShape, type HitZone, type PlayerState, type Team } from './core/state';
import { solids, colliders } from './world';
import { slideMoveXZ, resolveVertical, hasLineOfSight, findFreeSpawn } from './collision';
import { GRAVITY } from './sim/movement';
import { damagePlayer, damageBot, checkRoundEnd } from './combat';
import { sfxEnemyShoot } from './audio';
import { spawnImpact } from './effects';
import { addKillfeed, updateScore } from './hud';
import { DefaultBrain, type BrainMode } from './sim/botBrains';
import { acquireVisual, type PerceptionId } from './sim/perception';
import { NAV_RADIUS, route, navGrid } from './nav';
import { nearestNode, navNode, pickPatrolNode } from './sim/navGrid';

/**
 * Half-width of a bot's collision box — shared by the move gate and spawn
 * placement, and by the navigation graph, which owns it (nav.ts:NAV_RADIUS).
 * The graph samples what fits through gaps at this width, so a bot wider than
 * the value its routes were built against would be promised gaps it jams in.
 */
const BOT_RADIUS = NAV_RADIUS;

/** Length of the aim barrel (m); the muzzle sits at half this along its +z. */
const BARREL_LEN = 0.6;

/**
 * Ceiling on how far a bot's aim tips to track a target (rad, ~69°).
 * Presentation only — a bot's shot is probability, not a ray from the muzzle.
 * Wide enough to read as "aiming up at the deck" from underneath, short of
 * vertical so the barrel never disappears into the bot's own silhouette.
 */
const MAX_AIM_PITCH = 1.2;

/**
 * How close (m) a bot must get to a waypoint before the next one is offered.
 * One nav cell: the path's own resolution, so a bot never chases a point it
 * has effectively already stood on.
 */
const WAYPOINT_REACHED = 1;

/** Seconds between route recomputes while pursuing a moving goal. */
const ROUTE_INTERVAL = 1;

/**
 * How far (m) off its own path a bot may drift before the route is thrown
 * away and rebuilt — it fell, was shoved, or respawned somewhere else.
 */
const ROUTE_ABANDON = 6;

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
// T tan/brown, CT blue-gray, so sides read at a glance.
const botGeo = {
  torso:  new THREE.BoxGeometry(0.7, 0.9, 0.4),
  head:   new THREE.BoxGeometry(0.34, 0.34, 0.34),
  legs:   new THREE.BoxGeometry(0.6, 0.9, 0.35),
  barrel: new THREE.BoxGeometry(0.08, 0.08, BARREL_LEN),
};
/** Gunmetal, shared by both teams — a weapon reads as a weapon, not as a side. */
const matBarrel = new THREE.MeshLambertMaterial({ color: 0x23262b });
const palettes: Record<Team, { body: THREE.MeshLambertMaterial; head: THREE.MeshLambertMaterial; legs: THREE.MeshLambertMaterial }> = {
  T: {
    body: new THREE.MeshLambertMaterial({ color: 0x8a6b2e }),
    head: new THREE.MeshLambertMaterial({ color: 0xd8c39a }),
    legs: new THREE.MeshLambertMaterial({ color: 0x4d4436 }),
  },
  CT: {
    body: new THREE.MeshLambertMaterial({ color: 0x4a5a78 }),
    head: new THREE.MeshLambertMaterial({ color: 0xc9d2df }),
    legs: new THREE.MeshLambertMaterial({ color: 0x2f3646 }),
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
  /** This bot's policy; instances own per-bot state (strafe dir, cooldown). */
  private readonly brain = new DefaultBrain();
  /**
   * Fair-rotation cursor for the per-frame visual acquisition: the index the
   * next scan starts from when the brain's tracked identity is not cheaply
   * eligible. Advanced by acquisition only (see sim/perception.ts); reset
   * with the rest of the per-life state on respawn.
   */
  private perceptionCursor = 0;
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
  /** How far along `path` the bot has got. */
  private leg = 0;
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

  constructor(team: Team = 'T') {
    // Plain assignments, not a parameter property: the `name` derivation must
    // see the team, and field initializers run before constructor-body
    // parameter-property writes would.
    this.team = team;
    this.name = `${team}-${++teamSerials[team]}`;

    // Build the ragdoll-ish stack: legs / torso / head as separate meshes so
    // raycasts can distinguish hit zones. All parts share this group's transform.
    const palette = palettes[team];
    this.torso = new THREE.Mesh(botGeo.torso, palette.body);
    this.torso.position.y = 1.35;
    this.head = new THREE.Mesh(botGeo.head, palette.head);
    this.head.position.y = 2.0;
    this.legs = new THREE.Mesh(botGeo.legs, palette.legs);
    this.legs.position.y = 0.45;
    [this.torso, this.head, this.legs].forEach(p => { p.castShadow = true; this.mesh.add(p); });
    const parts = { torso: this.torso, head: this.head, legs: this.legs };
    // Tag every part with its owner so bullet raycasts can attribute hits.
    for (const part of Object.values(parts)) part.userData.bot = this;

    // Aim pivot: a barrel on a shoulder-height hinge, so PITCH is visible.
    // Rotating the head cube in place was not — a featureless box turning
    // about its own centre shows nothing, which a playtest confirmed
    // (docs/ai-plan.md, lesson 25). A barrel that swings has a direction.
    //
    // Deliberately NOT tagged with userData.bot, and deliberately not a field
    // weapons.ts knows about: its raycast targets are an explicit allowlist
    // (`bot.head, bot.torso, bot.legs`), so this stays decorative by
    // construction. It has to — sim/damage.ts:partForMesh falls through to
    // 'torso' for any mesh it does not recognize, so a barrel that ever
    // reached that list would silently become a torso hit rather than error.
    // Bot LOS rays against `solids` only, so it never blocks sight either.
    this.aim.position.set(0.16, 1.5, 0);
    const barrel = new THREE.Mesh(botGeo.barrel, matBarrel);
    barrel.position.z = BARREL_LEN / 2;
    barrel.castShadow = true;
    this.aim.add(barrel);
    this.mesh.add(this.aim);

    this.spawnAtRandom();
    scene.add(this.mesh);
  }

  /**
   * Place on this bot's own half: Ts in the far band (z ∈ [-55, -20], away
   * from player spawn), CTs mirrored onto the player's half (z ∈ [20, 55]).
   * Rejection-sampled against `colliders` — a blind draw lands inside a
   * corner block or crate ~20% of the time, and a bot spawned inside
   * geometry is stuck there for life (the move gate only blocks entering).
   */
  spawnAtRandom(): void {
    const zSign = this.team === 'T' ? -1 : 1;
    const p = findFreeSpawn(
      () => new THREE.Vector3((Math.random() - 0.5) * 90, 0, zSign * (20 + Math.random() * 35)),
      BOT_RADIUS,
      colliders,
    );
    this.respawnPoint.copy(p);
    this.mesh.position.copy(p);
    // Spawn facing is a team convention, not a gameplay input: Ts look down
    // the arena toward +z (the player's half), CTs back the other way. The
    // first perception frame reads its facing basis off this yaw.
    this.mesh.rotation.y = this.team === 'T' ? 0 : Math.PI;
    // Spawns are on open ground: clear vertical state carried from the life
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
    this.spawnAtRandom();
    // The brain outlived the body: re-arm its spawn stagger and drop the
    // corpse's attention, memory and reactions — a new life inherits nothing.
    this.brain.onRespawn();
    this.perceptionCursor = 0;
    this.clearRouteCache();
    this.patrolGoal = null;
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

    // Opposing entities as STABLE CANDIDATES — no positional selection here.
    // Perception owns acquisition; the brain only ever learns about the one
    // candidate the frame's single ray successfully looked at. Ts fight the
    // player and every CT; CTs fight every T. The player is listed even
    // while dead — a dead candidate is a cheap rejection, so the bot holds
    // rather than chasing the corpse position.
    const enemies: Target[] = [];
    if (this.team === 'T') {
      enemies.push({
        kind: 'player',
        id: 'player',
        // Feet, not the eye that `player.pos` holds: rise and the planar
        // closure measure compare these against bot feet, and passing the
        // eye through would hand every bot 1.7 m of phantom height.
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

    // Clamped, not free-running: a bot that spends minutes not routing would
    // otherwise drift the timer arbitrarily negative for no benefit, and the
    // first request after a lull should fire immediately either way.
    this.routeCooldown = Math.max(0, this.routeCooldown - dt);

    const intent = this.brain.decide(
      {
        selfFeet: this.mesh.position,
        facing: selfFacing,
        visual: acquisition.observation,
        onGround: this.onGround,
        selfSpeed: this.speed,
        moveBlocked: this.moveBlocked,
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
      },
      dt,
    );

    // Route-cache ownership: whenever the intent leaves route/engage — a
    // search or hold of any kind (arrival, dead end, damage reaction,
    // forget, patrol pause) — drop the cached path so a later, unrelated
    // goal cannot inherit it. And whenever the intent leaves patrol — a
    // visual, damage reaction, search or hold interrupted it — the patrol
    // goal is dead: drop it (and any patrol-owned path) so a later leg
    // cannot inherit a stale destination.
    if (intent.mode === 'search' || intent.mode === 'hold') this.clearRouteCache();
    if (intent.mode !== 'patrol') this.clearPatrolGoal();

    // Horizontal gate: the SAME axis-separated slide the player uses, with
    // feet-aware blocking — risers within STEP_HEIGHT don't stop a bot.
    const prevFeet = this.mesh.position.y;
    const preX = this.mesh.position.x, preZ = this.mesh.position.z;
    const intended = intent.step.length();
    slideMoveXZ(this.mesh.position, intent.step.x, intent.step.z, BOT_RADIUS, prevFeet, colliders);
    // Report rejection for NEXT frame's brain. DefaultBrain consumes the
    // contact's leading edge to reverse once; sustained rejection preserves
    // that committed drift until the bot clears the geometry.
    this.moveBlocked =
      Math.hypot(this.mesh.position.x - preX, this.mesh.position.z - preZ) < intended * 0.25;

    // Vertical: same swept support resolution as the player, so bots climb
    // stairs mid-chase and land when they walk off an edge.
    this.vy -= GRAVITY * dt;
    const vert = resolveVertical(prevFeet, this.vy, dt,
      this.mesh.position.x, this.mesh.position.z, BOT_RADIUS, colliders, this.onGround);
    this.mesh.position.y = vert.feetY;
    this.vy = vert.velY;
    this.onGround = vert.onGround;

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
      // ACTUAL post-move distance (see botBrains.ts:botHitChance).
      const target = enemies.find(e => e.id === obs.id);
      if (target) this.shoot(this.eyePos().distanceTo(obs.eye), target);
    }
  }

  /**
   * Planar vector to the next waypoint on a route to `goal`, with a
   * three-way outcome: a waypoint when a (cached or fresh) path exists,
   * `undefined` when the shared one-A-star-per-frame budget deferred the
   * request, `null` when the graph confirmed there is no route.
   *
   * Mechanism, not policy: this keeps and refreshes the path and decides which
   * waypoint is "next", while the brain decides whether to walk it at all —
   * and only ever names the goal, which is whatever it currently SEES or last
   * remembered. Same split as the old seeTarget: the executor owns the
   * raycast and the graph, the brain owns the trigger and the route decision.
   */
  private waypointToward(goal: THREE.Vector3, visualPursuit: boolean): THREE.Vector3 | undefined | null {
    // A remembered goal must not inherit a path computed for a different
    // pursuit ('v' vs 'm') or a different target (focus id): key the cache
    // and drop it on any mismatch.
    const key = `${visualPursuit ? 'v' : 'm'}:${this.brain.focusId ?? '*'}`;
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
    if (this.routeKey !== key) {
      this.routeKey = key;
      this.path = [];
      this.leg = 0;
    }
    // Drop a path the bot is no longer on: it fell off an edge, got shoved,
    // or respawned across the map still holding last life's route.
    if (this.path.length > 0) {
      const leg = this.path[Math.min(this.leg, this.path.length - 1)]!;
      if (Math.hypot(leg.x - here.x, leg.z - here.z) > ROUTE_ABANDON) {
        this.path = [];
        this.leg = 0;
      }
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
      const found = route(here, goal);
      if (found) {
        this.path = found;
        this.leg = 0;
      } else {
        // A failed recompute must not keep walking a stale path.
        this.path = [];
        this.leg = 0;
      }
    }
    if (this.path.length === 0) {
      // Deferred (budget spent elsewhere) vs confirmed dead end — the brain
      // waits on the first and starts searching on the second.
      return recomputed ? null : undefined;
    }

    // Consume waypoints already stood on, planar — the step is planar too.
    while (this.leg < this.path.length - 1) {
      const w = this.path[this.leg]!;
      if (Math.hypot(w.x - here.x, w.z - here.z) >= WAYPOINT_REACHED) break;
      this.leg++;
    }
    const w = this.path[this.leg]!;
    const to = new THREE.Vector3(w.x - here.x, 0, w.z - here.z);
    // A patrol's FINAL node within the one-metre threshold IS the arrival:
    // the leg is over, the goal and route die, and the brain stands down.
    if (patrolArrival && this.leg === this.path.length - 1 && to.length() <= WAYPOINT_REACHED) {
      this.clearRouteCache();
      return null;
    }
    return to.lengthSq() < 1e-8 ? null : to;
  }

  /** Drop the cached route: path, leg and goal key. */
  private clearRouteCache(): void {
    this.path = [];
    this.leg = 0;
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

  /** World-space eye position used for LOS checks (~head height). */
  eyePos(): THREE.Vector3 {
    return new THREE.Vector3(this.mesh.position.x, this.mesh.position.y + 1.9, this.mesh.position.z);
  }

  /**
   * World-space barrel tip, for the muzzle flash.
   *
   * Flushes the group's world matrix first: update() has already written this
   * frame's yaw and pitch, but nothing has composed them yet — the renderer
   * does that later. Called only on firing frames, so the flush is paid at
   * the bot's cooldown rate rather than per frame.
   */
  private muzzlePos(): THREE.Vector3 {
    this.mesh.updateMatrixWorld(true);
    return this.aim.localToWorld(new THREE.Vector3(0, 0, BARREL_LEN));
  }

  /**
   * Realize a shot the brain ordered. Hits are probabilistic (no
   * projectile): chance falls off linearly with the eye-to-eye distance to
   * the target so distant bots are mostly noise; a hit routes damage by
   * target kind — the player through damagePlayer, a bot through damageBot
   * as a flat torso hit. Both dice (hit and damage) come from the brain's
   * rng stream.
   */
  private shoot(dist: number, target: Target): void {
    sfxEnemyShoot(this.mesh.position);
    spawnImpact(this.muzzlePos()); // cheap muzzle flash, from the barrel tip

    if (!this.brain.rollHit(dist)) return;
    const dmg = this.brain.rollDamage();
    if (target.kind === 'player') damagePlayer(dmg, this.name);
    else damageBot(target.bot, dmg, 'torso', this.name);
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
    this.mesh.visible = false;
    this.deaths++;
    // Team scores: scoreKills is the CT score (player kills and CT allies
    // downing a T); scoreDeaths is the T score, so a T downing a CT counts
    // there — the same counter combat.ts bumps when a T downs the player.
    if (killerName === undefined || this.team === 'T') score.scoreKills++;
    else score.scoreDeaths++;
    // Scoreboard attribution: the player's own kills get a personal counter;
    // a bot killer is resolved by display name (unique per team serial).
    if (killerName === undefined) {
      score.playerKills++;
    } else {
      const killer = bots.find(b => b.name === killerName);
      if (killer) killer.kills++;
    }
    updateScore();
    addKillfeed(killerName === undefined
      ? `You ${killerPart === 'head' ? '☠ headshot' : 'killed'} ${this.name}`
      : `${killerName} killed ${this.name}`);
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
}

/** Create a starting wave of one team. Called from main.ts with the menu-configured counts (parser clamps Ts to >= 1, CTs to >= 0). */
export function spawnBots(count: number, team: Team): void {
  for (let i = 0; i < count; i++) bots.push(new Bot(team));
}

/** Advance all bot AI. Called once per frame from the main loop. */
export function updateBots(dt: number, player: PlayerState): void {
  // One route per frame, shared out first-come: see routeBudget.
  routeBudget = 1;
  bots.forEach(b => b.update(dt, player));
}
