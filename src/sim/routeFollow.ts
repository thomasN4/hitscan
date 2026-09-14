// routeFollow.ts — the route-abandon decision and the lookahead shortcut for a
// bot walking a nav-graph path.
//
// Pure and engine-free like everything in sim/: waypoints are plain planar
// points, so this is testable without a scene, a mesh, or the Bot class —
// and it is the seam bots.ts:waypointOnRoute is wired through (the same
// extract-for-test shape as sim/recoil.ts:convertOnSwap).
//
// Why the previous waypoint matters: a NavLink flight enters the graph as a
// single mouth-to-landing edge, so a path can hold an 11 m hop beside a 1 m
// one. waypointOnRoute consumes a waypoint the moment the bot stands within a
// metre of it, promoting `leg` to that 11 m hop — and an abandon check that
// reads only the CURRENT leg concludes the bot "fell off" and drops the path.
// The next frame regrows the identical path deterministically, re-consumes,
// and abandons again: consume → abandon → recompute forever, zero net
// displacement, `moveBlocked` false (docs/warehouse2-bot-playtest.md section
// 4, the patrol stair livelock). A waypoint the bot just inherited by
// consuming its predecessor is not ground truth about where the bot should
// be — so abandonment requires the bot to be far from the waypoint it was
// already walking toward as well.

/** A waypoint or body position, reduced to the planar coordinates the step uses. */
export interface RoutePoint {
  readonly x: number;
  readonly z: number;
}

/** Planar distance between two route points — the step is planar too. */
function planarDistance(a: RoutePoint, b: RoutePoint): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * Whether a cached route should be thrown away as drifted: the bot fell off
 * an edge, got shoved, or respawned across the map still holding last life's
 * route.
 *
 * Abandonment needs BOTH the current leg and the previous one beyond
 * `abandonDistance`. A bot standing on the waypoint it just consumed (previous
 * near, current far across a link edge) has arrived, not drifted — it keeps
 * walking. A bot far from both has genuinely left its path. With no previous
 * waypoint (`leg` 0) the current one decides alone.
 *
 * @param path waypoints in nav-graph order; empty is never abandoned.
 * @param leg how far along `path` the bot has got (clamped to the path).
 * @param here the bot's current position.
 * @param abandonDistance how far off-path before the route is dropped.
 */
export function shouldAbandonRoute(
  path: readonly RoutePoint[],
  leg: number,
  here: RoutePoint,
  abandonDistance: number,
): boolean {
  if (path.length === 0) return false;
  const clamped = Math.min(leg, path.length - 1);
  const current = path[clamped]!;
  if (planarDistance(current, here) <= abandonDistance) return false;
  if (clamped === 0) return true;
  const previous = path[clamped - 1]!;
  return planarDistance(previous, here) > abandonDistance;
}

/**
 * Spacing (m) between walkability samples along a shortcut segment — a body
 * radius, so a wall the executor's own gate would refuse cannot hide between
 * two samples, and so a support gate judged under each sample's centre
 * (collision.ts:standableAt) leaves no point between two passing samples
 * further than half a radius from a surface.
 */
const SHORTCUT_SAMPLE_STEP = 0.5;

/**
 * Index of the waypoint to steer at: the furthest one within `maxDistance`
 * whose straight segment from `here` samples walkable throughout.
 *
 * Steering at every 1 m node in turn waggles the heading at each polyline
 * joint and drifts the body into whatever corner the joint rounds; aiming
 * past the joints cuts the smooth line the path approximates. Aiming past a
 * leg does not consume it — consumeReached below does that, by proximity,
 * for any leg up to the one aimed at — so the abandon decision above keeps
 * reading where the bot actually got to.
 *
 * A leg the bot must physically board through (`transport[k].elevatorId`)
 * ends the scan: aiming past an elevator mouth steers around the deck
 * instead of onto it. Anything merely far or blocked is skipped rather than
 * ending the scan — a clear line to a later waypoint around a corner is
 * still a legitimate shortcut. Always at least `leg`: an empty path, a leg
 * past the end, or nothing ahead qualifying all steer at the current leg,
 * exactly as before.
 *
 * @param path waypoints in nav-graph order; empty steers nowhere informative.
 * @param transport parallel boarding flags; true at elevator-approach legs.
 * @param leg how far along `path` the bot has got (clamped to the path).
 * @param here the bot's current position.
 * @param maxDistance how far ahead to look for a shortcut.
 * @param isBlocked true when a body may NOT walk onto a sampled point —
 *   blocked by geometry or unsupported. Between nav nodes there is no floor
 *   guarantee, so the caller's predicate must check support as well as
 *   collision (collision.ts:standableAt), or a chord past a deck's concave
 *   corner samples clear over a drop.
 */
