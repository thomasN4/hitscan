# Match end tranche — plan

Make a match actually END. The round clock previously reset itself to full
length on expiry (an explicitly deferred placeholder); now expiry — or wiping
the enemy wave — transitions to a real score screen.

## Why this work exists

`main.ts` counted `score.roundTime` down and silently restarted it, with a
comment deferring "what a real round end looks like" to a later PR. The only
round mechanic was `checkRoundEnd`'s all-Ts-dead announcement, which respawned
everyone without recording anything. Scores existed (CT/T kill tallies) but
never resolved into a win, and there was nowhere to see them at the end.

## Decisions

- **Two win conditions, one transition.** Clock expiry decides by kill score
  (`sim/match.ts:decideWinner` — higher of scoreKills/scoreDeaths, ties draw);
  wiping every T wins outright for CT. Both converge on
  `combat.ts:endMatch(winner)`, a one-shot guarded by `session.matchOver`,
  which releases pointer lock (freezing the sim through the existing lock
  gate) and reveals the screen on a WALL-clock beat for the same reason
  damagePlayer's death picker uses one.
  *(Annotation, PR #120: with a selectable side, wiping the side opposing
  `session.playerTeam` wins outright for the player's side
  (`combat.ts:checkRoundEnd` selects `foeTeam` and hands `endMatch` the
  player's own side).)*
- **1v1 keeps the wave loop.** With a single enemy, elimination would end the
  match seconds after every spawn, so `eliminationEndsMatch(ts.length)` is
  false for tbots ≤ 1 and the old wave-respawn behavior stays — killfeed line
  reworded to "★ Bot down — respawning..." (review of this PR: nothing is won
  in a 1v1, so "Round won!" overstated it); only the clock can end such a
  match. The check passes the LIVE wave count, not session.botsT, so debug
  tooling removing bots can't leave one survivor ending the match.
  *(Annotation, PR #120: the count is now the live `foes` wave and the
  parameter is renamed `enemyCount` (`sim/match.ts`); the ≤1 rule is
  unchanged.)*
- **Winner decided by the CALLER**, passed into endMatch as `'CT' | 'T' |
  'draw'`: elimination knows its winner outright; expiry computes from the
  scores. endMatch owns state + presentation only.
- **Scoreboard counters are additive, not re-derived.** Team scores stay as
  they were (scoreKills/scoreDeaths already mean CT/T side kills). New:
  per-bot `kills`/`deaths` on the Bot shape, personal
  `score.playerKills`/`playerDeaths`, attributed where deaths already cross
  zero (bots.ts:die, combat.ts:damagePlayer — attacker resolved by display
  name, which is unique per team serial).
- **Score screen is menu.ts's** (#endScreen), per the DOM-ownership rule:
  banner colored by winner, final team line, K/D table (You highlighted,
  everyone sorted by kills desc) built fresh per reveal, Rematch (reload —
  same query IS same match config) and Back to Menu (bare path → defaults).
- **Post-match input is dead, not just hidden.** damagePlayer ignores damage
  once matchOver (a bot can loose a shot in endMatch's own frame), the
  death-picker timeout yields to the score screen if the match ends inside
  its 400 ms window, canvas click-to-relock refuses, and pointerlockchange
  never offers the pause menu over it.

## Verification

- Unit (`sim/match.test.ts`): winner decision incl. draw; elimination ends
  matches at ≥2 Ts and not at ≤1.
- Smoke test (`[matchend]` phase): elimination path asserts the banner, the
  killfeed line, personal AND team credit for the wipe, row count; rematch
  reload resets matchOver behind the same query; clock path forces
  roundTime ≈ 0 with T ahead and asserts the T banner plus the readout
  frozen at 0:00.
