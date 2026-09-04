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
// agrees with the intent's focus. Behavior tuning lives in two places, and
// neither is here: BrainParams / brain classes for policy, and
// sim/botWeapons.ts:BOT_WEAPON_TUNING for everything a WEAPON decides — its
// accuracy curve, cadence, burst discipline and the chase bands it wants to
// fight at. This file holds no policy numbers; the per-weapon geometry below
// is presentation, and the muzzle offset it carries is a model dimension
// rather than a tunable.
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
import { createCelMaterial } from './core/materials';
import { scene, camera } from './core/engine';
import { bots, score, session, gameTime, soundEvents, playerFeet, BOT_SPAWNS, WEAPONS, type Bot as BotShape, type BotWeaponChoice, type BotWeaponId, type HitZone, type PlayerState, type Team } from './core/state';
import { solids, colliders, liftPads } from './world';
import { slideMoveXZ, resolveVertical, hasLineOfSight, findFreeSpawn } from './collision';
import { GRAVITY } from './sim/movement';
import { launchFrom } from './sim/lift';
import { damagePlayer, damageBot, checkRoundEnd } from './combat';
import { sfxEnemyShoot } from './audio';
import { spawnImpact } from './effects';
import { addKillfeed, botKillTag, updateScore } from './hud';
import { DEFAULT_BRAIN_PARAMS, DefaultBrain, type BrainMode } from './sim/botBrains';
import {
  BOT_WEAPON_TUNING, WeaponFireController, botBrainParams, resolveBotWeapon,
} from './sim/botWeapons';
import { acquireVisual, type PerceptionId } from './sim/perception';
import { GUNSHOT_RADIUS_M, withinEarshot, type HeardSound } from './sim/soundEvents';
import { NAV_RADIUS, route, navGrid } from './nav';
import { nearestNode, navNode, pickPatrolNode } from './sim/navGrid';

/**
 * Half-width of a bot's collision box — shared by the move gate and spawn
 * placement, and by the navigation graph, which owns it (nav.ts:NAV_RADIUS).
 * The graph samples what fits through gaps at this width, so a bot wider than
 * the value its routes were built against would be promised gaps it jams in.
 */
const BOT_RADIUS = NAV_RADIUS;

/**
 * One bot weapon's silhouette, in the aim hinge's local space.
 *
 * Only LENGTH and BULK vary between weapons, because those are the two cues
 * that survive at combat distance — a bot is a stack of untextured boxes seen
 * at 20 m, and anything finer than a silhouette is invisible there (lesson
 * 25: a cosmetic cue that cannot read is not a cue).
 *
 * Built here rather than cloned from weapons.ts's viewmodels, for four
 * separate reasons any one of which is decisive: those meshes are positioned
 * in CAMERA space with baked first-person offsets; there is one instance of
 * each and an Object3D has exactly one parent; weapons.ts already imports
 * this module (botFor), so importing back would be the module cycle the
 * architecture rules ban outright; and their parts carry reload-pose userData
 * a bot has no use for.
 */
interface BotWeaponModel {
  /** Parts to hang on the aim hinge: shared geometry, local offset, material. */
  readonly parts: readonly {
    geo: THREE.BufferGeometry;
    pos: readonly [number, number, number];
    mat: THREE.Material;
  }[];
  /** Local +z of the barrel tip — where muzzlePos() puts the flash. */
  readonly muzzle: number;
}

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
// T tan/brown, CT blue-gray, so sides read at a glance.
const botGeo = {
  torso:  new THREE.BoxGeometry(0.7, 0.9, 0.4),
  head:   new THREE.BoxGeometry(0.34, 0.34, 0.34),
  legs:   new THREE.BoxGeometry(0.6, 0.9, 0.35),
};
/** Gunmetal, shared by both teams — a weapon reads as a weapon, not as a side. */
const matBarrel = createCelMaterial({ color: 0x23262b });
/** Walnut, for the shotgun's furniture — the one weapon that isn't all steel. */
const matStock = createCelMaterial({ color: 0x4a331f });

