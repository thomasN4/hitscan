// navGrid.ts — a walkable graph of the level, and A* over it.
//
// Why this exists: bot steering is reactive, so a bot beelines at its target
// and gets whatever the geometry allows. That works in the open and fails
// everywhere else — measured on maps/elevation.ts, bots under the second-floor
// deck walk 17 m in five seconds to finish 0.1 m from where they started,
// never blocked, orbiting the point beneath a player they have no route to.
// Straight-line steering toward a staircase does not fix it either: the
// internal flight's TALL end faces them, and the outdoor flight is behind a
// doorway. Doorways and interiors need an actual graph.
//
// Engine-free and DOM-free like everything in sim/, and it does not import
// collision.ts either — nothing in sim/ does, and this is not the module to
// start. The two questions it needs about the world ("can a body stand here",
// "what holds it up") arrive as an injected NavProbe, the same seam pattern
// as perception.ts's injected LOS callback. That is also what makes it
// testable against synthetic worlds with no colliders at all.
//
// The graph is MULTI-LEVEL: a column of space holds one node per standable
// height, which is what lets a two-storey building have a floor and a deck
// over the same ground. Stairs do NOT appear as sampled cells — see NavLink.
import * as THREE from 'three';

/** What the graph needs to know about the world, supplied by the caller. */
export interface NavProbe {
  /** Whether a body of the build radius can stand at (x, z) with feet at `feetY`. */
  canStand(x: number, z: number, feetY: number): boolean;
  /**
   * Candidate floor heights in the column at (x, z) — every surface top a
   * body might stand on. Ground level is added for you; duplicates and
   * unstandable heights are fine, canStand filters them.
   */
  floorsAt(x: number, z: number): number[];
}

/** A level change traversable by walking, joining two points at different heights. */
export interface NavLinkSpec {
  bottom: THREE.Vector3;
  top: THREE.Vector3;
  /** Half the traversable width across the line of travel (m). */
  halfWidth: number;
  /** Upward only. Omitted means both ways, which is what a flight of stairs is. */
  oneWay?: boolean;
  elevatorId?: string;
  extraCost?: number;
}

/** Rectangular XZ extent the graph covers. */
export interface NavBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** One standable spot: a cell column plus the height stood at within it. */
export interface NavNode {
  x: number;
  y: number;
  z: number;
}

/**
 * A built graph, stored flat.
 *
 * Node positions are three parallel arrays and adjacency is compressed sparse
 * row — `edgeTo[edgeStart[i] .. edgeStart[i+1])` are node i's neighbours —
 * rather than the arrays-of-arrays-of-objects this started as. The elevation
 * map is 17k nodes and 124k edges; boxed, that measured 5.5 MB of live heap
 * against a 6 MB baseline for the whole game, and every edge walk chased
 * pointers. Flat it is a little over 1 MB and the walk is sequential.
 */
export interface NavGrid {
  readonly cell: number;
  /** Number of nodes; xs/ys/zs and edgeStart are indexed by node. */
  readonly count: number;
  readonly xs: Float32Array;
  readonly ys: Float32Array;
  readonly zs: Float32Array;
  /** CSR row offsets, length count + 1. */
  readonly edgeStart: Int32Array;
  /** Neighbour node indices, length edgeStart[count]. */
  readonly edgeTo: Int32Array;
  /** Traversal cost per entry, parallel to edgeTo. */
  readonly edgeCost: Float32Array;
  /**
   * Connected-component id per node, over UNDIRECTED edges (a directed link
   * joins both ends). Labelled once at build time: any directed route implies
   * an undirected one, so nodes in different components have no route either
   * way — which is what lets the patrol selector discard cross-component
   * candidates without ever discarding a routable one. The converse is not
   * exact: a one-way link shares its component both ways, so a filtered pick
   * can still be unroutable downhill off a lift pad. Length `count`.
   */
  readonly component: Int32Array;
  /** Directed node-pair keys for transport edges, retained through A*. */
  readonly elevatorEdges?: ReadonlyMap<string, string>;
}

