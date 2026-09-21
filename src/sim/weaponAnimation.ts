import type { WeaponId } from '../core/state';
import { SWAP_DELAY } from './weaponSwap';

export interface WeaponAnimationInput {
  id: WeaponId;
  now: number;
  shotAt: number;
  fireInterval: number;
  switchedAt: number;
  hasOutgoing: boolean;
  aiming: boolean;
  reloading: boolean;
  reloadStartedAt: number;
  reloadT: number;
  roundInterval: number;
  lastRound: boolean;
  emptyReload: boolean;
  reloadSpent?: number;
  reloadShells?: number;
  closeAt: number;
  closeBlend: number;
}

export interface WeaponPose {
  reload: number;
  magazine: number;
  shell: boolean;
  insert: number;
  cylinder: number;
  pump: number;
  boltLift: number;
  boltPull: number;
  slide: number;
  hammer: number;
  index: number;
  charge: number;
  draw: number;
  holster: boolean;
  holsterDrop: number;
  swing: number;
  breakOpen: number;
  extraction: number;
  shellCount: number;
  spentCount: number;
}

function smooth(a: number, b: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function hold(t: number, start: number, peak: number, endStart: number, end: number): number {
  return smooth(start, peak, t) * (1 - smooth(endStart, end, t));
}

/** Shared pump envelope for the mechanism and ADS recovery; never changes readiness. */
export function shotgunPump(input: Pick<WeaponAnimationInput, 'id' | 'now' | 'shotAt' | 'fireInterval' | 'reloading'>): number {
  const cycle = (input.now - input.shotAt) / input.fireInterval;
  return input.id === 'shotgun' && !input.reloading && cycle >= 0 && cycle < 1
    ? hold(cycle, 0.10, 0.36, 0.48, 0.78) : 0;
}

/** Keep the shot's initial punch, then let the pump stroke carry aimed recovery. */
export function shotgunChambering(pump: number, ads: number): { dip: number; roll: number; recoilScale: number } {
  const amount = pump * ads;
  return { dip: -0.03 * amount, roll: Math.PI / 30 * amount, recoilScale: 1 - 0.75 * amount };
}

/** Absolute game-clock evaluation: no integration drift or pause-time catch-up. */
export function weaponPose(input: WeaponAnimationInput): WeaponPose {
  const { id, now, shotAt, fireInterval, reloading, reloadT: t } = input;
  const shotAge = now - shotAt;
  const cycle = shotAge / fireInterval;
  const firing = cycle >= 0 && cycle < 1;
  const perRound = id === 'shotgun' || id === 'revolver';
  const closing = input.closeBlend * (1 - smooth(0, 0.14, now - input.closeAt));
  const opening = smooth(0, perRound ? .18 : input.roundInterval * .16, now - input.reloadStartedAt);
  const finalClose = input.lastRound ? 1 - smooth(0.86, 1, t) : 1;
  const reload = reloading ? (perRound ? opening * finalClose : hold(t, 0, 0.12, 0.89, 1)) : closing;
  const swapAge = now - input.switchedAt;
  const swapping = !input.aiming && !reloading && !firing;
  // The cosmetic swap tracks the gameplay deploy window (issue #15): the
  // outgoing viewmodel drops for the first 30% of SWAP_DELAY, then the
  // incoming one rises until the weapon is ready to fire. Deriving both ends
  // from the shared constant keeps art and gate from drifting apart.
  const holsterEnd = SWAP_DELAY * 0.3;
  const holster = swapping && input.hasOutgoing && swapAge >= 0 && swapAge < holsterEnd;
  return {
    reload,
    breakOpen: id === 'sawnOff' ? (reloading ? hold(t, 0, .18, .80, 1) : closing) : 0,
    extraction: id === 'sawnOff' && reloading ? smooth(.20, .36, t) : 0,
    spentCount: id === 'sawnOff' && reloading && t >= .18 && t < .38 ? (input.reloadSpent ?? 0) : 0,
    shellCount: id === 'sawnOff' && reloading && t >= .44 && t < .80 ? (input.reloadShells ?? 0) : 0,
    magazine: reloading && !perRound ? hold(t, 0.14, 0.36, 0.52, 0.77) : 0,
    shell: reloading && perRound && t >= 0.25 && t < 0.83,
    insert: id === 'sawnOff' ? smooth(.48, .74, t) : smooth(0.35, 0.82, t),
    cylinder: id === 'revolver' ? reload : 0,
    pump: shotgunPump(input),
    boltLift: id === 'sniper' && firing && !reloading ? hold(cycle, 0.12, 0.26, 0.76, 0.90) : 0,
    boltPull: id === 'sniper' && firing && !reloading ? hold(cycle, 0.27, 0.46, 0.54, 0.75) : 0,
    slide: (id === 'pistol' || id === 'smg' || id === 'ak47') && firing && !reloading ? hold(shotAge, -0.001, 0.025, 0.035, 0.09) : 0,
    hammer: id === 'revolver' && firing && !reloading ? hold(cycle, 0.05, 0.25, 0.35, 0.48) : 0,
    // Index the next chamber after the loading fingers withdraw. A full sixth
    // turn is geometrically identical at the next round's zero phase.
    index: id === 'revolver' ? (reloading ? smooth(.84, .98, t) : firing ? smooth(0.05, 0.28, cycle) : 0) : 0,
    charge: reloading && input.emptyReload && !perRound ? hold(t, 0.79, 0.85, 0.89, 0.95) : 0,
    draw: swapping ? 1 - smooth(input.hasOutgoing ? holsterEnd : 0, SWAP_DELAY, swapAge) : 0,
    holster,
    holsterDrop: holster ? smooth(0, holsterEnd, swapAge) : 0,
    // Contact occurs on the successful shot frame; this is the follow-through.
    swing: id === 'knife' && firing ? 1 - smooth(0, 0.85, cycle) : 0,
  };
}

/** Threshold crossings emit at most once even when a frame skips a milestone. */
export function crossedCue(previousAge: number, age: number, threshold: number): boolean {
  return previousAge < threshold && age >= threshold;
}