/** Shared weapon geometry: one allocation per shape, for every bot carrying it. */
const wpnGeo = {
  smgBody:   new THREE.BoxGeometry(0.08, 0.08, 0.60),
  smgMag:    new THREE.BoxGeometry(0.05, 0.16, 0.07),
  sniperBody: new THREE.BoxGeometry(0.06, 0.06, 1.05),
  sniperScope: new THREE.CylinderGeometry(0.05, 0.05, 0.26, 10),
  shotgunBody: new THREE.BoxGeometry(0.12, 0.12, 0.70),
  shotgunTube: new THREE.BoxGeometry(0.07, 0.07, 0.52),
  shotgunStock: new THREE.BoxGeometry(0.09, 0.13, 0.26),
  pistolBody: new THREE.BoxGeometry(0.07, 0.07, 0.28),
  pistolGrip: new THREE.BoxGeometry(0.06, 0.14, 0.07),
  revolverBody: new THREE.BoxGeometry(0.07, 0.07, 0.34),
  revolverCylinder: new THREE.CylinderGeometry(0.06, 0.06, 0.11, 8),
};
// The scope and the cylinder are lathe shapes lying ALONG the barrel, so both
// need the x-quarter-turn weapons.ts gives its viewmodel scope. Baking it into
// the geometry keeps the model table a flat list of positions.
wpnGeo.sniperScope.rotateX(Math.PI / 2);
wpnGeo.revolverCylinder.rotateX(Math.PI / 2);

/**
 * What each weapon looks like on a bot. A full Record over BotWeaponId, like
 * every other per-weapon table in the repo: widening the union fails to
 * compile here until the new weapon has a silhouette.
 */
