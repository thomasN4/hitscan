// Pins the pure half of the DEV bot-observation overlay (debugView.ts).
//
// The overlay itself is a presentation change, and lesson 25 is explicit that
// confirming presentation maths is not confirming anything is visible — the
// playtest is that gate. What this suite covers is the part a playtest cannot
// check by eye: which segments get emitted, and that consumed waypoints are
// dropped rather than drawn back toward where the bot has already been.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildDebugSegments, type DebugBotView, type DebugViewBasis } from './debugView';

const LIFT = 0.05; // must match debugView.ts's floor lift
/** Segments the screen-facing marker contributes per living bot (a diamond). */
const MARKER_SEGS = 4;
const MARKER_VERTS = MARKER_SEGS * 2;

/**
 * A camera at the origin looking down -z, so `right` is +x and `up` is +y —
 * the marker's plane is then the xy plane and its shape is easy to assert.
 */
const VIEW: DebugViewBasis = {
  right: new THREE.Vector3(1, 0, 0),
  up: new THREE.Vector3(0, 1, 0),
  eye: new THREE.Vector3(0, 0, 0),
};

function bot(over: Partial<DebugBotView> = {}): DebugBotView {
  const position = over.mesh?.position ?? new THREE.Vector3(0, 0, 0);
  return {
    alive: true,
    team: 'T',
    mode: 'engage',
    mesh: { position },
    navPath: [],
    navLeg: 0,
    targetEye: null,
    targetInRange: false,
    targetLOS: null,
    eyePos: () => new THREE.Vector3(position.x, position.y + 1.9, position.z),
    ...over,
  };
}

function buffers(): { pos: Float32Array; col: Float32Array } {
  return { pos: new Float32Array(24 * 64 * 2 * 3), col: new Float32Array(24 * 64 * 2 * 3) };
}

/**
 * Assert vertex `i` is a given point. Compared with a tolerance because the
 * buffer is Float32Array — 1.9 round-trips as 1.899999976158142.
 */
function expectVertex(pos: Float32Array, i: number, x: number, y: number, z: number): void {
  expect(pos[i * 3]!).toBeCloseTo(x, 5);
  expect(pos[i * 3 + 1]!).toBeCloseTo(y, 5);
  expect(pos[i * 3 + 2]!).toBeCloseTo(z, 5);
}

