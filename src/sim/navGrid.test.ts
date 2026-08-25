// navGrid.test.ts — the walkable graph, against synthetic worlds.
//
// The probe is injected, so these tests describe worlds directly instead of
// building geometry: `blocked` lists rectangles a body cannot stand in, and
// `floors` lists raised surfaces. That is the whole point of taking a NavProbe
// rather than importing collision.ts — the graph's rules can be stated without
// a collider, a mesh or a scene anywhere in sight.
import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { buildNavGrid, findPath, navNode, nearestNode, type NavGrid, type NavLinkSpec, type NavProbe } from './navGrid';

const STEP = 0.3;
const HEAD = 2;

/**
 * A raised, standable surface over an XZ rectangle.
 *
 * `bottom` is its underside, defaulting to the ground: a solid block. Give it
 * one near `y` and it becomes a thin deck, standable on top AND walkable
 * beneath — which is the shape that makes a column hold two nodes.
 */
interface Floor { minX: number; maxX: number; minZ: number; maxZ: number; y: number; bottom?: number }
/** A region no body may stand in at any height. */
interface Wall { minX: number; maxX: number; minZ: number; maxZ: number }

const inside = (r: { minX: number; maxX: number; minZ: number; maxZ: number }, x: number, z: number): boolean =>
  x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;

/**
 * World from a list of walls and raised floors. Ground is y = 0 everywhere; a
 * wall blocks at every height; a floor adds a standable surface at its own y.
 *
 * A floor obstructs a body only when it is both too tall to step onto and too
 * low to duck under, mirroring collision.ts:collidesAt.
 */
function world(walls: Wall[] = [], floors: Floor[] = []): NavProbe {
  return {
    canStand: (x, z, feetY) => {
      if (walls.some(w => inside(w, x, z))) return false;
      return !floors.some(f => inside(f, x, z)
        // Both halves of collision.ts:collidesAt: a surface within one step
        // of the feet is walked ONTO, and one whose underside clears head
        // height is walked UNDER. Only what fails both is a wall.
        && f.y > feetY + STEP + 1e-6
        && (f.bottom ?? 0) < feetY + HEAD - 1e-6);
    },
    floorsAt: (x, z) => floors.filter(f => inside(f, x, z)).map(f => f.y),
  };
}

const bounds = { minX: 0, maxX: 10, minZ: 0, maxZ: 10 };
const build = (probe: NavProbe, links?: NavLinkSpec[]) =>
  buildNavGrid({ bounds, cell: 1, stepHeight: STEP, probe, links });

/** Whether the graph holds any route between two world points. */
const connected = (grid: ReturnType<typeof build>, a: THREE.Vector3, b: THREE.Vector3): boolean =>
  findPath(grid, a, b) !== null;

const at = (x: number, z: number, y = 0): THREE.Vector3 => new THREE.Vector3(x, y, z);

/** Every node as a point — the flat CSR arrays unpacked, for readable assertions. */
const nodesIn = (grid: NavGrid) =>
  Array.from({ length: grid.count }, (_, i) => navNode(grid, i));

/** Node indices adjacent to `i`, read out of the CSR rows. */
const neighboursOf = (grid: NavGrid, i: number): number[] =>
  Array.from(grid.edgeTo.slice(grid.edgeStart[i], grid.edgeStart[i + 1]));

describe('buildNavGrid sampling', () => {
  test('open ground is one node per cell, all connected', () => {
    const grid = build(world());
    expect(grid.count).toBe(100); // 10x10 at cell 1
    expect(connected(grid, at(0.5, 0.5), at(9.5, 9.5))).toBe(true);
  });

  test('a wall across the map splits it in two', () => {
    const grid = build(world([{ minX: 0, maxX: 10, minZ: 4.4, maxZ: 5.6 }]));
    expect(connected(grid, at(5, 1), at(5, 9))).toBe(false);
  });

  test('a doorway in that wall reconnects it', () => {
    // Same wall, with a gap at x ~ 5. The gap must be wide enough that the
    // cell centre at 5.5 falls outside the wall rectangle.
    const grid = build(world([
      { minX: 0, maxX: 5, minZ: 4.4, maxZ: 5.6 },
      { minX: 6, maxX: 10, minZ: 4.4, maxZ: 5.6 },
    ]));
    expect(connected(grid, at(5, 1), at(5, 9))).toBe(true);
    const path = findPath(grid, at(5, 1), at(5, 9))!;
    // Every waypoint must clear the wall band, i.e. route through the gap.
    const throughGap = path.filter(p => p.z > 4.4 && p.z < 5.6);
    expect(throughGap.length).toBeGreaterThan(0);
    for (const p of throughGap) expect(p.x).toBeGreaterThan(5);
  });

  test('a column under a deck yields a node at each level', () => {
    // A 0.2 m slab at 3 m: stand on it, or walk underneath it.
    const grid = build(world([], [{ minX: 2, maxX: 4, minZ: 2, maxZ: 4, y: 3, bottom: 2.8 }]));
    const stacked = nodesIn(grid).filter(n => Math.abs(n.x - 2.5) < 0.01 && Math.abs(n.z - 2.5) < 0.01);
    expect(stacked.map(n => n.y).sort()).toEqual([0, 3]);
  });
});

