// perception.ts — bot visual acquisition as a pure seam.
//
// The pre-perception bot chose its target by POSITION (nearestOpposing under
// the brain's scorer) and then probed line-of-sight to whatever it had already
// picked — omniscient targeting with an honesty check bolted on. This module
// inverts that: candidates are identified first, and only a successful look
// through the injected LOS callback yields a VisualObservation. The brain sees
// ZERO or ONE observation per frame — never a ranked list, never a position it
// did not see.
//
// Engine-free and DOM-free like everything in sim/: the raycast arrives as an
// injected callback, the same seam pattern as navGrid's NavProbe. One call
// spends AT MOST ONE ray, so a dozen bots cost a dozen rays per frame worst
// case, not one per candidate.
import * as THREE from 'three';

/**
 * Stable identity of a perceivable entity. The player is the fixed string
 * 'player'; bots are their per-match serial (core/state.ts:Bot.id), which
 * survives death/respawn. Identities — not positions — are what the brain
 * tracks across frames.
 */
export type PerceptionId = 'player' | number;

/** One opposing entity as perception sees it: identity + geometry + liveness. */
export interface VisualCandidate {
  id: PerceptionId;
  /** World-space FEET position (feet-aware convention — see collision.ts). */
  feet: THREE.Vector3;
  /** World-space eye position: the LOS endpoint and range reference. */
  eye: THREE.Vector3;
  alive: boolean;
}

/** What one successful look reveals about a candidate. All values COPIED or derived — no live references escape. */
export interface VisualObservation {
  id: PerceptionId;
  /** Copy of the observed entity's feet position. */
  feet: THREE.Vector3;
  /** Copy of the observed entity's eye position. */
  eye: THREE.Vector3;
  /** Planar (XZ) distance from self feet to the observed feet — the closure measure. */
  dist: number;
  /** Eye-to-eye 3D distance — the same range the hit die and bands read. */
  dist3: number;
  /** Observed feet minus self feet (m). Positive: the target is above. */
  rise: number;
}

/**
 * Perception range (m): full 3D eye-to-eye distance beyond which a candidate
 * is a cheap rejection. Inclusive boundary — exactly 80 m is still visible.
 */
export const PERCEPTION_RANGE_M = 80;
/**
 * Horizontal FOV (degrees, TOTAL cone width): candidates farther than half of
 * this off the bot's planar facing are cheap rejections. Vertical angle never
 * narrows the cone — a bot looking at the ground plane still "sees" a deck
 * overhead that its planar facing covers.
 */
export const PERCEPTION_FOV_DEG = 120;

const COS_HALF_FOV = Math.cos((PERCEPTION_FOV_DEG / 2) * (Math.PI / 180));

/** The executor's raycast, injected so this module stays testable in plain Node. */
export type LosProbe = (from: THREE.Vector3, to: THREE.Vector3) => boolean;

/** The perceiving bot's own geometry for one acquisition call. */
export interface PerceptionSelf {
  /** World-space eye position: LOS origin and range reference. */
  eye: THREE.Vector3;
  /** World-space feet position: the rise and planar-distance reference. */
  feet: THREE.Vector3;
  /** Normalized planar facing (the FOV basis). */
  facing: THREE.Vector3;
}

/** Result of one acquisition call: at most one observation, plus bookkeeping for tests/observability. */
export interface VisualAcquisition {
  /** The frame's look, or null when nothing was seen. */
  observation: VisualObservation | null;
  /**
   * Next fair-rotation cursor (index into the deterministically ordered
   * candidate list). Advances past a NON-focused attempt whether its LOS
   * succeeded or failed; unchanged when the focused candidate consumed the
   * frame's ray or when nothing was eligible to probe.
   */
  cursor: number;
  /**
   * Id of the candidate this call spent its single ray on, or null when no
   * ray was spent (empty list, or every candidate cheap-rejected).
   */
  attempted: PerceptionId | null;
}

/** Deterministic candidate order: the player first, then bots by ascending id. */
function compareIds(a: PerceptionId, b: PerceptionId): number {
  if (a === 'player') return b === 'player' ? 0 : -1;
  if (b === 'player') return 1;
  return a - b;
}

