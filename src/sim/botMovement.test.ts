// Replay real policy and collision together: isolated feeler/timer tests cannot
// see the speed eaten by repeated partial slides in an inside corner.
import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { collidesAt, resolveVertical, slideMoveXZ, supportedAt, STEP_HEIGHT } from '../collision';
import { WEAPONS } from '../core/state';
import {
  DECK_Y, FLIGHT_MOUTH_X, FLIGHT_Z, INNER_Z, STEP_D, STEP_H, warehouse2Spec,
} from '../maps/warehouse2Spec';
import { openTreadBase } from '../world';
import { GRAVITY } from './movement';
import { DefaultBrain, DEFAULT_BRAIN_PARAMS, type BrainParams } from './botBrains';
import { makeBotLoadout } from './botWeapons';

function corner(params: BrainParams, hz: number): { loss: number; stall: number } {
  let seed = 103;
  const rng = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const brain = new DefaultBrain(params, rng, makeBotLoadout('smg', 'pistol', id => WEAPONS[id], rng));
  const walls = [
    new THREE.Box3(new THREE.Vector3(-1.7, 0, -15), new THREE.Vector3(-0.7, 4, 15)),
    new THREE.Box3(new THREE.Vector3(-15, 0, -1.7), new THREE.Vector3(15, 4, -0.7)),
  ];
  const feet = new THREE.Vector3(), target = new THREE.Vector3(4, 0, 4);
  let blocked = false, intended = 0, lost = 0, stall = 0, longest = 0;
  const dt = 1 / hz;
  for (let frame = 0; frame < hz * 12; frame++) {
    const dist = target.distanceTo(feet);
    const intent = brain.decide({ selfFeet: feet, facing: target.clone().sub(feet).normalize(),
      visual: { id: 'player', feet: target, eye: target.clone().setY(1.6), dist, dist3: Math.hypot(dist, 0.2), rise: 0 },
      onGround: true, selfSpeed: 3.9, moveBlocked: blocked, heard: [],
      canStandAt: (x, z) => !collidesAt(new THREE.Vector3(x, 0, z), 0.5, 0, walls),
      hasFootingAt: () => true,
      nextWaypoint: () => null, nextPatrolWaypoint: () => null, objective: null,
    }, dt);
    expect(intent.mode).toBe('engage');
    const before = feet.clone();
    slideMoveXZ(feet, intent.step.x, intent.step.z, 0.5, 0, walls);
    const actual = feet.distanceTo(before), requested = intent.step.length();
    intended += requested;
    lost += Math.max(0, requested - actual);
    blocked = actual < requested * 0.25;
    stall = blocked ? stall + dt : 0;
    longest = Math.max(longest, stall);
    expect(collidesAt(feet, 0.5, 0, walls)).toBe(false);
  }
  return { loss: lost / intended, stall: longest };
}

test.each([20, 60, 120])('escapes an engaged inside corner without grinding at %i Hz', hz => {
  const tuned = corner(DEFAULT_BRAIN_PARAMS, hz);
  const previous = corner({ ...DEFAULT_BRAIN_PARAMS, stuckTime: 0.25, commitTime: 0.5 }, hz);
  expect(tuned.loss).toBeLessThan(0.2);
  expect(tuned.loss).toBeLessThan(previous.loss * 0.7);
  expect(tuned.stall).toBeLessThanOrEqual(0.1 + 1 / hz + 1e-9);
});

// Issue #127, replayed on the shipped Warehouse2 geometry: the brain's steps
// through the same slide + gravity + support stages bots.ts runs, with the
// executor's two probes backed by the real collision predicates. A bot that
// walks off its level shows up as feet below the surface it started on.
// Colliders are built from the pure map spec (maps/warehouse2Spec.ts), the
// same data the builder attaches, so a layout change moves the test with it.
function warehouse2Colliders(): THREE.Box3[] {
  const spec = warehouse2Spec();
  const out = spec.boxes.map(b => new THREE.Box3(
    new THREE.Vector3(b.x - b.w / 2, b.y, b.z - b.d / 2),
    new THREE.Vector3(b.x + b.w / 2, b.y + b.h, b.z + b.d / 2),
  ));
  // Open flights: the treads are the only colliders (stringers block nothing).
  for (const f of spec.flights) {
    const alongZ = f.dir === 'z+' || f.dir === 'z-';
    for (let i = 0; i < f.count; i++) {
      const run = (i + 0.5) * f.stepD;
      const cx = f.dir === 'x+' ? f.x + run : f.dir === 'x-' ? f.x - run : f.x;
      const cz = f.dir === 'z+' ? f.z + run : f.dir === 'z-' ? f.z - run : f.z;
      const hw = (alongZ ? f.width : f.stepD) / 2, hd = (alongZ ? f.stepD : f.width) / 2;
      const base = openTreadBase(f.y, i, f.stepH, f.treadT!);
      out.push(new THREE.Box3(
        new THREE.Vector3(cx - hw, base, cz - hd),
        new THREE.Vector3(cx + hw, base + f.treadT!, cz + hd),
      ));
    }
  }
  return out;
}

