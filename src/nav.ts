// nav.ts — binds the pure navigation graph to this game's world.
//
// sim/navGrid.ts knows how to sample a world into a walkable graph but nothing
// about THIS world; collision.ts knows how bodies fit through geometry but
// nothing about graphs. This module is the join, the same shape as weapons.ts
// binding sim/accuracy.ts to live state: no algorithm of its own, no policy
// numbers beyond the sampling constants below.
//
// It is pure — no scene, no DOM — so it stays testable in plain Node even
// though it is not in sim/. What keeps it out of sim/ is the collision.ts
// import: nothing in sim/ has one, and a navmesh is not a good enough reason
// to be the first.
import * as THREE from 'three';
import { colliders, navLinks } from './world';
import { collidesAt, STEP_HEIGHT } from './collision';
import { buildNavGrid, findPath, type NavGrid, type NavProbe } from './sim/navGrid';

/**
 * Footprint half-width every walkable test is built against (m).
 *
 * The larger of the two bodies in the game — bots at 0.5, the player at 0.45 —
 * so one graph serves both and neither is promised a gap it cannot fit. Owned
 * here rather than in bots.ts because the graph is what pins it: widen a bot
 * past this and its routes stop matching its collisions.
 */
export const NAV_RADIUS = 0.5;

/**
 * Sample spacing (m). Deliberately coarser than the 0.75 m stair treads: at
 * this size one cell along a flight climbs more than STEP_HEIGHT, so flights
 * read as walls and enter the graph as NavLink edges instead. Resolving
 * treads by sampling would need 0.5 m and quadruple the build.
 */
const CELL = 1;

/** Padding (m) around the level's geometry, so the outermost floor is sampled. */
const MARGIN = 2;

/** The current map's graph; undefined until buildNav() runs. */
let grid: NavGrid | undefined;

/**
 * Colliders bucketed by XZ cell, so a probe tests its neighbourhood instead of
 * the whole level.
 *
 * Every collidesAt/supportHeightAt call in the game is a linear scan over the
 * registry, which is fine at one call per entity per frame. The graph build
 * makes tens of thousands of them against ~90 boxes, and that is the first
 * time the scan is worth avoiding.
 */
interface ColliderIndex {
  bucketSize: number;
  minX: number;
  minZ: number;
  cols: number;
  rows: number;
  buckets: THREE.Box3[][];
}

function indexColliders(boxes: readonly THREE.Box3[], bounds: Bounds): ColliderIndex {
  const bucketSize = 8;
  const cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / bucketSize));
  const rows = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / bucketSize));
  const buckets: THREE.Box3[][] = Array.from({ length: cols * rows }, () => []);
  for (const c of boxes) {
    const x0 = clampIndex((c.min.x - bounds.minX) / bucketSize, cols);
    const x1 = clampIndex((c.max.x - bounds.minX) / bucketSize, cols);
    const z0 = clampIndex((c.min.z - bounds.minZ) / bucketSize, rows);
    const z1 = clampIndex((c.max.z - bounds.minZ) / bucketSize, rows);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) buckets[cx * rows + cz]!.push(c);
    }
  }
  return { bucketSize, minX: bounds.minX, minZ: bounds.minZ, cols, rows, buckets };
}

function clampIndex(raw: number, count: number): number {
  return Math.min(count - 1, Math.max(0, Math.floor(raw)));
}

/** Colliders whose bucket covers (x, z) — a superset of those that can overlap it. */
function near(index: ColliderIndex, x: number, z: number): THREE.Box3[] {
  const cx = clampIndex((x - index.minX) / index.bucketSize, index.cols);
  const cz = clampIndex((z - index.minZ) / index.bucketSize, index.rows);
  return index.buckets[cx * index.rows + cz]!;
}

interface Bounds { minX: number; maxX: number; minZ: number; maxZ: number }

/** The level's XZ extent, from the geometry itself — no map declares it. */
function boundsOf(boxes: readonly THREE.Box3[]): Bounds {
  const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const c of boxes) {
    b.minX = Math.min(b.minX, c.min.x); b.maxX = Math.max(b.maxX, c.max.x);
    b.minZ = Math.min(b.minZ, c.min.z); b.maxZ = Math.max(b.maxZ, c.max.z);
  }
  if (!Number.isFinite(b.minX)) return { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  return {
    minX: b.minX - MARGIN, maxX: b.maxX + MARGIN,
    minZ: b.minZ - MARGIN, maxZ: b.maxZ + MARGIN,
  };
}

/**
 * Build the graph for the level currently in `world.ts`'s registries.
 *
 * Called from main.ts right after the map builder, which is the first moment
 * `colliders` is populated. Map switching is a full page reload, so this runs
 * exactly once per session.
 */
export function buildNav(): NavGrid {
  const bounds = boundsOf(colliders);
  const index = indexColliders(colliders, bounds);
  const probe: NavProbe = {
    canStand: (x, z, feetY) =>
      !collidesAt(new THREE.Vector3(x, 0, z), NAV_RADIUS, feetY, near(index, x, z)),
    floorsAt: (x, z) => {
      const tops: number[] = [];
      for (const c of near(index, x, z)) {
        if (x + NAV_RADIUS <= c.min.x || x - NAV_RADIUS >= c.max.x) continue;
        if (z + NAV_RADIUS <= c.min.z || z - NAV_RADIUS >= c.max.z) continue;
        tops.push(c.max.y);
      }
      return tops;
    },
  };
  const t0 = performance.now();
  grid = buildNavGrid({ bounds, cell: CELL, stepHeight: STEP_HEIGHT, probe, links: navLinks });
  // DEV-only, like bots.ts:debugLog: the build runs once at startup and its
  // cost scales with map size times collider count, so a map that quietly
  // makes it expensive should be visible rather than felt. Statically dead in
  // production builds.
  if (import.meta.env.DEV) {
    console.debug(`[nav] ${grid.count} nodes, ${grid.edgeTo.length} edges, ${navLinks.length} links`
      + ` in ${(performance.now() - t0).toFixed(0)} ms`);
  }
  return grid;
}

/** The built graph, or undefined before buildNav(). */
export function navGrid(): NavGrid | undefined {
  return grid;
}

/**
 * Waypoints from `from` to `to`, or null when the graph holds no route.
 * Endpoints snap to their nearest node, so callers standing off-grid still
 * route; the list excludes the caller's own position.
 */
export function route(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[] | null {
  return grid ? findPath(grid, from, to) : null;
}

