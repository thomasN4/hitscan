// spawn.ts — pure player-spawn helpers for combat.ts:respawn().
//
// combat.ts is browser-side (audio/hud/menu imports), so the unit suite
// cannot reach anything defined there — the import ban in eslint.config.js
// bars tests from it outright. Facing lives here instead: the one piece of
// player placement that is pure logic. Same seam precedent as
// sim/recoil.ts:convertOnSwap().
import type { Team } from '../core/state';

/**
 * Player spawn facing: into the map by team convention — CTs face -z (yaw 0),
 * Ts face +z (yaw PI). The range is not covered: it is side-agnostic (no
 * bots), so both sides take combat.ts:RANGE_SPAWN's downrange facing.
 *
 * Note the trap: Bot.spawnAtRandom writes the same convention onto meshes as
 * rotation.y T=0/CT=PI — opposite numbering, because a mesh faces +z at
 * rotation 0 while aim yaw 0 faces -z. Unify the two numberings and one side
 * spawns staring at its own back line.
 */
export function playerSpawnYaw(team: Team): number {
  return team === 'T' ? Math.PI : 0;
}
