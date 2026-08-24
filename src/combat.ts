// combat.ts — damage resolution, player respawn, round-end detection.
//
// This module is the single place where HP crosses 0: bots call
// damagePlayer, weapons.ts calls damageBot. Keeping the two flows together
// makes the kill/score/respawn rules easy to audit.
import type { Bot as BotShape, HitZone } from './core/state';
import { player, session, aim, wpn, motion, score, bots, input, gameTime, resetAmmo } from './core/state';
import { sfxHurt } from './audio';
import { flashDamageVignette, clearVignette, addKillfeed, updateScore, updateHUD } from './hud';
import { showDeathScreen } from './menu';

/**
 * Apply damage to the player. On death: awards the bot-side score,
 * releases pointer lock (which pauses the loop) and shows the death screen.
 * @param dmg raw damage; caller decides falloff/accuracy
 * @param attackerName display name for the killfeed — required so the
 *   compiler flags any future caller that would revive the anonymous
 *   'Bot killed You' wording
 */
export function damagePlayer(dmg: number, attackerName: string): void {
  if (!player.alive) return;
  player.hp -= dmg;
  flashDamageVignette(dmg);
  sfxHurt();
  updateHUD();
  if (player.hp <= 0) {
    player.alive = false;
    score.scoreDeaths++;
    addKillfeed(`${attackerName} killed You`);
    updateScore();
    document.exitPointerLock();
    // Wall clock ON PURPOSE: pointer lock was just released, so game time is
    // frozen — a pausable schedule here would never fire and the death
    // screen would never show. The delay exists to be seen while paused.
    // Small delay so the killer's shot is visible before the menu covers it.
    setTimeout(() => {
      showDeathScreen(true);
    }, 400);
  }
}

/**
 * Apply damage to a bot and kill it if HP is exhausted.
 * @param bot instance from core/state's `bots` registry
 * @param dmg already-multiplied damage from the shooter
 * @param part hit zone, used for the killfeed text
 * @param attackerName display name of the shooting bot; omitted when the
 *   PLAYER pulled the trigger
 */
export function damageBot(bot: BotShape, dmg: number, part: HitZone, attackerName?: string): void {
  if (!bot.alive) return;
  bot.hp -= dmg;
  if (bot.hp <= 0) bot.die(part, attackerName);
}

/** Reset player + ammo to round-start values. Called from the Respawn button. */
export function respawn(): void {
  const spawnZ = session.map === 'range' ? 8 : 48; // range: behind the firing line
  player.pos.set(0, player.eyeHeight, spawnZ);
  player.vel.set(0, 0, 0);
  player.hp = 100;
  player.alive = true;
  aim.yaw = 0;   // face -z, into the arena / downrange
  aim.pitch = 0;
  wpn.recoil = 0;    // else the view punch would spawn the camera mid-climb
  wpn.recoilYaw = 0; // and mid-wander, off to one side
  wpn.spray = 1;     // resting multiplier, NOT 0 — see core/state.ts
  // Same class: the accuracy/pose blends are smoothed toward their target over
  // ~100-200 ms, so dying mid-air respawns you inside the full AIR_PENALTY
  // (0.08 rad, ~15x the standing cone) until airLerp bleeds out.
  motion.airLerp = 0;
  motion.crouchLerp = 0;
  input.crouching = false; // else a death while crouch-toggled respawns you crouched
  wpn.adsLerp = 0;
  resetAmmo();    // refills both slots and mirrors the smg into `weapon`
  wpn.slot = 0;
  wpn.zoomLevel = 0;
  updateHUD();
  clearVignette();
}

/**
 * Win check after each bot death: when every T is dead at once, announce
 * the round win and bring everyone (both teams) back after 2.5s. Bots also
 * self-respawn 6s after dying individually, so this only fires on the brief
 * all-clear. CT casualties never end a round — the wave is the enemy.
 */
export function checkRoundEnd(): void {
  const ts = bots.filter(b => b.team === 'T');
  if (ts.length > 0 && ts.every(b => !b.alive)) {
    addKillfeed('★ Round won! Respawning all bots...');
    // Game time: the wave stays dead while paused.
    gameTime.schedule(2.5, () => bots.forEach(b => { b.hp = 100; b.alive = true; b.mesh.visible = true; b.spawnAtRandom(); }));
  }
}
