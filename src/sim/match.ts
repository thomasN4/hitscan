// sim/match.ts — match-end decision rules.
//
// Pure. Kept out of combat.ts/main.ts so the two ways a match can end are
// unit-testable without a browser: the clock expiring (winner by score) and
// the last enemy falling (immediate win for the player's side, except the 1v1 case).

/** Which side took the match, or nobody. */
export type MatchWinner = 'CT' | 'T' | 'draw';

/**
 * Winner when the round clock expires: higher kill score takes it. The CT
 * score is `scoreKills`, the T score is `scoreDeaths` — the same pair the
 * HUD top bar renders.
 */
export function decideWinner(scoreKills: number, scoreDeaths: number): MatchWinner {
  if (scoreKills > scoreDeaths) return 'CT';
  if (scoreDeaths > scoreKills) return 'T';
  return 'draw';
}

/**
 * Whether "every enemy dead at once" ends the match outright rather than just
 * respawning the wave. With a single enemy there is no wave to come back
 * from — the arena would end seconds after every spawn — so 1v1 keeps the
 * old respawn behavior and only the clock can end it.
 *
 * TDM only: domination disables the wipe win entirely (combat.ts:checkRoundEnd
 * returns early there), so this is never consulted in dom mode.
 */
export function eliminationEndsMatch(enemyCount: number): boolean {
  return enemyCount > 1;
}

/**
 * Winner of a domination match from the ticked flag points: higher score
 * takes it, ties draw. Kills score nothing in domination, so the TDM kill
 * counters are never consulted here — the `dom` slice owns both numbers.
 */
export function decideDomWinner(scoreCt: number, scoreT: number): MatchWinner {
  if (scoreCt > scoreT) return 'CT';
  if (scoreT > scoreCt) return 'T';
  return 'draw';
}

/**
 * Whether a domination score has hit the match-ending limit. Checked with
 * >= rather than ===: a multi-flag tick can jump a fractional score past the
 * limit without ever equalling it.
 */
export function reachesDomLimit(score: number, limit: number): boolean {
  return score >= limit;
}