/** Read node `i` back out as a point. For tests, DEV overlays and callers. */
export function navNode(grid: NavGrid, i: number): NavNode {
  return { x: grid.xs[i]!, y: grid.ys[i]!, z: grid.zs[i]! };
}

/** Options for buildNavGrid; every number an explicit parameter, none inferred. */
export interface NavGridOptions {
  bounds: NavBounds;
  /** Sample spacing in metres. */
  cell: number;
  /** Largest height difference a walker climbs without help (collision.ts:STEP_HEIGHT). */
  stepHeight: number;
  probe: NavProbe;
  /** Level changes too steep for the sampled grid; see NavLink in world.ts. */
  links?: readonly NavLinkSpec[];
  /**
   * Fractional extra traversal cost per wall-adjacent side of a node, 0 to
   * disable (the default: edges cost their pure 3D length). A node counts how
   * many of its four orthogonal neighbours one `cell` away are unstandable at
   * its own height, and every edge touching it is charged
   * `length * (1 + clearanceWeight * blockedSides / 4)` — so a corridor's
   * middle prices below its wall-grazing edges and A* swings wide where the
   * detour is cheap, while a narrow-but-valid gap stays routable at a premium
   * rather than pruning shut. Costs only ever grow above the 3D length, so the
   * straight-line heuristic stays admissible and A* stays optimal.
   */
  clearanceWeight?: number;
}

/**
 * The height open ground sits at. A constant because this game's maps are all
 * built on a y = 0 plane (world.ts:registerSolid takes the ground planes with
 * no AABB at all); terrain would make it a probe.
 */
const GROUND_Y = 0;

/** Neighbour offsets: four orthogonal, then four diagonal. Order matters below. */
const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/**
 * Sample the world into a walkable graph.
 *
 * Nodes are (column, height) pairs; edges join neighbouring columns whose
 * heights differ by at most `stepHeight` AND where the destination is
 * standable with the SOURCE's feet — the same feet-aware rule
 * collision.ts:slideMoveXZ applies, so the graph never promises a step the
 * movement gate would refuse. Diagonals additionally require both of their
 * orthogonal neighbours, so a path cannot squeeze through a corner a body
 * of the build radius does not fit through.
 */
