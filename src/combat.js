import { player, weapon, game, bots } from './core.js';
import { sfxHurt } from './audio.js';
import { flashDamageVignette, clearVignette, addKillfeed, updateScore, updateHUD } from './hud.js';

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
    setTimeout(() => {
      document.getElementById('deathScreen').style.display = 'flex';
    }, 400);
  }
}

export function damageBot(bot, dmg, part) {
  if (!bot.alive) return;
  bot.hp -= dmg;
  if (bot.hp <= 0) bot.die(part);
}

export function respawn() {
  player.pos.set(0, player.eyeHeight, 48);
  player.vel.set(0, 0, 0);
  player.hp = 100;
  player.alive = true;
  game.yaw = Math.PI;
  game.pitch = 0;
  weapon.mag = weapon.magSize;
  weapon.reserve = 90;
  weapon.reloading = false;
  updateHUD();
  clearVignette();
}

export function checkRoundEnd() {
  if (bots.every(b => !b.alive)) {
    addKillfeed('★ Round won! Respawning enemies...');
    setTimeout(() => bots.forEach(b => { b.hp = 100; b.alive = true; b.mesh.visible = true; b.spawnAtRandom(); }), 2500);
  }
}
