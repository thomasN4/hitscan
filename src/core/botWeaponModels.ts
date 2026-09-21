// Bot-held weapon rigs: third-person mounts of the SAME authored GLB assets
// the player's viewmodels are built from (core/weaponAssets.ts).
//
// This module is the seam that lets bots.ts hold real models without the
// problems the old procedural silhouettes existed to dodge: the camera-space
// offsets live in core/weaponModels.ts's viewmodel wrapper, which is never
// touched here — only the asset-space rig (root/grip/muzzle/mechanisms) is
// cloned — and weapons.ts already imports bots.ts (botFor), so bots.ts
// reaches the assets through THIS module instead of importing back.
//
// Coordinates are metres, matching the sources: authored forward is -Z while
// the bot aim hinge fires down +Z, so each mount counter-rotates its rig half
// a turn and seats grip_right on the hinge. Scale is exactly 1:1 — the same
// model in both hands, no readability fudge factor.
//
// Mechanism animation is cosmetic and third-person only: a firing kick that
// decays after each shot, and a reload displacement (magazine toward its
// authored extraction marker, revolver cylinder swung out) that follows a
// caller-smoothed blend. Ammo timing stays in the brain's fire controller;
// this only poses nodes. ADS/run/draw/holster group motion from
// core/weaponPresentation.ts is first-person and deliberately not mirrored.
import * as THREE from 'three';
import { createAuthoredWeaponRig, type AuthoredWeaponRig, type WeaponAssets } from './weaponAssets';
import type { BotWeaponId } from './state';

/** Loaded once at startup; every bot clones out of it (clone shares geometry/materials). */
let assets: WeaponAssets | null = null;

/**
 * Store the loaded weapon assets for bot mounts. Call once from main.ts
 * before spawnBots — constructing a rig earlier is a named startup error,
 * the same loudness as the player path failing to load.
 */
export function initBotWeaponModels(loaded: WeaponAssets): void {
  assets = loaded;
}

export interface BotWeaponRig {
  /** Added to the bot's aim hinge; owns the adapted pose. Identity at rest. */
  mount: THREE.Group;
  /** Authored muzzle marker, for the muzzle flash — null on the knife. */
  muzzle: THREE.Object3D | null;
  /** Firing/reloading nodes, renamed for scene queries (see below). */
  mechanisms: AuthoredWeaponRig['mechanisms'];
  /** Rest pose of every mechanism node, for absolute (non-accumulating) posing. */
  rest: Map<THREE.Object3D, { position: THREE.Vector3; rotation: THREE.Euler }>;
  /** Extraction marker for the reload displacement; set exactly when mechanisms.magazine is. */
  magazineOut: THREE.Object3D | undefined;
  /** Loading port, the reload displacement's fixed end; same pairing. */
  port: THREE.Object3D | undefined;
}

/**
 * Build a fresh third-person rig; the caller owns it for the bot's life (or
 * until the next dry swap rebuilds it). Throws when initBotWeaponModels()
 * has not run — a bot constructed before startup finished is corrupted
 * state, not a fallback case.
 */
export function createBotWeaponRig(id: BotWeaponId): BotWeaponRig {
  if (!assets) {
    throw new Error('Bot weapons: initBotWeaponModels() must run before spawnBots (main.ts startup order)');
  }
  const authored = createAuthoredWeaponRig(id, assets[id]);
  const mount = new THREE.Group();
  mount.name = `bot-weapon-${id}`;
  const tilt = new THREE.Group();
  // Authored forward (-Z) onto the hinge's forward (+Z).
  tilt.rotation.y = Math.PI;
  mount.add(tilt);
  tilt.add(authored.root);
  // Seat the grip on the hinge: shift the root so grip_right lands on the
  // mount origin. Done through composed matrices rather than grip.position,
  // which is only root-local when the grip is a direct child (the shotgun's
  // grip is not constrained to be one). The root itself is an identity
  // transform, so shifting it by the grip's tilt-space offset lands the grip
  // exactly on the origin whatever its nesting depth.
  mount.updateMatrixWorld(true);
  const gripLocal = tilt.worldToLocal(authored.grip.getWorldPosition(new THREE.Vector3()));
  authored.root.position.sub(gripLocal);
  // Full-length stocks extend behind the grip and would poke out through the
  // bot's back, so slide the seated gun forward until its rear clears the
  // torso. Measured, not tabulated: the bounding box adapts per model, and
  // short weapons (sidearms, blade) already clear the limit and stay exactly
  // grip-seated. The mount is still detached and identity here, so the
  // world-space box reads directly in mount coordinates.
  mount.updateMatrixWorld(true);
  const rear = new THREE.Box3().setFromObject(authored.root).min.z;
  if (rear < STOCK_REAR_LIMIT) {
    // Tilt-space -Z is mount-space +Z (the half-turn flips x and z), so
    // decreasing the root's tilt-space z walks the gun forward. Markers
    // (muzzle, magazine path) ride along as children, staying consistent.
    authored.root.position.z -= STOCK_REAR_LIMIT - rear;
    mount.updateMatrixWorld(true);
  }
  authored.root.updateMatrixWorld(true);
  const mechanisms: BotWeaponRig['mechanisms'] = { ...authored.mechanisms };
  const rest: BotWeaponRig['rest'] = new Map();
  for (const [key, node] of Object.entries(mechanisms)) {
    // Distinct from the viewmodel's `weapon-mechanism-*`: scene queries
    // address one or the other, never both.
    node.name = `bot-weapon-mechanism-${key}`;
    rest.set(node, { position: node.position.clone(), rotation: node.rotation.clone() });
  }
  // No shadow casting from the guns: the bot bodies already ground them
  // visually, and every caster is re-rasterized into the shadow map each
  // frame — ~10 detailed meshes per bot cratered CPU-rasterizer throughput 4x
  // in the 13-bot arena (7.7 vs 33.5 fps), starving the game-time-bound smoke
  // phases. Matches the first-person viewmodels, which never cast either.
  mount.traverse(node => {
    if (node instanceof THREE.Mesh) node.castShadow = false;
  });
  return { mount, muzzle: authored.muzzle ?? null, mechanisms, rest,
    magazineOut: authored.magazineOut, port: authored.port };
}

