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
// through walls.
//
// Hit zones: each body part is its own mesh with `userData.bot` pointing at
// this instance — weapons.ts raycasts against head/torso/legs directly and
// multiplies damage by zone.
import * as THREE from 'three';
import { scene, camera } from './core/engine';
import { bots, score, gameTime, type Bot as BotShape, type HitZone, type PlayerState, type Team } from './core/state';
import { solids, colliders } from './world';
import { slideMoveXZ, resolveVertical, hasLineOfSight, findFreeSpawn } from './collision';
import { GRAVITY } from './sim/movement';
import { damagePlayer, damageBot, checkRoundEnd } from './combat';
import { sfxEnemyShoot } from './audio';
import { spawnImpact } from './effects';
import { addKillfeed, updateScore } from './hud';
import { DefaultBrain, type BrainMode } from './sim/botBrains';
import { acquireVisual, type PerceptionId, type VisualCandidate } from './sim/perception';
import { NAV_RADIUS, route } from './nav';

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

/** Seconds between route recomputes for one bot, while it wants a route. */
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
 * player's own `pos` is its EYE (core/state.ts), so the player arm has to
 * drop eyeHeight rather than pass the state vector straight through. `eye`
 * is the LOS endpoint: the camera for the player, the bot's eyePos().
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
        feet: new THREE.Vector3(player.pos.x, player.pos.y - player.eyeHeight, player.pos.z),
        eye: camera.position,
        alive: player.alive,
      });
    }
    for (const b of bots) {
      if (b === this || b.team === this.team) continue;
      enemies.push({ kind: 'bot', id: b.id, feet: b.mesh.position, eye: b.eyePos(), alive: b.alive, bot: b });
    }
    const candidates: VisualCandidate[] = enemies.map(e => ({ id: e.id, feet: e.feet, eye: e.eye, alive: e.alive }));

    // ONE acquisition per living update: the brain's tracked identity is
    // probed first, else the cursor rotates fairly. Only its observation —
    // never the candidate list — reaches the brain.
    const selfEye = this.eyePos();
    const selfFacing = new THREE.Vector3(
      Math.sin(this.mesh.rotation.y), 0, Math.cos(this.mesh.rotation.y),
    );
    const acquisition = acquireVisual(
      { eye: selfEye, feet: this.mesh.position, facing: selfFacing },
      candidates,
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
        // rather than fight where it stands.
        nextWaypoint: (goal) => this.waypointToward(goal),
      },
      dt,
    );

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
    // engageRange). The range gate is written only from a CURRENT
    // observation, so an in-range-without-observation state never appears.
    // Sight here is the frame's own observation (acquisition already spent
    // the frame's ray), so the readout costs no extra probe and is fresh
    // every frame.
    const obs = acquisition.observation;
    this.targetInRange = obs !== null && this.brain.inRange(obs.dist3);
    this.targetLOS = obs !== null ? true : acquisition.attempted !== null ? false : null;

    if (intent.wantShoot && obs && obs.id === intent.focusId
        && this.brain.inRange(obs.dist3)) {
      // Identity agreement first: the intent's focus must be the SAME frame's
      // observation. Only then does the id resolve back to the stable
      // candidate, and the die rolls from the ACTUAL post-move distance (see
      // botBrains.ts:botHitChance).
      const target = enemies.find(e => e.id === obs.id);
      if (target) this.shoot(this.eyePos().distanceTo(obs.eye), target);
    }
  }

  /**
   * Planar vector to the next waypoint on a route to `goal`, or null when the
   * graph has none.
   *
   * Mechanism, not policy: this keeps and refreshes the path and decides which
   * waypoint is "next", while the brain decides whether to walk it at all —
   * and only ever names the goal, which is whatever it currently SEES. Same
   * split as the old seeTarget: the executor owns the raycast and the graph,
   * the brain owns the trigger and the route decision.
   */
  private waypointToward(goal: THREE.Vector3): THREE.Vector3 | null {
    const here = this.mesh.position;
    // Drop a path the bot is no longer on: it fell off an edge, got shoved,
    // or respawned across the map still holding last life's route.
    if (this.path.length > 0) {
      const leg = this.path[Math.min(this.leg, this.path.length - 1)]!;
      if (Math.hypot(leg.x - here.x, leg.z - here.z) > ROUTE_ABANDON) this.path = [];
    }
    if ((this.path.length === 0 || this.routeCooldown <= 0) && routeBudget > 0) {
      // One A* per frame across all bots; whoever misses out keeps walking
      // whatever it already has.
      routeBudget--;
      this.routeCooldown = ROUTE_INTERVAL;
      const found = route(here, goal);
      if (found) {
        this.path = found;
        this.leg = 0;
      }
    }
    if (this.path.length === 0) return null;

    // Consume waypoints already stood on, planar — the step is planar too.
    while (this.leg < this.path.length - 1) {
      const w = this.path[this.leg]!;
      if (Math.hypot(w.x - here.x, w.z - here.z) >= WAYPOINT_REACHED) break;
      this.leg++;
    }
    const w = this.path[this.leg]!;
    const to = new THREE.Vector3(w.x - here.x, 0, w.z - here.z);
    return to.lengthSq() < 1e-8 ? null : to;
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
      this.hp = 100;
      this.alive = true;
      this.mesh.visible = true;
      this.spawnAtRandom();
      // The brain outlived the body: re-arm its spawn stagger so a revived
      // bot does not open fire on whatever cooldown its corpse was carrying,
      // and drop its focus — a new life does not inherit the corpse's
      // attention.
      this.brain.onRespawn();
      this.perceptionCursor = 0;
      this.path = [];
      this.leg = 0;
      this.mode = 'hold';
      this.targetEye = null;
      this.targetInRange = false;
      this.targetLOS = null;
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