/** Lowest feet height a bot reaches fighting a static target from `start`. */
function lowestFeet(
  colliders: THREE.Box3[], start: THREE.Vector3, target: THREE.Vector3, seed: number, guarded: boolean,
): number {
  const rng = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const brain = new DefaultBrain(DEFAULT_BRAIN_PARAMS, rng, makeBotLoadout('smg', 'pistol', id => WEAPONS[id], rng));
  const R = 0.5, SPEED = 3.9, hz = 60, dt = 1 / hz;
  const feet = start.clone(), probe = new THREE.Vector3();
  let vy = 0, onGround = true, blocked = false, lowest = feet.y;
  for (let frame = 0; frame < hz * 8; frame++) {
    const dist = Math.hypot(target.x - feet.x, target.z - feet.z);
    const intent = brain.decide({ selfFeet: feet, facing: new THREE.Vector3(target.x - feet.x, 0, target.z - feet.z).normalize(),
      visual: { id: 'player', feet: target, eye: target.clone().setY(target.y + 1.6), dist,
        dist3: Math.hypot(dist, target.y - feet.y), rise: target.y - feet.y },
      onGround, selfSpeed: SPEED, moveBlocked: blocked, heard: [],
      canStandAt: (x, z) => !collidesAt(probe.set(x, 0, z), R, feet.y, colliders),
      hasFootingAt: guarded ? (x, z) => supportedAt(probe.set(x, 0, z), feet.y, colliders) : () => true,
      nextWaypoint: () => null, nextPatrolWaypoint: () => null, objective: null,
    }, dt);
    const prevFeet = feet.y, preX = feet.x, preZ = feet.z;
    slideMoveXZ(feet, intent.step.x, intent.step.z, R, prevFeet, colliders);
    blocked = Math.hypot(feet.x - preX, feet.z - preZ) < intent.step.length() * 0.25;
    vy -= GRAVITY * dt;
    const vert = resolveVertical(prevFeet, vy, dt, feet.x, feet.z, R, colliders, onGround);
    feet.y = vert.feetY;
    vy = vert.velY;
    onGround = vert.onGround;
    lowest = Math.min(lowest, feet.y);
  }
  return lowest;
}

const SEEDS = [1, 7, 42, 103, 2024, 31337];

describe('warehouse2: engaged bots keep their footing (#127)', () => {
  const colliders = warehouse2Colliders();

  // Catwalk just inside the middle north port (x -6..-2), enemy 4.5 m in
  // front on the ring: inside nearBand, and the band would only be restored
  // 7 m out — past the port's outer lip, over a 5.04 m drop to the yard.
  const windowStart = new THREE.Vector3(-4, DECK_Y, -INNER_Z + 0.5);
  const windowTarget = new THREE.Vector3(-4, DECK_Y, -INNER_Z + 5);

  // Eighth tread of the +x void flight (top 1.44, 3.6 m wide, air beneath),
  // enemy on the floor 10 m out past the mouth: mid-band, so the step is a
  // pure strafe across the flight toward its open sides.
  const TREAD = 7;
  const treadTop = (TREAD + 1) * STEP_H;
  const flightStart = new THREE.Vector3(FLIGHT_MOUTH_X + (TREAD + 0.5) * STEP_D, treadTop, FLIGHT_Z);
  const flightTarget = new THREE.Vector3(flightStart.x - 10, 0, FLIGHT_Z);

  test.each(SEEDS)('backing off never leaves the catwalk through a port (seed %i)', seed => {
    expect(lowestFeet(colliders, windowStart, windowTarget, seed, true))
      .toBeGreaterThanOrEqual(DECK_Y - STEP_HEIGHT - 1e-6);
  });

  test.each(SEEDS)('strafing never steps off the side of an open flight (seed %i)', seed => {
    expect(lowestFeet(colliders, flightStart, flightTarget, seed, true))
      .toBeGreaterThanOrEqual(treadTop - STEP_HEIGHT - 1e-6);
  });

  test('without the guard the same replays fall — the scenarios bite', () => {
    // Control: an executor probe that finds ground everywhere is the pre-#127
    // brain. Every seed must fall out of the window; strafes juke at random,
    // so the flight only has to lose most of them.
    const window = SEEDS.map(s => lowestFeet(colliders, windowStart, windowTarget, s, false));
    const flight = SEEDS.map(s => lowestFeet(colliders, flightStart, flightTarget, s, false));
    expect(window.every(y => y < DECK_Y - 1)).toBe(true);
    expect(flight.filter(y => y < treadTop - 1).length).toBeGreaterThan(SEEDS.length / 2);
  });
});
