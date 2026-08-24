// bots.ts — bot bodies and effectors: meshes, collision-gated movement,
// probabilistic shots, death/respawn. Both teams (T enemies, CT allies) are
// instances of this one class; behavior comes from sim/botBrains.ts.
//
// Division of labor with sim/botBrains.ts: a BotBrain DECIDES, Bot EXECUTES.
// Each frame update() picks the best opposing entity (player or bot) under
// the brain's own ranking, builds a passive BrainView around it (planar
// steering vector, 3D range and rise, a lazy LOS thunk, last frame's
// collision outcome), hands it to decide(), then
// realizes the BrainIntent: attempt the returned step against world
// geometry through the SAME feet-aware gates the player uses (slideMoveXZ +
// resolveVertical, so bots climb stairs and land off edges), reporting
// rejection back as moveBlocked, and looses a shot if asked. All tuning of
// behavior lives in BrainParams / brain classes; this file holds no policy
// numbers.
//
// Shot gating contract (realized by the default brain): fire only when a
// cooldown expires AND line of sight passes; without sight it retries on a
// short 0.3s cooldown so bots keep hunting instead of shooting through walls.
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
import { DefaultBrain, nearestOpposing } from './sim/botBrains';

/** Half-width of a bot's collision box — shared by the move gate and spawn placement. */
const BOT_RADIUS = 0.5;

/** Length of the aim barrel (m); the muzzle sits at half this along its +z. */
const BARREL_LEN = 0.6;

/**
 * Ceiling on how far a bot's aim tips to track a target (rad, ~69°).
 * Presentation only — a bot's shot is probability, not a ray from the muzzle.
 * Wide enough to read as "aiming up at the deck" from underneath, short of
 * vertical so the barrel never disappears into the bot's own silhouette.
 */
const MAX_AIM_PITCH = 1.2;

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
 * One entity this bot may fight. The player and bot targets differ in how
 * their LOS endpoint is derived and where shot damage is routed.
 *
 * `pos` is the target's FEET on both arms — see OpposingCandidate. The
 * player's own `pos` is its EYE (core/state.ts), so the player arm has to
 * drop eyeHeight rather than pass the state vector straight through.
 */
type Target =
  | { kind: 'player'; pos: THREE.Vector3; alive: boolean }
  | { kind: 'bot'; pos: THREE.Vector3; alive: boolean; bot: BotShape };

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
   * The brain's target ranking, bound once. Which enemy is worth chasing is
   * policy, so it comes from the brain; hoisting it to a field keeps
   * nearestOpposing from allocating a fresh closure per bot per frame.
   */
  private readonly targetScore = this.brain.targetScore;
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
    // Spawns are on open ground: clear vertical state carried from the life
    // that just ended rather than relying on resolveVertical to self-heal it.
    this.vy = 0;
    this.onGround = true;
  }

  /**
   * Per-frame executor pass: pick a target, build the view, take the
   * brain's intent, realize it. No policy decisions live here.
   * @param dt delta time (s)
   * @param player the player entity
   */
  update(dt: number, player: PlayerState): void {
    if (!this.alive) return;

    // Opposing entities: Ts fight the player and every CT; CTs fight every
    // T. The player is listed even while dead — with ctbots=0 that keeps an
    // enemy chasing the corpse position exactly as pre-team behavior did,
    // while shooting stays gated off by targetAlive.
    const enemies: Target[] = [];
    if (this.team === 'T') {
      enemies.push({
        kind: 'player',
        // Feet, not the eye that `player.pos` holds: `rise` and the brain's
        // target ranking both compare this against bot feet, and passing
        // the eye through would hand every bot 1.7 m of phantom height.
        pos: new THREE.Vector3(player.pos.x, player.pos.y - player.eyeHeight, player.pos.z),
        alive: player.alive,
      });
    }
    for (const b of bots) {
      if (b === this || b.team === this.team) continue;
      enemies.push({ kind: 'bot', pos: b.mesh.position, alive: b.alive, bot: b });
    }
    const target = nearestOpposing(this.mesh.position, enemies, this.targetScore)
      ?? enemies[0]; // no live opponent: Ts fall back to the inert player entry, CTs stand down

    if (!target) {
      this.moveBlocked = false;
      return;
    }

    const toTarget = new THREE.Vector3().subVectors(target.pos, this.mesh.position);
    const rise = toTarget.y; // target feet minus own feet, before y is stripped
    toTarget.y = 0; // STEERING is planar — a step only ever moves in x/z
    const dist = toTarget.length();

    // RANGING is not. The eye-to-eye distance the hit die already rolled on
    // is what the brain's bands and engage gate read too, so a target on a
    // deck overhead stops reading as point-blank.
    const selfEye = this.eyePos();
    const targetEye = target.kind === 'player' ? camera.position : target.bot.eyePos();
    const dist3 = selfEye.distanceTo(targetEye);

    // Face the target, and tip the aim barrel at it so a bot firing up at a
    // deck visibly aims up. The mesh yaw puts local +z on the target, and a
    // positive x-rotation tips that forward axis DOWN — hence the negation.
    this.mesh.rotation.y = Math.atan2(toTarget.x, toTarget.z);
    const pitch = Math.atan2(targetEye.y - selfEye.y, Math.max(dist, 1e-6));
    this.aim.rotation.x = -THREE.MathUtils.clamp(pitch, -MAX_AIM_PITCH, MAX_AIM_PITCH);

    const losTo = target.kind === 'player'
      ? () => hasLineOfSight(this.eyePos(), camera.position, solids)
      : () => hasLineOfSight(this.eyePos(), target.bot.eyePos(), solids);

    const intent = this.brain.decide(
      {
        toTarget,
        dist,
        dist3,
        rise,
        targetAlive: target.alive,
        // Lazy on purpose: the raycast is only paid when the trigger is
        // otherwise ready — see BrainView.seeTarget.
        seeTarget: losTo,
        selfSpeed: this.speed,
        moveBlocked: this.moveBlocked,
      },
      dt,
    );

    // Horizontal gate: the SAME axis-separated slide the player uses, with
    // feet-aware blocking — risers within STEP_HEIGHT don't stop a bot.
    const prevFeet = this.mesh.position.y;
    const preX = this.mesh.position.x, preZ = this.mesh.position.z;
    const intended = intent.step.length();
    slideMoveXZ(this.mesh.position, intent.step.x, intent.step.z, BOT_RADIUS, prevFeet, colliders);
    // Pinned against geometry: report rejection so NEXT frame's brain
    // reverses its drift (DefaultBrain.decide consumes this).
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

    if (intent.wantShoot) {
      // Re-measured AFTER the move, unlike the view's dist3: the bot has
      // stepped since, and the die should roll from where it is actually
      // shooting (see botBrains.ts:botHitChance).
      this.shoot(this.eyePos().distanceTo(targetEye), target);
    }
  }

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
    // scoreKills is the CT score (player kills and CT allies downing a T);
    // scoreDeaths is the T score, so a T downing a CT counts there — the
    // same counter combat.ts bumps when a T downs the player.
    if (killerName === undefined || this.team === 'T') score.scoreKills++;
    else score.scoreDeaths++;
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
      // bot does not open fire on whatever cooldown its corpse was carrying.
      this.brain.onRespawn();
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
  bots.forEach(b => b.update(dt, player));
}
