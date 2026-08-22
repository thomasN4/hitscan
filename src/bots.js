import * as THREE from 'three';
import { scene, camera, bots, solids, game } from './core.js';
import { collidesAt, hasLineOfSight } from './collision.js';
import { damagePlayer, checkRoundEnd } from './combat.js';
import { sfxEnemyShoot } from './audio.js';
import { spawnImpact } from './effects.js';
import { addKillfeed, updateScore } from './hud.js';

const BOT_COUNT = 6;
const botGeo = {
  torso: new THREE.BoxGeometry(0.7, 0.9, 0.4),
  head:  new THREE.BoxGeometry(0.34, 0.34, 0.34),
  legs:  new THREE.BoxGeometry(0.6, 0.9, 0.35),
};
const matBotBody = new THREE.MeshLambertMaterial({ color: 0x8a6b2e }); // T tan/brown
const matBotHead = new THREE.MeshLambertMaterial({ color: 0xd8c39a });
const matBotLegs = new THREE.MeshLambertMaterial({ color: 0x4d4436 });

class Bot {
  constructor() {
    this.mesh = new THREE.Group();
    this.torso = new THREE.Mesh(botGeo.torso, matBotBody);
    this.torso.position.y = 1.35;
    this.head = new THREE.Mesh(botGeo.head, matBotHead);
    this.head.position.y = 2.0;
    this.legs = new THREE.Mesh(botGeo.legs, matBotLegs);
    this.legs.position.y = 0.45;
    [this.torso, this.head, this.legs].forEach(p => { p.castShadow = true; this.mesh.add(p); });
    this.parts = { torso: this.torso, head: this.head, legs: this.legs };
    this.parts.torso.userData.bot = this.head.userData.bot = this.legs.userData.bot = this;

    this.hp = 100;
    this.alive = true;
    this.speed = 3.2 + Math.random() * 1.4;
    this.fireCooldown = 1 + Math.random() * 2;
    this.strafeDir = Math.random() < 0.5 ? 1 : -1;
    this.respawnPoint = new THREE.Vector3();

    this.spawnAtRandom();
    scene.add(this.mesh);
  }

  spawnAtRandom() {
    // Spawn in far half of map
    const x = (Math.random() - 0.5) * 90;
    const z = -(20 + Math.random() * 35);
    this.respawnPoint.set(x, 0, z);
    this.mesh.position.copy(this.respawnPoint);
  }

  update(dt, player) {
    if (!this.alive) return;

    const toPlayer = new THREE.Vector3().subVectors(player.pos, this.mesh.position);
    toPlayer.y = 0;
    const dist = toPlayer.length();

    // Face the player
    this.mesh.rotation.y = Math.atan2(toPlayer.x, toPlayer.z);

    // Move toward player until within range, then strafe
    const move = new THREE.Vector3();
    if (dist > 14) move.add(toPlayer.clone().normalize());
    else if (dist < 7) move.sub(toPlayer.clone().normalize());
    const strafe = new THREE.Vector3(-toPlayer.z, 0, toPlayer.x).normalize().multiplyScalar(this.strafeDir * 0.7);
    move.add(strafe).normalize().multiplyScalar(this.speed * dt);

    const nextPos = this.mesh.position.clone().add(move);
    nextPos.y = 0;
    if (!collidesAt(nextPos, 0.5)) this.mesh.position.copy(nextPos);
    else this.strafeDir *= -1;

    if (Math.random() < dt * 0.5) this.strafeDir *= -1;

    // Shoot at player — only with clear line of sight
    this.fireCooldown -= dt;
    if (this.fireCooldown <= 0 && dist < 45 && player.alive) {
      if (hasLineOfSight(this.eyePos(), camera.position, solids)) {
        this.fireCooldown = 0.7 + Math.random() * 1.2;
        this.shoot(dist);
      } else {
        this.fireCooldown = 0.3; // re-check soon; keep hunting
      }
    }
  }

  eyePos() {
    return new THREE.Vector3(this.mesh.position.x, this.mesh.position.y + 1.9, this.mesh.position.z);
  }

  shoot(dist) {
    sfxEnemyShoot(this.mesh.position);
    // Muzzle flash at bot
    spawnImpact(this.mesh.position.clone().add(new THREE.Vector3(0, 1.5, 0)));

    // Accuracy falls off with distance
    const hitChance = Math.max(0.12, 0.65 - dist / 80);
    if (Math.random() < hitChance) {
      const dmg = 8 + Math.random() * 14;
      damagePlayer(dmg);
    }
  }

  die(killerPart) {
    this.alive = false;
    this.mesh.visible = false;
    game.scoreKills++;
    updateScore();
    addKillfeed(`You ${killerPart === 'head' ? '☠ headshot' : 'killed'} Bot`);
    checkRoundEnd();
    // Respawn after delay
    setTimeout(() => {
      this.hp = 100;
      this.alive = true;
      this.mesh.visible = true;
      this.spawnAtRandom();
    }, 6000);
  }
}

export function spawnBots() {
  for (let i = 0; i < BOT_COUNT; i++) bots.push(new Bot());
}

export function updateBots(dt, player) {
  bots.forEach(b => b.update(dt, player));
}
