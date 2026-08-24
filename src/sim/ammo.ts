// sim/ammo.ts — the low-ammo threshold behind the HUD reload hint.
//
// Pure. The hint used to hardcode `mag <= 10`, written when the SMG (30-round
// mag) was the only weapon; the sniper's FULL mag is also 10, so it advertised
// a reload that tryReload would refuse (issue #10). A third of the magazine
// keeps the SMG's original threshold exactly while making the rule per-weapon.

/** True when `mag` rounds left counts as "think about reloading" for this weapon. */
export function isLowAmmo(mag: number, magSize: number): boolean {
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
