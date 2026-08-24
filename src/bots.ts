// bots.ts — enemy AI: movement, line-of-sight-gated shooting, death/respawn.
//
// Bot behavior each frame (see Bot.update):
//   1. face the player
//   2. move: approach if far (>14m), back off if very close (<7m), else strafe
//      — through the same geometry gates as the player (slideMoveXZ +
//      resolveVertical), so bots climb stairs and fall off edges too
//   3. shoot only when a fireCooldown expires AND hasLineOfSight passes;
//      without LOS the check retries on a short 0.3s cooldown so bots keep
//      hunting instead of shooting through walls
//
// Hit zones: each body part is its own mesh with `userData.bot` pointing at
// this instance — weapons.ts raycasts against head/torso/legs directly and
// multiplies damage by zone.
import * as THREE from 'three';
import { scene, camera } from './core/engine';
import { bots, score, gameTime, type Bot as BotShape, type HitZone, type PlayerState } from './core/state';
import { solids, colliders } from './world';
import { slideMoveXZ, resolveVertical, hasLineOfSight, findFreeSpawn } from './collision';
import { GRAVITY } from './sim/movement';
import { damagePlayer, checkRoundEnd } from './combat';
import { sfxEnemyShoot } from './audio';
import { spawnImpact } from './effects';
import { addKillfeed, updateScore } from './hud';

/** Half-width of a bot's collision box — shared by the move gate and spawn placement. */
const BOT_RADIUS = 0.5;

/** Serial source for Bot ids/names; 1-based per match. */
let nextBotId = 1;

/**
 * DEV-only lifecycle trace (issue #17): makes the pause-freeze of the
 * scheduled revival observable from devtools — kill a bot, note the death
 * line, wait past 6 s wall-clock behind the pause menu, confirm the respawn
 * line only appears after resuming. Statically dead in production builds.
 */
function debugLog(msg: string): void {
  if (import.meta.env.DEV) console.debug(`[bot] ${msg}`);
}