export function buildNavGrid(opts: NavGridOptions): NavGrid {
  const { bounds, cell, stepHeight, probe, clearanceWeight = 0 } = opts;
  const cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cell));
  const rows = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / cell));

  const nodes: NavNode[] = [];
  // Column index -> node indices standing in it, so edge building can look up
  // a neighbour column without scanning every node.
  const column: number[][] = Array.from({ length: cols * rows }, () => []);

  for (let cx = 0; cx < cols; cx++) {
    for (let cz = 0; cz < rows; cz++) {
      const x = bounds.minX + (cx + 0.5) * cell;
      const z = bounds.minZ + (cz + 0.5) * cell;
      // Ground first, then every surface top in the column. Ground is seeded
      // rather than probed for: asking for the highest support returns the
      // DECK over a two-storey column and loses the floor underneath it,
      // which is exactly the case the graph exists to handle.
      const heights = [GROUND_Y, ...probe.floorsAt(x, z)].sort((a, b) => a - b);
      let last = NaN;
      for (const h of heights) {
        if (Math.abs(h - last) < 1e-6) continue;
        last = h;
        if (!probe.canStand(x, z, h)) continue;
        column[cx * rows + cz]!.push(nodes.length);
        nodes.push({ x, y: h, z });
      }
    }
  }

  // Wall-adjacency penalty per node: the share of its four orthogonal
  // neighbours one cell away that cannot be stood on at its own height.
  // Probed, not derived from missing columns — a column can hold a node at
  // another level while a wall stands at this one. All zeros when disabled,
  // so the default build prices exactly what it always did.
  const penalty: number[] = nodes.map(n => {
    if (clearanceWeight === 0) return 0;
    let blocked = 0;
    if (!probe.canStand(n.x + cell, n.z, n.y)) blocked++;
    if (!probe.canStand(n.x - cell, n.z, n.y)) blocked++;
    if (!probe.canStand(n.x, n.z + cell, n.y)) blocked++;
    if (!probe.canStand(n.x, n.z - cell, n.y)) blocked++;
    return blocked / 4;
  });

  /** Traversal price of a segment: its 3D length, uplifted by the tighter end's wall adjacency. */
  const priced = (a: number, b: number, from: NavNode, to: NavNode): number =>
    edgeLength(from, to) * (1 + clearanceWeight * Math.max(penalty[a]!, penalty[b]!));

  const edges: number[][] = nodes.map(() => []);
  const costs: number[][] = nodes.map(() => []);
  const columnOf = (cx: number, cz: number): number[] | undefined =>
    cx < 0 || cz < 0 || cx >= cols || cz >= rows ? undefined : column[cx * rows + cz];

  for (let cx = 0; cx < cols; cx++) {
    for (let cz = 0; cz < rows; cz++) {
      const here = column[cx * rows + cz]!;
      if (here.length === 0) continue;
      for (let n = 0; n < NEIGHBOURS.length; n++) {
        const [dx, dz] = NEIGHBOURS[n]!;
        const there = columnOf(cx + dx, cz + dz);
        if (!there || there.length === 0) continue;
        const diagonal = n >= 4;
        for (const a of here) {
          const from = nodes[a]!;
          // A diagonal is only walkable if both orthogonal moves are: a body
          // with width cannot clip the corner between two blocked cells.
          if (diagonal && !(
            stepsInto(from, columnOf(cx + dx, cz), nodes, stepHeight, probe)
            && stepsInto(from, columnOf(cx, cz + dz), nodes, stepHeight, probe)
          )) continue;
          for (const b of there) {
            const to = nodes[b]!;
            if (!walkable(from, to, stepHeight, probe)) continue;
            edges[a]!.push(b);
            costs[a]!.push(priced(a, b, from, to));
          }
        }
      }
    }
  }

  const elevatorEdges = new Map<string, string>();
  for (const spec of opts.links ?? []) {
    const a = nearestOf(nodes, spec.bottom);
    const b = nearestOf(nodes, spec.top);
    if (a < 0 || b < 0 || a === b) continue;
    // One DIRECTED edge, charged its priced length (see priced): the 3D
    // length uplifted by wall adjacency, plus any waiting cost for transport.
    const edge = (i: number, j: number): void => {
      const cost = priced(i, j, nodes[i]!, nodes[j]!) + (spec.extraCost ?? 0);
      if (spec.elevatorId) elevatorEdges.set(`${i}:${j}`, spec.elevatorId);
      edges[i]!.push(j); costs[i]!.push(cost);
    };
    // Stairs are as walkable down as up, so a flight joins BOTH ways — but a
    // one-way launch link must not: a pad throws a body upward and offers
    // nothing on the way back, and an edge claiming otherwise routes bots off
    // the deck and onto the pad, which launches them again.
    const join = (i: number, j: number): void => {
      edge(i, j);
      if (spec.oneWay) return;
      edge(j, i);
    };
    join(a, b);
    // Elevators have no permanent intermediate walking surfaces.
    if (spec.elevatorId) continue;

    // …and every node ON the flight joins both ends, because a staircase is
    // traversable from anywhere along it, not only from its mouth.
    //
    // Without this a bot partway up is stranded: treads are 0.75 m apart and
    // cells are 1 m, so consecutive tread nodes differ by more than
    // STEP_HEIGHT and the sampled grid refuses to connect them. The tread
    // nodes become isolated islands, and A* — correctly, given that graph —
    // routes a mid-flight bot back DOWN to the mouth to reach the one edge
    // that climbs. It then walks up, gets re-routed down, and oscillates in
    // place. Observed as a bot frozen two risers up for fifteen seconds,
    // never blocked.
    //
    // On a one-way link the intermediates are directed too, and UPHILL ONLY:
    // bottom → intermediate and intermediate → top, never back down. A
    // bidirectional intermediate edge would let A* route a bot on the deck
    // down onto a lift pad — the exact loop one-way exists to prevent.
    for (let i = 0; i < nodes.length; i++) {
      if (i === a || i === b) continue;
      const n = nodes[i]!;
      if (n.y <= spec.bottom.y + 1e-6 || n.y >= spec.top.y - 1e-6) continue;
      if (distanceToSegmentXZ(n, spec.bottom, spec.top) > spec.halfWidth) continue;
      if (spec.oneWay) {
        edge(a, i);
        edge(i, b);
      } else {
        join(i, a);
        join(i, b);
      }
    }
  }

  return { ...compact(cell, nodes, edges, costs, labelComponents(nodes.length, edges)), elevatorEdges };
}

