// sim/gameClock.ts — the gameplay time base: one clock, one pausable scheduler.
//
// Pure. No imports, no browser APIs — instances are constructed and advanced
// explicitly, which is what makes pausing structural rather than a flag:
// the shared instance (core/state.ts:gameTime) is advanced once per frame
// from main.ts's simulation block ONLY, so everything measured in game time
// — fire-rate gates, reloads, respawn delays — freezes whenever the loop is
// paused and resumes exactly where it stopped.
//
// This exists because gameplay timing used to sit on two unrelated bases:
// THREE.Clock's elapsedTime (which keeps running during pause because the
// render loop always calls getDelta) and raw performance.now(). Neither
// pauses; both also disagree on their zero point.

/** Returned by schedule(); cancel() before the delay elapses stops the job. */
export interface ScheduledHandle {
  cancel(): void;
}

interface ScheduledJob {
  /** Game-time instant at which fn runs. */
  at: number;
  fn: () => void;
}

/**
 * A monotonic clock whose time passes only when advance() is called, plus a
 * scheduler whose jobs fire from inside advance() — never from wall-clock
 * timers — so scheduled work inherits the clock's pause semantics for free.
 *
 * Jobs fire in due-time order (ties in schedule order). A job may schedule or
 * cancel other jobs, including ones already due: they run within the same
 * advance() call. Nothing fires without advance().
 *
 * One deliberate ordering detail: advance() adds all of dt BEFORE draining,
 * so a delay scheduled from inside a job is measured against the clock's
 * new time, not the instant the parent job was queued.
 */
export class GameClock {
  private t = 0;
  private jobs: ScheduledJob[] = [];

  /** Seconds of simulated gameplay since construction. */
  now(): number {
    return this.t;
  }

  /**
   * Advance game time by `dt` seconds and fire every job whose due time has
   * been reached, in order. dt must be >= 0 — a negative step means a caller
   * is feeding unclamped or corrupted deltas and would rewind the epoch.
   */
  advance(dt: number): void {
    if (dt < 0) throw new Error(`GameClock.advance: negative dt ${dt}`);
    this.t += dt;
    // Re-sorted per call so jobs enqueued by earlier jobs land in order too;
    // the queue holds at most a handful of entries.
    this.jobs.sort((a, b) => a.at - b.at);
    while (this.jobs.length > 0) {
      const job = this.jobs[0];
      if (!job || job.at > this.t) break;
      this.jobs.shift();
      job.fn();
    }
  }

  /**
   * Run `fn` after `delaySec` seconds of GAME time have passed — not wall
   * time — so it suspends with everything else while paused. Negative delays
   * clamp to 0 (due on the next advance). Returns a handle; cancelling an
   * already-fired job is a harmless no-op.
   */
  schedule(delaySec: number, fn: () => void): ScheduledHandle {
    const job: ScheduledJob = { at: this.t + Math.max(0, delaySec), fn };
    this.jobs.push(job);
    return {
      cancel: () => {
        const i = this.jobs.indexOf(job);
        if (i >= 0) this.jobs.splice(i, 1);
      },
    };
  }
}
