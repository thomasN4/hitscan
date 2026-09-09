// routeFollow.ts — the route-abandon decision for a bot walking a nav-graph path.
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
