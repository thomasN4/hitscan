// soundEvents.test.ts — pins the ring's cursor contract.
//
// The properties under test are the ones bots.ts leans on and cannot check for
// itself: reads never consume, two listeners at different cursors see the same
// events, a listener left behind by wraparound resumes rather than stalls, and
// a captured high-water sequence bounds a whole frame's reads. Expected values
// are written out longhand rather than derived the way the implementation
// derives them.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  SOUND_RING_CAPACITY,
  SoundRing,
  withinEarshot,
  type SoundEmission,
} from './soundEvents';

/** A gunshot at (x, 0, z) from the player, 80 m audible. */
function shot(x: number, z: number, over: Partial<SoundEmission> = {}): SoundEmission {
  return {
    t: over.t ?? 0,
    kind: over.kind ?? 'gunshot',
    sourceId: over.sourceId ?? 'player',
    team: over.team ?? 'CT',
    pos: over.pos ?? new THREE.Vector3(x, 0, z),
    radius: over.radius ?? 80,
  };
}

describe('SoundRing sequencing', () => {
  it('starts empty, at sequence zero', () => {
    const ring = new SoundRing();
    expect(ring.latestSeq).toBe(0);
    expect(ring.since(0)).toEqual([]);
  });

  it('assigns 1-based sequences in emission order', () => {
    const ring = new SoundRing();
    expect(ring.emit(shot(0, 0)).seq).toBe(1);
    expect(ring.emit(shot(1, 0)).seq).toBe(2);
    expect(ring.emit(shot(2, 0)).seq).toBe(3);
    expect(ring.latestSeq).toBe(3);
    expect(ring.since(0).map(e => e.seq)).toEqual([1, 2, 3]);
  });

  it('reads strictly AFTER the cursor', () => {
    const ring = new SoundRing();
    ring.emit(shot(0, 0));
    ring.emit(shot(1, 0));
    expect(ring.since(1).map(e => e.seq)).toEqual([2]);
    expect(ring.since(2)).toEqual([]);
  });

  it('does not consume: the same cursor reads the same events again', () => {
    const ring = new SoundRing();
    ring.emit(shot(0, 0));
    ring.emit(shot(1, 0));
    expect(ring.since(0).map(e => e.seq)).toEqual([1, 2]);
    expect(ring.since(0).map(e => e.seq)).toEqual([1, 2]);
  });

  it('serves two listeners at different cursors independently', () => {
    const ring = new SoundRing();
    ring.emit(shot(0, 0));
    ring.emit(shot(1, 0));
    ring.emit(shot(2, 0));
    // One bot caught up at 2; another has heard nothing at all. Both are
    // entitled to every event they have not read — this is why reads cannot
    // consume.
    expect(ring.since(2).map(e => e.seq)).toEqual([3]);
    expect(ring.since(0).map(e => e.seq)).toEqual([1, 2, 3]);
  });
});

describe('SoundRing capacity', () => {
  it('retains exactly the last SOUND_RING_CAPACITY events', () => {
    const ring = new SoundRing();
    for (let i = 0; i < SOUND_RING_CAPACITY + 10; i++) ring.emit(shot(i, 0));
    const all = ring.since(0);
    expect(all).toHaveLength(SOUND_RING_CAPACITY);
    // 266 emitted, 256 retained: 11..266 inclusive.
    expect(all[0]!.seq).toBe(11);
    expect(all[all.length - 1]!.seq).toBe(SOUND_RING_CAPACITY + 10);
  });

  it('resumes a stale cursor at the oldest RETAINED event', () => {
    const ring = new SoundRing();
    for (let i = 0; i < SOUND_RING_CAPACITY + 10; i++) ring.emit(shot(i, 0));
    // A listener stuck at 3 lost 4..10 to wraparound. It must resume at 11,
    // not stall and not report a gap.
    const heard = ring.since(3);
    expect(heard[0]!.seq).toBe(11);
    expect(heard).toHaveLength(SOUND_RING_CAPACITY);
  });

  it('a full ring is exactly on the retention boundary', () => {
    const ring = new SoundRing();
    for (let i = 0; i < SOUND_RING_CAPACITY; i++) ring.emit(shot(i, 0));
    expect(ring.since(0)[0]!.seq).toBe(1);
    expect(ring.since(0)).toHaveLength(SOUND_RING_CAPACITY);
  });

  it('reset drops everything and restarts sequencing', () => {
    const ring = new SoundRing();
    ring.emit(shot(0, 0));
    ring.reset();
    expect(ring.latestSeq).toBe(0);
    expect(ring.since(0)).toEqual([]);
    expect(ring.emit(shot(0, 0)).seq).toBe(1);
  });
});

describe('SoundRing high-water snapshots', () => {
  it('caps a read at the captured sequence, so a mid-frame emission waits', () => {
    const ring = new SoundRing();
    ring.emit(shot(0, 0));
    ring.emit(shot(1, 0));
    // updateBots captures 2 before iterating; an early bot then fires, making
    // 3. Every bot this frame must still read through 2, or hearing would
    // depend on registry order.
    const highWater = ring.latestSeq;
    ring.emit(shot(2, 0));
    expect(ring.since(0, highWater).map(e => e.seq)).toEqual([1, 2]);
    // Next frame's snapshot picks it up for everyone.
    expect(ring.since(highWater, ring.latestSeq).map(e => e.seq)).toEqual([3]);
  });

  it('a high-water beyond the newest event is harmless', () => {
    const ring = new SoundRing();
    ring.emit(shot(0, 0));
    expect(ring.since(0, 99).map(e => e.seq)).toEqual([1]);
  });
});

describe('SoundEvent immutability', () => {
  it('copies the emitted position: moving the source does not move the event', () => {
    const ring = new SoundRing();
    const muzzle = new THREE.Vector3(5, 1.9, 5);
    const ev = ring.emit(shot(0, 0, { pos: muzzle }));
    muzzle.set(-100, 0, -100);
    expect(ev.pos.x).toBe(5);
    expect(ev.pos.z).toBe(5);
    expect(ring.since(0)[0]!.pos.x).toBe(5);
  });

  it('carries the emitter identity and team the listener filters on', () => {
    const ring = new SoundRing();
    const ev = ring.emit(shot(0, 0, { sourceId: 7, team: 'T', kind: 'footstep', t: 12.5 }));
    expect(ev.sourceId).toBe(7);
    expect(ev.team).toBe('T');
    expect(ev.kind).toBe('footstep');
    expect(ev.t).toBe(12.5);
  });
});

describe('withinEarshot', () => {
  const ring = new SoundRing();
  const ev = ring.emit(shot(0, 0, { radius: 24 }));

  it('is inclusive exactly at the radius', () => {
    expect(withinEarshot(ev, new THREE.Vector3(24, 0, 0))).toBe(true);
  });

  it('rejects just beyond it', () => {
    expect(withinEarshot(ev, new THREE.Vector3(24.001, 0, 0))).toBe(false);
  });

  it('measures in 3D, so a listener on a deck overhead is farther away', () => {
    // 24 m along x and 3.6 m up is 24.27 m — outside a 24 m radius, though the
    // planar distance is exactly on it.
    expect(withinEarshot(ev, new THREE.Vector3(24, 3.6, 0))).toBe(false);
    expect(withinEarshot(ev, new THREE.Vector3(23, 3.6, 0))).toBe(true);
  });
});