describe('buildDebugSegments', () => {
  it('draws the remaining route from the bot, skipping consumed waypoints', () => {
    const { pos, col } = buffers();
    const b = bot({
      mesh: { position: new THREE.Vector3(1, 0, 1) },
      navPath: [
        new THREE.Vector3(2, 0, 2),
        new THREE.Vector3(3, 0, 3),
        new THREE.Vector3(4, 3.6, 4),
      ],
      navLeg: 1,
    });

    const verts = buildDebugSegments([b], pos, col, VIEW);

    // Two legs remain (leg 1 -> 2, and the bot's own position -> leg 1), so
    // two segments; the consumed waypoint contributes nothing. The marker
    // follows every living bot, targeted or not.
    expect(verts).toBe(4 + MARKER_VERTS);
    expectVertex(pos, 0, 1, LIFT, 1);        // starts AT the bot
    expectVertex(pos, 1, 3, LIFT, 3);        // straight to the current leg
    expectVertex(pos, 2, 3, LIFT, 3);
    expectVertex(pos, 3, 4, 3.6 + LIFT, 4);  // keeps the waypoint's own height
  });

  it('emits an intent line from the eye to the target', () => {
    const { pos, col } = buffers();
    const b = bot({
      mesh: { position: new THREE.Vector3(0, 0, 0) },
      targetEye: new THREE.Vector3(10, 5.3, 0),
    });

    expect(buildDebugSegments([b], pos, col, VIEW)).toBe(2 + MARKER_VERTS);
    expectVertex(pos, 0, 0, 1.9, 0);
    expectVertex(pos, 1, 10, 5.3, 0);
  });

  it('colours the intent line by brain mode, all four distinct', () => {
    const { pos, col } = buffers();
    const target = new THREE.Vector3(1, 1, 1);
    const seen: number[][] = [];
    for (const mode of ['hold', 'search', 'route', 'engage'] as const) {
      buildDebugSegments([bot({ mode, targetEye: target })], pos, col, VIEW);
      seen.push([col[0]!, col[1]!, col[2]!]);
    }
    // Every mode tint must be distinguishable from every other — the overlay
    // is the only place a bot's mode is visible at a glance.
    for (let i = 0; i < seen.length; i++) {
      for (let j = i + 1; j < seen.length; j++) {
        expect(seen[i]).not.toEqual(seen[j]);
      }
    }
  });

  // Issue #46: the old single-brightness line read as "everyone is engaging
  // me through walls". The shot gates must grade the tint — hue stays the
  // mode's, brightness says whether this bot can actually fire.
  describe('shot-gate brightness tiers', () => {
    /** First vertex colour written for one bot with the given gates. */
    function tierColor(over: Partial<DebugBotView>): number[] {
      const { pos, col } = buffers();
      buildDebugSegments(
        [bot({ targetEye: new THREE.Vector3(3, 3, 3), ...over })],
        pos, col, VIEW,
      );
      return [col[0]!, col[1]!, col[2]!]; // intent line's first endpoint (no route precedes it)
    }

    it('full brightness only when in range AND sight is proven', () => {
      const shoot = tierColor({ targetInRange: true, targetLOS: true });
      expect(shoot).toEqual([1.0, 0.0, 0.0]); // engage red, unmodified
    });

    it('mid tier when in range but sight is blocked or unproven', () => {
      const blocked = tierColor({ targetInRange: true, targetLOS: false });
      expect(blocked).toEqual([0.5, 0, 0]);
      const unproven = tierColor({ targetInRange: true, targetLOS: null });
      expect(unproven).toEqual(blocked); // null means "no probe taken", not "clear"
    });

    it('dims a bot whose target is beyond engage range, whatever the sight', () => {
      expect(tierColor({ targetInRange: false, targetLOS: true })).toEqual([0.25, 0, 0]);
      expect(tierColor({ targetInRange: false, targetLOS: false })).toEqual([0.25, 0, 0]);
    });

    it('never grants full brightness to a holding bot', () => {
      // Hold (stage 1): no visual observation, no lookAt, no shot. The
      // marker still floats — a standing bot must stay visible — but at the
      // dim tier in its own hue, never the shootable one.
      const { pos, col } = buffers();
      const verts = buildDebugSegments(
        [bot({ mode: 'hold', targetEye: null, targetInRange: false, targetLOS: null })],
        pos, col, VIEW,
      );
      // No intent line (nothing to look at): the marker alone, dimmed orange.
      expect(verts).toBe(MARKER_VERTS);
      expect(col[0]).toBeCloseTo(0.25, 12);      // 0.25 × hold red
      expect(col[1]).toBeCloseTo(0.125, 12);     // 0.25 × hold green
      expect(col[2]).toBeCloseTo(0, 12);
    });

    it('keeps a search intent line dim even though its endpoint is non-null', () => {
      // A memory or damage search exposes a scan lookAt (a frozen remembered
      // eye, or a direction-only heading), but the endpoint is NOT a seen
      // target: the line is drawn, yet stays at the dim, non-shootable tier
      // in the search hue.
      const { pos, col } = buffers();
      const verts = buildDebugSegments(
        [bot({
          mode: 'search',
          targetEye: new THREE.Vector3(3, 1.9, 0),
          targetInRange: false,
          targetLOS: null,
        })],
        pos, col, VIEW,
      );
      expect(verts).toBe(2 + MARKER_VERTS); // the intent line is still emitted
      expectVertex(pos, 0, 0, 1.9, 0);
      expectVertex(pos, 1, 3, 1.9, 0);
      expect(col[0]).toBeCloseTo(0.25, 12); // 0.25 × search yellow
      expect(col[1]).toBeCloseTo(0.25, 12);
      expect(col[2]).toBeCloseTo(0, 12);
    });
  });

  it('colours routes by team', () => {
    const { pos, col } = buffers();
    const path = [new THREE.Vector3(5, 0, 5)];
    buildDebugSegments([bot({ team: 'T', navPath: path })], pos, col, VIEW);
    const tSide = [col[0], col[1], col[2]];
    buildDebugSegments([bot({ team: 'CT', navPath: path })], pos, col, VIEW);
    expect([col[0], col[1], col[2]]).not.toEqual(tSide);
  });

  // The marker is the whole reason the builder takes a camera basis: an intent
  // line ending at the viewpoint projects to a single pixel, so it cannot show
  // the case that matters most — a bot targeting the player. See debugView.ts.
  describe('the screen-facing marker', () => {
    it('lies in the plane spanned by the camera basis', () => {
      const { pos, col } = buffers();
      const b = bot({ mesh: { position: new THREE.Vector3(3, 0, -7) } });
      const verts = buildDebugSegments([b], pos, col, VIEW);

      expect(verts).toBe(MARKER_VERTS); // no route, no target: the marker alone
      // VIEW's basis is right=+x, up=+y, so every marker vertex must sit at the
      // bot's own z — a marker with any z spread would not be facing the camera.
      for (let i = 0; i < verts; i++) expect(pos[i * 3 + 2]!).toBeCloseTo(-7, 5);
    });

    it('floats above the bot rather than inside it', () => {
      const { pos, col } = buffers();
      const b = bot({ mesh: { position: new THREE.Vector3(0, 0, -10) } });
      buildDebugSegments([b], pos, col, VIEW);
      // Head cube tops out at ~2.17 m; every vertex must clear it.
      for (let i = 0; i < MARKER_VERTS; i++) expect(pos[i * 3 + 1]!).toBeGreaterThan(2.2);
    });

    it('holds apparent size by scaling with distance', () => {
      const near = buffers();
      const far = buffers();
      const spread = (pos: Float32Array) => {
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < MARKER_VERTS; i++) { lo = Math.min(lo, pos[i * 3]!); hi = Math.max(hi, pos[i * 3]!); }
        return hi - lo;
      };
      buildDebugSegments([bot({ mesh: { position: new THREE.Vector3(0, 0, -10) } })], near.pos, near.col, VIEW);
      buildDebugSegments([bot({ mesh: { position: new THREE.Vector3(0, 0, -40) } })], far.pos, far.col, VIEW);
      // Four times the distance, so roughly four times the world width — which
      // is what keeps the SCREEN width the same.
      expect(spread(far.pos) / spread(near.pos)).toBeGreaterThan(3);
    });

    it('is tinted by brain mode', () => {
      const { pos, col } = buffers();
      buildDebugSegments([bot({ mode: 'route' })], pos, col, VIEW);
      const routing = [col[0], col[1], col[2]];
      buildDebugSegments([bot({ mode: 'engage' })], pos, col, VIEW);
      expect([col[0], col[1], col[2]]).not.toEqual(routing);
    });

    it('is drawn for a bot targeting the player, where the intent line cannot be', () => {
      const { pos, col } = buffers();
      // targetEye AT the camera: the degenerate case measured in debugView.ts.
      const b = bot({ mesh: { position: new THREE.Vector3(0, 0, -10) }, targetEye: VIEW.eye.clone() });
      expect(buildDebugSegments([b], pos, col, VIEW)).toBe(2 + MARKER_VERTS);
    });
  });

  it('draws nothing for a dead bot', () => {
    const { pos, col } = buffers();
    const b = bot({ alive: false, navPath: [new THREE.Vector3(2, 0, 2)], targetEye: new THREE.Vector3(3, 3, 3) });
    expect(buildDebugSegments([b], pos, col, VIEW)).toBe(0);
  });

  it('still draws the intent line for a bot with no route', () => {
    const { pos, col } = buffers();
    expect(buildDebugSegments([bot({ targetEye: new THREE.Vector3(3, 3, 3) })], pos, col, VIEW)).toBe(2 + MARKER_VERTS);
  });

  it('drops segments past capacity rather than writing out of bounds', () => {
    const { pos, col } = buffers();
    // 24 bots is the buffer's whole budget; a 25th must be refused silently.
    const long = Array.from({ length: 200 }, (_, i) => new THREE.Vector3(i, 0, 0));
    const crowd = Array.from({ length: 40 }, () => bot({ navPath: long, targetEye: new THREE.Vector3(1, 1, 1) }));
    const verts = buildDebugSegments(crowd, pos, col, VIEW);
    expect(verts).toBeLessThanOrEqual(pos.length / 3);
  });

  it('accumulates across bots', () => {
    const { pos, col } = buffers();
    const one = bot({ navPath: [new THREE.Vector3(1, 0, 0)] });
    const two = bot({ team: 'CT', navPath: [new THREE.Vector3(2, 0, 0)] });
    expect(buildDebugSegments([one, two], pos, col, VIEW)).toBe(4 + 2 * MARKER_VERTS);
  });
});
