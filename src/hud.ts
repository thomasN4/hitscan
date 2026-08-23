// hud.ts — all DOM manipulation for the 2D overlay (health, ammo, score,
// kill feed, crosshair, hit/damage feedback).
//
// The HUD elements are plain markup in index.html; this module grabs the
// references once and exposes small update functions. Nothing else should
// touch the DOM directly.
//
// NOTE: functions here read core/state.ts directly rather than taking
// params — acceptable because the HUD is a pure view of that state.
import { player, weapon, game, WEAPONS, BASE_FOV } from './core/state';

/**
 * Fetch an element by id, or fail loudly at startup naming it.
 *
 * getElementById returns `T | null`, and the old code relied on a later
 * null-property crash to reveal markup changes — far from where the real
 * problem is. This is the one deliberate behavior change of the migration:
 * a missing element is now a named startup error. Used by main.ts and
 * combat.ts too, so every DOM lookup shares one failure path.
 */
export function requireEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id} — index.html markup changed?`);
  return el;
}

// Element refs are resolved by initHUD() rather than at module scope, so
// importing this module does not require a DOM. main.ts calls initHUD()
// once, before the game loop starts; every function below assumes it ran.
const el = requireEl;

let hitmarkerEl: HTMLElement, killfeedEl: HTMLElement, hpText: HTMLElement,
  healthFill: HTMLElement, magText: HTMLElement,
  ammoReserve: HTMLElement, reloadHint: HTMLElement, scopeOverlay: HTMLElement,
  zoomText: HTMLElement, weaponName: HTMLElement;

// Declared non-optional on purpose: like engine.ts's singletons, the
// contract is "read only after init*()" — typing them optional would push
// a null check onto every consumer for a violation the contract rules out.
export let hudEl: HTMLElement;
export let crosshair: HTMLElement;
export let vignette: HTMLElement;

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

let hitmarkerTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Flash the X-shaped marker at screen center.
 * @param {boolean} headshot - red marker instead of white
 */
export function showHitmarker(headshot: boolean): void {
  hitmarkerEl.querySelectorAll('div').forEach(d => d.style.background = headshot ? '#ff4444' : '#fff');
  hitmarkerEl.style.opacity = '1';
  if (hitmarkerTimer !== null) clearTimeout(hitmarkerTimer);
  // (DOM lib's clearTimeout accepts number | undefined, not null)
  hitmarkerTimer = setTimeout(() => { hitmarkerEl.style.opacity = '0'; }, 120);
}

/** Red edge-glow pulse when the player takes damage; intensity scales with `dmg`. */
export function flashDamageVignette(dmg: number): void {
  vignette.style.boxShadow = `inset 0 0 ${100 + (100 - player.hp)}px rgba(255,0,0,${0.25 + dmg / 60})`;
  // Let the CSS transition fade it back; persistent glow remains at low HP.
  setTimeout(() => {
    vignette.style.boxShadow = `inset 0 0 120px rgba(255,0,0,${player.hp < 40 ? 0.18 : 0})`;
  }, 150);
}

export function clearVignette(): void {
  vignette.style.boxShadow = 'none';
}

/** Prepend an entry to the kill feed; auto-fades after 3.5s. */
export function addKillfeed(text: string): void {
  const entry = document.createElement('div');
  entry.className = 'kf';
  entry.textContent = text;
  killfeedEl.prepend(entry);
  // style properties are CSS strings; bare numbers only worked via coercion
  setTimeout(() => { entry.style.opacity = '0'; }, 3500);
  setTimeout(() => entry.remove(), 4500);
}

/** Refresh CT/T round score from game.scoreKills / game.scoreDeaths. */
export function updateScore(): void {
  requireEl('scoreCT').textContent = 'CT ' + game.scoreKills;
  requireEl('scoreT').textContent = 'T ' + game.scoreDeaths;
}

/** Format remaining seconds as m:ss in the top-bar timer. */
export function setTimer(seconds: number): void {
  const m = Math.floor(seconds / 60), s = Math.floor(seconds % 60);
  requireEl('timer').textContent = `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Full refresh of HP + ammo widgets. Called every frame while playing —
 * cheap enough, and spares callers from tracking which value changed.
 */
/**
 * Push the crosshair arms out from center. `px` should derive from the
 * same totalSpread the bullets use (see weapons.ts) so the reticle honestly
 * reflects where shots will land.
 */
export function setCrosshairGap(px: number): void {
  crosshair.style.setProperty('--gap', px.toFixed(1) + 'px');
}

/**
 * Show/hide the full-screen sniper scope reticle. While it is up the normal
 * crosshair is hidden (the reticle replaces it). Called every frame from
 * weapons.ts, so flips are cached to avoid DOM churn; main.ts also forces
 * `false` on pointer-lock loss since updateWeapon stops running then.
 */
let scopeShown = false;
export function setScopeOverlay(on: boolean): void {
  if (on === scopeShown) return;
  scopeShown = on;
  scopeOverlay.style.display = on ? 'block' : 'none';
  crosshair.style.visibility = on ? 'hidden' : 'visible';
}

let lastName = '';
let lastZoomLabel = '';
export function updateHUD() {
  hpText.textContent = String(Math.max(0, Math.round(player.hp)));
  healthFill.style.width = Math.max(0, player.hp) + '%';
  // Color shifts green -> orange -> red as HP drops.
  healthFill.style.background = player.hp > 60 ? '#4caf50' : player.hp > 25 ? '#ffab40' : '#ff5252';
  magText.textContent = String(weapon.mag);
  ammoReserve.textContent = String(weapon.reserve);
  reloadHint.style.visibility = (weapon.mag <= 10 && !weapon.reloading) ? 'visible' : 'hidden';
  if (weapon.reloading) reloadHint.textContent = 'RELOADING...';
  else reloadHint.textContent = 'PRESS [R] TO RELOAD';
  // Weapon name + scope zoom label; cached so unchanged values don't touch
  // the DOM (these are written every frame like the rest of updateHUD).
  if (weapon.name !== lastName) {
    lastName = weapon.name;
    weaponName.textContent = weapon.name;
  }
  // zoomLevel is wheel-wrapped and reset to 0 by weapons.ts, so a miss here
  // cannot happen in play — but the honest guard under noUncheckedIndexedAccess
  // degrades to no label instead of crashing the HUD refresh.
  const zoomFov = game.aiming && game.slot === 1 ? WEAPONS[game.slot]?.zoomFovs[game.zoomLevel] : undefined;
  const zoomLabel = zoomFov !== undefined ? Math.round(BASE_FOV / zoomFov) + 'x' : '';
  if (zoomLabel !== lastZoomLabel) {
    lastZoomLabel = zoomLabel;
    zoomText.textContent = zoomLabel;
  }
}