/**
 * Label the graph's weakly connected components: one BFS over the undirected
 * closure of the edge lists, so a link joins both ends regardless of its
 * direction. Runs once at build time (~16k nodes); the patrol selector then
 * filters in O(1) per sample instead of routing per candidate.
 */
function labelComponents(count: number, edges: readonly (readonly number[])[]): Int32Array {
  const component = new Int32Array(count).fill(-1);
  const reverse: number[][] = Array.from({ length: count }, () => []);
  for (let a = 0; a < count; a++) {
    for (const b of edges[a]!) reverse[b]!.push(a);
  }
  let next = 0;
  const stack: number[] = [];
  for (let s = 0; s < count; s++) {
    if (component[s]! !== -1) continue;
    component[s] = next;
    stack.push(s);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const nb of edges[cur]!) {
        if (component[nb]! === -1) { component[nb] = next; stack.push(nb); }
      }
      for (const nb of reverse[cur]!) {
        if (component[nb]! === -1) { component[nb] = next; stack.push(nb); }
      }
    }
    next++;
  }
  return component;
}

/** Pack the build-time arrays-of-arrays into the flat CSR form. */
function compact(
  cell: number,
  nodes: readonly NavNode[],
  edges: readonly (readonly number[])[],
  costs: readonly (readonly number[])[],
  component: Int32Array,
): NavGrid {
  const count = nodes.length;
  const xs = new Float32Array(count);
  const ys = new Float32Array(count);
  const zs = new Float32Array(count);
  const edgeStart = new Int32Array(count + 1);
  let total = 0;
  for (let i = 0; i < count; i++) {
    const n = nodes[i]!;
    xs[i] = n.x; ys[i] = n.y; zs[i] = n.z;
    edgeStart[i] = total;
    total += edges[i]!.length;
  }
  edgeStart[count] = total;
  const edgeTo = new Int32Array(total);
  const edgeCost = new Float32Array(total);
  let at = 0;
  for (let i = 0; i < count; i++) {
    const to = edges[i]!;
    const cost = costs[i]!;
    for (let k = 0; k < to.length; k++, at++) {
      edgeTo[at] = to[k]!;
      edgeCost[at] = cost[k]!;
    }
  }
  return { cell, count, xs, ys, zs, edgeStart, edgeTo, edgeCost, component };
}

/**
 * Cost of traversing between two nodes: the true 3D length of the segment,
 * before the clearance uplift priced() applies on top.
 *
 * Every edge cost in the graph MUST be at least this, links included, and
 * findPath's heuristic must stay the straight-line 3D distance. That pairing
 * is what makes the heuristic admissible — a straight line is never longer
 * than a path of segments — and admissibility is what makes A* return the
 * shortest route rather than merely a route.
 *
 * Charging only the planar run, as this first did, breaks it the moment a
 * link has any rise at all: at the foot of the elevation map's internal
 * flight the true cost to the top is its 9 m run, while a heuristic adding
 * |Δy| asks for 12.6. Not a future-steep-staircase hazard — it was wrong for
 * the maps already in the repo.
 */
function edgeLength(from: NavNode, to: NavNode): number {
  return Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
}

/** Whether one node can step to another: small rise, and standable on arrival. */
function walkable(from: NavNode, to: NavNode, stepHeight: number, probe: NavProbe): boolean {
  if (Math.abs(to.y - from.y) > stepHeight + 1e-6) return false;
  return probe.canStand(to.x, to.z, from.y);
}

