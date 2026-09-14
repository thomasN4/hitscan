// sim/domination.ts — domination rules as pure functions.
//
// Capture, tick scoring, objective dispatch and spawn scoring live here so
// they are unit-testable in plain Node (domination.test.ts): no engine, no
// DOM, no reads of shared state. Browser-side modules (main.ts's updater,
// bots.ts's dispatcher feed) call in with live data.
//
// Shapes are structural on purpose: DomFlagState (core/state.ts) satisfies
// MutableDomFlag without importing it, the same seam pattern as
// perception.ts's injected LOS callback — the suite scripts plain literals
// instead of THREE vectors.
import type { Team } from '../core/state';

/** Seconds of uncontested presence to flip a flag. */
export const CAPTURE_TIME_S = 8;
/** Points ticked per second per owned flag. */
export const TICK_POINTS_PER_SEC = 1;
/** Points that end the match immediately for the side reaching them. */
export const DOM_SCORE_LIMIT = 200;
/**
 * Adjustable score-limit range (points): the menu edits within it and the
 * parser clamps hand-typed URLs into it, mirroring TIME_LIMITS_S's job for
 * round length.
 */
export const SCORE_LIMITS = { min: 50, max: 500 } as const;
/**
 * Feet-height window (m) a body must be inside to count toward a flag.
 * Elevation's B sits on the slab at 3.6 over a walkable ground floor: 2.0
 * keeps the deck fight and the room below from ever counting each other.
 */
export const VERTICAL_TOL_M = 2;
/** How often updateBots re-runs the dispatcher (s); assignments are sticky between runs. */
export const DISPATCH_INTERVAL_S = 1;
/** Max bots of one team piling onto a single flag before the dispatcher spreads them. */
export const FLAG_CAP = 4;

/** Minimum live shape of a flag the capture updater mutates. */
export interface MutableDomFlag {
  id: string;
  pos: { x: number; y: number; z: number };
  radius: number;
  owner: Team | null;
  progress: number;
  challenger: Team | null;
}

/** One body that may count toward a flag: side + world-space FEET position. */
export interface DomBody {
  team: Team;
  x: number;
  /** Feet height (not eye): B's deck and the floor below must not mix. */
  feetY: number;
  z: number;
}

/**
 * Whether one body counts toward a flag: planar distance within the radius
 * AND feet within VERTICAL_TOL_M of the flag's walk surface. The single
 * ring test behind both the capture tick and the bots' teammate awareness,
 * so the two can never disagree about who is "on" a flag.
 */
export function isBodyInRing(
  flag: Pick<MutableDomFlag, 'pos' | 'radius'>,
  body: DomBody,
): boolean {
  const dx = body.x - flag.pos.x;
  const dz = body.z - flag.pos.z;
  if (dx * dx + dz * dz > flag.radius * flag.radius) return false;
  return Math.abs(body.feetY - flag.pos.y) <= VERTICAL_TOL_M;
}

/**
 * A ring body with identity, for holder ranking. Bots only — the player has
 * no bot id and never appears here (though they still count in
 * countFlagBodies): rank is bots-only by design, so a player passing through
 * the ring never vacates the point by outranking its bots.
 */
export interface RankedBody extends DomBody {
  id: number;
}

/**
 * Holder rank per bot id: among each team's bodies inside the ring, how many
 * have a LOWER id. Rank 0 is the designated holder and sits the point;
 * higher ranks escort — free to leave the ring after live contact while the
 * holder keeps ticking the capture. Per team independently, so opposite
 * sides converging on one flag rank against their own mates only. Bots
 * outside the ring are absent (their rank is read as 0, which is exactly
 * "nobody ahead of me" and is only ever read while capping anyway).
 */
export function holderRanks(
  flag: Pick<MutableDomFlag, 'pos' | 'radius'>,
  bodies: readonly RankedBody[],
): Map<number, number> {
  const ids: Record<Team, number[]> = { T: [], CT: [] };
  for (const b of bodies) {
    if (isBodyInRing(flag, b)) ids[b.team].push(b.id);
  }
  const ranks = new Map<number, number>();
  for (const team of ['T', 'CT'] as const) {
    const sorted = ids[team].sort((a, b) => a - b);
    sorted.forEach((id, rank) => ranks.set(id, rank));
  }
  return ranks;
}

/**
 * Count each side's bodies inside a flag's ring (see isBodyInRing).
 */
export function countFlagBodies(
  flag: Pick<MutableDomFlag, 'pos' | 'radius'>,
  bodies: readonly DomBody[],
): { t: number; ct: number } {
  let t = 0;
  let ct = 0;
  for (const b of bodies) {
    if (!isBodyInRing(flag, b)) continue;
    if (b.team === 'T') t++;
    else ct++;
  }
  return { t, ct };
}

/**
 * Advance one flag's capture state by `dt` given the sides present.
 *
 * - Both sides present: frozen (contested) — progress neither grows nor decays.
 * - Nobody present, or only the owner: challenger progress decays at the
 *   capture rate, so stepping off briefly costs little and abandoning wipes.
 * - Only the other side: progress grows toward it (switching challengers
 *   restarts from 0); at 1 the flag flips and the event is returned.
 *
 * @returns the capturing side on the frame the flag flips, else null.
 */
