// weapons.ts — the player's weapons: viewmodels, firing, reloading,
// weapon switching, iron sights / sniper scope.
//
// Damage model: weapon.damage per torso hit, legs x0.75, head x
// weapon.headshotMult (stats per weapon in core.WEAPONS). Bullets are
// hitscan: a single ray from the camera; the NEAREST intersection across
// walls + bot parts wins, so cover always blocks damage.
import * as THREE from 'three';
import { scene, camera } from './core/engine';
import { solids } from './world';
import { bots, weapon, session, input, aim, wpn, motion, player, gameTime, WEAPONS, ammoStore,
         RECOIL_CAP, RECOIL_YAW_CAP, BASE_FOV,
         equippedId,
         type WeaponDef, type WeaponSlot, type WeaponId } from './core/state';
import { sfxShoot, sfxSniper, sfxShotgun, sfxPistol, sfxRevolver, sfxReload, sfxSwitch } from './audio';
import { showHitmarker, setCrosshairGap, setScopeOverlay } from './hud';
import { damageBot } from './combat';
import { spawnImpact, spawnBulletHole } from './effects';
import { botFor } from './bots';
import { computeSpread, crosshairGapPx } from './sim/accuracy';
import { aimPitch, aimYaw, convertOnSwap, decayRecoil, decaySpray, decayToward } from './sim/recoil';
import { shotDirection } from './sim/ballistics';
import { damageForPart, partForMesh } from './sim/damage';
import { approach } from './sim/smoothing';

// The live weapon def. WEAPONS is a Record over the WeaponId union and
// equippedId() resolves the loadout position to an id, so this read cannot
// miss and needs no guard — the type does the work that a named throw used
// to. wpn.zoomLevel is still a plain number, though, so aimFovFor below still
// has a real miss case to decide about.
function currentDef(): WeaponDef {
  return WEAPONS[equippedId(wpn.slot)];
}

/** Zoom FOV target for the current zoom level, clamped into range. */
function aimFovFor(def: WeaponDef): number {
  const fov = def.zoomFovs[Math.min(wpn.zoomLevel, def.zoomFovs.length - 1)];
  if (fov === undefined) throw new Error(`${def.name}: empty zoomFovs`);
  return fov;
}

/** The ONE read of `userData.baseY`, stamped on each viewmodel magazine below. */
function magBaseY(mag: THREE.Mesh): number {
  return mag.userData.baseY as number;
}

// ---------- Viewmodel ----------
// First-person guns rendered as children of the camera so they inherit the
// view transform. One group per catalog id; visibility follows
// WEAPONS[equippedId(wpn.slot)] every frame via the VIEWMODELS registry.
// Position is animated each frame in
// updateWeapon/updateViewmodel: x/y shift toward center when aiming (adsLerp),
// z/x-rotation kick with recoil, y bobs while moving (bobAmt from player.ts).
// The viewmodel meshes below are pure THREE objects, so they are built at
// module scope; only ATTACHING them to the engine's camera/scene needs
// initEngine() to have run first — see initWeaponViewmodels().
export const gunGroup = new THREE.Group();

const smgGroup = new THREE.Group();
let smgMag: THREE.Mesh; // kept for the reload animation (mag drop/reseat)
{
  const dark = new THREE.MeshLambertMaterial({ color: 0x2b2b2b });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.10, 0.5), dark);
  body.position.set(0.25, -0.22, -0.45); // lower-right of the view
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.35), dark);
  barrel.position.set(0.25, -0.19, -0.82);
  smgMag = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.09), dark);
  smgMag.position.set(0.25, -0.31, -0.42);
  smgMag.userData.baseY = -0.31;
  smgGroup.add(body, barrel, smgMag);
}

const sniperGroup = new THREE.Group();
let sniperMag: THREE.Mesh; // kept for the reload animation (mag drop/reseat)
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

