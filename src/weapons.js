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
let rifleMag; // kept for the reload animation (mag drop/reseat)
{
  const dark = new THREE.MeshLambertMaterial({ color: 0x2b2b2b });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.10, 0.5), dark);
  body.position.set(0.25, -0.22, -0.45); // lower-right of the view
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.35), dark);
  barrel.position.set(0.25, -0.19, -0.82);
  rifleMag = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.09), dark);
  rifleMag.position.set(0.25, -0.31, -0.42);
  rifleMag.userData.baseY = -0.31;
  rifleGroup.add(body, barrel, rifleMag);
}

const sniperGroup = new THREE.Group();
let sniperMag; // kept for the reload animation (mag drop/reseat)
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
  mag.userData.baseY = -0.29;
  sniperMag = mag;
  sniperGroup.add(body, barrel, stock, scope, mag);
}

gunGroup.add(rifleGroup, sniperGroup);

const raycaster = new THREE.Raycaster();
const muzzleFlashLight = new THREE.PointLight(0xffdd88, 0, 12);
scene.add(muzzleFlashLight);

/**
 * Vertical aim angle including recoil view punch. The camera (player.js)
 * and the shot direction (shoot()) must BOTH use this so the crosshair
 * center is always truthful about where bullets actually go.
 */
export function aimPitch() {
  return game.pitch + game.recoil * WEAPONS[game.slot].punchRad;
}

// ---------- Reload animation ----------
// Procedural viewmodel reload: the gun dips away from the camera and tilts
// while the magazine drops out and slides back in. Everything is driven by
// reload progress (0..1 over weapon.reloadTime), so calling with t = 0
// restores the rest pose — offsets self-reset when `weapon.reloading` clears.
const MAG_TRAVEL = 0.22; // how far the magazine drops, view units

/** Smooth 0→1→0 hold envelope: eases in over [0,inFrac], out over [1-outFrac,1]. */
function holdEnv(t, inFrac, outFrac) {
  return THREE.MathUtils.smoothstep(t, 0, inFrac) *
    (1 - THREE.MathUtils.smoothstep(t, 1 - outFrac, 1));
}

/**
 * Pose one weapon group for reload progress `t`. Applied to the per-slot
 * group (not gunGroup, whose transform player.js owns every frame).
 * @param {THREE.Group} group weapon viewmodel group
 * @param {THREE.Mesh} mag its magazine mesh (needs userData.baseY set)
 * @param {number} t reload progress 0..1
 */
function poseReload(group, mag, t) {
  const dip = holdEnv(t, 0.2, 0.25);
  // Negative x-rotation tips the muzzle down; z rolls it toward center
  group.position.y = -0.15 * dip;
  group.rotation.x = -0.32 * dip;
  group.rotation.z = 0.15 * dip;
  // Mag falls out early (8%..38%), seats home late (55%..88%)
  const drop = THREE.MathUtils.smoothstep(t, 0.08, 0.38);
  const seat = THREE.MathUtils.smoothstep(t, 0.55, 0.88);
  mag.position.y = mag.userData.baseY - MAG_TRAVEL * drop * (1 - seat);
}

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
    recoilRecover: def.recoilRecover,
  });
  sfxSwitch();
}

/**
 * Fire one shot: consume ammo, apply recoil/spread bloom, then hitscan.
 * The spread cone widens with consecutive fire (`game.spread`) and shrinks
 * to the weapon's spreadMul while aiming. Nearest hit across solids + live
 * bot parts decides the outcome — bot hit -> damage by zone, wall hit ->
 * impact puff only.
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

  // Bolt-action feel: firing kicks you out of the scope. Clearing
  // game.aiming means a fresh RMB press is needed to re-scope even if the
  // button is still held (mouseup will just re-clear it harmlessly).
  if (def.unscopeOnShot) game.aiming = false;

  const dir = new THREE.Vector3(
    (Math.random() - 0.5) * game.spread,
    (Math.random() - 0.5) * game.spread,
    // 'YXZ' must match the camera's rotation order (player.js) or the shot
    // direction diverges from the view direction as pitch/yaw grow; the
    // pitch includes the recoil punch via aimPitch() so shots follow the
    // same climb the camera shows.
    -1
  ).normalize().applyEuler(new THREE.Euler(aimPitch(), game.yaw, 0, 'YXZ'));

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
let triggerLatch = false; // semi-auto edge detector: set on fire, cleared on release

export function updateWeapon(dt) {
  const def = WEAPONS[game.slot];

  // Recoil kick decay — rate is per-weapon (rifle resets fast for full-auto,
  // the sniper settles slowly for bolt-action feel; see core.WEAPONS)
  game.recoil = Math.max(0, game.recoil - dt * weapon.recoilRecover);

  // Aiming: blend FOV with adsLerp toward the weapon's current zoom target —
  // rifle has a single iron-sights step; the sniper cycles its wheel-chosen
  // zoomFovs entry. Running adds a +5° speed-feel kick (run and aim are
  // mutually exclusive by the movement precedence rules).
  if (!game.aiming) game.zoomLevel = 0; // every re-scope starts at lowest zoom
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

  // Reload animation: progress through the active reload (0 when idle so
  // the pose resets). Uses wall-clock time to match weapon.reloadEnd.
  const nowS = performance.now() / 1000;
  const reloadT = weapon.reloading
    ? THREE.MathUtils.clamp(1 - (weapon.reloadEnd - nowS) / weapon.reloadTime, 0, 1)
    : 0;
  if (game.slot === 0) poseReload(rifleGroup, rifleMag, reloadT);
  else poseReload(sniperGroup, sniperMag, reloadT);

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

  // Trigger: rifle is full-auto while LMB held; semi-autos (sniper) fire
  // once per press — the latch blocks repeats until the button is released.
  if (!game.shooting) triggerLatch = false;
  else if (!def.semiAuto || !triggerLatch) {
    if (clock.elapsedTime - weapon.lastShot >= weapon.fireRate) {
      shoot();
      if (def.semiAuto) triggerLatch = true;
    }
  }

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
  game.bloom = Math.max(0, game.bloom - dt * def.bloomRecover);

  // Crosshair arms sit at the EDGE of the actual scatter cone, projected to
  // screen space with the live FOV (per-axis half-angle ≈ spread/2) — so the
  // gap always matches where bullets can land, hip-fire or ADS. The mean
  // impact point is screen center itself via aimPitch().
  const pxPerTan = window.innerHeight / 2 / Math.tan(camera.fov * Math.PI / 360);
  setCrosshairGap(Math.min(3 + Math.tan(game.spread / 2) * pxPerTan, 60));
}
