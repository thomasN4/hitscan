// botBrains.ts — bot decision policies as an engine-free seam.
//
// Division of labor with the concrete Bot (bots.ts): a BotBrain DECIDES,
// the Bot EXECUTES. Each frame the executor builds a passive BrainView
// (positions, distance, a lazy line-of-sight thunk, collision feedback),
// hands it to decide(), then realizes the returned BrainIntent: applies
// the movement step under world collision and fires if told to. Nothing in
// here may import the engine, world, audio or DOM — that is what keeps the
// policies unit-testable in plain Node (botBrains.test.ts), the same seam
// pattern as recoil.ts:convertOnSwap.
//
// The default policy is a faithful port of the original inline behavior:
// approach beyond farBand, back off inside nearBand, always drift
// perpendicular at strafeFactor weight with random jukes; fire only when a
// cooldown expires AND seeTarget() passes, retrying soon when sight is
// blocked so bullets respect cover like the player's do.
import * as THREE from 'three';

/** Tunables of a reactive policy. Lengths in metres, times in seconds. */
export interface BrainParams {
  /** Closer than this: back off. */
  nearBand: number;
  /** Farther than this: approach. */
  farBand: number;
  /** Perpendicular drift weight vs the radial band blend. */
  strafeFactor: number;
  /** Mean strafe-direction flips per second (the juke). */
  jukeRate: number;
  /** Never shoot beyond this range. */
  engageRange: number;
  /** Cooldown while sight is blocked — a soon re-check, not a shot. */
  retryCooldown: number;
  /** Post-shot cooldown lower bound. */
  cooldownMin: number;
  /** Post-shot cooldown random span added to cooldownMin. */
  cooldownSpan: number;
  /** Spawn stagger lower bound (first-shot delay). */
  firstDelayMin: number;
  /** Spawn stagger random span added to firstDelayMin. */
  firstDelaySpan: number;
}

/** The shipped T-bot behavior, verbatim from the pre-seam inline numbers. */
export const DEFAULT_BRAIN_PARAMS: BrainParams = {
  nearBand: 7,
  farBand: 14,
  strafeFactor: 0.7,
  jukeRate: 0.5,
  engageRange: 45,
  retryCooldown: 0.3,
  cooldownMin: 0.7,
  cooldownSpan: 1.2,
  firstDelayMin: 1,
  firstDelaySpan: 2,
};

/**
 * Hit chance of a bot bullet at planar `dist`: linear falloff from close
 * range clamped to a floor, so distant bots are mostly noise.
 * Tuning notes: 0.65 up close, −1/80 per metre, floor 0.12.
 */
export function botHitChance(dist: number): number {
  return Math.max(0.12, 0.65 - dist / 80);
}

/** Damage of a landed bot bullet, drawn via `rng` over [8, 22]. */
export function botDamageRoll(rng: () => number): number {
  return 8 + rng() * 14;
}

/** What a brain may know about the world this frame — all executor-supplied. */
export interface BrainView {
  /** Planar vector from the bot to its target (y stripped; ground-locked sim). */
  toTarget: THREE.Vector3;
  /** Planar distance to the target (=== toTarget.length()). */
  dist: number;
  targetAlive: boolean;
  /**
   * Line-of-sight probe to the target. A THUNK on purpose: the raycast
   * against world solids is only worth paying when the trigger is otherwise
   * ready, so the default policy calls it at most once per cooldown window.
   */
  seeTarget(): boolean;
  /** Movement speed (m/s) the executor can realize this frame. */
  selfSpeed: number;
  /** Whether LAST frame's step was rejected by world collision. */
  moveBlocked: boolean;
}

/** What a brain wants done this frame. */
export interface BrainIntent {
  /** World-space displacement to attempt (already includes selfSpeed·dt). */
  step: THREE.Vector3;
  /** Loose a shot THIS frame; the executor owes it when true. */
  wantShoot: boolean;
}

/** The decision half of a bot. Instances own per-bot state; executors are stateless shells. */
export interface BotBrain {
  decide(view: BrainView, dt: number): BrainIntent;
}

/** The original inline T-bot policy, parameterized for future variants. */
export class DefaultBrain implements BotBrain {
  private strafeDir: 1 | -1;
  private cooldown: number;

  constructor(
    private readonly params: BrainParams = DEFAULT_BRAIN_PARAMS,
    private rng: () => number = Math.random,
  ) {
    this.strafeDir = this.rng() < 0.5 ? -1 : 1;
    // Staggered first shot so a fresh wave doesn't volley in unison.
    this.cooldown = this.params.firstDelayMin + this.rng() * this.params.firstDelaySpan;
  }

  decide(view: BrainView, dt: number): BrainIntent {
    const dir = view.toTarget.clone().normalize();

    // Collision feedback from LAST frame's application: bumped geometry
    // reverses the drift, starting with this frame's step (the original
    // flipped between frames, not within one).
    if (view.moveBlocked) this.strafeDir = this.strafeDir === 1 ? -1 : 1;

    // Movement blend: radial band preference plus a perpendicular drift
    // component, normalized and scaled to the realized speed.
    const step = new THREE.Vector3();
    if (view.dist > this.params.farBand) step.add(dir);
    else if (view.dist < this.params.nearBand) step.sub(dir);
    const strafe = new THREE.Vector3(-view.toTarget.z, 0, view.toTarget.x)
      .normalize()
      .multiplyScalar(this.strafeDir * this.params.strafeFactor);
    step.add(strafe).normalize().multiplyScalar(view.selfSpeed * dt);

    // Random juke (~jukeRate flips/sec); drawn after the step like the
    // original statement order, so it steers from the NEXT frame on.
    if (this.rng() < dt * this.params.jukeRate) this.strafeDir = this.strafeDir === 1 ? -1 : 1;

    // Trigger: cooldown-gated, range-gated, target-gated, LOS-gated. Blocked
    // sight retries on the short retryCooldown instead of firing through cover.
    let wantShoot = false;
    this.cooldown -= dt;
    if (this.cooldown <= 0 && view.dist < this.params.engageRange && view.targetAlive) {
      if (view.seeTarget()) {
        this.cooldown = this.params.cooldownMin + this.rng() * this.params.cooldownSpan;
        wantShoot = true;
      } else {
        this.cooldown = this.params.retryCooldown;
      }
    }

    return { step, wantShoot };
  }
}