const pistolGroup = new THREE.Group();
let pistolMag: THREE.Mesh; // kept for the reload animation (mag drop/reseat)
{
  const dark = new THREE.MeshLambertMaterial({ color: 0x33322f });
  const slide = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, 0.30), dark);
  slide.position.set(0.24, -0.20, -0.38);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.15, 0.09), dark);
  grip.position.set(0.24, -0.30, -0.27);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.13, 0.07), dark);
  mag.position.set(0.24, -0.31, -0.28);
  mag.userData.baseY = -0.31;
  pistolMag = mag;
  pistolGroup.add(slide, grip, mag);
}

const shotgunGroup = new THREE.Group();
let shotgunMag: THREE.Mesh; // kept for the reload animation (mag drop/reseat)
{
  const wood = new THREE.MeshLambertMaterial({ color: 0x4a331f }); // oiled walnut
  const steel = new THREE.MeshLambertMaterial({ color: 0x26262a });
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.11, 0.34), steel);
  receiver.position.set(0.25, -0.22, -0.5);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.62), steel);
  barrel.position.set(0.25, -0.18, -0.95);
  const tube = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.55), steel); // under-barrel shell tube
  tube.position.set(0.25, -0.235, -0.9);
  const pump = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.16), wood);
  pump.position.set(0.25, -0.24, -0.78);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.26), wood);
  stock.position.set(0.25, -0.25, -0.1);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.12), steel); // loading gate/shell
  mag.position.set(0.25, -0.29, -0.46);
  mag.userData.baseY = -0.29;
  shotgunMag = mag;
  shotgunGroup.add(receiver, barrel, tube, pump, stock, mag);
}

const revolverGroup = new THREE.Group();
let revolverMag: THREE.Mesh; // kept for the reload animation (cylinder drop/reseat)
{
  const dark = new THREE.MeshLambertMaterial({ color: 0x2e2e33 });
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.075, 0.34), dark);
  frame.position.set(0.24, -0.2, -0.4);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.22), dark);
  barrel.position.set(0.24, -0.185, -0.62);
  // Cylinder: a short fat cylinder laid along the barrel (default axis is y
  // -> rotate x), the visual signature of a revolver.
  const cylinder = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 0.09, 8), dark);
  cylinder.rotation.x = Math.PI / 2;
  cylinder.position.set(0.24, -0.2, -0.44);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.08),
    new THREE.MeshLambertMaterial({ color: 0x4a331f })); // wood grips
  grip.position.set(0.24, -0.3, -0.28);
  const mag = cylinder; // the reload pose drops/swings the cylinder itself
  mag.userData.baseY = -0.2;
  revolverMag = mag;
  revolverGroup.add(frame, barrel, cylinder, grip);
}

gunGroup.add(smgGroup, sniperGroup, pistolGroup, shotgunGroup, revolverGroup);

/**
 * Per-weapon viewmodel: the animated group plus the mesh poseReload() drops
 * and reseats during a reload. Keyed by catalog id so a new weapon fails to
 * compile until it registers here.
 */
interface ViewModel {
  group: THREE.Group;
  mag: THREE.Mesh;
}

const VIEWMODELS: Record<WeaponId, ViewModel> = {
  smg: { group: smgGroup, mag: smgMag },
  sniper: { group: sniperGroup, mag: sniperMag },
  shotgun: { group: shotgunGroup, mag: shotgunMag },
  pistol: { group: pistolGroup, mag: pistolMag },
  revolver: { group: revolverGroup, mag: revolverMag },
};

// Per-weapon shot sound; keyed by WeaponId so no weapon can miss.
const SHOT_SFX: Record<WeaponId, () => void> = {
  smg: sfxShoot,
  sniper: sfxSniper,
  shotgun: sfxShotgun,
  pistol: sfxPistol,
  revolver: sfxRevolver,
};

const raycaster = new THREE.Raycaster();
const muzzleFlashLight = new THREE.PointLight(0xffdd88, 0, 12);

/**
 * Attach the viewmodel to the camera and the muzzle flash to the scene.
 * Requires initEngine() to have run; call once from main.ts before the loop.
 * `scene.add(camera)` is what makes the camera-parented gun render at all.
 */
export function initWeaponViewmodels(): void {
  camera.add(gunGroup);
  scene.add(camera);
  scene.add(muzzleFlashLight);
}