/**
 * Cheap eligibility: everything decidable WITHOUT a ray. Dead, out-of-range,
 * behind-FOV and zero-planar-offset candidates are rejected here and never
 * reach the LOS callback.
 */
function cheaplyVisible(self: PerceptionSelf, c: VisualCandidate): boolean {
  if (!c.alive) return false;
  const dx = c.eye.x - self.eye.x;
  const dy = c.eye.y - self.eye.y;
  const dz = c.eye.z - self.eye.z;
  if (Math.hypot(dx, dy, dz) > PERCEPTION_RANGE_M) return false;
  // FOV is horizontal only: normalized XZ of the eye-to-eye offset vs facing.
  // Zero planar offset (directly overhead/beneath) has no horizontal
  // direction — a cheap rejection, since vertical angle never widens the cone.
  const planar = Math.hypot(dx, dz);
  if (planar === 0) return false;
  const dot = (dx / planar) * self.facing.x + (dz / planar) * self.facing.z;
  // Inclusive cosine boundary: dot === cos(halfFov) is still inside the cone.
  // A floating-point-scale tolerance absorbs the one-ulp gap between a
  // mathematically exact half-angle direction's normalized dot and
  // Math.cos(halfFov); a meaningfully outside direction stays rejected.
  return dot >= COS_HALF_FOV - 1e-12;
}

/** Build the observation for a candidate that just passed LOS. Vectors are copied. */
function observe(self: PerceptionSelf, c: VisualCandidate): VisualObservation {
  const feet = c.feet.clone();
  const eye = c.eye.clone();
  return {
    id: c.id,
    feet,
    eye,
    dist: Math.hypot(feet.x - self.feet.x, feet.z - self.feet.z),
    dist3: self.eye.distanceTo(eye),
    rise: feet.y - self.feet.y,
  };
}

/**
 * One visual acquisition: at most ONE LOS ray, spent on the best candidate
 * this frame.
 *
 * Order of preference: the CURRENT FOCUS (when cheaply eligible) is probed
 * first, so a tracked identity keeps its look across frames; otherwise the
 * scan rotates fairly from `cursor`, probing the first cheaply-eligible
 * candidate and advancing the cursor past it whether the look succeeded or
 * failed. Cheap rejections never spend the ray, so a scan over a wall of dead
 * or behind-you candidates costs nothing.
 *
 * @param candidates every opposing entity, in any order — it is sorted
 *   deterministically (player first, then ascending bot ids) so the cursor is
 *   stable across frames
 * @param focus the identity the perceiver is tracking, or null
 * @param cursor the fair-rotation start index (any integer; wrapped to the
 *   candidate count)
 * @param los the injected raycast
 */
export function acquireVisual(
  self: PerceptionSelf,
  candidates: readonly VisualCandidate[],
  focus: PerceptionId | null,
  cursor: number,
  los: LosProbe,
): VisualAcquisition {
  const ordered = [...candidates].sort((a, b) => compareIds(a.id, b.id));
  if (ordered.length === 0) return { observation: null, cursor: 0, attempted: null };

  if (focus !== null) {
    const idx = ordered.findIndex(c => c.id === focus);
    if (idx >= 0 && cheaplyVisible(self, ordered[idx]!)) {
      const c = ordered[idx]!;
      if (los(self.eye, c.eye)) {
        return { observation: observe(self, c), cursor, attempted: c.id };
      }
      // The focused look failed: it consumed the frame's ray, so nothing else
      // is probed — but the identity stays tracked (the caller keeps focus).
      return { observation: null, cursor, attempted: c.id };
    }
    // Cheaply ineligible focus: fall through to the fair rotation.
  }

  const start = ((cursor % ordered.length) + ordered.length) % ordered.length;
  for (let k = 0; k < ordered.length; k++) {
    const i = (start + k) % ordered.length;
    const c = ordered[i]!;
    if (!cheaplyVisible(self, c)) continue;
    if (los(self.eye, c.eye)) {
      return { observation: observe(self, c), cursor: (i + 1) % ordered.length, attempted: c.id };
    }
    return { observation: null, cursor: (i + 1) % ordered.length, attempted: c.id };
  }
  // Nothing eligible this frame: the cursor holds so the next scan resumes
  // where this one would have started.
  return { observation: null, cursor: start, attempted: null };
}
