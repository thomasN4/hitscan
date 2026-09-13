// weapons.ts — the player's weapons: viewmodels, firing, reloading,
// weapon switching, iron sights / sniper scope.
//
// Damage model: weapon.damage per torso hit, legs x0.75, head x
// weapon.headshotMult (stats per weapon in core.WEAPONS). Bullets are
// hitscan: a single ray from the camera; the NEAREST intersection across
// walls + bot parts wins, so cover always blocks damage.
import * as THREE from 'three';
import { poseWeapon } from './core/weaponPresentation';
import { weaponPose, crossedCue, shotgunPump, shotgunChambering } from './sim/weaponAnimation';
import type { WeaponAssets } from './core/weaponAssets';
import { createWeaponViewModel, type WeaponViewModel } from './core/weaponModels';
import { scene, camera } from './core/engine';
import { solids } from './world';
import { bots, weapon, session, input, aim, wpn, motion, player, keyHeld, gameTime,
         soundEvents, playerFeet, WEAPONS, ammoStore,
         RECOIL_CAP, RECOIL_YAW_CAP, BASE_FOV,
         equippedId, cancelPendingReloadSfx, effectiveCrouching, freshWeaponAnimation,
         type WeaponDef, type WeaponSlot, type WeaponId, type Bot } from './core/state';
import { sfxShoot, sfxSniper, sfxShotgun, sfxPistol, sfxRevolver, sfxKnife, sfxKnifeHit,
         sfxReload, sfxShell, sfxMechanism, sfxSwitch } from './audio';
import { showHitmarker, setCrosshairGap, setScopeOverlay } from './hud';
import { damageBot } from './combat';
import { spawnImpact, spawnBulletHole } from './effects';
import { GUNSHOT_RADIUS_M } from './sim/soundEvents';
import { botFor } from './bots';
import { computeSpread, crosshairGapPx } from './sim/accuracy';
import { roundInterval, roundTransfer, planReload, cancelsReload } from './sim/ammo';
import {
  aimPitch,
  aimYaw,
  convertOnSwap,
  decayRecoil,
  decaySpray,
  decayToward,
  viewmodelRecoil,
} from './sim/recoil';
import { shotDirection, pelletShotDirection } from './sim/ballistics';
import { damageForPart, partForMesh } from './sim/damage';
import { isBackstab, meleeSwing, type MeleeCandidate } from './sim/melee';
import { isSprintActive } from './sim/movement';
import { isDeploying } from './sim/weaponSwap';
import { approach } from './sim/smoothing';

// The live weapon def. WEAPONS is a Record over the WeaponId union and
// equippedId() resolves the loadout position to an id, so this read cannot
// miss and needs no guard — the type does the work that a named throw used
// to. wpn.zoomLevel is still a plain number, though, so aimFovFor below still
// has a real miss case to decide about.
function currentDef(): WeaponDef {
  return WEAPONS[equippedId(wpn.slot)];
}

/** Live sprint policy shared with player.ts, including stance precedence. */
export function currentSprintActive(crouching: boolean): boolean {
  return isSprintActive({
    sprintHeld: input.running,
    aiming: input.aiming,
    crouching,
    forward: keyHeld('KeyW'),
    backward: keyHeld('KeyS'),
    left: keyHeld('KeyA'),
    right: keyHeld('KeyD'),
  });
}

/** Zoom FOV target for the current zoom level, clamped into range. */
function aimFovFor(def: WeaponDef): number {
  const fov = def.zoomFovs[Math.min(wpn.zoomLevel, def.zoomFovs.length - 1)];
  if (fov === undefined) throw new Error(`${def.name}: empty zoomFovs`);
  return fov;
}

// ---------- Viewmodel ----------
// First-person guns rendered as children of the camera so they inherit the
// view transform. One group per catalog id; visibility follows
// WEAPONS[equippedId(wpn.slot)] every frame via the VIEWMODELS registry.
// Position is animated each frame in
// updateWeapon/updateViewmodel: x/y shift toward center when aiming (adsLerp),
// z/x-rotation kick with recoil, y bobs while moving (bobAmt from player.ts).
// Geometry is built during explicit startup after the weapon assets load.
export const gunGroup = new THREE.Group();