/**
 * Vertical aim angle for the CURRENT weapon and recoil state.
 *
 * Thin binding over sim/recoil.ts:aimPitch — the pure function is the one
 * source of truth, this just supplies the live state. The camera
 * (player.ts:updateCamera) and the shot direction (shoot()) must BOTH go
 * through it so the crosshair stays truthful about where bullets go.
 */
export function currentAimPitch(): number {
  return aimPitch(aim.pitch, wpn.recoil, currentDef().punchRad);
}

/**
 * Horizontal aim angle for the CURRENT weapon and recoil state — the
 * counterpart of currentAimPitch(), over sim/recoil.ts:aimYaw.
 *
 * Same contract: the camera (player.ts:updateCamera) and the shot direction
 * (shoot()) must BOTH go through it, or the crosshair stops being truthful
 * about horizontal drift the way it once did about vertical climb.
 */
export function currentAimYaw(): number {
  return aimYaw(aim.yaw, wpn.recoilYaw, currentDef().punchRad);
}

// ---------- Reload animation ----------
// Procedural viewmodel reload: the gun dips away from the camera and tilts
// while the magazine drops out and slides back in. Everything is driven by
// reload progress (0..1 over weapon.reloadTime), so calling with t = 0
// restores the rest pose — offsets self-reset when `weapon.reloading` clears.
const MAG_TRAVEL = 0.22; // how far the magazine drops, view units

/** Smooth 0→1→0 hold envelope: eases in over [0,inFrac], out over [1-outFrac,1]. */
function holdEnv(t: number, inFrac: number, outFrac: number): number {
  return THREE.MathUtils.smoothstep(t, 0, inFrac) *
    (1 - THREE.MathUtils.smoothstep(t, 1 - outFrac, 1));
}

/**
 * Pose one weapon group for reload progress `t`. Applied to the per-slot
 * group (not gunGroup, whose transform player.ts owns every frame).
 */
function poseReload(group: THREE.Group, mag: THREE.Mesh, t: number): void {
  const dip = holdEnv(t, 0.2, 0.25);
  // Negative x-rotation tips the muzzle down; z rolls it toward center
  group.position.y = -0.15 * dip;
  group.rotation.x = -0.32 * dip;
  group.rotation.z = 0.15 * dip;
  // Mag falls out early (8%..38%), seats home late (55%..88%)
  const drop = THREE.MathUtils.smoothstep(t, 0.08, 0.38);
  const seat = THREE.MathUtils.smoothstep(t, 0.55, 0.88);
  mag.position.y = magBaseY(mag) - MAG_TRAVEL * drop * (1 - seat);
}

/** Start reloading if possible. Bound to R and to firing an empty mag. */
export function tryReload(): void {
  if (!session.started || !player.alive || weapon.reloading || weapon.mag === weapon.magSize || weapon.reserve <= 0) return;
  weapon.reloading = true;
  weapon.reloadEnd = gameTime.now() + weapon.reloadTime;
  sfxReload();
}

/**
 * Switch to loadout position `slot` (0 primary, 1 secondary). The weapon
 * itself comes from the loadout slice via equippedId. Saves the current
 * mag/reserve back into ammoStore so swaps don't refill mags, copies the new
 * weapon's stats into the live `weapon` object, converts the live recoil/
 * spray state to the incoming weapon's terms, and resets scope zoom. Cancels
 * an in-progress reload CS-style rather than being blocked by one (see below).
 */
