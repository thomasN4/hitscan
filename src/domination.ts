// domination.ts — per-frame domination updater (browser glue).
//
// The RULES live in sim/domination.ts as pure functions; this module feeds
// them live bodies, announces flips on the killfeed, ticks the HUD and the
// flag markers, and ends the match when the score limit lands. Called from
// main.ts's loop after updateBots, inside the locked-only simulate block —
// like everything else measured in game time, domination freezes on pause.
import { bots, dom, player, playerFeet, session } from './core/state';
import {
  countFlagBodies,
  tickDomScores,
  updateFlagCapture,
  type DomBody,
} from './sim/domination';
import { decideDomWinner, reachesDomLimit } from './sim/match';
import { addKillfeed, updateDomHUD } from './hud';
import { updateDomFlagColors } from './domFlags';
import { endMatch } from './combat';

/**
 * Advance capture, tick scores, refresh the flag views, and end the match
 * on the score limit. No-op outside domination matches, on flagless maps,
 * and once the match is over (endMatch is one-shot, but the tick must not
 * keep moving the numbers behind the score screen).
 */
export function updateDomination(dt: number): void {
  if (session.mode !== 'dom' || dom.flags.length === 0 || session.matchOver) return;
  const bodies: DomBody[] = [];
  if (player.alive) {
    const feet = playerFeet(player);
    bodies.push({ team: session.playerTeam, x: feet.x, feetY: feet.y, z: feet.z });
  }
  for (const b of bots) {
    if (!b.alive) continue;
    bodies.push({ team: b.team, x: b.mesh.position.x, feetY: b.mesh.position.y, z: b.mesh.position.z });
  }
  for (const flag of dom.flags) {
    const { t, ct } = countFlagBodies(flag, bodies);
    const flipped = updateFlagCapture(flag, t, ct, dt);
    if (flipped !== null) {
      addKillfeed(flipped === 'T' ? `★ T captured ${flag.id}!` : `★ CT captured ${flag.id}!`);
    }
  }
  const scores = { ct: dom.scoreCt, t: dom.scoreT };
  tickDomScores(dom.flags, scores, dt);
  dom.scoreCt = scores.ct;
  dom.scoreT = scores.t;
  updateDomFlagColors();
  updateDomHUD();
  if (reachesDomLimit(dom.scoreCt, session.scoreLimit) || reachesDomLimit(dom.scoreT, session.scoreLimit)) {
    // Floored like the HUD: the end screen must agree with the top bar.
    const winner = decideDomWinner(Math.floor(dom.scoreCt), Math.floor(dom.scoreT));
    addKillfeed(winner === 'draw' ? `★ Score limit reached` : `★ ${winner} hit ${session.scoreLimit}!`);
    endMatch(winner);
  }
}
