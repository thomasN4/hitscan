// maps/mapSpec.ts — the shared vocabulary for the per-map pure geometry specs.
//
// Each map's placement arithmetic lives in its `<name>Spec.ts` sibling as plain
// data (no scene, no materials, no DOM), and the `<name>.ts` builder attaches
// that data to the world. scripts/mapSvg.mjs + mapPng.mjs render the same data to
// docs/maps/*.png. One source of truth, two consumers — a map cannot drift
// from its reference drawing without also moving its own geometry, and the
// scripts/mapSvgs.test.mjs gate fails while a committed PNG is stale.
//
// The split follows the sim/recoil.ts:convertOnSwap precedent: rather than
// mocking the browser for the suite, the pure half moves behind a seam the
// suite can reach. Spec modules import nothing at runtime (only `import type`),
// so they stay importable anywhere — vitest, a plain-node script, or the game.
import type { StairDir } from '../world';

/**
 * Render semantics for one placed box: what the reference map draws, and (via
 * each builder's kind -> material switch) what the game builds.
 *
 * `wall`/`wall2` are the same masonry fill on paper in two builder materials;
 * `deck` is a walkable surface with air beneath it (slabs, bridges, docks);
 * `rail` is a low edge wall (parapets, void rails); `stair` is step paint —
 * flights that match their map's trim share its kind, flights with their own
 * finish take `stair`; the rest are what they say.
 */
export type MapBoxKind =
  | 'wall' | 'wall2' | 'deck' | 'crate' | 'rack' | 'rail' | 'stair'
  | 'fence' | 'post' | 'conveyor' | 'pad'
  | 'roof' | 'glass' | 'beam' | 'marker';

/** One solid box, in world.ts:addSolidBox argument order (base y, not centre). */
export interface MapBox {
  x: number;
  /** Base y — the ground the box stands on, exactly as addSolidBox takes it. */
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  kind: MapBoxKind;
}

/** One stair flight, in world.ts:addStairs/addOpenStairs argument order. */
export interface FlightSpec {
  x: number;
  y: number;
  z: number;
  width: number;
  stepH: number;
  stepD: number;
  count: number;
  dir: StairDir;
  /** True for world.ts:addOpenStairs (thin treads, walk-under), false for addStairs. */
  open: boolean;
  /** Tread plate thickness; present exactly when open (addOpenStairs' treadT). */
  treadT?: number;
  /**
   * Material key for the steps, through the builder's kind -> material switch.
   * Steps are boxes too, and maps vary them (elevation's plateau flight wears
   * matWall beside matWall2 siblings) — so the finish lives with the numbers
   * rather than as a second call-site comparison in the builder.
   */
  kind: MapBoxKind;
}

/** One cargo lift, sans material and Vector3s (the builder adds both). */
export interface LiftSpec {
  id: string;
  x: number;
  z: number;
  width: number;
  depth: number;
  thickness: number;
  lowerY: number;
  upperY: number;
  speed: number;
  dwell: number;
  lowerLanding: [number, number, number];
  upperLanding: [number, number, number];
}

/** One range target: position, platform height and facing (builder owns part dims). */
export interface TargetSpec {
  x: number;
  z: number;
  height: number;
  yaw: number;
}

/** One painted floor label (builder owns the canvas texture, the map owns the text). */
export interface LabelSpec {
  x: number;
  z: number;
  text: string;
}

/** The ground the reference map draws as its background (builders own their planes). */
export interface GroundRect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Everything one reference map draws, in build order. */
export interface MapSpec {
  /** MapName key: docs/maps/<name>.png. Must match a BUILDERS key. */
  name: string;
  ground: GroundRect;
  boxes: MapBox[];
  flights: FlightSpec[];
  lifts: LiftSpec[];
  targets: TargetSpec[];
  labels: LabelSpec[];
  /** Free-form notes the renderer prints under the legend (omissions, joins). */
  notes: string[];
}

/**
 * Split a wall/rail/fence run into solid segments between `gaps`.
 *
 * The pure half of maps/warehouse2.ts:wallRun (and its railRun/fenceSide
 * siblings): `gaps` are openings along the run, ascending and non-overlapping.
 * Returns [start, end] pairs; a gap flush with either end leaves no segment
 * (under 0.05 m is treated as no segment, as the builders do). Callers turn
 * pairs into boxes with their own mid/len/height — the segmentation is what is
 * shared, not the cross-section.
 */
export function segmentRun(
  from: number,
  to: number,
  gaps: readonly (readonly [number, number])[],
): [number, number][] {
  const cuts: number[] = [from, ...gaps.flat(), to];
  const segs: [number, number][] = [];
  // i + 1 < length bounds both reads below, so the assertions are the
  // bound-guarded kind (no fallback invents a segment).
  for (let i = 0; i + 1 < cuts.length; i += 2) {
    const a = cuts[i]!;
    const b = cuts[i + 1]!;
    if (b - a >= 0.05) segs.push([a, b]);
  }
  return segs;
}
