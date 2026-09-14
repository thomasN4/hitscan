// domSpawnDraw.ts — pure domination respawn draws.
//
// The director (domSpawns.ts) picks uniformly ACROSS zones — one share per
// owned flag plus one for the home zone — and these helpers draw uniformly
// WITHIN the picked zone: a uniform rect for the home zone, an area-uniform
// annulus around a flag. No engine, no DOM, no reads of shared state, so the
// suite scripts them with a stub rng in plain Node.
//
// Rng budget per draw, in order: the zone pick consumes one call, then the
// point consumes two (angle + radius fraction for a ring, x + z fractions
// for the rect). Scripted-rng tests pin that sequence.
import type { SpawnZone } from '../core/state';

/** A candidate respawn point: world-space position with feet height. */
export interface SpawnCandidate {
  x: number;
  y: number;
  z: number;
}

/**
 * Flag-ring band (m): inside the capture radius would spawn onto the fight,
 * outside 10 m is not "near" it.
 */
export const DOM_RING_INNER = 4;
export const DOM_RING_OUTER = 10;

/**
 * Pick the respawning zone: owned flags occupy indices 0..k-1 in the caller's
 * order, the home zone is index k. Each of the k+1 zones takes an equal
 * share — with A+B owned that is 1/3 for A, 1/3 for B, 1/3 for home.
 */
export function pickDomZoneIndex(ownedCount: number, rng: () => number): number {
  return Math.floor(rng() * (ownedCount + 1));
}

/** Uniform point in a home-zone rect, at the zone's feet height. */
export function drawZonePoint(zone: SpawnZone, rng: () => number): SpawnCandidate {
  return {
    x: zone.minX + rng() * (zone.maxX - zone.minX),
    y: zone.y,
    z: zone.minZ + rng() * (zone.maxZ - zone.minZ),
  };
}

/**
 * Area-uniform point in a flag's ring, at the flag's feet height. The radius
 * is sqrt-sampled so equal areas are equally likely — a uniform radius would
 * bunch draws against the inner edge (area grows with r).
 */
export function drawRingPoint(
  flag: { x: number; y: number; z: number },
  rng: () => number,
  inner: number = DOM_RING_INNER,
  outer: number = DOM_RING_OUTER,
): SpawnCandidate {
  const a = rng() * Math.PI * 2;
  const u = rng();
  const r = Math.sqrt(u * (outer * outer - inner * inner) + inner * inner);
  return { x: flag.x + Math.cos(a) * r, y: flag.y, z: flag.z + Math.sin(a) * r };
}
