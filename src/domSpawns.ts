// domSpawns.ts — uniform-share respawn director for domination matches.
//
// Initial spawns do not come through here at all: bots draw their BOT_SPAWNS
// zone via Bot.spawnAtRandom and the player draws the same zone the same way
// in combat.ts:respawn. (The zones themselves are not untouched — this branch
// moved elevation's to corner pockets — but the opening draw is.)
// RESPAWNS in dom mode come through here instead: one zone is picked uniformly
// from the team's owned flags plus its initial zone (1/(k+1) each — with A+B
// owned that is 1/3 A, 1/3 B, 1/3 home), then a point is drawn uniformly
// WITHIN that zone (sim/domSpawnDraw.ts) and returned as a feet position.
// Pure uniform: enemy positions play no part, so a camped flag ring kills at
// full odds.
//
// A colliding draw is resampled inside the SAME zone, so a walled ring does
// not silently become a home-zone spawn and skew the shares. Only after the
// zone's budget is exhausted do the other zones get their own budgets; a fully
// walled map still returns the last draw rather than hanging.
//
// Standability is checked here against live colliders via
// collision.ts:standableAt — unobstructed AND supported within a step below
// the feet, so a ring draw over a stairwell void is resampled rather than
// spawning midair. DRAWING is the pure seam's job. That split is what keeps
// the draw unit-testable in Node while the geometry test stays where
// colliders live.
import * as THREE from 'three';
import { BOT_SPAWNS, dom, session, type Team } from './core/state';
import { colliders } from './world';
import { standableAt } from './collision';
import { NAV_RADIUS } from './nav';
import {
  DOM_RING_INNER,
  DOM_RING_OUTER,
  drawRingPoint,
  drawZonePoint,
  pickDomZoneIndex,
  type SpawnCandidate,
} from './sim/domSpawnDraw';

/** Draws retried inside one zone before the director tries another zone. */
const ZONE_TRIES = 16;

/**
 * Pick a domination respawn point for `team`.
 *
 * @param team respawning side; its owned flags plus its initial zone share the draw equally.
 * @param rng draw stream; Math.random in production, scripted in tests.
 * @param isStandable collision gate; live colliders in production, stubbed in tests.
 */
export function pickDomRespawn(
  team: Team,
  rng: () => number = Math.random,
  isStandable: (c: SpawnCandidate) => boolean = (c) =>
    standableAt(new THREE.Vector3(c.x, 0, c.z), NAV_RADIUS, c.y, colliders),
): THREE.Vector3 {
  const zone = BOT_SPAWNS[session.map][team];
  const owned = dom.flags.filter(f => f.owner === team);
  // Owned flags are indices 0..k-1 in flag order, home is index k — the same
  // numbering sim/domSpawnDraw.ts:pickDomZoneIndex deals.
  const first = pickDomZoneIndex(owned.length, rng);
  const order = [first];
  for (let i = 0; i <= owned.length; i++) {
    if (i !== first) order.push(i);
  }
  // Bound-guarded read below: order always holds the picked zone first, and
  // ZONE_TRIES >= 1, so last is assigned before any return path is skipped.
  let last: SpawnCandidate | undefined;
  for (const zi of order) {
    const flag = zi < owned.length ? owned[zi] : undefined;
    for (let t = 0; t < ZONE_TRIES; t++) {
      const c = flag !== undefined
        ? drawRingPoint(
          { x: flag.pos.x, y: flag.pos.y, z: flag.pos.z },
          rng,
          // The band must clear the CAPTURE ring, which is per-flag while
          // DOM_RING_INNER is a single floor: every elevation flag has
          // radius 4.5, so the bare constant would put ~5% of ring draws
          // inside the point and freeze the capture with a body that just
          // respawned there.
          Math.max(DOM_RING_INNER, flag.radius),
          DOM_RING_OUTER,
        )
        : drawZonePoint(zone, rng);
      last = c;
      if (isStandable(c)) return new THREE.Vector3(c.x, c.y, c.z);
    }
  }
  const won = last!;
  return new THREE.Vector3(won.x, won.y, won.z);
}
