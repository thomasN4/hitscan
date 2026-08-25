// Pins the pure half of the DEV bot-observation overlay (debugView.ts).
//
// The overlay itself is a presentation change, and lesson 25 is explicit that
// confirming presentation maths is not confirming anything is visible — the
// playtest is that gate. What this suite covers is the part a playtest cannot
// check by eye: which segments get emitted, and that consumed waypoints are
// dropped rather than drawn back toward where the bot has already been.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildDebugSegments, type DebugBotView } from './debugView';

const LIFT = 0.05; // must match debugView.ts's floor lift

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

    const verts = buildDebugSegments([b], pos, col);

    // Two legs remain (leg 1 -> 2, and the bot's own position -> leg 1), so
    // two segments; the consumed waypoint contributes nothing.
    expect(verts).toBe(4);
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

    expect(buildDebugSegments([b], pos, col)).toBe(2);
    expectVertex(pos, 0, 0, 1.9, 0);
    expectVertex(pos, 1, 10, 5.3, 0);
  });

  it('colours the intent line by brain mode', () => {
    const { pos, col } = buffers();
    const target = new THREE.Vector3(1, 1, 1);
    buildDebugSegments([bot({ mode: 'route', targetEye: target })], pos, col);
    const routing = [col[0], col[1], col[2]];
    buildDebugSegments([bot({ mode: 'engage', targetEye: target })], pos, col);
    expect([col[0], col[1], col[2]]).not.toEqual(routing);
  });

  it('colours routes by team', () => {
    const { pos, col } = buffers();
    const path = [new THREE.Vector3(5, 0, 5)];
    buildDebugSegments([bot({ team: 'T', navPath: path })], pos, col);
    const tSide = [col[0], col[1], col[2]];
    buildDebugSegments([bot({ team: 'CT', navPath: path })], pos, col);
    expect([col[0], col[1], col[2]]).not.toEqual(tSide);
  });

  it('draws nothing for a dead bot', () => {
    const { pos, col } = buffers();
    const b = bot({ alive: false, navPath: [new THREE.Vector3(2, 0, 2)], targetEye: new THREE.Vector3(3, 3, 3) });
    expect(buildDebugSegments([b], pos, col)).toBe(0);
  });

  it('still draws the intent line for a bot with no route', () => {
    const { pos, col } = buffers();
    expect(buildDebugSegments([bot({ targetEye: new THREE.Vector3(3, 3, 3) })], pos, col)).toBe(2);
  });

  it('drops segments past capacity rather than writing out of bounds', () => {
    const { pos, col } = buffers();
    // 24 bots is the buffer's whole budget; a 25th must be refused silently.
    const long = Array.from({ length: 200 }, (_, i) => new THREE.Vector3(i, 0, 0));
    const crowd = Array.from({ length: 40 }, () => bot({ navPath: long, targetEye: new THREE.Vector3(1, 1, 1) }));
    const verts = buildDebugSegments(crowd, pos, col);
    expect(verts).toBeLessThanOrEqual(pos.length / 3);
  });

  it('accumulates across bots', () => {
    const { pos, col } = buffers();
    const one = bot({ navPath: [new THREE.Vector3(1, 0, 0)] });
    const two = bot({ team: 'CT', navPath: [new THREE.Vector3(2, 0, 0)] });
    expect(buildDebugSegments([one, two], pos, col)).toBe(4);
  });
});
