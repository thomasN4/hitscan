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
import { advanceArrow, trimTrail, ARROW_MAX_AGE, type SegmentHit } from './sim/arrow';
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
/**
 * Vertices each trail's buffer is allocated with, once: TRAIL_SECONDS of one
 * sample per frame up to ~200 fps. The oldest are dropped past it.
 */
const TRAIL_CAPACITY = 64;
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
  // A fixed buffer updated in place: replacing the attribute every frame
  // leaks the old one's GPU buffer, and a resize is not something three.js
  // supports on a geometry that has already been drawn.
  const trailGeometry = new THREE.BufferGeometry();
  trailGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_CAPACITY * 3), 3));
  trailGeometry.setDrawRange(0, 0);
  const trailLine = new THREE.Line(trailGeometry, trailMaterial);
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
  arrow.trail.push({ at: arrow.mesh.position.clone(), age: arrow.age });
  trimTrail(arrow.trail, arrow.age, TRAIL_SECONDS);
  while (arrow.trail.length > TRAIL_CAPACITY) arrow.trail.shift();
  const geometry = arrow.trailLine.geometry;
  const position = geometry.getAttribute('position');
  arrow.trail.forEach((point, i) => position.setXYZ(i, point.at.x, point.at.y, point.at.z));
  position.needsUpdate = true;
  geometry.setDrawRange(0, arrow.trail.length);
}

function retire(arrow: Arrow): void {
  scene.remove(arrow.trailLine);
  arrow.trailLine.geometry.dispose();
  const i = arrows.indexOf(arrow);
  if (i >= 0) arrows.splice(i, 1);
}

/**
 * Leave the arrow standing where it struck scenery, point buried, parented
 * to the solid it hit as bullet holes are (effects.ts): an arrow in an
 * elevator deck rides the deck instead of hanging where the deck used to be.
 * attach() keeps the world transform; solids are never scaled.
 */
function stick(arrow: Arrow, surface: THREE.Object3D): void {
  arrow.launchOffset.set(0, 0, 0);
  placeMesh(arrow);
  arrow.mesh.position.addScaledVector(direction, PENETRATION);
  surface.attach(arrow.mesh);
  stuckArrows.push(arrow.mesh);
  if (stuckArrows.length > MAX_STUCK) stuckArrows.shift()?.removeFromParent();
}

/**
 * Stage — advance every arrow in flight, after the bots have moved (main.ts),
 * so a hit is judged against where each body is THIS frame.
 */
export function updateArrows(dt: number): void {
  if (arrows.length === 0) return;
  // One target set per frame for every arrow, as shoot() gathers per pull.
  // updateBots has just moved the bodies, but their parts' world matrices
  // are only refreshed by the render (or bots.ts's own fire/melee flush), so
  // a raycast here would see where each bot stood LAST frame. Flush first.
  const targets: THREE.Object3D[] = [...solids];
  for (const bot of bots) {
    if (!bot.alive) continue;
    bot.mesh.updateMatrixWorld(true);
    targets.push(bot.head, bot.torso, bot.legs);
  }
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
        stick(arrow, hit.payload.object);
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
