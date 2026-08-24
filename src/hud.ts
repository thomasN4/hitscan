// hud.ts — all DOM manipulation for the 2D overlay (health, ammo, score,
// kill feed, crosshair, hit/damage feedback).
//
// The HUD elements are plain markup in index.html; this module grabs the
// references once and exposes small update functions. Nothing else should
// touch the DOM directly.
//
// NOTE: functions here read core/state.ts directly rather than taking
// params — acceptable because the HUD is a pure view of that state.
import { player, weapon, input, wpn, score, session, bots, WEAPONS, BASE_FOV, equippedId } from './core/state';
import { isLowAmmo } from './sim/ammo';

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
  healthFill: HTMLElement, magText: HTMLElement, ammoSep: HTMLElement,
  ammoReserve: HTMLElement, reloadHint: HTMLElement, scopeOverlay: HTMLElement,
  zoomText: HTMLElement, weaponName: HTMLElement, botDebug: HTMLElement;

// Declared non-optional on purpose: like engine.ts's singletons, the
// contract is "read only after init*()" — typing them optional would push
// a null check onto every consumer for a violation the contract rules out.
export let hudEl: HTMLElement;
export let crosshair: HTMLElement;
export let vignette: HTMLElement;

/** Resolve every HUD element reference. Call once, after the DOM is ready. */
export function initHUD(): void {
  hudEl = el('hud');
  crosshair = el('crosshair');
  hitmarkerEl = el('hitmarker');
  vignette = el('vignette');
  killfeedEl = el('killfeed');
  hpText = el('hpText');
  healthFill = el('healthFill');
  magText = el('magText');
  ammoSep = el('ammoSep');
  ammoReserve = el('ammoReserve');
  reloadHint = el('reloadHint');
  scopeOverlay = el('scopeOverlay');
  zoomText = el('zoomText');
  weaponName = el('weaponName');
  botDebug = el('botDebug');
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

/** Refresh CT/T round score from score.scoreKills / score.scoreDeaths. */
export function updateScore(): void {
  requireEl('scoreCT').textContent = 'CT ' + score.scoreKills;
  requireEl('scoreT').textContent = 'T ' + score.scoreDeaths;
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
export function updateHUD(): void {
  hpText.textContent = String(Math.max(0, Math.round(player.hp)));
  healthFill.style.width = Math.max(0, player.hp) + '%';
  // Color shifts green -> orange -> red as HP drops.
  healthFill.style.background = player.hp > 60 ? '#4caf50' : player.hp > 25 ? '#ffab40' : '#ff5252';
  // The knife holds no rounds: the mag/reserve readout and reload hint hide
  // while it is live (the separator between the two numbers goes with them).
  const meleeHeld = WEAPONS[equippedId(wpn.slot)].melee === true;
  const ammoDisplay = meleeHeld ? 'none' : 'inline';
  magText.style.display = ammoDisplay;
  ammoSep.style.display = ammoDisplay;
  ammoReserve.style.display = ammoDisplay;
  reloadHint.style.visibility = (!meleeHeld && !weapon.reloading && isLowAmmo(weapon.mag, weapon.magSize)) ? 'visible' : 'hidden';
  if (weapon.reloading) reloadHint.textContent = 'RELOADING...';
  else reloadHint.textContent = 'PRESS [R] TO RELOAD';
  // Weapon name + scope zoom label; cached so unchanged values don't touch
  // the DOM (these are written every frame like the rest of updateHUD).
  if (weapon.name !== lastName) {
    lastName = weapon.name;
    weaponName.textContent = weapon.name;
  }
  // The WEAPONS read needs no guard (Record keyed by WeaponId), but zoomFovs
  // is a plain array indexed by the unbounded wpn.zoomLevel, so that read is
  // still `T | undefined`. weapons.ts:aimFovFor CLAMPS the same index because
  // it owes its caller a number; the HUD degrades to no label instead, because
  // a view must never throw mid-frame over a cosmetic string. Both are
  // unreachable in play — zoomLevel is wheel-wrapped mod n and reset to 0 on
  // swap — but they are deliberately different answers to the same miss, so
  // change them together. The label only applies to multi-step zooms: a
  // single-entry weapon (iron sights / bead) has nothing to cycle.
  const liveDef = WEAPONS[equippedId(wpn.slot)];
  const zoomFov = input.aiming && liveDef.zoomFovs.length > 1
    ? liveDef.zoomFovs[wpn.zoomLevel]
    : undefined;
  const zoomLabel = zoomFov !== undefined ? Math.round(BASE_FOV / zoomFov) + 'x' : '';
  if (zoomLabel !== lastZoomLabel) {
    lastZoomLabel = zoomLabel;
    zoomText.textContent = zoomLabel;
  }
  updateBotDebug();
}

// ---------- Bot elevation readout (DEV, elevation map only) ----------
// The elevation map exists to make bot-vs-height behavior observable, and the
// three numbers that explain what a bot is doing on a staircase — how high its
// feet are, whether it is grounded, whether geometry just rejected its step —
// are otherwise only reachable by pausing in devtools. Rendered as one cached
// string because updateHUD runs every frame; a bot standing still must not
// touch the DOM. Mesh y IS the bot's feet height (bots.ts positions by feet).
let lastBotDebug = '';
function updateBotDebug(): void {
  if (!import.meta.env.DEV || session.map !== 'elevation') return;
  const text = bots
    .map(b => `${b.name.padEnd(5)} y=${b.mesh.position.y.toFixed(2).padStart(5)}` +
              `${b.onGround ? '  G' : '  -'}${b.moveBlocked ? ' blk' : '    '}` +
              `${b.alive ? '' : ' dead'}`)
    .join('\n');
  if (text === lastBotDebug) return;
  lastBotDebug = text;
  botDebug.textContent = text;
  botDebug.style.display = text ? 'block' : 'none';
}
