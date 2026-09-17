// stairs.ts — the scalar endpoint arithmetic shared by navigation and the maps.
//
// world.ts:stairLink publishes a flight's endpoints as a NavLink (THREE
// vectors); scripts/mapSvg.mjs:flightTop draws the same landing on paper.
// Both used to compute the landing inline from the same formula, so the
// reference map could drift from the graph it documents without any gate
// noticing. This module owns the formula — pure numbers in, plain numbers
// out, no engine, no DOM — and both call sites delegate to it.
//
// The single `import type` below is erased, so nothing is pulled into Node at
// runtime (the sim/damage.ts seam).
import type { StairDir } from '../world';

/** A flight landing in world coordinates, as plain numbers (no THREE). */
export interface StairTop {
  x: number;
  y: number;
  z: number;
}

/**
 * Landing of one stair flight: the point navigation aims at.
 *
 * (x, z) is the flight's origin — step 0's centre sits half a tread along
 * `dir` from it, so the origin itself is the floor immediately at the mouth.
 * The far edge of the last step sits `count` treads along, at `count` risers
 * up. `y` is the base the flight stands on.
 */
export function stairTop(
  x: number,
  y: number,
  z: number,
  stepH: number,
  stepD: number,
  count: number,
  dir: StairDir,
): StairTop {
  const run = count * stepD;
  return {
    x: dir === 'x+' ? x + run : dir === 'x-' ? x - run : x,
    y: y + count * stepH,
    z: dir === 'z+' ? z + run : dir === 'z-' ? z - run : z,
  };
}
