// bots.ts — bot bodies and effectors: meshes, collision-gated movement,
// probabilistic shots, death/respawn. Both teams (T enemies, CT allies) are
// instances of this one class; behavior comes from sim/botBrains.ts.
//
// Division of labor with sim/botBrains.ts: a BotBrain DECIDES, Bot EXECUTES.
// Each frame update() builds a passive BrainView (planar vector/distance to
// the player, a lazy LOS thunk, last frame's collision outcome), hands it to
// decide(), then realizes the BrainIntent: attempt the returned step against
// world geometry (reporting rejection back as moveBlocked) and loose a shot
// if asked. All tuning of behavior lives in BrainParams / brain classes;
// this file holds no policy numbers.
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
import { collidesAt, hasLineOfSight, findFreeSpawn } from './collision';
import { damagePlayer, checkRoundEnd } from './combat';
import { sfxEnemyShoot } from './audio';
import { spawnImpact } from './effects';
import { addKillfeed, updateScore } from './hud';
import { DefaultBrain } from './sim/botBrains';

/** Half-width of a bot's collision box — shared by the move gate and spawn placement. */
const BOT_RADIUS = 0.5;

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
  torso: new THREE.BoxGeometry(0.7, 0.9, 0.4),
  head:  new THREE.BoxGeometry(0.34, 0.34, 0.34),
  legs:  new THREE.BoxGeometry(0.6, 0.9, 0.35),
};
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

/** Concrete Bot: implements the structural `Bot` shape core/state.ts declares for the registry. */
export class Bot implements BotShape {
  mesh = new THREE.Group();
  torso: THREE.Mesh;
  head: THREE.Mesh;
  legs: THREE.Mesh;
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
  /** Whether last frame's intended step was rejected by world collision. */
  private moveBlocked = false;

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
  }

  /**
   * Per-frame executor pass: build the view, take the brain's intent,
   * realize it. No policy decisions live here.
   * @param dt delta time (s)
   * @param player the player entity
   */
  update(dt: number, player: PlayerState): void {
    if (!this.alive) return;

    const toPlayer = new THREE.Vector3().subVectors(player.pos, this.mesh.position);
    toPlayer.y = 0; // planar distance; Y handled implicitly since everything is ground-locked
    const dist = toPlayer.length();

    // Face the player
    this.mesh.rotation.y = Math.atan2(toPlayer.x, toPlayer.z);

    const intent = this.brain.decide(
      {
        toTarget: toPlayer,
        dist,
        targetAlive: player.alive,
        // Lazy on purpose: the raycast is only paid when the trigger is
        // otherwise ready — see BrainView.seeTarget.
        seeTarget: () => hasLineOfSight(this.eyePos(), camera.position, solids),
        selfSpeed: this.speed,
        moveBlocked: this.moveBlocked,
      },
      dt,
    );

    const nextPos = this.mesh.position.clone().add(intent.step);
    nextPos.y = 0;
    this.moveBlocked = collidesAt(nextPos, BOT_RADIUS, colliders);
    if (!this.moveBlocked) this.mesh.position.copy(nextPos);

    if (intent.wantShoot) this.shoot(dist);
  }

  /** World-space eye position used for LOS checks (~head height). */
  eyePos(): THREE.Vector3 {
    return new THREE.Vector3(this.mesh.position.x, this.mesh.position.y + 1.9, this.mesh.position.z);
  }

  /**
   * Realize a shot the brain ordered. Hits are probabilistic (no
   * projectile): chance falls off linearly with distance so distant bots
   * are mostly noise, and a hit deals 8-22 damage.
   */
  private shoot(dist: number): void {
    sfxEnemyShoot(this.mesh.position);
    spawnImpact(this.mesh.position.clone().add(new THREE.Vector3(0, 1.5, 0))); // cheap muzzle flash

    if (Math.random() < this.brain.hitChance(dist)) {
      damagePlayer(this.brain.rollDamage());
    }
  }

  /**
   * Death: hide, score for the player, then self-respawn after 6 s of GAME
   * time — a paused match doesn't respawn bots behind the menu.
   * @param killerPart zone that landed the kill
   */
  die(killerPart: HitZone): void {
    this.alive = false;
    this.mesh.visible = false;
    score.scoreKills++;
    updateScore();
    addKillfeed(`You ${killerPart === 'head' ? '☠ headshot' : 'killed'} ${this.name}`);
    debugLog(`${this.name} died (${killerPart}) t=${gameTime.now().toFixed(1)}s`);
    checkRoundEnd();
    gameTime.schedule(6, () => {
      this.hp = 100;
      this.alive = true;
      this.mesh.visible = true;
      this.spawnAtRandom();
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
