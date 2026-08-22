// combat.js — damage resolution, player respawn, round-end detection.
//
// This module is the single place where HP crosses 0: bots call
// damagePlayer, weapons.js calls damageBot. Keeping the two flows together
// makes the kill/score/respawn rules easy to audit.
import { player, game, bots, resetAmmo } from './core.js';
import { sfxHurt } from './audio.js';
import { flashDamageVignette, clearVignette, addKillfeed, updateScore, updateHUD } from './hud.js';

/**
 * Apply damage to the player. On death: awards the bot-side score,
 * releases pointer lock (which pauses the loop) and shows the death screen.
 * @param {number} dmg - raw damage; caller decides falloff/accuracy
 */
export function damagePlayer(dmg) {
  if (!player.alive) return;
  player.hp -= dmg;
  flashDamageVignette(dmg);
  sfxHurt();
  updateHUD();
  if (player.hp <= 0) {
    player.alive = false;
    game.scoreDeaths++;
    addKillfeed('Bot killed You');
    updateScore();
    document.exitPointerLock();
    // Small delay so the killer's shot is visible before the menu covers it.
    setTimeout(() => {
      document.getElementById('deathScreen').style.display = 'flex';
    }, 400);
  }
}

/**
 * Apply damage to a bot and kill it if HP is exhausted.
 * @param {Bot} bot - instance from core.bots
 * @param {number} dmg - already-multiplied damage from weapons.js
 * @param {'head'|'torso'|'legs'} part - hit zone, used for the killfeed text
 */
export function damageBot(bot, dmg, part) {
  if (!bot.alive) return;
  bot.hp -= dmg;
  if (bot.hp <= 0) bot.die(part);
}

/** Reset player + ammo to round-start values. Called from the Respawn button. */
export function respawn() {
  const spawnZ = game.map === 'range' ? 8 : 48; // range: behind the firing line
  player.pos.set(0, player.eyeHeight, spawnZ);
  player.vel.set(0, 0, 0);
  player.hp = 100;
  player.alive = true;
  game.yaw = 0;   // face -z, into the arena / downrange
  game.pitch = 0;
  game.recoil = 0; // else the view punch would spawn the camera mid-climb
  game.bloom = 0;
  resetAmmo();    // refills both slots and mirrors the rifle into `weapon`
  game.slot = 0;
  game.zoomLevel = 0;
  updateHUD();
  clearVignette();
}

/**
 * Win check after each bot death: when every bot is dead at once, announce
 * the round win and bring them all back after 2.5s. Bots also self-respawn
 * 6s after dying individually, so this only fires on the brief all-clear.
 */
export function checkRoundEnd() {
  if (bots.every(b => !b.alive)) {
    addKillfeed('★ Round won! Respawning enemies...');
    setTimeout(() => bots.forEach(b => { b.hp = 100; b.alive = true; b.mesh.visible = true; b.spawnAtRandom(); }), 2500);
  }
}
