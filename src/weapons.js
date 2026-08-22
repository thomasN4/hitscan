// weapons.js — the player's weapons: viewmodels, firing, reloading,
// weapon switching, iron sights / sniper scope.
//
// Damage model: weapon.damage per torso hit, legs x0.75, head x
// weapon.headshotMult (stats per weapon in core.WEAPONS). Bullets are
// hitscan: a single ray from the camera; the NEAREST intersection across
// walls + bot parts wins, so cover always blocks damage.
import * as THREE from 'three';
import { scene, camera, clock, solids, bots, weapon, game, player, WEAPONS, ammoStore } from './core.js';
import { sfxShoot, sfxSniper, sfxReload, sfxSwitch } from './audio.js';
import { showHitmarker, setCrosshairGap, setScopeOverlay } from './hud.js';
import { damageBot } from './combat.js';
import { spawnImpact, spawnBulletHole } from './effects.js';

// ---------- Viewmodel ----------
// First-person guns rendered as children of the camera so they inherit the
// view transform. One group per slot (rifle / sniper); visibility follows
// game.slot every frame. Position is animated each frame in
// updateWeapon/updatePlayer: x/y shift toward center when aiming (adsLerp),
// z/x-rotation kick with recoil, y bobs while moving (bobAmt from player.js).
export const gunGroup = new THREE.Group();
camera.add(gunGroup);
scene.add(camera);

const rifleGroup = new THREE.Group();
{
  const dark = new THREE.MeshLambertMaterial({ color: 0x2b2b2b });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.10, 0.5), dark);
  body.position.set(0.25, -0.22, -0.45); // lower-right of the view
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.35), dark);
  barrel.position.set(0.25, -0.19, -0.82);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.09), dark);
  mag.position.set(0.25, -0.31, -0.42);
  rifleGroup.add(body, barrel, mag);
}

const sniperGroup = new THREE.Group();
{
  const dark = new THREE.MeshLambertMaterial({ color: 0x24301f }); // green gunmetal
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.62), dark);
  body.position.set(0.26, -0.21, -0.55);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.72), dark);
  barrel.position.set(0.26, -0.18, -1.15); // long barrel reaching mid-screen
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.13, 0.22), dark);
  stock.position.set(0.26, -0.24, -0.14);
  // Scope: cylinder laid along the barrel (default axis is y -> rotate x)
  const scopeMat = new THREE.MeshLambertMaterial({ color: 0x111111 });
  const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.26, 12), scopeMat);
  scope.rotation.x = Math.PI / 2;
  scope.position.set(0.26, -0.12, -0.6);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.10, 0.10), dark);
  mag.position.set(0.26, -0.29, -0.52);
  sniperGroup.add(body, barrel, stock, scope, mag);
}

gunGroup.add(rifleGroup, sniperGroup);

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
 * Switch to slot `slot` (0 rifle, 1 sniper). Saves the current mag/reserve
 * back into ammoStore so mugs don't refill on swap, copies the new slot's
 * stats into the live `weapon` object, and resets scope zoom. Blocked while
 * reloading to avoid mid-mag-swap state corruption.
 */
export function switchWeapon(slot) {
  if (slot === game.slot || !game.started || !player.alive || weapon.reloading) return;
  ammoStore[game.slot].mag = weapon.mag;
  ammoStore[game.slot].reserve = weapon.reserve;
  game.slot = slot;
  game.zoomLevel = 0; // always re-enter the scope at its lowest step
  const def = WEAPONS[slot];
  Object.assign(weapon, {
    name: def.name,
    magSize: def.magSize,
    mag: ammoStore[slot].mag,
    reserve: ammoStore[slot].reserve,
    fireRate: def.fireRate,
    reloadTime: def.reloadTime,
    damage: def.damage,
    headshotMult: def.headshotMult,
  });
  sfxSwitch();
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
  const def = WEAPONS[game.slot];
  game.recoil = Math.min(game.recoil + def.recoilKick, 6);
  // Recoil bloom kick; capped so sustained fire stays controllable-ish
  game.bloom = Math.min(game.bloom + def.bloomKick, 0.25);

  muzzleFlashLight.intensity = 3;
  setTimeout(() => muzzleFlashLight.intensity = 0, 50);
  (game.slot === 1 ? sfxSniper : sfxShoot)();

  const dir = new THREE.Vector3(
    (Math.random() - 0.5) * game.spread,
    (Math.random() - 0.5) * game.spread,
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
  const def = WEAPONS[game.slot];

  // Recoil kick decay
  game.recoil = Math.max(0, game.recoil - dt * 30);

  // Aiming: blend FOV with adsLerp toward the weapon's current zoom target —
  // rifle has a single iron-sights step; the sniper cycles its wheel-chosen
  // zoomFovs entry. Running adds a +5° speed-feel kick (run and aim are
  // mutually exclusive by the movement precedence rules).
  const aimFov = def.zoomFovs[Math.min(game.zoomLevel, def.zoomFovs.length - 1)];
  game.adsLerp += ((game.aiming ? 1 : 0) - game.adsLerp) * Math.min(1, dt * 12);
  // Sensitivity scales with the actual zoom ratio so tracking at 12x stays
  // usable; main.js multiplies mouse deltas by this.
  game.zoomScale = 1 - (1 - aimFov / 75) * game.adsLerp;
  const targetFov = 75 + 5 * game.runLerp - (75 - aimFov) * game.adsLerp;
  if (Math.abs(camera.fov - targetFov) > 0.01) {
    camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 12);
    camera.updateProjectionMatrix();
  }

  // Viewmodel visibility: per-slot group swap; the sniper disappears
  // entirely once the full-screen scope reticle takes over.
  rifleGroup.visible = game.slot === 0;
  sniperGroup.visible = game.slot === 1;
  gunGroup.visible = !(def.scopedOverlay && game.adsLerp > 0.85);

  // Scope reticle is DOM (hud.js); only touch it on state flips.
  setScopeOverlay(def.scopedOverlay && game.adsLerp > 0.85);

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

  // ---- Accuracy model -------------------------------------------------
  // totalSpread = (stance base + movement penalty + recoil bloom) × ADS
  //   stance base: crouching cuts it ~72% AND halves the movement penalty,
  //                making crouch-walk the most accurate mobile stance
  //   movement:    moveLerp is MEASURED speed ÷ walk (see player.js)
  //   ADS:         weapon's spreadMul — 30% for the rifle's iron sights,
  //                5% for a scoped sniper shot
  // game.spread is consumed by shoot(); the crosshair gap in hud.js maps
  // from the same value, keeping what you see in sync with where bullets go.
  const adsMul = game.aiming ? def.spreadMul : 1;
  const stanceBase = 0.0025 - 0.0018 * game.crouchLerp;
  const movePenalty = 0.010 * game.moveLerp * (1 - 0.5 * game.crouchLerp);
  game.spread = Math.max(0.0005,
    (stanceBase + movePenalty + game.bloom) * adsMul);
  game.bloom = Math.max(0, game.bloom - dt * 0.06);

  // Crosshair mirrors the cone: ~6 px standing still, opening with movement
  // and bloom (capped so a long spray doesn't push arms off-screen).
  // Multiplier chosen so stance/movement differences are visible per arm.
  setCrosshairGap(Math.min(3 + game.spread * 1100, 60));
}
