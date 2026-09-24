// arrows.ts — loosed longbow arrows: flight, hits, and the ones left standing
// in the scenery.
//
// Unlike a bullet, an arrow is an entity: it leaves the eye along the
// crosshair (weapons.ts:looseArrow) and then flies under sim/arrow.ts's
// gravity and drag, one frame at a time. Its hit test sweeps the same target
// set shoot() rays against — every solid plus live bot parts, nearest wins —
// so cover stops arrows exactly as it stops bullets, and ally bodies stop them
// without harm.
import * as THREE from 'three';
import { scene } from './core/engine';
import { arrows, stuckArrows, bots, session, WEAPONS, type Arrow, type Bot } from './core/state';
import { createArrowModel } from './core/arrowModel';
import { solids } from './world';
import { botFor } from './bots';
import { damageBot } from './combat';
import { showHitmarker } from './hud';
import { sfxArrowHit } from './audio';
import { advanceArrow, ARROW_MAX_AGE, type SegmentHit } from './sim/arrow';
import { arrowDamage } from './sim/bow';
import { damageForPart, partForMesh } from './sim/damage';

/** Arrows left standing in walls and floors before the oldest is cleared. */
const MAX_STUCK = 40;
/** How deep (m) a stopped arrow buries its point: the head and a little shaft. */
const PENETRATION = 0.07;
/** Seconds over which the drawn arrow settles from the bow onto its true line. */
const LAUNCH_SETTLE = 0.12;
/**
 * Seconds of past flight the trail shows. An arrow seen from behind is a
 * couple of pixels of fletching within a few metres; the trail is what lets
 * the archer read the arc and where it went.
 */
const TRAIL_SECONDS = 0.3;
/** Anything that has fallen this far below the map is gone. */
const FLOOR_Y = -50;

// Dark rather than white: both the sky and the sand are pale here.
const trailMaterial = new THREE.LineBasicMaterial({ color: 0x2a221c, transparent: true, opacity: 0.6 });
const raycaster = new THREE.Raycaster();
const direction = new THREE.Vector3();
const FORWARD = new THREE.Vector3(0, 0, -1);

/** What an arrow struck: a bot part (bot set) or scenery (bot null). */
interface Struck { bot: Bot | null; object: THREE.Object3D }

/**
 * Loose an arrow: `origin` is the eye, `velocity` its launch velocity, and
 * `drawnFrom` where the viewmodel's nocked arrow tip was, so the mesh can be
 * seen to leave the bow before it joins the flight line.
 */
export function spawnArrow(origin: THREE.Vector3, velocity: THREE.Vector3, drawnFrom: THREE.Vector3): void {
  const mesh = createArrowModel();
  scene.add(mesh);
  const trailLine = new THREE.Line(new THREE.BufferGeometry(), trailMaterial);
  trailLine.frustumCulled = false;
  scene.add(trailLine);
  const arrow: Arrow = {
    pos: origin.clone(), vel: velocity.clone(), age: 0, mesh,
    launchOffset: drawnFrom.clone().sub(origin),
    trail: [], trailLine,
  };
  arrows.push(arrow);
  placeMesh(arrow);
}

/** Draw the arrow along its velocity, easing the launch offset away. */
function placeMesh(arrow: Arrow): void {
  const settle = Math.max(0, 1 - arrow.age / LAUNCH_SETTLE);
  arrow.mesh.position.copy(arrow.pos).addScaledVector(arrow.launchOffset, settle * settle);
  direction.copy(arrow.vel).normalize();
  arrow.mesh.quaternion.setFromUnitVectors(FORWARD, direction);
}

function updateTrail(arrow: Arrow): void {
  arrow.trail.push(arrow.mesh.position.clone());
  // One point per frame; keep enough for TRAIL_SECONDS at the frame rate seen.
  const keep = Math.max(2, Math.round(TRAIL_SECONDS / Math.max(1e-3, arrow.age / arrow.trail.length)));
  while (arrow.trail.length > keep) arrow.trail.shift();
  arrow.trailLine.geometry.setFromPoints(arrow.trail);
}

function retire(arrow: Arrow): void {
  scene.remove(arrow.trailLine);
  arrow.trailLine.geometry.dispose();
  const i = arrows.indexOf(arrow);
  if (i >= 0) arrows.splice(i, 1);
}

/** Leave the arrow standing where it struck scenery, point buried. */
function stick(arrow: Arrow): void {
  arrow.launchOffset.set(0, 0, 0);
  placeMesh(arrow);
  arrow.mesh.position.addScaledVector(direction, PENETRATION);
  stuckArrows.push(arrow.mesh);
  if (stuckArrows.length > MAX_STUCK) {
    const oldest = stuckArrows.shift();
    if (oldest) scene.remove(oldest);
  }
}

/**
 * Stage — advance every arrow in flight, after the bots have moved (main.ts),
 * so a hit is judged against where each body is THIS frame.
 */
export function updateArrows(dt: number): void {
  if (arrows.length === 0) return;
  // One target set per frame for every arrow, as shoot() gathers per pull.
  const targets: THREE.Object3D[] = [...solids];
  for (const bot of bots) if (bot.alive) targets.push(bot.head, bot.torso, bot.legs);
  const cast = (from: THREE.Vector3, to: THREE.Vector3): SegmentHit<Struck> | null => {
    const span = to.distanceTo(from);
    if (span === 0) return null;
    raycaster.set(from, direction.subVectors(to, from).normalize());
    raycaster.far = span;
    const hit = raycaster.intersectObjects(targets, false)[0];
    if (!hit) return null;
    const bot = botFor(hit.object) ?? null;
    return { point: hit.point, payload: { bot, object: hit.object } };
  };

  const def = WEAPONS.longbow;
  // Documented pairing (validateWeapons): a bow always has a launchSpeed.
  const fullSpeed = def.launchSpeed ?? 1;
  for (const arrow of [...arrows]) {
    const hit = advanceArrow(arrow, dt, cast);
    placeMesh(arrow);
    updateTrail(arrow);
    if (hit) {
      retire(arrow);
      sfxArrowHit(hit.point);
      const { bot } = hit.payload;
      if (!bot) {
        stick(arrow);
      } else {
        // An arrow in a body is not left in it: the bot's parts are reused on
        // respawn, and an arrow riding them into the next life would lie.
        scene.remove(arrow.mesh);
        // Friendly fire is OFF, as for bullets: an ally stops the arrow, unhurt.
        if (bot.team !== session.playerTeam) {
          const part = partForMesh(bot, hit.payload.object);
          const damage = arrowDamage(def.damage, arrow.vel.length(), fullSpeed);
          showHitmarker(part === 'head');
          damageBot(bot, damageForPart({ damage, headshotMult: def.headshotMult }, part), part);
        }
      }
    } else if (arrow.age > ARROW_MAX_AGE || arrow.pos.y < FLOOR_Y) {
      retire(arrow);
      scene.remove(arrow.mesh);
    }
  }
}
