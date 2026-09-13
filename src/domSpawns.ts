// domSpawns.ts — CoD-style respawn director for domination matches.
//
// Initial spawns stay exactly as before (BOT_SPAWNS zones via
// Bot.spawnAtRandom, combat.ts:SPAWN for the player). RESPAWNS in dom mode
// come through here instead: half the candidates ring team-owned flags,
// half come from the team's initial zone, the standable ones are ranked by
// sim/domination.ts:scoreDomSpawn (far from enemies, near owned flags) and
// the winner is returned as a feet position.
//
// Standability is checked here against live colliders; RANKING is the pure
// seam's job. That split is what keeps the scoring unit-testable in Node
// while the geometry test stays where colliders live.
import * as THREE from 'three';
import { BOT_SPAWNS, dom, session, type Team } from './core/state';
import { colliders } from './world';
import { collidesAt } from './collision';
import { NAV_RADIUS } from './nav';
import { scoreDomSpawn, type SpawnCandidate } from './sim/domination';

/** Respawn candidates drawn per call: half flag rings, half zone draws. */
const CANDIDATES = 8;
/** Flag-ring band (m): inside the capture radius would spawn onto the fight, outside 10 m is not "near" it. */
const RING_INNER = 4;
const RING_OUTER = 10;

/**
 * Pick a domination respawn point for `team`.
 *
 * @param team respawning side; its owned flags anchor the ring candidates.
 * @param enemies world-space XZ of live opponents to spawn away from.
 * @param rng draw stream; Math.random in production, scripted in a pinch.
 */
export function pickDomRespawn(
  team: Team,
  enemies: readonly { x: number; z: number }[],
  rng: () => number = Math.random,
): THREE.Vector3 {
  const zone = BOT_SPAWNS[session.map][team];
  const owned = dom.flags.filter(f => f.owner === team);
  const candidates: SpawnCandidate[] = [];
  for (let i = 0; i < CANDIDATES; i++) {
    if (owned.length > 0 && i % 2 === 0) {
      const f = owned[Math.floor(rng() * owned.length)]!;
      const a = rng() * Math.PI * 2;
      const r = RING_INNER + rng() * (RING_OUTER - RING_INNER);
      candidates.push({ x: f.pos.x + Math.cos(a) * r, y: f.pos.y, z: f.pos.z + Math.sin(a) * r });
    } else {
      candidates.push({
        x: zone.minX + rng() * (zone.maxX - zone.minX),
        y: zone.y,
        z: zone.minZ + rng() * (zone.maxZ - zone.minZ),
      });
    }
  }
  // NAV_RADIUS fits both bodies (bots 0.5, player 0.45): one graph, one test.
  const standable = candidates.filter(
    c => !collidesAt(new THREE.Vector3(c.x, 0, c.z), NAV_RADIUS, c.y, colliders),
  );
  const pool = standable.length > 0 ? standable : candidates;
  const idx = scoreDomSpawn(
    pool,
    enemies,
    owned.map(f => ({ x: f.pos.x, z: f.pos.z })),
  );
  const won = pool[idx] ?? candidates[0]!;
  return new THREE.Vector3(won.x, won.y, won.z);
}
