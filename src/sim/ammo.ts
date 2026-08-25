// sim/ammo.ts — the low-ammo threshold behind the HUD reload hint.
//
// Pure. The hint used to hardcode `mag <= 10`, written when the SMG (30-round
// mag) was the only weapon; the sniper's FULL mag is also 10, so it advertised
// a reload that tryReload would refuse (issue #10). A third of the magazine
// keeps the SMG's original threshold exactly while making the rule per-weapon.

/** True when `mag` rounds left counts as "think about reloading" for this weapon. */
export function isLowAmmo(mag: number, magSize: number): boolean {
  // A zero-capacity weapon (the melee knife) has NO ammo semantics — it can
  // never be "low". Returning false here keeps "a full mag is never low"
  // universal over the whole catalog instead of special-casing the caller.
  if (magSize <= 0) return false;
  return mag <= Math.floor(magSize / 3);
}

// ---------- Per-round reload ----------
// The shell-by-shell model shared by the shotgun and revolver (perRound defs):
// the full reloadTime budget is spent moving one round at a time, so the
// weapon becomes shootable mid-reload with whatever has already transferred.
// These two functions are the whole mechanic — weapons.ts just schedules them.

/**
 * Seconds between transfers of a per-round reload: the weapon's total
 * reloadTime spread evenly across its magazine, so empty-to-full time is
 * IDENTICAL to the old whole-mag swap by construction.
 */
export function roundInterval(reloadTime: number, magSize: number): number {
  return reloadTime / magSize;
}

/** Result of one per-round reload transfer. */
export interface RoundTransfer {
  /** Rounds now chambered. */
  mag: number;
  /** Rounds now held in reserve. */
  reserve: number;
  /** True when the reload should stop: mag full, or nothing left to load. */
  done: boolean;
}

/**
 * Move ONE round from reserve to mag. Pure and defensive: a dry reserve or a
 * full mag transfers nothing and reports done, so a mis-scheduled caller can
 * never overdraw or loop forever.
 */
export function roundTransfer(mag: number, magSize: number, reserve: number): RoundTransfer {
  const took = Math.min(1, magSize - mag, Math.max(reserve, 0));
  const newMag = mag + took;
  const newReserve = reserve - took;
  return { mag: newMag, reserve: newReserve, done: newMag === magSize || newReserve <= 0 };
}

// ---------- Reload intent ----------
// Whether pressing R begins a reload — and whether beginning one drops the
// sights. This is the whole gate that weapons.ts:tryReload enforces; it lives
// here so the Node suite can pin the rules (and their interaction with aim)
// without reaching into browser-side state.

/** Everything planReload weighs, in the shape of the live slices. */
export interface ReloadRequest {
  /** The match is live (session.started). */
  started: boolean;
  alive: boolean;
  reloading: boolean;
  mag: number;
  magSize: number;
  reserve: number;
  /** RMB held: iron sights / scope raised right now. */
  aiming: boolean;
}

/** What a keypress of R amounts to. */
export interface ReloadDecision {
  start: boolean;
  /**
   * A STARTED reload drops iron sights / the scope — one motion at a time,
   * and a fresh RMB press re-raises afterwards (same semantics as
   * unscopeOnShot: clearing input.aiming beats a still-held button). False
   * whenever `start` is false: a REFUSED reload must never touch the aim.
   */
  dropAim: boolean;
}

/** A request that starts reloading: partial mag, rounds available, live player. */
export function planReload(r: ReloadRequest): ReloadDecision {
  const start = r.started && r.alive && !r.reloading &&
    r.mag < r.magSize && r.reserve > 0;
  return { start, dropAim: start && r.aiming };
}
