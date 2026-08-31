// soundEvents.ts — what the world sounded like, as gameplay data.
//
// audio.ts already makes noise for the PLAYER's ears; this is the parallel
// record bots read. The two are deliberately separate: a WebAudio node is
// fire-and-forget and unreadable, and gating AI on it would make hearing a
// side effect of whether the browser felt like playing a sound.
//
// A ring rather than a list because emission is unbounded (every trigger pull,
// every footstep) while interest is not: a bot cares about the last second or
// two, and the buffer costs a fixed 256 slots forever instead of growing until
// the match ends.
//
// What 256 buys, at the configurable worst case of 24 bots (12 per team) with
// the player holding the trigger and running. Bots now fire on their WEAPON's
// cadence (sim/botWeapons.ts), and the loudest is a field of smgs: three
// rounds at the catalog's 0.075 s, then a 0.9-1.5 s pause — a 1.35 s cycle for
// 3 events, so 2.2/s each and ~53/s across 24. Plus the player's SMG at
// 13.3/s and footsteps at 3.3/s: call it 70 events/s, so the ring retains
// ~3.7 s.
//
// That is HALF the headroom the pre-weapon bot left (it fired once per ~1.3 s,
// for ~35/s overall), and the reason is bursts rather than volume of bots.
// Still ample: a reader hears everything as long as it reads at all, and every
// living bot reads every frame — the depth is slack for one that misses
// frames, not a window anyone waits out. Worth re-checking if a later weapon
// fires faster than the smg, since that is the number this bound tracks.
//
// Reads are NON-DESTRUCTIVE and cursor-based, which is the whole point of the
// shape: every bot must be able to hear the same gunshot, so no listener may
// consume an event out from under another. Engine-free and DOM-free like the
// rest of sim/ — `Team` arrives as a TYPE-only import, erased at build, so the
// one runtime edge between the modules stays core/state.ts → sim/.
import * as THREE from 'three';

import type { Team } from '../core/state';
import type { PerceptionId } from './perception';

/**
 * What made the noise. Ordering between the two is POLICY (botBrains.ts
 * prefers gunshots), not a property of the buffer.
 */
export type SoundKind = 'gunshot' | 'footstep';

/**
 * One thing that was audible, as emitted. Every field is readonly and `pos` is
 * a copy taken at emission: an event is a record of a moment, so it must not
 * move when its source does — the same rule the brain's visual memory follows.
 */
export interface SoundEvent {
  /** Monotonic, 1-based, never reused. Cursors are compared against it. */
  readonly seq: number;
  /** Game-time seconds at emission (`gameTime.now()`), for readouts and traces. */
  readonly t: number;
  readonly kind: SoundKind;
  /** Who made it, so a listener can drop its own and its allies' noise. */
  readonly sourceId: PerceptionId;
  readonly team: Team;
  /** COPY of the world position the sound came from. */
  readonly pos: THREE.Vector3;
  /** Audible radius (m). Hearing is radius-only: walls neither block nor attenuate. */
  readonly radius: number;
}

/** What a caller hands `emit`; `seq` is the ring's to assign. */
export type SoundEmission = Omit<SoundEvent, 'seq'>;

/**
 * One event as a LISTENER receives it, after the executor has filtered by
 * team and earshot.
 *
 * Deliberately NOT a `SoundEvent`: `sourceId` and `team` stay on the
 * executor's side of the seam. A noise identifies NOBODY — it is a place and
 * a kind — and handing the brain an id would let policy track an entity it
 * has never seen, which is the omniscience tranche 6a removed. `pos` is a
 * copy, like every position that crosses into a brain.
 */
export interface HeardSound {
  /** The originating event's sequence — the brain's "which is newest" test. */
  readonly seq: number;
  /** Game-time seconds at emission. */
  readonly t: number;
  readonly kind: SoundKind;
  /** COPY of where the noise came from; a routable, ground-level position. */
  readonly pos: THREE.Vector3;
}