/** Decay rate (1/s) of the firing kick — snappy enough to read per shot. */
const SHOT_KICK_RATE = 9;

/**
 * Rear-most mount-space z any held gun may occupy. The hinge sits at the
 * torso's centre plane and the torso is 0.4 deep, so a stock ending here
 * stays inside the body instead of poking out of the back.
 */
const STOCK_REAR_LIMIT = -0.05;

/**
 * Lateral magnitude (m) of the aim-hinge offset from the torso centre.
 * The bot faces local +Z, so in right-handed Y-up coordinates its right
 * shoulder sits at -X: a right-handed bot holds its gun at -OFFSET.
 */
export const BOT_SHOULDER_OFFSET = 0.16;

/** Probability a bot holds its weapon on the right shoulder (~9:1 split). */
export const BOT_RIGHT_HANDED_PROBABILITY = 0.9;

/**
 * Pick this bot's hinge-side offset. Rolled once per bot at construction —
 * handedness is identity, not per-life state — with the rng passed in so
 * the Node suite can pin the boundary without touching Math.random.
 */
export function pickBotShoulderOffset(rng: () => number): number {
  return rng() < BOT_RIGHT_HANDED_PROBABILITY ? -BOT_SHOULDER_OFFSET : BOT_SHOULDER_OFFSET;
}

/**
 * Firing-kick envelope for a shot `shotAge` seconds ago: 1 on the firing
 * frame, decaying to ~0 within half a second. Non-finite ages (no shot yet)
 * kick nothing.
 */
export function botShotKick(shotAge: number): number {
  return Number.isFinite(shotAge) ? Math.exp(-shotAge * SHOT_KICK_RATE) : 0;
}

/**
 * Pose a rig for this frame: restore every mechanism to rest, then apply the
 * firing kick and the reload displacement. Absolute offsets every frame, so
 * a missed call cannot accumulate a drift.
 *
 * Amplitudes mirror the first-person ones in core/weaponPresentation.ts
 * (slide/pump travel, bolt lift+pull, hammer swing, cylinder swing-out) —
 * same model, same motion language, seen from the other side.
 */
export function poseBotWeaponRig(
  rig: BotWeaponRig,
  pose: { shotAge: number; reloadBlend: number },
): void {
  for (const [node, r] of rig.rest) {
    node.position.copy(r.position);
    node.rotation.copy(r.rotation);
  }
  const m = rig.mechanisms;
  if (m.hinge) m.hinge.rotation.x -= Math.PI / 5 * pose.reloadBlend;
  const kick = botShotKick(pose.shotAge);
  if (kick > 0.001) {
    if (m.slide) m.slide.position.z += 0.045 * kick;
    if (m.bolt) {
      m.bolt.rotation.z += 1.15 * kick;
      m.bolt.position.z += 0.105 * kick;
    }
    if (m.pump) m.pump.position.z += 0.095 * kick;
    if (m.hammer) m.hammer.rotation.x += 0.5 * kick;
  }
  // Documented pairing (weaponAssets.ts): magazineOut/port exist exactly when
  // mechanisms.magazine does (pistol/smg/ak47/sniper). The shotgun feeds its tube
  // and the revolver its swung-out cylinder, so neither displaces a magazine.
  if (pose.reloadBlend > 0.001 && m.magazine && rig.magazineOut && rig.port) {
    const magazine = m.magazine;
    const parent = magazine.parent;
    const restPose = rig.rest.get(magazine);
    // All three markers are validated onto the root, but only directions are
    // read through the world matrices — rigid ancestors (hinge pitch, mesh
    // yaw, the mount's own half-turn) rotate the travel without scaling it.
    if (parent && restPose) {
      const travel = rig.magazineOut.getWorldPosition(new THREE.Vector3())
        .sub(rig.port.getWorldPosition(new THREE.Vector3()));
      const parentQuat = parent.getWorldQuaternion(new THREE.Quaternion()).invert();
      magazine.position.copy(restPose.position)
        .addScaledVector(travel.applyQuaternion(parentQuat), pose.reloadBlend);
    }
  }
  if (pose.reloadBlend > 0.001 && m.cylinder) {
    m.cylinder.rotation.z += 1.60 * pose.reloadBlend;
  }
}
