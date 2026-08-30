// soundEvents.ts — what the world sounded like, as gameplay data.
//
// audio.ts already makes noise for the PLAYER's ears; this is the parallel
// record bots read. The two are deliberately separate: a WebAudio node is
// fire-and-forget and unreadable, and gating AI on it would make hearing a
// side effect of whether the browser felt like playing a sound.
//
// A ring rather than a list because emission is unbounded (every trigger pull,
// every footstep) while interest is not: a bot cares about the last second or
// two. 256 entries is ~4 s of a twelve-bot firefight at SMG cadence, and the
// buffer costs a fixed 256 slots forever instead of growing until the match
// ends.
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
 * Retained events. Older ones are overwritten in place, so a listener that
 * stops reading for longer than this loses the overflow rather than stalling
 * the emitters.
 */
export const SOUND_RING_CAPACITY = 256;

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
