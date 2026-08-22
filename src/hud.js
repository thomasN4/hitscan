import { player, weapon, game } from './core.js';

const el = id => document.getElementById(id);
const hudEl = el('hud');
const crosshair = el('crosshair');
const hitmarkerEl = el('hitmarker');
const vignette = el('vignette');
const killfeedEl = el('killfeed');
const hpText = el('hpText');
const healthFill = el('healthFill');
const magText = el('magText');
const ammoReserve = el('ammoReserve');
const reloadHint = el('reloadHint');

export { hudEl, crosshair, vignette };

let hitmarkerTimer = null;
export function showHitmarker(headshot) {
  hitmarkerEl.querySelectorAll('div').forEach(d => d.style.background = headshot ? '#ff4444' : '#fff');
  hitmarkerEl.style.opacity = 1;
  clearTimeout(hitmarkerTimer);
  hitmarkerTimer = setTimeout(() => hitmarkerEl.style.opacity = 0, 120);
}

export function flashDamageVignette(dmg) {
  vignette.style.boxShadow = `inset 0 0 ${100 + (100 - player.hp)}px rgba(255,0,0,${0.25 + dmg / 60})`;
  setTimeout(() => {
    vignette.style.boxShadow = `inset 0 0 120px rgba(255,0,0,${player.hp < 40 ? 0.18 : 0})`;
  }, 150);
}

export function clearVignette() {
  vignette.style.boxShadow = 'none';
}

export function addKillfeed(text) {
  const entry = document.createElement('div');
  entry.className = 'kf';
  entry.textContent = text;
  killfeedEl.prepend(entry);
  setTimeout(() => entry.style.opacity = 0, 3500);
  setTimeout(() => entry.remove(), 4500);
}

export function updateScore() {
  document.getElementById('scoreCT').textContent = 'CT ' + game.scoreKills;
  document.getElementById('scoreT').textContent = 'T ' + game.scoreDeaths;
}

export function setTimer(seconds) {
  const m = Math.floor(seconds / 60), s = Math.floor(seconds % 60);
  document.getElementById('timer').textContent = `${m}:${s.toString().padStart(2, '0')}`;
}

export function updateHUD() {
  hpText.textContent = Math.max(0, Math.round(player.hp));
  healthFill.style.width = Math.max(0, player.hp) + '%';
  healthFill.style.background = player.hp > 60 ? '#4caf50' : player.hp > 25 ? '#ffab40' : '#ff5252';
  magText.textContent = weapon.mag;
  ammoReserve.textContent = weapon.reserve;
  reloadHint.style.visibility = (weapon.mag <= 10 && !weapon.reloading) ? 'visible' : 'hidden';
  if (weapon.reloading) reloadHint.textContent = 'RELOADING...';
  else reloadHint.textContent = 'PRESS [R] TO RELOAD';
}