export function switchWeapon(slot: WeaponSlot): void {
  if (slot === wpn.slot || !session.started || !player.alive) return;
  // Switching cancels an in-progress reload instead of waiting it out. Safe
  // because no rounds have moved yet — the mag is refilled from reserve only
  // when the timer completes in updateWeapon — and the still-partial mag is
  // saved back into ammoStore below, so the interrupted weapon keeps exactly
  // what it had. This clear is also the real fix for the hazard the old
  // blanket block guarded: a reloading flag riding across the swap would run
  // that completion check against the INCOMING weapon's stats with the stale
  // reloadEnd — an instant free reload.
  weapon.reloading = false;
  const saved = ammoStore[wpn.slot];
  const loaded = ammoStore[slot];
  saved.mag = weapon.mag;
  saved.reserve = weapon.reserve;

  // Record the outgoing slot BEFORE re-pointing `slot`: this is what makes
  // the Q quick-swap a two-weapon toggle (Q,Q returns you to where you were).
  wpn.lastSlot = wpn.slot;

  // Recoil/spray state is weapon-RELATIVE, so the swap converts it instead of
  // carrying the raw numbers across: without this the sniper's punchRad renders
  // the smg's stored units as a different angle and the aim snaps mid-swap.
  //
  // This comment used to claim converting also stops 1-2-1 being a free recoil
  // cancel. It does NOT, and playtesting PR #14 found it out. Converting only
  // prevents an INSTANT reset — the swap then copies the incoming weapon's
  // recoilRecover into `weapon`, and the decay does the reset regardless. The
  // sniper drains a full smg climb (3.6 units after conversion) at 13 units/s,
  // so it is gone in 0.277 s, well inside a human swap. Same for the scopeGate
  // half of the old claim. The real fix is for switching to cost time; tracked
  // as issue #15, and NOT a regression — main behaves identically.
  //
  // The arithmetic itself lives in sim/recoil.ts. It is pure, and leaving it
  // inline here put it behind sfxSwitch()'s AudioContext where the Node test
  // suite could not reach it — which is how the ratio shipped inverted with all
  // 128 tests green (review lesson 2, and now lessons 19-20).
  const outgoing = currentDef();
  const incoming = WEAPONS[equippedId(slot)];
  const converted = convertOnSwap(wpn, outgoing, incoming,
    { recoil: RECOIL_CAP, recoilYaw: RECOIL_YAW_CAP });
  wpn.recoil = converted.recoil;
  wpn.recoilYaw = converted.recoilYaw;
  wpn.spray = converted.spray;

  wpn.slot = slot;
  wpn.zoomLevel = 0; // always re-enter the scope at its lowest step
  const def = incoming;
  Object.assign(weapon, {
    name: def.name,
    magSize: def.magSize,
    mag: loaded.mag,
    reserve: loaded.reserve,
    fireRate: def.fireRate,
    reloadTime: def.reloadTime,
    damage: def.damage,
    headshotMult: def.headshotMult,
    recoilRecover: def.recoilRecover,
  });
  sfxSwitch();
}

/**
 * Quick-swap to the weapon held immediately before the current one (bound to
 * Q). Just re-enters switchWeapon with wpn.lastSlot: when nothing has been
 * swapped yet (or you're already holding that slot) switchWeapon's own gate
 * no-ops, so no extra state to guard here.
 */
export function switchToLast(): void {
  switchWeapon(wpn.lastSlot);
}

/**
 * Fire one shot (one trigger pull): consume ammo, kick recoil and spray, then
 * hitscan. A weapon with `pellets` fires that many independent rays, each
 * sampled in the live spread cone — the shotgun's wide kill/no-kill falloff
 * IS that sampling. Nearest hit across solids + live bot parts decides each
 * ray's outcome — bot hit -> damage by zone, wall hit -> impact puff only.
 */