export function furthestWalkable(
  path: readonly RoutePoint[],
  transport: ReadonlyArray<{ readonly elevatorId?: string }>,
  leg: number,
  here: RoutePoint,
  maxDistance: number,
  isBlocked: (x: number, z: number) => boolean,
): number {
  if (path.length === 0) return leg;
  const clamped = Math.min(leg, path.length - 1);
  // A leg the bot must board through ends the scan; find that boundary first
  // so the walk below never looks past an elevator mouth.
  let end = path.length;
  for (let k = clamped + 1; k < path.length; k++) {
    if (transport[k]?.elevatorId) { end = k; break; }
  }
  // Walk downward from the furthest eligible leg: the first in-range clear
  // segment is the maximum qualifying index, and the common all-clear case
  // costs one segment check instead of one per candidate.
  for (let k = end - 1; k > clamped; k--) {
    const cand = path[k]!;
    if (planarDistance(cand, here) > maxDistance) continue;
    if (segmentBlocked(here, cand, isBlocked)) continue;
    return k;
  }
  return clamped;
}

/**
 * The leg to walk after consuming every waypoint the bot has reached: the
 * index past the LAST waypoint within `reachedDistance` among those it has
 * been steered at, i.e. legs `leg .. aimed`.
 *
 * Consuming only `path[leg]` in strict order is not enough once shortcuts
 * exist: a bot aimed three nodes ahead, or shoved a metre off its current
 * leg, can pass that leg outside the reach radius and then stand on later
 * ones with `leg` frozen behind it. Frozen, `leg` starves the abandon check
 * of ground truth — the bot walks the route correctly and is still judged
 * drifted once it is `abandonDistance` past the frozen leg — and never
 * reaches a boarding leg, so an elevator approach it corner-cut cannot
 * board. Bounding the scan at `aimed` keeps a path that doubles back near
 * itself honest: a waypoint the bot was never steered at is not one it
 * reached by following the route, however close it stands.
 *
 * A boarding leg is never consumed by proximity (the elevator branch owns
 * it) and nothing past one is either; the final waypoint is never consumed
 * (arrival is the caller's decision). With `aimed` below `leg` the scan is
 * just the current leg, exactly the previous strict-order behaviour.
 *
 * @param path waypoints in nav-graph order.
 * @param transport parallel boarding flags; true at elevator-approach legs.
 * @param leg how far along `path` the bot has got.
 * @param aimed the furthest leg the bot has been steered at (furthestWalkable).
 * @param here the bot's current position.
 * @param reachedDistance how near a waypoint must be to count as reached.
 */
export function consumeReached(
  path: readonly RoutePoint[],
  transport: ReadonlyArray<{ readonly elevatorId?: string }>,
  leg: number,
  aimed: number,
  here: RoutePoint,
  reachedDistance: number,
): number {
  let next = leg;
  const last = Math.min(Math.max(aimed, leg), path.length - 2);
  for (let k = leg; k <= last; k++) {
    if (transport[k]?.elevatorId) break;
    if (planarDistance(path[k]!, here) < reachedDistance) next = k + 1;
  }
  return next;
}

/** Whether any walkability sample along the segment from `from` to `to` is blocked. */
function segmentBlocked(
  from: RoutePoint,
  to: RoutePoint,
  isBlocked: (x: number, z: number) => boolean,
): boolean {
  const dist = planarDistance(from, to);
  const steps = Math.max(1, Math.ceil(dist / SHORTCUT_SAMPLE_STEP));
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    if (isBlocked(from.x + (to.x - from.x) * t, from.z + (to.z - from.z) * t)) return true;
  }
  return false;
}
