// combat.ts — damage resolution, player respawn, match-end detection.
//
// This module is the single place where HP crosses 0: bots call
// damagePlayer, weapons.ts calls damageBot. Keeping the two flows together
// makes the kill/score/respawn rules easy to audit. It also owns endMatch,
// the one transition into the finished state both win conditions converge
// on (clock expiry from main.ts, elimination from checkRoundEnd).
import type { Bot as BotShape, HitZone, MapName, Team } from './core/state';
import { player, session, aim, wpn, motion, score, bots, input, gameTime, armLoadout, playerFeet, cancelPendingReloadSfx } from './core/state';
import type { MatchWinner } from './sim/match';
import { eliminationEndsMatch } from './sim/match';
import * as THREE from 'three';
import { sfxHurt } from './audio';
import { flashDamageVignette, clearVignette, botKillTag, addKillfeed, updateScore, updateHUD } from './hud';
import { showLoadoutPicker, showEndScreen } from './menu';

/**
 * Apply damage to the player. On death: awards the killer's side its score,
 * releases pointer lock (which pauses the loop) and shows the death screen.
 * @param dmg raw damage; caller decides falloff/accuracy
 * @param attackerName display name for the killfeed — required so the
 *   compiler flags any future caller that would revive the anonymous
 *   'Bot killed You' wording
 */
export function damagePlayer(dmg: number, attackerName: string): void {
  // Debug-view god-mode: with the V overlay up the player is observing, not
  // playing, so incoming fire is dropped before it touches HP, the vignette,
  // the hurt sfx or the death screen. Bots still acquire and shoot normally —
  // only the damage landing is suppressed.
  if (session.debugView) return;
  // A finished match's scores are final: bots may still loose a shot in the
  // same frame the match ended, and it must not touch the scoreboard.
  if (!player.alive || session.matchOver) return;
  player.hp -= dmg;
  flashDamageVignette(dmg);
  sfxHurt();
  updateHUD();
  if (player.hp <= 0) {
    player.alive = false;
    cancelPendingReloadSfx();
    const attacker = bots.find(b => b.name === attackerName);
    // Side-fixed scores: a CT kill is a CT point (scoreKills), a T kill a T
    // point (scoreDeaths). The attacker is always the enemy; the fallback
    // covers an unresolvable name by crediting the opposing side.
    const killerTeam: Team = attacker?.team ?? (session.playerTeam === 'CT' ? 'T' : 'CT');
    if (killerTeam === 'CT') score.scoreKills++;
    else score.scoreDeaths++;
    score.playerDeaths++;
    if (attacker) attacker.kills++;
    addKillfeed(`${attackerName}${botKillTag(attacker)} killed You`);
    updateScore();
    document.exitPointerLock();
    // Wall clock ON PURPOSE: pointer lock was just released, so game time is
    // frozen — a pausable schedule here would never fire and the death
    // screen would never show. The delay exists to be seen while paused.
    // Small delay so the killer's shot is visible before the menu covers it.
    setTimeout(() => {
      // The match can end inside this window (a simultaneous elimination or
      // expiry): the end screen outranks the death picker. The reverse —
      // picker already up when the match ends — cannot happen (dying dropped
      // pointer lock, freezing the sim before another end condition can
      // fire); were that ever wrong, #endScreen would cover #loadoutScreen
      // by DOM order alone (both .menu).
      if (!session.matchOver) showLoadoutPicker('death');
    }, 400);
  }
}

/**
 * Resolve the incoming-fire stimulus for a bot about to take damage: a
 * normalized PLANAR victim-to-attacker bearing, or null when no direction
 * is known. An omitted `attackerName` means the live PLAYER; otherwise the
 * live bot with that display name. Resolution failing (unknown or already
 * dead attacker) or a degenerate zero planar offset yields no stimulus.
 * The brain never learns WHO fired or HOW FAR away it was — only the
 * direction.
 */
function incomingFireBearing(bot: BotShape, attackerName?: string): THREE.Vector3 | null {
  let from: THREE.Vector3 | null;
  if (attackerName === undefined) {
    if (!player.alive) return null;
    from = playerFeet(player);
  } else {
    const attacker = bots.find(b => b.name === attackerName);
    from = attacker && attacker.alive ? attacker.mesh.position : null;
  }
  if (!from) return null;
  const dx = from.x - bot.mesh.position.x;
  const dz = from.z - bot.mesh.position.z;
  const planar = Math.hypot(dx, dz);
  if (planar === 0) return null;
  return new THREE.Vector3(dx / planar, 0, dz / planar);
}

/**
 * Apply damage to a bot and kill it if HP is exhausted. Before the HP
 * mutation, a live attacker is resolved and a direction-only incoming-fire
 * bearing is forwarded — the victim reacts to WHERE the shot came from on
 * its next decision, even if this one kills it. It never learns the
 * attacker's identity or position.
 * @param bot instance from core/state's `bots` registry
 * @param dmg already-multiplied damage from the shooter
 * @param part hit zone, used for the killfeed text
 * @param attackerName display name of the shooting bot; omitted when the
 *   PLAYER pulled the trigger
 */
export function damageBot(bot: BotShape, dmg: number, part: HitZone, attackerName?: string): void {
  if (!bot.alive) return;
  const bearing = incomingFireBearing(bot, attackerName);
  if (bearing) bot.onIncomingFire(bearing);
  bot.hp -= dmg;
  if (bot.hp <= 0) bot.die(part, attackerName);
}