export function shoot(): void {
  if (weapon.reloading || weapon.mag <= 0) {
    if (weapon.mag <= 0) tryReload(); // auto-reload on dry fire
    return;
  }
  weapon.mag--;
  weapon.lastShot = gameTime.now();
  const def = currentDef();
  const pellets = def.pellets ?? 1; // documented default: a single hitscan ray

  muzzleFlashLight.intensity = 3;
  // Wall clock on purpose: purely visual cleanup, and running it during
  // pause means a shot fired on the same frame as Esc can't leave the light
  // stuck on behind the menu.
  setTimeout(() => muzzleFlashLight.intensity = 0, 50);
  SHOT_SFX[equippedId(wpn.slot)]();

  // Bolt-action feel: firing kicks you out of the scope. Clearing
  // input.aiming means a fresh RMB press is needed to re-scope even if the
  // button is still held (mouseup will just re-clear it harmlessly).
  if (def.unscopeOnShot) input.aiming = false;

  const origin = camera.getWorldPosition(new THREE.Vector3());
  // Gather every solid (walls, crates, ground) plus live bot parts once for
  // the whole trigger pull — every pellet tests the same target set.
  const targets: THREE.Object3D[] = [...solids];
  for (const bot of bots) {
    if (!bot.alive) continue;
    targets.push(bot.head, bot.torso, bot.legs);
  }

  let anyHit = false;
  let anyHead = false;

  /** One hitscan ray: sample the cone, take the nearest intersection. */
  const fireRay = (): void => {
    // Euler order and cone sampling live in sim/ballistics.ts; pitch and yaw
    // both carry their recoil punch, so shots follow exactly what the camera
    // shows — vertically via currentAimPitch, horizontally via currentAimYaw.
    const dir = shotDirection(currentAimPitch(), currentAimYaw(), wpn.spread);
    raycaster.set(origin, dir);
    raycaster.far = 200;
    const hits = raycaster.intersectObjects(targets, false);
    if (hits.length === 0) return;
    // length checked above; the assertion only records that fact
    const hit = hits[0]!;
    const bot = botFor(hit.object); // stamped onto each part in Bot's constructor
    if (bot && bot.team === 'CT') {
      // Friendly fire is OFF: ally bodies stop the bullet (visible impact,
      // no hitmarker, no damage) but never bleed CT score.
      spawnImpact(hit.point);
    } else if (bot) {
      const part = partForMesh(bot, hit.object);
      anyHit = true;
      anyHead = anyHead || part === 'head';
      damageBot(bot, damageForPart(weapon, part), part);
    } else {
      spawnImpact(hit.point);
      // Decal needs the surface normal in world space; face.normal is
      // object-space and level geometry is rotated (ground plane, etc.)
      if (hit.face) {
        const worldNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        spawnBulletHole(hit.point, worldNormal);
      }
    }
  };

  // Every pellet of this trigger pull leaves from the same PRE-KICK aim
  // point: the recoil below steers only FOLLOWING shots.
  for (let i = 0; i < pellets; i++) fireRay();

  // Recoil/spray kicks are applied once per trigger pull, AFTER the rays:
  // eight pellets must not cost eight kicks.
  wpn.recoil = Math.min(wpn.recoil + def.recoilKick, RECOIL_CAP);
  // Horizontal noise: a signed random walk, so sprays wander sideways
  // unpredictably and have to be steered back rather than just pulled down.
  wpn.recoilYaw = THREE.MathUtils.clamp(
    wpn.recoilYaw + (Math.random() * 2 - 1) * def.yawKick,
    -RECOIL_YAW_CAP, RECOIL_YAW_CAP);
  wpn.spray = Math.min(wpn.spray + def.sprayKick, def.sprayCap);

  // One marker per trigger pull, red if ANY pellet reached a head.
  if (anyHit) showHitmarker(anyHead);
}

/**
 * Per-frame weapon upkeep: recoil/ADS smoothing, FOV zoom toward iron-sight
 * target, reload completion, trigger handling, spread recovery.
 *
 * Stage 2 of the frame, sequenced by main.ts: runs AFTER updateMovement
 * (whose blends feed the spread model) and BEFORE updateCamera /
 * updateViewmodel (which read the recoil this decays).
 */
let triggerLatch = false; // semi-auto edge detector: set on fire, cleared on release

/** Blend rate for ADS position and FOV zoom (1/s); ~12 ≈ 80 ms to settle. */
const ADS_RATE = 12;

