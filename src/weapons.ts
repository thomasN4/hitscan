// weapons.ts — the player's weapons: viewmodels, firing, reloading,
// weapon switching, iron sights / sniper scope.
//
// Damage model: weapon.damage per torso hit, legs x0.75, head x
// weapon.headshotMult (stats per weapon in core.WEAPONS). Bullets are
// hitscan: a single ray from the camera; the NEAREST intersection across
// walls + bot parts wins, so cover always blocks damage.
import * as THREE from 'three';
import { scene, camera, clock } from './core/engine';
import { solids } from './world';
import { bots, weapon, game, player, WEAPONS, ammoStore,
         RECOIL_CAP, RECOIL_YAW_CAP, BASE_FOV,
         type WeaponDef, type WeaponSlot } from './core/state';
import { sfxShoot, sfxSniper, sfxReload, sfxSwitch } from './audio';
import { showHitmarker, setCrosshairGap, setScopeOverlay } from './hud';
import { damageBot } from './combat';
import { spawnImpact, spawnBulletHole } from './effects';
import { botFor } from './bots';
import { computeSpread, crosshairGapPx } from './sim/accuracy';
import { aimPitch, aimYaw, convertOnSwap, decayRecoil, decaySpray, decayToward } from './sim/recoil';
import { shotDirection } from './sim/ballistics';
import { damageForPart, partForMesh } from './sim/damage';
import { approach } from './sim/smoothing';

// The live weapon def. WEAPONS is a tuple and game.slot is WeaponSlot, so
// this read cannot miss and needs no guard — the type does the work that a
// named throw used to. game.zoomLevel is still a plain number, though, so
// aimFovFor below still has a real miss case to decide about.
function currentDef(): WeaponDef {
  return WEAPONS[game.slot];
}

/** Zoom FOV target for the current zoom level, clamped into range. */
function aimFovFor(def: WeaponDef): number {
  const fov = def.zoomFovs[Math.min(game.zoomLevel, def.zoomFovs.length - 1)];
  if (fov === undefined) throw new Error(`${def.name}: empty zoomFovs`);
  return fov;
}

/** The ONE read of `userData.baseY`, stamped on each viewmodel magazine below. */
function magBaseY(mag: THREE.Mesh): number {
  return mag.userData.baseY as number;
}

// ---------- Viewmodel ----------
// First-person guns rendered as children of the camera so they inherit the
// view transform. One group per slot (smg / sniper); visibility follows
// game.slot every frame. Position is animated each frame in
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

gunGroup.add(smgGroup, sniperGroup);

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
  return aimPitch(game.pitch, game.recoil, currentDef().punchRad);
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
  return aimYaw(game.yaw, game.recoilYaw, currentDef().punchRad);
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
  if (!game.started || !player.alive || weapon.reloading || weapon.mag === weapon.magSize || weapon.reserve <= 0) return;
  weapon.reloading = true;
  weapon.reloadEnd = performance.now() / 1000 + weapon.reloadTime;
  sfxReload();
}

/**
 * Switch to slot `slot` (0 smg, 1 sniper). Saves the current mag/reserve
 * back into ammoStore so mugs don't refill on swap, copies the new slot's
 * stats into the live `weapon` object, converts the live recoil/spray state to
 * the incoming weapon's terms, and resets scope zoom. Blocked while reloading
 * to avoid mid-mag-swap state corruption.
 */