// Models own geometry, sight lines and mechanism assemblies.
// Gameplay continues to own selection, recoil, reload progress and shot aim.
// Read only after initWeaponViewmodels(), like the engine bindings.
let VIEWMODELS: Record<WeaponId, WeaponViewModel>;

/**
 * The equipped weapon's hip→ADS viewmodel delta, for player.ts:updateViewmodel
 * to apply scaled by adsLerp. Same no-miss lookup contract as currentDef().
 */
export function viewmodelAimOffset(): { x: number; y: number; z: number } {
  return VIEWMODELS[equippedId(wpn.slot)].aimOffset;
}

/**
 * Bounded recoil signal for player.ts:updateViewmodel. This is deliberately a
 * separate binding from currentAimPitch(): only the cosmetic weapon transform
 * is reshaped; the camera and shot direction keep using raw recoil.
 */
export function currentViewmodelRecoil(): number {
  const pump = shotgunPump({ id: equippedId(wpn.slot), now: gameTime.now(),
    shotAt: wpn.animation.shotAt, fireInterval: weapon.fireRate, reloading: weapon.reloading });
  return viewmodelRecoil(wpn.recoil, currentDef().recoilKick)
    * shotgunChambering(pump, wpn.adsLerp).recoilScale;
}

// Per-weapon shot sound; keyed by WeaponId so no weapon can miss.
const SHOT_SFX: Record<WeaponId, () => void> = {
  smg: sfxShoot,
  sniper: sfxSniper,
  shotgun: sfxShotgun,
  pistol: sfxPistol,
  revolver: sfxRevolver,
  knife: sfxKnife,
};

const raycaster = new THREE.Raycaster();
const muzzleFlashLight = new THREE.PointLight(0xffdd88, 0, 12);

/**
 * Attach the viewmodel to the camera and the muzzle flash to the scene.
 * Requires initEngine() to have run; call once from main.ts before the loop.
 * `scene.add(camera)` is what makes the camera-parented gun render at all.
 */
