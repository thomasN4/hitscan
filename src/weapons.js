import * as THREE from 'three';
import { scene, camera, clock, solids, bots, weapon, game, player } from './core.js';
import { sfxShoot, sfxReload } from './audio.js';
import { showHitmarker } from './hud.js';
import { damageBot } from './combat.js';
import { spawnImpact } from './effects.js';

// ---------- Viewmodel ----------
export const gunGroup = new THREE.Group();
camera.add(gunGroup);
scene.add(camera);
{
  const dark = new THREE.MeshLambertMaterial({ color: 0x2b2b2b });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.10, 0.5), dark);
  body.position.set(0.25, -0.22, -0.45);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.35), dark);
  barrel.position.set(0.25, -0.19, -0.82);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.09), dark);
  mag.position.set(0.25, -0.31, -0.42);
  gunGroup.add(body, barrel, mag);
}

const raycaster = new THREE.Raycaster();
const muzzleFlashLight = new THREE.PointLight(0xffdd88, 0, 12);
scene.add(muzzleFlashLight);

export function tryReload() {
  if (!game.started || !player.alive || weapon.reloading || weapon.mag === weapon.magSize || weapon.reserve <= 0) return;
  weapon.reloading = true;
  weapon.reloadEnd = performance.now() / 1000 + weapon.reloadTime;
  sfxReload();
}

export function shoot() {
  if (weapon.reloading || weapon.mag <= 0) {
    if (weapon.mag <= 0) tryReload();
    return;
  }
  weapon.mag--;
  weapon.lastShot = clock.elapsedTime;
  game.recoil = Math.min(game.recoil + 1, 6);
  game.spread += 0.02;

  muzzleFlashLight.intensity = 3;
  setTimeout(() => muzzleFlashLight.intensity = 0, 50);
  sfxShoot();

  const adsFactor = game.aiming ? 0.3 : 1;
  const dir = new THREE.Vector3(
    (Math.random() - 0.5) * game.spread * adsFactor,
    (Math.random() - 0.5) * game.spread * adsFactor,
    -1
  ).normalize().applyEuler(new THREE.Euler(game.pitch, game.yaw, 0));

  raycaster.set(camera.getWorldPosition(new THREE.Vector3()), dir);
  raycaster.far = 200;

  // Gather every solid (walls, crates, ground) plus live bot parts,
  // then take the single closest intersection — walls block bullets.
  const targets = [...solids];
  for (const bot of bots) {
    if (!bot.alive) continue;
    targets.push(bot.head, bot.torso, bot.legs);
  }
  const hits = raycaster.intersectObjects(targets, false);
  if (hits.length > 0) {
    const hit = hits[0];
    const bot = hit.object.userData.bot;
    if (bot) {
      const part = hit.object === bot.head ? 'head' : hit.object === bot.legs ? 'legs' : 'torso';
      const dmg = weapon.damage * (part === 'head' ? weapon.headshotMult : part === 'legs' ? 0.75 : 1);
      showHitmarker(part === 'head');
      damageBot(bot, dmg, part);
    } else {
      spawnImpact(hit.point);
    }
  }
}

export function updateWeapon(dt) {
  // Recoil kick decay
  game.recoil = Math.max(0, game.recoil - dt * 30);

  // Iron sights (lerp viewmodel to center + zoom)
  game.adsLerp += ((game.aiming ? 1 : 0) - game.adsLerp) * Math.min(1, dt * 12);
  const targetFov = game.aiming ? 55 : 75;
  if (Math.abs(camera.fov - targetFov) > 0.01) {
    camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 12);
    camera.updateProjectionMatrix();
  }

  // Reload finish
  if (weapon.reloading && performance.now() / 1000 >= weapon.reloadEnd) {
    const need = weapon.magSize - weapon.mag;
    const take = Math.min(need, weapon.reserve);
    weapon.mag += take;
    weapon.reserve -= take;
    weapon.reloading = false;
  }

  // Fire
  if (game.shooting && clock.elapsedTime - weapon.lastShot >= weapon.fireRate) shoot();

  // Spread recovery
  game.spread = Math.max(0.001, game.spread - dt * 0.06);
}