export function updateWeapon(dt: number): void {
  // Dead players don't shoot, reload or blend. exitPointerLock() fires
  // pointerlockchange asynchronously, so at least one frame runs with
  // alive === false and locked === true; without this guard a held LMB
  // would spend ammo and could still score a kill from that frame.
  if (!player.alive) return;

  const def = currentDef();

  // Recoil kick decay — rate is per-weapon (the smg resets fast for full-auto,
  // the sniper settles slowly for bolt-action feel; see core/state.ts WEAPONS).
  // The horizontal walk drains at its OWN, much slower rate: it is mean-zero, so
  // a drain sized against the vertical climb outruns it and zeroes the wander
  // before the next shot leaves.
  wpn.recoil = decayRecoil(wpn.recoil, dt, weapon.recoilRecover);
  wpn.recoilYaw = decayToward(wpn.recoilYaw, dt, def.yawRecover);

  // Aiming: blend FOV with adsLerp toward the weapon's current zoom target —
  // the smg has a single iron-sights step; the sniper cycles its wheel-chosen
  // zoomFovs entry. Running adds a +5° speed-feel kick (run and aim are
  // mutually exclusive by the movement precedence rules).
  if (!input.aiming) wpn.zoomLevel = 0; // every re-scope starts at lowest zoom
  const aimFov = aimFovFor(def);
  wpn.adsLerp = approach(wpn.adsLerp, input.aiming ? 1 : 0, dt, ADS_RATE);
  // Sensitivity scales with the actual zoom ratio so tracking at 12x stays
  // usable; main.ts multiplies mouse deltas by this.
  wpn.zoomScale = 1 - (1 - aimFov / BASE_FOV) * wpn.adsLerp;
  const targetFov = BASE_FOV + 5 * motion.runLerp - (BASE_FOV - aimFov) * wpn.adsLerp;
  if (Math.abs(camera.fov - targetFov) > 0.01) {
    camera.fov = approach(camera.fov, targetFov, dt, ADS_RATE);
    camera.updateProjectionMatrix();
  }

  // Viewmodel visibility: registry swap on the equipped weapon; the sniper
  // disappears entirely once the full-screen scope reticle takes over.
  const liveId = equippedId(wpn.slot);
  for (const [id, vm] of Object.entries(VIEWMODELS)) vm.group.visible = id === liveId;
  gunGroup.visible = !(def.scopedOverlay && wpn.adsLerp > 0.85);

  // Scope reticle is DOM (hud.ts); only touch it on state flips.
  setScopeOverlay(def.scopedOverlay && wpn.adsLerp > 0.85);

  // Reload animation: progress through the active reload (0 when idle so
  // the pose resets). Uses game time to match weapon.reloadEnd, so a paused
  // reload freezes mid-animation instead of finishing behind the menu.
  const now = gameTime.now();
  const reloadT = weapon.reloading
    ? THREE.MathUtils.clamp(1 - (weapon.reloadEnd - now) / weapon.reloadTime, 0, 1)
    : 0;
  const liveVm = VIEWMODELS[liveId];
  poseReload(liveVm.group, liveVm.mag, reloadT);

  // Reload finish: top the mag back up from reserve (partial reloads allowed).
  // Range mode: reserve is not deducted — R always restores a full loadout
  // so accuracy/recoil practice never pauses for ammo runs.
  if (weapon.reloading && gameTime.now() >= weapon.reloadEnd) {
    const need = weapon.magSize - weapon.mag;
    const take = Math.min(need, weapon.reserve);
    weapon.mag += take;
    if (session.map !== 'range') weapon.reserve -= take;
    weapon.reloading = false;
  }

  // Trigger: the smg is full-auto while LMB held; semi-autos (sniper) fire
  // once per press — the latch blocks repeats until the button is released.
  if (!input.shooting) triggerLatch = false;
  else if (!def.semiAuto || !triggerLatch) {
    if (gameTime.now() - weapon.lastShot >= weapon.fireRate) {
      shoot();
      if (def.semiAuto) triggerLatch = true;
    }
  }

  // ---- Accuracy model -------------------------------------------------
  // The model itself (and its tuning constants) lives in sim/accuracy.ts;
  // this just feeds it live state. wpn.spread is consumed by shoot(), and the
  // crosshair gap derives from the SAME value, so the arms move with every
  // change in the real cone — deliberately exaggerated by CROSSHAIR_GAIN, so
  // they read as a proportional indicator, not the edge of the group.
  wpn.spread = computeSpread({
    crouchLerp: motion.crouchLerp,
    moveLerp: motion.moveLerp,
    airLerp: motion.airLerp,
    spray: wpn.spray,
    inherent: def.inherent,
    adsMul: input.aiming ? def.spreadMul : 1,
  });
  wpn.spray = decaySpray(wpn.spray, dt, def.sprayRecover);
  setCrosshairGap(crosshairGapPx(wpn.spread, camera.fov, window.innerHeight));
}