const BOT_WEAPON_MODELS: Record<BotWeaponId, BotWeaponModel> = {
  // The shipped bot barrel, unchanged — this is the shape every existing
  // playtest impression was formed against.
  smg: {
    parts: [
      { geo: wpnGeo.smgBody, pos: [0, 0, 0.30], mat: matBarrel },
      { geo: wpnGeo.smgMag, pos: [0, -0.10, 0.18], mat: matBarrel },
    ],
    muzzle: 0.60,
  },
  // Nearly twice the smg's length plus a scope: the one that has to read as
  // "that thing outranges me" from across the map.
  sniper: {
    parts: [
      { geo: wpnGeo.sniperBody, pos: [0, 0, 0.53], mat: matBarrel },
      { geo: wpnGeo.sniperScope, pos: [0, 0.08, 0.30], mat: matBarrel },
    ],
    muzzle: 1.05,
  },
  // Short and THICK, with wood: bulk is the cue here, not length.
  shotgun: {
    parts: [
      { geo: wpnGeo.shotgunBody, pos: [0, 0, 0.35], mat: matBarrel },
      { geo: wpnGeo.shotgunTube, pos: [0, -0.09, 0.28], mat: matBarrel },
      { geo: wpnGeo.shotgunStock, pos: [0, -0.02, -0.13], mat: matStock },
    ],
    muzzle: 0.70,
  },
  // Visibly the smallest thing on the field.
  pistol: {
    parts: [
      { geo: wpnGeo.pistolBody, pos: [0, 0, 0.14], mat: matBarrel },
      { geo: wpnGeo.pistolGrip, pos: [0, -0.10, 0.02], mat: matBarrel },
    ],
    muzzle: 0.28,
  },
  revolver: {
    parts: [
      { geo: wpnGeo.revolverBody, pos: [0, 0, 0.17], mat: matBarrel },
      { geo: wpnGeo.revolverCylinder, pos: [0, -0.01, 0.04], mat: matBarrel },
    ],
    muzzle: 0.34,
  },
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
   * The catalog weapon this bot carries for the whole match. Drawn once at
   * construction and never re-drawn — a stable "T-3 is the sniper" is what
   * lets a playtest attribute a behavior to a weapon rather than guess at it.
   */
  readonly weapon: BotWeaponId;
  /**
   * This bot's policy and the weapon it fights with. Both are per-bot state;
   * the brain's whole stimulus ladder is weapon-independent, and everything
   * that differs between an smg bot and a sniper bot is either a BrainParams
   * number or something the composed FireController owns.
   */
  private readonly brain: DefaultBrain;
  /**
   * Barrel-tip offset along the aim hinge's local +z. Per weapon, so a
   * sniper's muzzle flash leaves the end of its longer barrel rather than
   * hanging in the middle of it.
   */
  private readonly muzzleZ: number;
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

  constructor(team: Team = 'T', weapon: BotWeaponId = 'smg') {
    // Plain assignments, not parameter properties: the `name` derivation must
    // see the team, and field initializers run before constructor-body
    // parameter-property writes would. The brain is the same case for a
    // sharper reason — it needs the weapon, which a field initializer cannot
    // see at all.
    this.team = team;
    this.name = `${team}-${++teamSerials[team]}`;
    this.weapon = weapon;
    const tuning = BOT_WEAPON_TUNING[weapon];
    this.brain = new DefaultBrain(
      botBrainParams(tuning, DEFAULT_BRAIN_PARAMS),
      Math.random,
      new WeaponFireController(weapon, WEAPONS[weapon], tuning, Math.random),
    );

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
    const model = BOT_WEAPON_MODELS[weapon];
    this.muzzleZ = model.muzzle;
    for (const part of model.parts) {
      const mesh = new THREE.Mesh(part.geo, part.mat);
      mesh.position.set(part.pos[0], part.pos[1], part.pos[2]);
      mesh.castShadow = true;
      this.aim.add(mesh);
    }
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
   */
  spawnAtRandom(): void {
    const zone = BOT_SPAWNS[session.map][this.team];
    const p = findFreeSpawn(
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
    this.spawnAtRandom();
    // The brain outlived the body: re-arm its spawn stagger and drop the
    // corpse's attention, memory and reactions — a new life inherits nothing.
    this.brain.onRespawn();
    this.perceptionCursor = 0;
    // The present, not zero: six seconds of combat happened while this bot
    // was a corpse and none of it is news.
    this.soundCursor = soundEvents.latestSeq;
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

    const intent = this.brain.decide(
      {
        selfFeet: this.mesh.position,
        facing: selfFacing,
        visual: acquisition.observation,
        onGround: this.onGround,
        selfSpeed: this.speed,
        moveBlocked: this.moveBlocked,
        heard,
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

    // Cargo lift. AFTER the resolve, because it keys off the grounded state
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
    // A heard goal carries no focus id to key on (a noise identifies nobody),
    // so it keys on the GOAL itself, rounded to a decimetre. Without that,
    // two successive noises would share the owner `m:*` and the second would
    // walk the first one's cached path until ROUTE_INTERVAL happened to
    // expire.
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

  /**
   * Magazine state for the DEV readout, delegated to the brain's weapon.
   * Getters for the same reason as the route views above: the fire controller
   * owns these numbers, and mirroring them into fields would be a second copy
   * to keep in sync every frame.
   */
  get mag(): number { return this.brain.mag; }
  get magSize(): number { return this.brain.magSize; }
  get reloading(): boolean { return this.brain.reloading; }

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
    return this.aim.localToWorld(new THREE.Vector3(0, 0, this.muzzleZ));
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
    const muzzle = this.muzzlePos();
    sfxEnemyShoot(this.mesh.position, this.weapon);
    spawnImpact(muzzle); // cheap muzzle flash, from the barrel tip
    // Emitted BEFORE the hit die, so a miss is exactly as audible as a hit —
    // hearing reports that a trigger was pulled, not that it landed. At the
    // FEET rather than the muzzle, for the reason weapons.ts states: a heard
    // position is a routing goal, and nearestNode's height weighting would
    // send a listener to the deck overhead.
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
    // Hoisted out of the counter branch because the killfeed needs it too:
    // a bot killer names the weapon it did it with.
    const killer = killerName === undefined
      ? undefined
      : bots.find(b => b.name === killerName);
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
}

/**
 * Create a starting wave of one team. Called from main.ts with the
 * menu-configured counts (the parser clamps Ts to >= 1, CTs to >= 0) and that
 * team's weapon setting.
 *
 * `choice` is resolved PER BOT, so 'mixed' gives a varied wave while a named
 * weapon arms every bot on the side identically — which is what lets a smoke
 * phase or a playtest hold the weapon still and vary something else.
 */
export function spawnBots(count: number, team: Team, choice: BotWeaponChoice = 'smg'): void {
  for (let i = 0; i < count; i++) {
    bots.push(new Bot(team, resolveBotWeapon(choice, Math.random)));
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
  bots.forEach(b => b.update(dt, player));
}
