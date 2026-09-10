// sim/weaponSwap.ts — the shared weapon-swap deploy delay.
//
// One fixed delay for bots AND the player (issue #15): switching positions
// costs time before the incoming weapon can fire, scope or reload. Fixed and
// per-weapon-free on purpose — a per-weapon table would need catalog fields
// plus validation for a feel difference nobody playtested.
//
// 0.4 s is CS-like and deliberately longer than the fastest recoil drain in
// the game (a full smg climb converted onto the sniper clears in 0.277 s at
// 13 units/s): any delay shorter than that drain still refunds the climb
// inside a human swap. Bots previously waited 0.5 s; they now wait this.
export const SWAP_DELAY = 0.4;

/**
 * Whether `now` still falls inside the deploy window opened by a swap at
 * `switchedAt`. Absolute game-clock comparison, so pause freezes it for free
 * (gameTime stops advancing) and a fresh life is always ready
 * (`switchedAt` starts at -Infinity via freshWeaponAnimation).
 *
 * A re-swap re-arms the window by writing a new `switchedAt` — the latest
 * press wins and spam delays readiness, which is the documented behavior.
 */
export function isDeploying(now: number, switchedAt: number): boolean {
  return now - switchedAt < SWAP_DELAY;
}
