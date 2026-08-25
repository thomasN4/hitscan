// sim/match.ts — match-end decision rules.
//
// Pure. Kept out of combat.ts/main.ts so the two ways a match can end are
// unit-testable without a browser: the clock expiring (winner by score) and
// the last T falling (immediate CT win, except the 1v1 case).

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
 * Whether "every T dead at once" ends the match outright rather than just
 * respawning the wave. With a single enemy there is no wave to come back
 * from — the arena would end seconds after every spawn — so 1v1 keeps the
 * old respawn behavior and only the clock can end it.
 */
export function eliminationEndsMatch(botsT: number): boolean {
  return botsT > 1;
}
