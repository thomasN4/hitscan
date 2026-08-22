// hud.js — all DOM manipulation for the 2D overlay (health, ammo, score,
// kill feed, crosshair, hit/damage feedback).
//
// The HUD elements are plain markup in index.html; this module grabs the
// references once and exposes small update functions. Nothing else should
// touch the DOM directly.
//
// NOTE: functions here read core.js state directly rather than taking
// params — acceptable because the HUD is a pure view of that state.
import { player, weapon, game, WEAPONS, BASE_FOV } from './core/state.js';

// Element refs are resolved by initHUD() rather than at module scope, so
// importing this module does not require a DOM. main.js calls initHUD()
// once, before the game loop starts; every function below assumes it ran.
const el = id => document.getElementById(id);

let hitmarkerEl, killfeedEl, hpText, healthFill, magText,
  ammoReserve, reloadHint, scopeOverlay, zoomText, weaponName;

/** @type {HTMLElement} */ export let hudEl;
/** @type {HTMLElement} */ export let crosshair;
/** @type {HTMLElement} */ export let vignette;

/** Resolve every HUD element reference. Call once, after the DOM is ready. */
export function initHUD() {
  hudEl = el('hud');
  crosshair = el('crosshair');
  hitmarkerEl = el('hitmarker');
  vignette = el('vignette');
  killfeedEl = el('killfeed');
  hpText = el('hpText');
  healthFill = el('healthFill');
  magText = el('magText');
  ammoReserve = el('ammoReserve');
  reloadHint = el('reloadHint');
  scopeOverlay = el('scopeOverlay');
  zoomText = el('zoomText');
  weaponName = el('weaponName');
}

let hitmarkerTimer = null;

/**
 * Flash the X-shaped marker at screen center.
 * @param {boolean} headshot - red marker instead of white
 */
export function showHitmarker(headshot) {
  hitmarkerEl.querySelectorAll('div').forEach(d => d.style.background = headshot ? '#ff4444' : '#fff');
  hitmarkerEl.style.opacity = 1;
  clearTimeout(hitmarkerTimer);
  hitmarkerTimer = setTimeout(() => hitmarkerEl.style.opacity = 0, 120);
}

/** Red edge-glow pulse when the player takes damage; intensity scales with `dmg`. */
export function flashDamageVignette(dmg) {
  vignette.style.boxShadow = `inset 0 0 ${100 + (100 - player.hp)}px rgba(255,0,0,${0.25 + dmg / 60})`;
  // Let the CSS transition fade it back; persistent glow remains at low HP.
  setTimeout(() => {
    vignette.style.boxShadow = `inset 0 0 120px rgba(255,0,0,${player.hp < 40 ? 0.18 : 0})`;
  }, 150);
}

export function clearVignette() {
  vignette.style.boxShadow = 'none';
}

/** Prepend an entry to the kill feed; auto-fades after 3.5s. */
export function addKillfeed(text) {
  const entry = document.createElement('div');
  entry.className = 'kf';
  entry.textContent = text;
  killfeedEl.prepend(entry);
  setTimeout(() => entry.style.opacity = 0, 3500);
  setTimeout(() => entry.remove(), 4500);
}

/** Refresh CT/T round score from game.scoreKills / game.scoreDeaths. */
export function updateScore() {
  document.getElementById('scoreCT').textContent = 'CT ' + game.scoreKills;
  document.getElementById('scoreT').textContent = 'T ' + game.scoreDeaths;
}

/** Format remaining seconds as m:ss in the top-bar timer. */
export function setTimer(seconds) {
  const m = Math.floor(seconds / 60), s = Math.floor(seconds % 60);
  document.getElementById('timer').textContent = `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Full refresh of HP + ammo widgets. Called every frame while playing —
 * cheap enough, and spares callers from tracking which value changed.
 */
/**
 * Push the crosshair arms out from center. `px` should derive from the
 * same totalSpread the bullets use (see weapons.js) so the reticle honestly
 * reflects where shots will land.
 */
export function setCrosshairGap(px) {
  crosshair.style.setProperty('--gap', px.toFixed(1) + 'px');
}

/**
 * Show/hide the full-screen sniper scope reticle. While it is up the normal
 * crosshair is hidden (the reticle replaces it). Called every frame from
 * weapons.js, so flips are cached to avoid DOM churn; main.js also forces
 * `false` on pointer-lock loss since updateWeapon stops running then.
 */
let scopeShown = false;
export function setScopeOverlay(on) {
  if (on === scopeShown) return;
  scopeShown = on;
  scopeOverlay.style.display = on ? 'block' : 'none';
  crosshair.style.visibility = on ? 'hidden' : 'visible';
}

let lastName = '';
let lastZoomLabel = '';
export function updateHUD() {
  hpText.textContent = Math.max(0, Math.round(player.hp));
  healthFill.style.width = Math.max(0, player.hp) + '%';
  // Color shifts green -> orange -> red as HP drops.
  healthFill.style.background = player.hp > 60 ? '#4caf50' : player.hp > 25 ? '#ffab40' : '#ff5252';
  magText.textContent = weapon.mag;
  ammoReserve.textContent = weapon.reserve;
  reloadHint.style.visibility = (weapon.mag <= 10 && !weapon.reloading) ? 'visible' : 'hidden';
  if (weapon.reloading) reloadHint.textContent = 'RELOADING...';
  else reloadHint.textContent = 'PRESS [R] TO RELOAD';
  // Weapon name + scope zoom label; cached so unchanged values don't touch
  // the DOM (these are written every frame like the rest of updateHUD).
  if (weapon.name !== lastName) {
    lastName = weapon.name;
    weaponName.textContent = weapon.name;
  }
  const zoomLabel = game.aiming && game.slot === 1
    ? Math.round(BASE_FOV / WEAPONS[game.slot].zoomFovs[game.zoomLevel]) + 'x'
    : '';
  if (zoomLabel !== lastZoomLabel) {
    lastZoomLabel = zoomLabel;
    zoomText.textContent = zoomLabel;
  }
}