/**
 * Retained events. Older ones are overwritten in place, so a listener that
 * stops reading for longer than this loses the overflow rather than stalling
 * the emitters.
 */
export const SOUND_RING_CAPACITY = 256;

/**
 * Audible radius of any firearm (m), player's and bots' alike.
 *
 * Deliberately ONE number for all five firearms rather than per-weapon
 * loudness: it matches perception.ts's PERCEPTION_RANGE_M, so a shot a bot
 * could have SEEN is a shot it can hear, which keeps the two senses' reach
 * comparable while hearing is new. A `WeaponDef.soundRadius` (sniper louder
 * than pistol) is deferred until the uniform version has been playtested.
 */
export const GUNSHOT_RADIUS_M = 80;
/** Audible radius of a sprinting footstep (m) — a third of a gunshot's. */
export const FOOTSTEP_RUN_RADIUS_M = 24;
/** Audible radius of a walking or aim-walking footstep (m): half of running. */
export const FOOTSTEP_WALK_RADIUS_M = 12;

/**
 * A fixed-capacity ring of sound events with cursor reads.
 *
 * Deliberately a class with no module-level instance: the live one belongs in
 * core/state.ts, this repository's one home for shared mutable game state, so
 * that a unit test can build its own without touching it.
 */
export class SoundRing {
  private readonly buf: (SoundEvent | undefined)[] = new Array<SoundEvent | undefined>(SOUND_RING_CAPACITY);
  private seq = 0;

  /**
   * Sequence of the newest event, or 0 when nothing has been emitted. A fresh
   * listener starts here to hear only what happens NEXT; a listener starting
   * at 0 hears everything still retained.
   */
  get latestSeq(): number {
    return this.seq;
  }

  /** Record one audible occurrence and return it, stamped with its sequence. */
  emit(e: SoundEmission): SoundEvent {
    this.seq += 1;
    const ev: SoundEvent = {
      seq: this.seq,
      t: e.t,
      kind: e.kind,
      sourceId: e.sourceId,
      team: e.team,
      pos: e.pos.clone(),
      radius: e.radius,
    };
    this.buf[(this.seq - 1) % SOUND_RING_CAPACITY] = ev;
    return ev;
  }

  /**
   * Events after `cursor`, oldest first, capped at `highWater`.
   *
   * `highWater` is how a whole frame reads one consistent world: updateBots
   * captures `latestSeq` once and every bot reads through that snapshot, so a
   * shot fired by an early bot is heard by ALL bots next frame rather than by
   * whichever ones happen to sit later in registry order.
   *
   * A cursor that predates the retained window (a listener that stopped
   * reading through more than SOUND_RING_CAPACITY emissions) resumes at the
   * oldest RETAINED event rather than reporting a gap — the overflow is gone
   * either way, and skipping to the present is the useful behavior.
   */
  since(cursor: number, highWater: number = this.seq): SoundEvent[] {
    const oldest = Math.max(1, this.seq - SOUND_RING_CAPACITY + 1);
    const from = Math.max(cursor + 1, oldest);
    const to = Math.min(highWater, this.seq);
    const out: SoundEvent[] = [];
    for (let s = from; s <= to; s++) {
      const ev = this.buf[(s - 1) % SOUND_RING_CAPACITY];
      // Only a slot never written can be missing, and `from` already excludes
      // those; the guard is what proves it to noUncheckedIndexedAccess.
      if (ev !== undefined) out.push(ev);
    }
    return out;
  }

  /** Drop every retained event and restart sequencing. Tests and match resets only. */
  reset(): void {
    this.buf.fill(undefined);
    this.seq = 0;
  }
}

/**
 * Whether `listener` is close enough to hear `e`. Radius-only by design:
 * occlusion would cost another geometry-probe budget per bot per event, and
 * the tranche that added hearing deliberately did not spend it.
 */
export function withinEarshot(e: SoundEvent, listener: THREE.Vector3): boolean {
  return e.pos.distanceTo(listener) <= e.radius;
}