/**
 * Player spawn per side per map, on the map's centre line (x = 0).
 *
 * A full Record rather than a ternary chain on purpose: adding a MapName now
 * fails to compile until the new map declares where EACH side starts, instead
 * of silently inheriting the arena's coordinates. T spawns mirror CT across
 * -z (facing +z); the range is side-agnostic (no bots), so both entries face
 * downrange. feetY is the floor under the spawn — 0 everywhere except
 * warehouse2's T-side catwalk (5.1, matching BOT_SPAWNS). yaw is the spawn
 * facing: into the map on combat maps, downrange on the range for both sides.
 */
const SPAWN: Record<Team, Record<MapName, { z: number; feetY: number; yaw: number }>> = {
  CT: {
    arena: { z: 48, feetY: 0, yaw: 0 },
    range: { z: 8, feetY: 0, yaw: 0 },       // behind the firing line
    elevation: { z: 48, feetY: 0, yaw: 0 },  // open ground south of the two-story building
    warehouse1: { z: 40, feetY: 0, yaw: 0 }, // dock yard floor, 5 m clear of the south dock's face at z = 45
    warehouse2: { z: 27, feetY: 0, yaw: 0 }, // the +z yard, between the shell wall at 20.5 and the fence at 34
  },
  T: {
    arena: { z: -48, feetY: 0, yaw: Math.PI },
    range: { z: 8, feetY: 0, yaw: 0 },       // side-agnostic lane: same firing line, same facing
    elevation: { z: -48, feetY: 0, yaw: Math.PI },
    warehouse1: { z: -40, feetY: 0, yaw: Math.PI },
    warehouse2: { z: -16, feetY: 5.1, yaw: Math.PI }, // the -z catwalk band (BOT_SPAWNS -19..-13)
  },
};

/** Reset player + ammo to round-start values. Called from the Respawn button. */
export function respawn(): void {
  cancelPendingReloadSfx();
  const spawn = SPAWN[session.playerTeam][session.map];
  player.pos.set(0, spawn.feetY + player.eyeHeight, spawn.z);
  player.vel.set(0, 0, 0);
  player.hp = 100;
  player.alive = true;
  aim.yaw = spawn.yaw;
  aim.pitch = 0;
  wpn.recoil = 0;    // else the view punch would spawn the camera mid-climb
  wpn.recoilYaw = 0; // and mid-wander, off to one side
  wpn.spray = 1;     // resting multiplier, NOT 0 — see core/state.ts
  wpn.triggerLatch = false;
  wpn.emptyReloadLatch = false;
  // Same class: the accuracy/pose blends are smoothed toward their target over
  // ~100-200 ms, so dying mid-air respawns you inside the full AIR_PENALTY
  // (0.08 rad, ~15x the standing cone) until airLerp bleeds out.
  motion.airLerp = 0;
  motion.crouchLerp = 0;
  // The camera rides a smoothed ground height (player.ts eases it toward the
  // physics feet), so seed it AT the spawn floor — not 0. Dying on platform
  // geometry with a stale height would otherwise ease the view down from it
  // over the first ~100 ms, and a 5.1 m spawn (warehouse2 T-side) would climb
  // up from the shed floor instead of starting on the catwalk.
  motion.groundSmoothY = spawn.feetY;
  input.crouching = false; // else a death while crouch-toggled respawns you crouched
  wpn.adsLerp = 0;
  armLoadout();   // refills both loadout positions and mirrors the primary into `weapon`
  wpn.slot = 0;
  // Spawn Q-READY: switchWeapon only records lastSlot on a REAL swap, so
  // pinning it to the primary here made the first Q a self-targeted no-op —
  // Q did nothing until you'd switched once by hand (playtest round 1).
  // Pre-seeding the secondary position makes the first Q take it.
  wpn.lastSlot = 1;
  wpn.zoomLevel = 0;
  updateHUD();
  clearVignette();
}

/**
 * Win check after each bot death. With two or more enemies, wiping the
 * opposing team wins the match outright (endMatch) for the player's side. In
 * a 1v1 there is no wave to speak of — the arena would end seconds after
 * every spawn — so the old behavior stays: announce the clear and bring
 * everyone back after 2.5s, leaving only the clock to end the match.
 */
export function checkRoundEnd(): void {
  const foeTeam: Team = session.playerTeam === 'CT' ? 'T' : 'CT';
  const foes = bots.filter(b => b.team === foeTeam);
  if (foes.length > 0 && foes.every(b => !b.alive)) {
    // Live wave count, not session bot counts: debug tooling can remove bots,
    // and the decision should read what's actually on the field.
    if (eliminationEndsMatch(foes.length)) {
      addKillfeed(foeTeam === 'T' ? '★ All Ts eliminated!' : '★ All CTs eliminated!');
      endMatch(session.playerTeam);
    } else {
      addKillfeed('★ Bot down — respawning...');
      // Game time: the wave stays dead while paused. Every bot goes through
      // the full respawn() reset (placement, brain state, cached routes),
      // matching die()'s own revival path.
      gameTime.schedule(2.5, () => bots.forEach(b => b.respawn()));
    }
  }
}

/**
 * End the match and move to the score screen. One-shot: both win conditions
 * converge here, and whichever fires first owns the transition. Winner is
 * decided by the caller — the player's side outright on elimination, or by
 * kill score when the clock runs out (sim/match.ts:decideWinner); callers
 * announce their own killfeed line first.
 *
 * Pointer lock is released first so the loop stops simulating; the screen
 * then reveals on a WALL-clock delay for the same reason damagePlayer's
 * death picker uses one — game time freezes the moment lock drops, so a
 * pausable schedule here would never fire. The beat lets the final
 * killfeed line land before it is covered.
 */
export function endMatch(winner: MatchWinner): void {
  if (session.matchOver) return;
  session.matchOver = true;
  document.exitPointerLock();
  setTimeout(() => showEndScreen(winner), 600);
}