export function initWeaponViewmodels(weaponAssets: WeaponAssets): void {
  VIEWMODELS = {
    smg: createWeaponViewModel('smg', weaponAssets),
    sniper: createWeaponViewModel('sniper', weaponAssets),
    shotgun: createWeaponViewModel('shotgun', weaponAssets),
    pistol: createWeaponViewModel('pistol', weaponAssets),
    revolver: createWeaponViewModel('revolver', weaponAssets),
    knife: createWeaponViewModel('knife', weaponAssets),
  };
  for (const model of Object.values(VIEWMODELS)) gunGroup.add(model.group);
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
/** Cancel reload state and any whole-mag completion clicks still pending. */
function cancelReload(): void {
  cancelPendingReloadSfx();
  if (weapon.reloading) {
    wpn.animation.closeAt = gameTime.now();
    wpn.animation.closeBlend = wpn.animation.reloadBlend;
  }
  weapon.reloading = false;
  weapon.reloadEnd = 0;
  weapon.nextRoundAt = 0;
}

/**
 * Start reloading if possible. Bound to R and to firing an empty mag (the
 * dry-fire auto-reload — which is why a reload STARTS while aiming rather
 * than being blocked. Sprint is the deliberate exception: an empty trigger
 * pull is refused and latched until LMB is released.
 *
 * The whole gate lives in sim/ammo.ts:planReload so the Node suite can pin
 * it; this binding only applies the decision. Starting a reload while the
 * sights are up DROPS them (dropAim): one motion at a time, and like
 * unscopeOnShot, clearing input.aiming means a fresh RMB press is needed to
 * re-raise even if the button is still held. A REFUSED reload leaves the aim
 * exactly as it was. The opposite order — sights raised DURING a reload —
 * cancels a gradual (perRound) reload and raises on the same press, keeping
 * every landed shell; for whole-mag reloads it is refused instead (main.ts
 * blocks the fresh RMB press and updateWeapon holds adsLerp at 0), so ADS
 * there is impossible until the reload finishes or sprint/swap cancels it.
 *
 * Whole-mag weapons (no `perRound`): one timer, the mag refills once at
 * reloadEnd. Per-round weapons (shotgun/revolver): reloadTime is spread
 * evenly across the mag — one round transfers every interval, so
 * empty-to-full time is unchanged and the weapon becomes shootable mid-load
 * with whatever has already chambered (see shoot()'s interrupt).
 */
export function tryReload(): void {
  // A blade holds no rounds — R is inert while knifing, before any of the
  // mag guards below could misfire on the knife's zeroed magSize.
  if (currentDef().melee) return;
  // A fresh swap owns the hands for SWAP_DELAY (issue #15): R during the
  // deploy window is ignored rather than starting a reload on the incoming
  // weapon, which would stack two timers' worth of downtime into one.
  if (isDeploying(gameTime.now(), wpn.animation.switchedAt)) return;
  const d = planReload({
    started: session.started,
    alive: player.alive,
    reloading: weapon.reloading,
    mag: weapon.mag,
    magSize: weapon.magSize,
    reserve: weapon.reserve,
    aiming: input.aiming,
    sprinting: currentSprintActive(effectiveCrouching()),
  });
  if (!d.start) return;
  if (d.dropAim) input.aiming = false; // one motion at a time; fresh RMB to re-raise
  cancelPendingReloadSfx();
  wpn.animation.reloadStartedAt = gameTime.now();
  wpn.animation.emptyReload = weapon.mag === 0;
  wpn.animation.closeAt = -Infinity;
  weapon.reloading = true;
  if (currentDef().perRound) {
    weapon.nextRoundAt = gameTime.now() + roundInterval(weapon.reloadTime, weapon.magSize);
    sfxShell(); // tactile feedback on the keypress; each transfer clicks too
  } else {
    weapon.reloadEnd = gameTime.now() + weapon.reloadTime;
    wpn.reloadSfxHandle = sfxReload(weapon.reloadTime);
  }
}

/**
 * Switch to loadout position `slot` (0 primary, 1 secondary). The weapon
 * itself comes from the loadout slice via equippedId. Saves the current
 * mag/reserve back into ammoStore so swaps don't refill mags, copies the new
 * weapon's stats into the live `weapon` object, converts the live recoil/
 * spray state to the incoming weapon's terms, and resets scope zoom. Cancels
 * an in-progress reload CS-style rather than being blocked by one (see below).
 *
 * The swap costs SWAP_DELAY (issue #15): the incoming weapon cannot fire,
 * scope or reload until the deploy window closes, and recoil/spray do not
 * decay while it is not in the hands. A re-swap re-arms the window — the
 * latest press wins, so spamming 1-2-1-Q delays readiness instead of
 * queueing it.
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
  cancelReload();
  wpn.animation = freshWeaponAnimation();
  wpn.animation.switchedAt = gameTime.now();
  wpn.animation.outgoingId = equippedId(wpn.slot);
  // One motion at a time: a swap drops the sights like a reload start does,
  // so a held RMB cannot carry a scope through the deploy window — a fresh
  // press is needed once the weapon is ready (see the main.ts RMB gate).
  input.aiming = false;
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
  // half of the old claim. The fix is the deploy window around this swap
  // (issue #15): firing, scoping and reloading are blocked for SWAP_DELAY,
  // and updateWeapon freezes recoil/spray decay until it closes — without the
  // freeze a longer window would drain MORE, not less.
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
    nextRoundAt: 0,
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
 * One melee swing. No ammo, no cone, no muzzle flash: the strike resolves
 * through sim/melee.ts's range+arc test against every live enemy part
 * (nearest wins; allies are neither struck nor blocking — a stronger cut
 * than the bullets' "allies stop the ray", and deliberate). The kick rides
 * the normal recoil channel for a small camera nod; the successful-shot
 * timestamp separately drives the hand/blade follow-through.
 */
function swingMelee(def: WeaponDef): void {
  weapon.lastShot = gameTime.now();
  wpn.animation.shotAt = weapon.lastShot;
  wpn.animation.previousShotAge = -1;
  wpn.animation.closeAt = -Infinity;
  SHOT_SFX[equippedId(wpn.slot)]();

  const origin = camera.getWorldPosition(new THREE.Vector3());
  // Exact aim direction — spread 0 samples no cone; a swing has none.
  const dir = shotDirection(currentAimPitch(), currentAimYaw(), 0);
  const candidates: MeleeCandidate<Bot>[] = [];
  for (const bot of bots) {
    if (!bot.alive || bot.team === session.playerTeam) continue;
    for (const zone of ['head', 'torso', 'legs'] as const) {
      candidates.push({ payload: bot, zone, at: bot[zone].getWorldPosition(new THREE.Vector3()) });
    }
  }
  // Documented pairing (validateWeapons): range/arcRad exist exactly when melee.
  const hit = meleeSwing(origin, dir, def.range ?? 0, def.arcRad ?? 0, candidates);
  if (hit) {
    sfxKnifeHit();
    showHitmarker(hit.part === 'head');
    // Backstab classification runs ONLY after the range/arc winner is chosen:
    // it scales that hit's ordinary zone damage, it never steers target
    // selection. The bot group's local +Z is its world facing (Bot.update
    // maintains the invariant), and the bearing reads horizontal X/Z only.
    const victimForward = hit.payload.mesh.getWorldDirection(new THREE.Vector3());
    let dmg = damageForPart(weapon, hit.part);
    if (isBackstab(origin, hit.payload.mesh.position, victimForward)) {
      dmg *= def.backstabMult ?? 1; // documented default: absent means no bonus
    }
    damageBot(hit.payload, dmg, hit.part);
  }

  wpn.recoil = Math.min(wpn.recoil + def.recoilKick, RECOIL_CAP);
  wpn.recoilYaw = THREE.MathUtils.clamp(
    wpn.recoilYaw + (Math.random() * 2 - 1) * def.yawKick,
    -RECOIL_YAW_CAP, RECOIL_YAW_CAP);
  wpn.spray = Math.min(wpn.spray + def.sprayKick, def.sprayCap);
}

/**
 * Fire one shot (one trigger pull): consume ammo, kick recoil and spray, then
 * hitscan. A weapon with `pellets` fires that many independent rays, each
 * sampled in the live spread cone — the shotgun's wide kill/no-kill falloff
 * IS that sampling. Nearest hit across solids + live bot parts decides each
 * ray's outcome — bot hit -> damage by zone, wall hit -> impact puff only.
 */
export function shoot(): void {
  // Deploying hands hold no weapon to fire (issue #15): a trigger pull inside
  // the swap window is dropped, not queued — the updateWeapon trigger gate
  // keeps pacing it every frame until the window closes.
  if (isDeploying(gameTime.now(), wpn.animation.switchedAt)) return;
  const def = currentDef();
  // A blade swings instead of firing: nothing to spend, nothing to cancel,
  // nothing to flash. updateWeapon's trigger gate already paced this against
  // the swing cadence.
  if (def.melee) {
    swingMelee(def);
    return;
  }
  // Per-round reloads are INTERRUPTIBLE CS-style: a trigger pull cancels the
  // remaining shells/chambers and fires whatever has already transferred.
  // Whole-mag weapons keep the hard block — no rounds exist until the timer
  // completes, so there is nothing to fire out of.
  if (weapon.reloading && def.perRound && weapon.mag > 0) {
    cancelReload();
  }
  if (weapon.reloading || weapon.mag <= 0) {
    if (weapon.mag <= 0 && !wpn.emptyReloadLatch) {
      // A refused held-LMB request is ONE attempt, not a queue that should
      // spring open as soon as sprint ends. Release LMB before trying again.
      if (currentSprintActive(effectiveCrouching())) wpn.emptyReloadLatch = true;
      else tryReload(); // auto-reload on a fresh dry-fire attempt
    }
    return;
  }
  weapon.mag--;
  weapon.lastShot = gameTime.now();
  wpn.animation.shotAt = weapon.lastShot;
  wpn.animation.previousShotAge = -1;
  wpn.animation.closeAt = -Infinity;
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
  // The gameplay half of the noise: ONE event per trigger pull, whatever the
  // weapon. Everything that must stay silent has already returned above — a
  // melee swing, a dry trigger, a blocked whole-mag reload — and a shotgun's
  // pellets are one pull, so this sits before the pellet loop rather than
  // inside it. Bots read it through core/state.ts:soundEvents; the audible
  // SHOT_SFX above is untouched and unrelated.
  //
  // FEET, not the eye `origin` the rays leave from. A heard position is a
  // place to walk to, and navGrid.ts:nearestNode weights a metre of height
  // like four of ground — so an eye-height goal snaps to the deck ABOVE the
  // shooter wherever one exists. 1.7 m makes no difference to an 80 m radius
  // and all the difference to the route.
  soundEvents.emit({
    kind: 'gunshot',
    sourceId: 'player',
    team: session.playerTeam,
    pos: playerFeet(player),
    radius: GUNSHOT_RADIUS_M,
    t: gameTime.now(),
  });

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
    // Pellet weapons sample TWO layers: the live situational cone plus the
    // weapon's fixed pattern (pelletCone), so ADS/crouch steer the pattern's
    // center without shrinking it.
    const pitch = currentAimPitch();
    const yaw = currentAimYaw();
    const dir = def.pelletCone !== undefined
      ? pelletShotDirection(pitch, yaw, wpn.spread, def.pelletCone)
      : shotDirection(pitch, yaw, wpn.spread);
    raycaster.set(origin, dir);
    raycaster.far = 200;
    const hits = raycaster.intersectObjects(targets, false);
    if (hits.length === 0) return;
    // length checked above; the assertion only records that fact
    const hit = hits[0]!;
    const bot = botFor(hit.object); // stamped onto each part in Bot's constructor
    if (bot && bot.team === session.playerTeam) {
      // Friendly fire is OFF: ally bodies stop the bullet (visible impact,
      // no hitmarker, no damage) but never bleed the ally's score.
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
        spawnBulletHole(hit.point, worldNormal, hit.object);
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
/** Blend rate for ADS position and FOV zoom (1/s); ~12 ≈ 80 ms to settle. */
const ADS_RATE = 12;

export function updateWeapon(dt: number): void {
  // Dead players don't shoot, reload or blend. exitPointerLock() fires
  // pointerlockchange asynchronously, so at least one frame runs with
  // alive === false and locked === true; without this guard a held LMB
  // would spend ammo and could still score a kill from that frame.
  if (!player.alive) return;

  const def = currentDef();

  // Sprinting always wins when it begins during a reload; aiming wins only for
  // gradual (perRound) reloads, where the landed shells stay live — the mirror
  // of tryReload's dropAim, and the same one-motion-at-a-time rule seen from
  // the order where nothing presses R. Run this before animation or
  // transfer/completion so the cancel frame cannot sneak in one last round.
  // Whole-mag reloads refuse RMB upstream instead (see the main.ts gate and
  // the aiming blend below), so the sights can never rise mid-reload there.
  // The cancel lands before the blend, so a per-round cancel raises the
  // sights on this same frame.
  if (cancelsReload({
    reloading: weapon.reloading,
    sprinting: currentSprintActive(effectiveCrouching()),
    aiming: input.aiming,
    perRound: def.perRound ?? false, // documented default: whole-mag unless marked
  })) {
    cancelReload();
  }

  // Recoil kick decay — rate is per-weapon (the smg resets fast for full-auto,
  // the sniper settles slowly for bolt-action feel; see core/state.ts WEAPONS).
  // The horizontal walk drains at its OWN, much slower rate: it is mean-zero, so
  // a drain sized against the vertical climb outruns it and zeroes the wander
  // before the next shot leaves.
  //
  // Frozen while deploying (issue #15): the incoming weapon is not in the
  // hands yet, so nothing about it may settle. This is the half of the 1-2-1
  // fix the fire gate alone cannot do — the sniper drains a converted smg
  // climb in 0.277 s, inside SWAP_DELAY, so decaying through the window would
  // still refund the climb, only slower-looking.
  const deploying = isDeploying(gameTime.now(), wpn.animation.switchedAt);
  if (!deploying) {
    wpn.recoil = decayRecoil(wpn.recoil, dt, weapon.recoilRecover);
    wpn.recoilYaw = decayToward(wpn.recoilYaw, dt, def.yawRecover);
  }

  // Aiming: blend FOV with adsLerp toward the weapon's current zoom target —
  // the smg has a single iron-sights step; the sniper cycles its wheel-chosen
  // zoomFovs entry. Running adds a +5° speed-feel kick (run and aim are
  // mutually exclusive by the movement precedence rules). RMB is inert while
  // a melee def is held — there is no sight line to raise — while deploying,
  // so the sights cannot rise out of the draw animation, and while a
  // whole-mag reload is running, so ADS is impossible there until the reload
  // finishes or is cancelled. Gradual (perRound) reloads are the exception:
  // RMB cancels them above, so by this line there is no reload left to block.
  const aiming = input.aiming && !def.melee && !deploying && !(weapon.reloading && !def.perRound);
  if (!aiming) wpn.zoomLevel = 0; // every re-scope starts at lowest zoom
  const aimFov = aimFovFor(def);
  wpn.adsLerp = approach(wpn.adsLerp, aiming ? 1 : 0, dt, ADS_RATE);
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

  // Reload progress. Whole-mag: nothing moves until reloadEnd, then the mag
  // tops up at once (partial reloads allowed). Per-round: one transfer per
  // interval until full or dry — every landed round is immediately live ammo,
  // because shoot() cancels the remainder on the next trigger pull.
  // Range mode: reserve is not deducted under EITHER model — R always restores
  // a full loadout so accuracy/recoil practice never pauses for ammo runs.
  if (weapon.reloading && def.perRound) {
    const interval = roundInterval(weapon.reloadTime, weapon.magSize);
    // A bottomless pool stands in for the reserve on the range, where the
    // reserve is never touched: done is then decided by the full mag alone.
    const pool = session.map === 'range' ? Number.MAX_SAFE_INTEGER : weapon.reserve;
    let transferred = false;
    let done = false;
    while (!done && gameTime.now() >= weapon.nextRoundAt) {
      const t = roundTransfer(weapon.mag, weapon.magSize, pool);
      weapon.mag = t.mag;
      if (session.map !== 'range') weapon.reserve = t.reserve;
      weapon.nextRoundAt += interval;
      transferred = true;
      done = t.done;
    }
    if (transferred) sfxShell(); // one click per frame-batch, not per shell
    if (done) {
      weapon.reloading = false;
      weapon.nextRoundAt = 0;
    }
  } else if (weapon.reloading && gameTime.now() >= weapon.reloadEnd) {
    const need = weapon.magSize - weapon.mag;
    const take = Math.min(need, weapon.reserve);
    weapon.mag += take;
    if (session.map !== 'range') weapon.reserve -= take;
    weapon.reloading = false;
    wpn.reloadSfxHandle = undefined;
  }

  // Trigger: the smg is full-auto while LMB held; single-press weapons fire
  // once per press — the latch blocks repeats until the button is released.
  if (!input.shooting) {
    wpn.triggerLatch = false;
    wpn.emptyReloadLatch = false;
  }
  else if (!def.semiAuto || !wpn.triggerLatch) {
    if (gameTime.now() - weapon.lastShot >= weapon.fireRate) {
      shoot();
      if (def.semiAuto) wpn.triggerLatch = true;
    }
  }

  updateWeaponPresentation();

  // ---- Accuracy model -------------------------------------------------
  // The model itself (and its tuning constants) lives in sim/accuracy.ts;
  // this just feeds it live state. wpn.spread is consumed by shoot(), and the
  // crosshair gap derives from the SAME value, so the arms move with every
  // change in the real cone — exaggerated by the weapon's crosshair gain
  // (CROSSHAIR_GAIN unless the def overrides; the shotgun draws its literal
  // bound), so they read as a proportional indicator, not the edge of the
  // group.
  wpn.spread = computeSpread({
    crouchLerp: motion.crouchLerp,
    moveLerp: motion.moveLerp,
    airLerp: motion.airLerp,
    spray: wpn.spray,
    inherent: def.inherent,
    adsMul: aiming ? def.spreadMul : 1,
  });
  // Same freeze as the recoil decay above: spray is carried across the swap by
  // convertOnSwap, and draining it through the window would re-clamp the cone
  // for free (issue #15).
  if (!deploying) wpn.spray = decaySpray(wpn.spray, dt, def.sprayRecover);
  // The crosshair must be honest about where shots land: for pellet weapons
  // that is the situational cone PLUS the fixed pattern (pelletCone) — their
  // per-axis sum is the true outer bound of a pellet's deflection.
  const displaySpread = wpn.spread + (def.pelletCone ?? 0); // documented default: no pattern
  setCrosshairGap(crosshairGapPx(displaySpread, camera.fov, window.innerHeight, def.crosshairGain));
}

/** Render after this frame's transfers and trigger, preserving the main stage order. */
function updateWeaponPresentation(): void {
  const def = currentDef();
  const id = equippedId(wpn.slot);
  const now = gameTime.now();
  const animation = wpn.animation;
  const interval = def.perRound ? roundInterval(weapon.reloadTime, weapon.magSize) : weapon.reloadTime;
  const reloadT = weapon.reloading
    ? 1 - THREE.MathUtils.clamp(((def.perRound ? weapon.nextRoundAt : weapon.reloadEnd) - now) / interval, 0, 1) : 0;
  const pose = weaponPose({ id, now, shotAt: animation.shotAt, fireInterval: weapon.fireRate,
    switchedAt: animation.switchedAt, hasOutgoing: animation.outgoingId !== null, aiming: input.aiming || wpn.adsLerp > 0.01,
    reloading: weapon.reloading, reloadStartedAt: animation.reloadStartedAt, reloadT,
    roundInterval: interval, lastRound: weapon.mag + 1 >= weapon.magSize || session.map !== 'range' && weapon.reserve === 1,
    emptyReload: animation.emptyReload, closeAt: animation.closeAt, closeBlend: animation.closeBlend });
  animation.reloadBlend = pose.reload;
  poseWeapon(VIEWMODELS[id], id, pose, now, wpn.adsLerp, motion.runLerp);
  if (pose.holster && animation.outgoingId !== null && animation.outgoingId !== id) {
    VIEWMODELS[id].group.visible = false;
    const outgoing = VIEWMODELS[animation.outgoingId];
    outgoing.group.visible = true;
    poseWeapon(outgoing, animation.outgoingId, { ...pose, draw: pose.holsterDrop }, now, 0, motion.runLerp);
  }
  const shotAge = now - animation.shotAt;
  if (!weapon.reloading && (id === 'shotgun' || id === 'sniper')) {
    for (const threshold of [0.30, 0.76]) {
      if (crossedCue(animation.previousShotAge, shotAge, weapon.fireRate * threshold)) sfxMechanism();
    }
  }
  animation.previousShotAge = shotAge;
}