/** Planar distance from a node to the segment between two points. */
function distanceToSegmentXZ(n: NavNode, from: THREE.Vector3, to: THREE.Vector3): number {
  const vx = to.x - from.x, vz = to.z - from.z;
  const len2 = vx * vx + vz * vz;
  const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((n.x - from.x) * vx + (n.z - from.z) * vz) / len2));
  return Math.hypot(n.x - (from.x + t * vx), n.z - (from.z + t * vz));
}

/** Whether ANY node in a neighbouring column is a legal step from `from`. */
function stepsInto(
  from: NavNode,
  neighbour: number[] | undefined,
  nodes: readonly NavNode[],
  stepHeight: number,
  probe: NavProbe,
): boolean {
  if (!neighbour) return false;
  for (const i of neighbour) {
    if (walkable(from, nodes[i]!, stepHeight, probe)) return true;
  }
  return false;
}

/** Index of the node in a built graph nearest a world point, weighting height heavily. */
export function nearestNode(grid: NavGrid, to: THREE.Vector3): number {
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < grid.count; i++) {
    const dy = (grid.ys[i]! - to.y) * 4; // a metre of height beats metres of ground
    const dx = grid.xs[i]! - to.x;
    const dz = grid.zs[i]! - to.z;
    const score = dx * dx + dz * dz + dy * dy;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** Index of the nearest node in a list still under construction. */
function nearestOf(nodes: readonly NavNode[], to: THREE.Vector3): number {
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    const dy = (n.y - to.y) * 4;
    const score = (n.x - to.x) ** 2 + (n.z - to.z) ** 2 + dy * dy;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/**
 * Shortest walk between two world points, as waypoints to steer at, or null
 * when the graph holds no route. Shortest, not merely valid — see the
 * heuristic below for the invariant that buys that.
 *
 * Endpoints snap to their nearest node, so a caller standing slightly off-grid
 * still gets a path; the returned list starts at the first node and ends at
 * the one nearest `to`, and does NOT include the caller's own position.
 */
export interface RouteWaypoint {
  point: THREE.Vector3;
  /** Travel from the preceding point to this point using this elevator. */
  elevatorId?: string;
}

export function findPath(grid: NavGrid, from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[] | null {
  return findTransportPath(grid, from, to)?.map(w => w.point) ?? null;
}

export function findTransportPath(grid: NavGrid, from: THREE.Vector3, to: THREE.Vector3): RouteWaypoint[] | null {
  const start = nearestNode(grid, from);
  const goal = nearestNode(grid, to);
  if (start < 0 || goal < 0) return null;
  if (start === goal) return [{ point: nodeVec(grid, goal) }];

  const tx = grid.xs[goal]!, ty = grid.ys[goal]!, tz = grid.zs[goal]!;
  // Straight-line 3D distance stays admissible: edges cost at least their
  // 3D length; elevator waits add nonnegative cost. Keep the two in step: an edge cheaper
  // than the distance it covers, or a heuristic charging for something edges
  // do not, silently turns A* into "finds a path" instead of "finds the
  // shortest path", with nothing anywhere reporting it.
  const heuristic = (i: number): number =>
    Math.hypot(grid.xs[i]! - tx, grid.ys[i]! - ty, grid.zs[i]! - tz);

  const best = new Float64Array(grid.count).fill(Infinity);
  const cameFrom = new Int32Array(grid.count).fill(-1);
  const priority = new Float64Array(grid.count).fill(Infinity);
  best[start] = 0;
  priority[start] = heuristic(start);

  // A real binary heap, not a scanned array: the grid runs to five figures of
  // nodes and this is re-run per bot on a timer, so an O(n) pick of the
  // minimum is what would make it show up in a frame budget.
  const open = new MinHeap(priority);
  open.push(start);

  while (open.size > 0) {
    const current = open.pop();
    if (current === goal) break;

    const rowEnd = grid.edgeStart[current + 1]!;
    for (let e = grid.edgeStart[current]!; e < rowEnd; e++) {
      const next = grid.edgeTo[e]!;
      const tentative = best[current]! + grid.edgeCost[e]!;
      if (tentative >= best[next]!) continue;
      best[next] = tentative;
      cameFrom[next] = current;
      priority[next] = tentative + heuristic(next);
      // Re-pushing a node already queued is the standard "lazy deletion"
      // trade: cheaper than locating and re-keying it, and the stale copy is
      // harmless because it pops later with a worse key and its neighbours
      // all fail the `tentative >= best` test.
      open.push(next);
    }
  }

  if (cameFrom[goal] === -1 && start !== goal) return null;

  const path: RouteWaypoint[] = [];
  for (let at = goal; at !== -1; at = cameFrom[at]!) {
    const elevatorId = grid.elevatorEdges?.get(`${cameFrom[at]!}:${at}`);
    path.push({ point: nodeVec(grid, at), ...(elevatorId ? { elevatorId } : {}) });
    if (at === start) break;
  }
  path.reverse();
  return path;
}

function nodeVec(grid: NavGrid, i: number): THREE.Vector3 {
  return new THREE.Vector3(grid.xs[i], grid.ys[i], grid.zs[i]);
}

/** Patrol candidate samples drawn per selection — bounds the selector's rng cost. */
export const PATROL_SAMPLE_COUNT = 8;
/**
 * Planar distance (m) from the bot at which a sampled node qualifies
 * outright. Patrol destinations must be materially elsewhere; the planar
 * measure is the right one because the result steers a walk, while combat
 * pursuit keeps its 3D ranges.
 */
export const PATROL_MIN_DISTANCE_M = 12;

/**
 * Pick a patrol destination over the graph's nodes — pure and deterministic
 * under the injected `rng`, so selection policy stays out of engine/DOM code.
 *
 * At most `PATROL_SAMPLE_COUNT` nodes are drawn uniformly (fewer when the
 * graph is smaller). Samples outside the bot's own connected component are
 * skipped — the graph holds no route to them, so accepting one costs an idle
 * bot a fresh one-second pause standing still. The FIRST same-component
 * sampled node at least `PATROL_MIN_DISTANCE_M` away wins immediately;
 * otherwise the farthest same-component sampled node that is not the bot's
 * own does. `-1` means no different reachable node could be selected — an
 * empty graph, an isolated bot node, or a sample that never left the bot's
 * own node or component.
 */
export function pickPatrolNode(
  grid: NavGrid,
  selfFeet: THREE.Vector3,
  currentIndex: number,
  rng: () => number,
): number {
  if (grid.count === 0) return -1;
  const own = currentIndex >= 0 && currentIndex < grid.count
    ? grid.component[currentIndex]!
    : -1;
  let best = -1;
  let bestDist = -1;
  const samples = Math.min(PATROL_SAMPLE_COUNT, grid.count);
  for (let s = 0; s < samples; s++) {
    const i = Math.floor(rng() * grid.count);
    if (i === currentIndex) continue;
    // A cross-component candidate is a guaranteed routing rejection, so it
    // is not a candidate at all — neither an early win nor the fallback.
    if (own !== -1 && grid.component[i]! !== own) continue;
    const d = Math.hypot(grid.xs[i]! - selfFeet.x, grid.zs[i]! - selfFeet.z);
    if (d >= PATROL_MIN_DISTANCE_M) return i;
    if (d > bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** Min-heap of node indices, ordered by an external priority array. */
class MinHeap {
  private readonly items: number[] = [];

  constructor(private readonly priority: Float64Array) {}

  get size(): number {
    return this.items.length;
  }

  push(node: number): void {
    const items = this.items;
    items.push(node);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.priority[items[parent]!]! <= this.priority[items[i]!]!) break;
      [items[parent], items[i]] = [items[i]!, items[parent]!];
      i = parent;
    }
  }

  pop(): number {
    const items = this.items;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length === 0) return top;
    items[0] = last;
    let i = 0;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let small = i;
      if (left < items.length && this.priority[items[left]!]! < this.priority[items[small]!]!) small = left;
      if (right < items.length && this.priority[items[right]!]! < this.priority[items[small]!]!) small = right;
      if (small === i) break;
      [items[small], items[i]] = [items[i]!, items[small]!];
      i = small;
    }
    return top;
  }
}
