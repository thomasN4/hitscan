// weapons.js — the player's rifle: viewmodel, firing, reloading, iron sights.
//
// Damage model: weapon.damage per torso hit, legs x0.75, head x4 (see
// core.weapon). Bullets are hitscan: a single ray from the camera; the
// NEAREST intersection across walls + bot parts wins, so cover always
// blocks damage.
import * as THREE from 'three';
import { scene, camera, clock, solids, bots, weapon, game, player } from './core.js';
import { sfxShoot, sfxReload } from './audio.js';
import { showHitmarker } from './hud.js';
import { damageBot } from './combat.js';
import { spawnImpact, spawnBulletHole } from './effects.js';

// ---------- Viewmodel ----------
// First-person gun rendered as a child of the camera so it inherits the
// view transform. Position is animated each frame in updateWeapon/updatePlayer:
// x/y shift toward center when aiming (adsLerp), z/x-rotation kick with recoil,
// y bobs while moving (bobAmt set by player.js).
export const gunGroup = new THREE.Group();
camera.add(gunGroup);
scene.add(camera);
{
  const dark = new THREE.MeshLambertMaterial({ color: 0x2b2b2b });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.10, 0.5), dark);
  body.position.set(0.25, -0.22, -0.45); // lower-right of the view
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.35), dark);
  barrel.position.set(0.25, -0.19, -0.82);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.09), dark);
  mag.position.set(0.25, -0.31, -0.42);
  gunGroup.add(body, barrel, mag);
}

const raycaster = new THREE.Raycaster();
const muzzleFlashLight = new THREE.PointLight(0xffdd88, 0, 12);
scene.add(muzzleFlashLight);

/** Start reloading if possible. Bound to R and to firing an empty mag. */
export function tryReload() {
  if (!game.started || !player.alive || weapon.reloading || weapon.mag === weapon.magSize || weapon.reserve <= 0) return;
  weapon.reloading = true;
  weapon.reloadEnd = performance.now() / 1000 + weapon.reloadTime;
  sfxReload();
}

/**
 * Fire one shot: consume ammo, apply recoil/spread bloom, then hitscan.
 * The spread cone widens with consecutive fire (`game.spread`) and shrinks
 * to 30% while aiming. Nearest hit across solids + live bot parts decides
 * the outcome — bot hit -> damage by zone, wall hit -> impact puff only.
 */
export function shoot() {
  if (weapon.reloading || weapon.mag <= 0) {
    if (weapon.mag <= 0) tryReload(); // auto-reload on dry fire
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
    // 'YXZ' must match the camera's rotation order (player.js) or the shot
    // direction diverges from the view direction as pitch/yaw grow.
    -1
  ).normalize().applyEuler(new THREE.Euler(game.pitch, game.yaw, 0, 'YXZ'));

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
    const bot = hit.object.userData.bot; // stamped onto each part in Bot's constructor
    if (bot) {
      const part = hit.object === bot.head ? 'head' : hit.object === bot.legs ? 'legs' : 'torso';
      const dmg = weapon.damage * (part === 'head' ? weapon.headshotMult : part === 'legs' ? 0.75 : 1);
      showHitmarker(part === 'head');
      damageBot(bot, dmg, part);
    } else {
      spawnImpact(hit.point);
      // Decal needs the surface normal in world space; face.normal is
      // object-space and level geometry is rotated (ground plane, etc.)
      const worldNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      spawnBulletHole(hit.point, worldNormal);
    }
  }
}

/**
 * Per-frame weapon upkeep: recoil/ADS smoothing, FOV zoom toward iron-sight
 * target, reload completion, trigger handling, spread recovery. Called from
 * player.js inside the game loop.
 */
export function updateWeapon(dt) {
  // Recoil kick decay
  game.recoil = Math.max(0, game.recoil - dt * 30);

  // Iron sights: blend FOV 75 -> 55 with adsLerp for a smooth zoom-in
  game.adsLerp += ((game.aiming ? 1 : 0) - game.adsLerp) * Math.min(1, dt * 12);
  const targetFov = game.aiming ? 55 : 75;
  if (Math.abs(camera.fov - targetFov) > 0.01) {
    camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 12);
    camera.updateProjectionMatrix();
  }

  // Reload finish: top the mag back up from reserve (partial reloads allowed).
  // Range mode: reserve is not deducted — R always restores a full loadout
  // so accuracy/recoil practice never pauses for ammo runs.
  if (weapon.reloading && performance.now() / 1000 >= weapon.reloadEnd) {
    const need = weapon.magSize - weapon.mag;
    const take = Math.min(need, weapon.reserve);
    weapon.mag += take;
    if (game.map !== 'range') weapon.reserve -= take;
    weapon.reloading = false;
  }

  // Trigger: full-auto while LMB held, paced by fireRate
  if (game.shooting && clock.elapsedTime - weapon.lastShot >= weapon.fireRate) shoot();

  // Spread recovery: bloom decays back to hip-fire accuracy over ~0.3s
  game.spread = Math.max(0.001, game.spread - dt * 0.06);
}