// Shared geometries/materials — one allocation for all bots.
const botGeo = {
  torso: new THREE.BoxGeometry(0.7, 0.9, 0.4),
  head:  new THREE.BoxGeometry(0.34, 0.34, 0.34),
  legs:  new THREE.BoxGeometry(0.6, 0.9, 0.35),
};
const matBotBody = new THREE.MeshLambertMaterial({ color: 0x8a6b2e }); // T tan/brown
const matBotHead = new THREE.MeshLambertMaterial({ color: 0xd8c39a });
const matBotLegs = new THREE.MeshLambertMaterial({ color: 0x4d4436 });

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
  name = `T-${this.id}`;
  /** Varied per bot so they spread out. */
  speed = 3.2 + Math.random() * 1.4;
  fireCooldown = 1 + Math.random() * 2; // staggered first shot
  strafeDir = Math.random() < 0.5 ? 1 : -1;
  respawnPoint = new THREE.Vector3();
  /** Vertical velocity — bots resolve support like the player does (stairs). */
  vy = 0;

  constructor() {
    // Build the ragdoll-ish stack: legs / torso / head as separate meshes so
    // raycasts can distinguish hit zones. All parts share this group's transform.
    this.torso = new THREE.Mesh(botGeo.torso, matBotBody);
    this.torso.position.y = 1.35;
    this.head = new THREE.Mesh(botGeo.head, matBotHead);
    this.head.position.y = 2.0;
    this.legs = new THREE.Mesh(botGeo.legs, matBotLegs);
    this.legs.position.y = 0.45;
    [this.torso, this.head, this.legs].forEach(p => { p.castShadow = true; this.mesh.add(p); });
    const parts = { torso: this.torso, head: this.head, legs: this.legs };
    // Tag every part with its owner so bullet raycasts can attribute hits.
    for (const part of Object.values(parts)) part.userData.bot = this;

    this.spawnAtRandom();
    scene.add(this.mesh);
  }

  /**
   * Place in the far half of the map (-z side), away from player spawn.
   * Rejection-sampled against `colliders` — a blind draw lands inside a
   * corner block or crate ~20% of the time, and a bot spawned inside
   * geometry is stuck there for life (the move gate only blocks entering).
   */
  spawnAtRandom(): void {
    const p = findFreeSpawn(
      () => new THREE.Vector3((Math.random() - 0.5) * 90, 0, -(20 + Math.random() * 35)),
      BOT_RADIUS,
      colliders,
    );
    this.respawnPoint.copy(p);
    this.mesh.position.copy(p);
  }

  /**
   * Per-frame AI update.
   * @param dt delta time (s)
   * @param player the player entity
   */
  update(dt: number, player: PlayerState): void {
    if (!this.alive) return;

    const toPlayer = new THREE.Vector3().subVectors(player.pos, this.mesh.position);
    toPlayer.y = 0; // planar chase distance; elevation is handled by the gates below
    const dist = toPlayer.length();

    // Face the player
    this.mesh.rotation.y = Math.atan2(toPlayer.x, toPlayer.z);

    // Movement blend: approach from afar, retreat when crowded, plus a
    // perpendicular strafe component that randomly flips direction to make
    // bots harder to track.
    const move = new THREE.Vector3();
    if (dist > 14) move.add(toPlayer.clone().normalize());
    else if (dist < 7) move.sub(toPlayer.clone().normalize());
    const strafe = new THREE.Vector3(-toPlayer.z, 0, toPlayer.x).normalize().multiplyScalar(this.strafeDir * 0.7);
    move.add(strafe).normalize().multiplyScalar(this.speed * dt);

    // Horizontal gate: the SAME axis-separated slide the player uses, with
    // feet-aware blocking — risers within STEP_HEIGHT don't stop a bot.
    const prevFeet = this.mesh.position.y;
    const preX = this.mesh.position.x, preZ = this.mesh.position.z;
    const intended = move.length();
    slideMoveXZ(this.mesh.position, move.x, move.z, BOT_RADIUS, prevFeet, colliders);
    if (Math.hypot(this.mesh.position.x - preX, this.mesh.position.z - preZ) < intended * 0.25) {
      this.strafeDir *= -1; // pinned against geometry: reverse strafe
    }

    // Vertical: same swept support resolution as the player, so bots climb
    // stairs mid-chase and land when they walk off an edge.
    this.vy -= GRAVITY * dt;
    const vert = resolveVertical(prevFeet, this.vy, dt,
      this.mesh.position.x, this.mesh.position.z, BOT_RADIUS, colliders);
    this.mesh.position.y = vert.feetY;
    this.vy = vert.velY;

    if (Math.random() < dt * 0.5) this.strafeDir *= -1; // ~50% chance/sec to juke

    // Shoot at player — only with clear line of sight. When blocked, retry
    // soon (0.3s) but do NOT fire; bullets must respect cover like the
    // player's do.
    this.fireCooldown -= dt;
    if (this.fireCooldown <= 0 && dist < 45 && player.alive) {
      if (hasLineOfSight(this.eyePos(), camera.position, solids)) {
        this.fireCooldown = 0.7 + Math.random() * 1.2;
        this.shoot(dist);
      } else {
        this.fireCooldown = 0.3;
      }
    }
  }

  /** World-space eye position used for LOS checks (~head height). */
  eyePos(): THREE.Vector3 {
    return new THREE.Vector3(this.mesh.position.x, this.mesh.position.y + 1.9, this.mesh.position.z);
  }

  /**
   * Fire at the player. Hits are probabilistic (no projectile): chance
   * falls off linearly with distance so distant bots are mostly noise,
   * and a hit deals 8-22 damage.
   */
  private shoot(dist: number): void {
    sfxEnemyShoot(this.mesh.position);
    spawnImpact(this.mesh.position.clone().add(new THREE.Vector3(0, 1.5, 0))); // cheap muzzle flash

    const hitChance = Math.max(0.12, 0.65 - dist / 80);
    if (Math.random() < hitChance) {
      const dmg = 8 + Math.random() * 14;
      damagePlayer(dmg);
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

/** Create the starting wave of bots. Called once from main.ts with the menu-configured enemy count (parser clamps it to >= 1). */
export function spawnBots(count: number): void {
  for (let i = 0; i < count; i++) bots.push(new Bot());
}

/** Advance all bot AI. Called once per frame from the main loop. */
export function updateBots(dt: number, player: PlayerState): void {
  bots.forEach(b => b.update(dt, player));
}