describe('buildNavGrid edges', () => {
  test('a rise within stepHeight is walkable', () => {
    const grid = build(world([], [{ minX: 5, maxX: 10, minZ: 0, maxZ: 10, y: STEP }]));
    expect(connected(grid, at(1, 5), at(9, 5, STEP))).toBe(true);
  });

  test('a rise beyond stepHeight is not', () => {
    const grid = build(world([], [{ minX: 5, maxX: 10, minZ: 0, maxZ: 10, y: STEP + 0.05 }]));
    expect(connected(grid, at(1, 5), at(9, 5, STEP + 0.05))).toBe(false);
  });

  test('a diagonal will not cut a corner between two blocked cells', () => {
    // Blocks at (5,4) and (4,5) leave (4,4) and (5,5) diagonally adjacent.
    // A body with width cannot pass between them, so the edge must be refused
    // and the only route is the long way round.
    const grid = build(world([
      { minX: 5, maxX: 6, minZ: 4, maxZ: 5 },
      { minX: 4, maxX: 5, minZ: 5, maxZ: 6 },
    ]));
    const a = nearestNode(grid, at(4.5, 4.5));
    const b = nearestNode(grid, at(5.5, 5.5));
    expect(neighboursOf(grid, a)).not.toContain(b);
  });
});

describe('nav links', () => {
  const twoLevels = () => world(
    // A wall ringing the upper floor so the ONLY way up is the link.
    [{ minX: 0, maxX: 10, minZ: 6, maxZ: 6.9 }],
    [{ minX: 0, maxX: 10, minZ: 7, maxZ: 10, y: 3, bottom: 2.8 }],
  );

  test('a link joins levels the sampled grid cannot', () => {
    const link = { bottom: at(1.5, 5.5), top: at(1.5, 7.5, 3), halfWidth: 1 };
    const grid = build(twoLevels(), [link]);
    expect(connected(grid, at(5, 1), at(8, 8, 3))).toBe(true);
  });

  test('and that assertion is not vacuous — without the link there is no route', () => {
    const grid = build(twoLevels());
    expect(connected(grid, at(5, 1), at(8, 8, 3))).toBe(false);
  });

  test('links are traversable in both directions', () => {
    const link = { bottom: at(1.5, 5.5), top: at(1.5, 7.5, 3), halfWidth: 1 };
    const grid = build(twoLevels(), [link]);
    expect(connected(grid, at(8, 8, 3), at(5, 1))).toBe(true);
  });
});

/** Dijkstra over the CSR arrays: the true optimum, with no heuristic involved. */
function optimalCost(grid: NavGrid, from: THREE.Vector3, to: THREE.Vector3): number {
  const start = nearestNode(grid, from);
  const goal = nearestNode(grid, to);
  const dist = new Float64Array(grid.count).fill(Infinity);
  const seen = new Uint8Array(grid.count);
  dist[start] = 0;
  for (;;) {
    let u = -1;
    let bestD = Infinity;
    for (let i = 0; i < grid.count; i++) {
      if (!seen[i] && dist[i]! < bestD) { bestD = dist[i]!; u = i; }
    }
    if (u === -1) break;
    seen[u] = 1;
    for (let e = grid.edgeStart[u]!; e < grid.edgeStart[u + 1]!; e++) {
      const v = grid.edgeTo[e]!;
      const nd = dist[u]! + grid.edgeCost[e]!;
      if (nd < dist[v]!) dist[v] = nd;
    }
  }
  return dist[goal]!;
}