export function updateFlagCapture(
  flag: MutableDomFlag,
  nT: number,
  nCt: number,
  dt: number,
): Team | null {
  if (nT > 0 && nCt > 0) return null;
  const present: Team | null = nT > 0 ? 'T' : nCt > 0 ? 'CT' : null;
  if (present === null || present === flag.owner) {
    flag.progress = Math.max(0, flag.progress - dt / CAPTURE_TIME_S);
    if (flag.progress === 0) flag.challenger = null;
    return null;
  }
  if (flag.challenger !== present) {
    flag.challenger = present;
    flag.progress = 0;
  }
  flag.progress += dt / CAPTURE_TIME_S;
  if (flag.progress >= 1) {
    flag.owner = present;
    flag.challenger = null;
    flag.progress = 0;
    return present;
  }
  return null;
}

/**
 * Tick team points from owned flags. `scores` is mutated ({ ct, t } in the
 * same order match.ts:decideDomWinner takes them); fractional dt slices
 * accumulate and render floored, so a 1 pt/s tick moves visibly.
 */
export function tickDomScores(
  flags: readonly Pick<MutableDomFlag, 'owner'>[],
  scores: { ct: number; t: number },
  dt: number,
): void {
  for (const f of flags) {
    if (f.owner === 'CT') scores.ct += dt * TICK_POINTS_PER_SEC;
    else if (f.owner === 'T') scores.t += dt * TICK_POINTS_PER_SEC;
  }
}

// ---------- Objective dispatch ----------

/** Minimum live shape of a bot the dispatcher assigns. */
export interface DispatchBot {
  id: number;
  team: Team;
  x: number;
  z: number;
}

/** Minimum live shape of a flag the dispatcher ranks. */
export interface DispatchFlag {
  id: string;
  x: number;
  z: number;
  owner: Team | null;
}

/**
 * Extra cost (in equivalent metres) added when ranking a flag, by ownership
 * from the assigning team's view. Neutral is cheapest (a free point), taking
 * an enemy flag costs a fight, stacking an owned flag is last resort — the
 * defenders it needs are assigned first, below.
 */
const ENEMY_FLAG_COST = 5;
const OWNED_FLAG_COST = 15;
/**
 * Stickiness bonus (equivalent metres) for keeping a bot on its previous
 * flag. Re-dispatch runs every DISPATCH_INTERVAL_S; without hysteresis two
 * equidistant flags would trade one bot back and forth forever.
 */
const STICKY_BONUS = 8;

/**
 * Assign every bot to a flag, per team independently. Defenders first (up to
 * one per owned flag, capped at a third of the team, nearest bots stick),
 * then the rest to the cheapest flag with room under FLAG_CAP — neutral
 * before enemy before owned, nearest before farthest, previous assignment
 * discounted. Deterministic: ties break by bot id, so the suite scripts it
 * exactly and the field never visibly churns.
 *
 * @param previous last run's bot-id → flag-id map; unknown ids count as unassigned.
 */
export function assignDomObjectives(
  bots: readonly DispatchBot[],
  flags: readonly DispatchFlag[],
  previous: ReadonlyMap<number, string>,
): Map<number, string> {
  const assigned = new Map<number, string>();
  if (flags.length === 0) return assigned;
  for (const team of ['T', 'CT'] as const) {
    const teamBots = bots.filter(b => b.team === team).sort((a, b) => a.id - b.id);
    if (teamBots.length === 0) continue;
    const load = new Map<string, number>(flags.map(f => [f.id, 0]));
    const take = (bot: DispatchBot, flagId: string): void => {
      assigned.set(bot.id, flagId);
      load.set(flagId, (load.get(flagId) ?? 0) + 1);
    };
    const dist = (bot: DispatchBot, flag: DispatchFlag): number =>
      Math.hypot(bot.x - flag.x, bot.z - flag.z) -
      (previous.get(bot.id) === flag.id ? STICKY_BONUS : 0);
    // Defenders: one per owned flag while the team can spare them.
    const owned = flags.filter(f => f.owner === team);
    const defenderSlots = Math.min(owned.length, Math.floor(teamBots.length / 3));
    const defenders = new Set<number>();
    for (let s = 0; s < defenderSlots; s++) {
      let best: { bot: DispatchBot; flag: DispatchFlag; d: number } | null = null;
      for (const flag of owned) {
        if ((load.get(flag.id) ?? 0) > 0) continue;
        for (const bot of teamBots) {
          if (defenders.has(bot.id)) continue;
          const d = dist(bot, flag);
          if (best === null || d < best.d) best = { bot, flag, d };
        }
      }
      if (best === null) break;
      defenders.add(best.bot.id);
      take(best.bot, best.flag.id);
    }
    // Attackers: cheapest flag with room — neutral, then enemy, then owned.
    for (const bot of teamBots) {
      if (defenders.has(bot.id)) continue;
      let best: { flag: DispatchFlag; cost: number } | null = null;
      for (const flag of flags) {
        if ((load.get(flag.id) ?? 0) >= FLAG_CAP) continue;
        const ownership = flag.owner === null ? 0 : flag.owner === team ? OWNED_FLAG_COST : ENEMY_FLAG_COST;
        const cost = Math.hypot(bot.x - flag.x, bot.z - flag.z) + ownership -
          (previous.get(bot.id) === flag.id ? STICKY_BONUS : 0);
        if (best === null || cost < best.cost) best = { flag, cost };
      }
      // FLAG_CAP only binds past 12 bots a side; fall back to nearest so no
      // bot is ever left goalless by the cap arithmetic.
      take(bot, best?.flag.id ?? nearestFlag(bot, flags).id);
    }
  }
  return assigned;
}

/** Nearest flag by planar distance; flags is non-empty at every call site above. */
function nearestFlag(bot: DispatchBot, flags: readonly DispatchFlag[]): DispatchFlag {
  let best = flags[0]!;
  let bestD = Infinity;
  for (const f of flags) {
    const d = Math.hypot(bot.x - f.x, bot.z - f.z);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return best;
}