export function switchWeapon(slot: WeaponSlot): void {
  if (slot === game.slot || !game.started || !player.alive || weapon.reloading) return;
  const saved = ammoStore[game.slot];
  const loaded = ammoStore[slot];
  saved.mag = weapon.mag;
  saved.reserve = weapon.reserve;

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
  const incoming = WEAPONS[slot];
  const converted = convertOnSwap(game, outgoing, incoming,
    { recoil: RECOIL_CAP, recoilYaw: RECOIL_YAW_CAP });
  game.recoil = converted.recoil;
  game.recoilYaw = converted.recoilYaw;
  game.spray = converted.spray;

  game.slot = slot;
  game.zoomLevel = 0; // always re-enter the scope at its lowest step
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
 * Fire one shot: consume ammo, kick recoil and spray, then hitscan.
 * The spread cone widens with consecutive fire (via the `game.spray`
 * multiplier) and shrinks to the weapon's spreadMul while aiming. Nearest hit across solids + live
 * bot parts decides the outcome — bot hit -> damage by zone, wall hit ->
 * impact puff only.
 */
export function shoot(): void {
  if (weapon.reloading || weapon.mag <= 0) {
    if (weapon.mag <= 0) tryReload(); // auto-reload on dry fire
    return;
  }
  weapon.mag--;
  weapon.lastShot = clock.elapsedTime;
  const def = currentDef();

  muzzleFlashLight.intensity = 3;
  setTimeout(() => muzzleFlashLight.intensity = 0, 50);
  (game.slot === 1 ? sfxSniper : sfxShoot)();

  // Bolt-action feel: firing kicks you out of the scope. Clearing
  // game.aiming means a fresh RMB press is needed to re-scope even if the
  // button is still held (mouseup will just re-clear it harmlessly).
  if (def.unscopeOnShot) game.aiming = false;

  // Euler order and cone sampling live in sim/ballistics.ts; pitch and yaw
  // both carry their recoil punch, so shots follow exactly what the camera
  // shows — vertically via currentAimPitch, horizontally via currentAimYaw.
  const dir = shotDirection(currentAimPitch(), currentAimYaw(), game.spread);

  // Recoil/spray kicks are applied only AFTER this shot's ray is built:
  // a bullet leaves from the pre-kick aim point (first round is dead-on),
  // and its own kick steers the FOLLOWING shots.
  game.recoil = Math.min(game.recoil + def.recoilKick, RECOIL_CAP);
  // Horizontal noise: a signed random walk, so sprays wander sideways
  // unpredictably and have to be steered back rather than just pulled down.
  game.recoilYaw = THREE.MathUtils.clamp(
    game.recoilYaw + (Math.random() * 2 - 1) * def.yawKick,
    -RECOIL_YAW_CAP, RECOIL_YAW_CAP);
  game.spray = Math.min(game.spray + def.sprayKick, def.sprayCap);

  raycaster.set(camera.getWorldPosition(new THREE.Vector3()), dir);
  raycaster.far = 200;

  // Gather every solid (walls, crates, ground) plus live bot parts,
  // then take the single closest intersection — walls block bullets.
  const targets: THREE.Object3D[] = [...solids];
  for (const bot of bots) {
    if (!bot.alive) continue;
    targets.push(bot.head, bot.torso, bot.legs);
  }
  const hits = raycaster.intersectObjects(targets, false);
  if (hits.length > 0) {
    // length checked above; the assertion only records that fact
    const hit = hits[0]!;
    const bot = botFor(hit.object); // stamped onto each part in Bot's constructor
    if (bot) {
      const part = partForMesh(bot, hit.object);
      showHitmarker(part === 'head');
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
  }
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
  game.recoil = decayRecoil(game.recoil, dt, weapon.recoilRecover);
  game.recoilYaw = decayToward(game.recoilYaw, dt, def.yawRecover);

  // Aiming: blend FOV with adsLerp toward the weapon's current zoom target —
  // the smg has a single iron-sights step; the sniper cycles its wheel-chosen
  // zoomFovs entry. Running adds a +5° speed-feel kick (run and aim are
  // mutually exclusive by the movement precedence rules).
  if (!game.aiming) game.zoomLevel = 0; // every re-scope starts at lowest zoom
  const aimFov = aimFovFor(def);
  game.adsLerp = approach(game.adsLerp, game.aiming ? 1 : 0, dt, ADS_RATE);
  // Sensitivity scales with the actual zoom ratio so tracking at 12x stays
  // usable; main.ts multiplies mouse deltas by this.
  game.zoomScale = 1 - (1 - aimFov / BASE_FOV) * game.adsLerp;
  const targetFov = BASE_FOV + 5 * game.runLerp - (BASE_FOV - aimFov) * game.adsLerp;
  if (Math.abs(camera.fov - targetFov) > 0.01) {
    camera.fov = approach(camera.fov, targetFov, dt, ADS_RATE);
    camera.updateProjectionMatrix();
  }

  // Viewmodel visibility: per-slot group swap; the sniper disappears
  // entirely once the full-screen scope reticle takes over.
  smgGroup.visible = game.slot === 0;
  sniperGroup.visible = game.slot === 1;
  gunGroup.visible = !(def.scopedOverlay && game.adsLerp > 0.85);

  // Scope reticle is DOM (hud.ts); only touch it on state flips.
  setScopeOverlay(def.scopedOverlay && game.adsLerp > 0.85);

  // Reload animation: progress through the active reload (0 when idle so
  // the pose resets). Uses wall-clock time to match weapon.reloadEnd.
  const nowS = performance.now() / 1000;
  const reloadT = weapon.reloading
    ? THREE.MathUtils.clamp(1 - (weapon.reloadEnd - nowS) / weapon.reloadTime, 0, 1)
    : 0;
  if (game.slot === 0) poseReload(smgGroup, smgMag, reloadT);
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

  // Trigger: the smg is full-auto while LMB held; semi-autos (sniper) fire
  // once per press — the latch blocks repeats until the button is released.
  if (!game.shooting) triggerLatch = false;
  else if (!def.semiAuto || !triggerLatch) {
    if (clock.elapsedTime - weapon.lastShot >= weapon.fireRate) {
      shoot();
      if (def.semiAuto) triggerLatch = true;
    }
  }

  // ---- Accuracy model -------------------------------------------------
  // The model itself (and its tuning constants) lives in sim/accuracy.ts;
  // this just feeds it live state. game.spread is consumed by shoot(), and the
  // crosshair gap derives from the SAME value, so the arms move with every
  // change in the real cone — deliberately exaggerated by CROSSHAIR_GAIN, so
  // they read as a proportional indicator, not the edge of the group.
  game.spread = computeSpread({
    crouchLerp: game.crouchLerp,
    moveLerp: game.moveLerp,
    airLerp: game.airLerp,
    spray: game.spray,
    inherent: def.inherent,
    adsMul: game.aiming ? def.spreadMul : 1,
  });
  game.spray = decaySpray(game.spray, dt, def.sprayRecover);
  setCrosshairGap(crosshairGapPx(game.spread, camera.fov, window.innerHeight));
}