/** Summed 3D length of a returned path — the cost its edges charged. */
const pathCost = (path: THREE.Vector3[]): number =>
  path.slice(1).reduce((sum, p, i) => sum + p.distanceTo(path[i]!), 0);

// A* returns the SHORTEST route, not merely a route — which holds only while
// the heuristic stays admissible, i.e. never exceeds the true remaining cost.
// Pinned against brute force because the failure is silent: an inadmissible
// heuristic still returns a valid path, and nothing anywhere reports that a
// cheaper one existed. The first version of this file charged links their
// planar run while the heuristic charged |dy| as well, which overestimates by
// the full rise of every flight in the repo.
describe('findPath optimality', () => {
  const twoWaysUp = () => world(
    [{ minX: 0, maxX: 10, minZ: 6, maxZ: 6.9 }],
    [{ minX: 0, maxX: 10, minZ: 7, maxZ: 10, y: 3, bottom: 2.8 }],
  );
  const links: NavLinkSpec[] = [
    { bottom: at(0.5, 5.5), top: at(0.5, 7.5, 3), halfWidth: 1 },
    { bottom: at(9.5, 5.5), top: at(9.5, 7.5, 3), halfWidth: 1 },
  ];

  test('matches brute force when two flights compete', () => {
    const grid = build(twoWaysUp(), links);
    for (const goal of [at(1.5, 9.5, 3), at(8.5, 9.5, 3), at(5.5, 7.5, 3)]) {
      const path = findPath(grid, at(5.5, 0.5), goal)!;
      expect(path).not.toBeNull();
      expect(pathCost(path)).toBeCloseTo(optimalCost(grid, at(5.5, 0.5), goal), 6);
    }
  });

  test('matches brute force on one level, around an obstacle', () => {
    const grid = build(world([{ minX: 4.4, maxX: 5.6, minZ: 0, maxZ: 6 }]));
    const path = findPath(grid, at(3, 3), at(7, 3))!;
    expect(pathCost(path)).toBeCloseTo(optimalCost(grid, at(3, 3), at(7, 3)), 6);
  });

  test('a climb costs its rise, not just its run', () => {
    // The invariant the heuristic leans on: an edge charges the 3D length of
    // the segment it spans, so a 3 m lift is never free.
    const grid = build(twoWaysUp(), [links[0]!]);
    const up = findPath(grid, at(0.5, 5.5), at(0.5, 7.5, 3))!;
    expect(pathCost(up)).toBeGreaterThan(3);
  });
});

describe('findPath', () => {
  test('returns waypoints ending at the goal', () => {
    const grid = build(world());
    const path = findPath(grid, at(0.5, 0.5), at(9.5, 9.5))!;
    expect(path.length).toBeGreaterThan(1);
    const last = path[path.length - 1]!;
    expect(last.x).toBeCloseTo(9.5, 6);
    expect(last.z).toBeCloseTo(9.5, 6);
  });

  test('takes the short way round an obstacle, not the long one', () => {
    // Wall from the south edge to mid-map: going north of its tip is shorter.
    const grid = build(world([{ minX: 4.4, maxX: 5.6, minZ: 0, maxZ: 6 }]));
    const path = findPath(grid, at(3, 3), at(7, 3))!;
    expect(Math.max(...path.map(p => p.z))).toBeGreaterThan(6);
    // ...and it should not have wandered to the far edge to do it.
    expect(Math.max(...path.map(p => p.z))).toBeLessThan(9);
  });

  test('a goal inside geometry snaps to the nearest standable node', () => {
    const grid = build(world([{ minX: 4, maxX: 6, minZ: 4, maxZ: 6 }]));
    const path = findPath(grid, at(1, 1), at(5, 5));
    expect(path).not.toBeNull();
    const last = path![path!.length - 1]!;
    expect(inside({ minX: 4, maxX: 6, minZ: 4, maxZ: 6 }, last.x, last.z)).toBe(false);
  });

  test('returns null when the goal is walled off entirely', () => {
    const grid = build(world([{ minX: 0, maxX: 10, minZ: 4.4, maxZ: 5.6 }]));
    expect(findPath(grid, at(5, 1), at(5, 9))).toBeNull();
  });
});
