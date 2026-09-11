// hud.ts — all DOM manipulation for the 2D overlay (health, ammo, score,
// kill feed, crosshair, hit/damage feedback).
//
// The HUD elements are plain markup in index.html; this module grabs the
// references once and exposes small update functions. Nothing else should
// touch the DOM directly.
//
// NOTE: functions here read core/state.ts directly rather than taking
// params — acceptable because the HUD is a pure view of that state.
import { player, weapon, input, wpn, score, session, bots, WEAPONS, BASE_FOV, equippedId, type Bot as BotShape } from './core/state';
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
  applyCrosshairVisibility();
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

/** Format the weapon suffix shared by every bot-authored killfeed line. */
export function botKillTag(bot: BotShape | undefined): string {
  return bot === undefined ? '' : ` [${WEAPONS[bot.weapon].name}]`;
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
  applyCrosshairVisibility();
}

/**
 * Crosshair gating: the arms show only in DEV while the V debug overlay is up
 * (and never under the sniper scope reticle, which replaces them). Normal play
 * aims down the viewmodel sights instead. Synced every frame from updateHUD so
 * debugView.ts's toggle needs no import back into this module; the cached flip
 * avoids DOM churn like scopeShown above.
 */
let crosshairShown = false;
function applyCrosshairVisibility(): void {
  const want = import.meta.env.DEV && session.debugView && !scopeShown;
  if (want === crosshairShown) return;
  crosshairShown = want;
  // Explicit 'block' on show, not '' — the stylesheet defaults #crosshair to
  // display:none (no pre-init flash), so clearing the inline style would just
  // fall back to hidden again.
  crosshair.style.display = want ? 'block' : 'none';
}

let lastName = '';
let lastZoomLabel = '';
export function updateHUD(): void {
  applyCrosshairVisibility();
  hpText.textContent = String(Math.max(0, Math.round(player.hp)));
  healthFill.style.width = Math.max(0, player.hp) + '%';
  // Color shifts green -> orange -> red as HP drops.
  healthFill.style.background = player.hp > 60 ? '#4caf50' : player.hp > 25 ? '#ffab40' : '#ff5252';
  magText.textContent = String(weapon.mag);
  ammoReserve.textContent = String(weapon.reserve);
  // The knife holds no rounds: the readout hides while it is live (the
  // separator between the two numbers goes with it). The text above keeps
  // updating regardless — hidden or not, it must never go stale, because
  // swapping back to a firearm re-reveals whatever this frame's state is.
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

// ---------- Bot readout (DEV, while the V overlay is up) ----------
// What a bot is doing — how high its feet are, whether it is grounded, whether
// geometry just rejected its step, whether it could FIRE at its focus, and
// which behavior its brain is running — is otherwise only reachable by
// pausing in devtools. It rides session.debugView (the wireframe overlay's
// flag) because both answer the same question, "what is this bot thinking",
// and the overlay is the explicit opt-in; on any map, since nothing here is
// elevation-specific.
// Modes are hold/search/route/engage/patrol (botBrains.ts:BrainMode). `search`
// is a memory scan — arrival at a remembered position, a routing dead end, or
// a direction-only incoming-fire reaction (the damage search advances along
// its bearing for its first seconds, so it may show motion). `route` with
// `blk` flickering is a bot squeezing past something; `route` that never
// becomes `engage` means it is not arriving. `patrol` is a goalless walk to a
// map-wide node. Rendered as one cached string because updateHUD runs
// every frame; a bot standing still must not touch the DOM. Mesh y IS the
// bot's feet height (bots.ts positions by feet). padEnd(6) fits the widest
// mode.
//
// The r/s pair restates the shot gates as text, because the overlay's
// brightness tiers are hard to tell apart at a glance and not
// colorblind-trivial: `rs` = the bot currently SEES its focus (the frame's
// visual observation agreeing with the intent's focus) AND it is inside
// engage range (can and will fire), `--` = no shootable observation at all
// (a holding, memory-pursuing or searching bot sits here). Same gates that
// grade the intent line's tint. The gates are written only from a CURRENT
// observation that agrees with the intent's focus (bots.ts), so an `r-`
// state — in range without a current agreeing observation — is not
// reachable: the readout shows shootable `rs` or non-shootable `--` (`-s`
// when a seen target sits beyond engageRange).
//
// The weapon column names what the bot is carrying and how much of it is
// left: NAME(8, the widest is REVOLVER), then mag/magSize plus the reserve,
// then `R` while a reload runs. A blade holds no rounds, so its cell is a
// dash. A reload is a window in which a bot cannot shoot at all, so a
// bot that stops firing mid-engagement is either reloading or dry — and
// without this column those two look identical to "the AI broke".
//
// lastBotDebug doubles as shown-state: it is non-empty exactly when the text
// was last written AND revealed, so the inactive path can hide with one check.
let lastBotDebug = '';
/**
 * Ammo cell for the DEV bot readout: mag/magSize plus the reserve for a
 * firearm, a dash for a weapon that holds no rounds. One helper rather than
 * template growth; the fixed width keeps the readout aligned.
 */
function botAmmoCell(b: BotShape): string {
  // A blade holds no rounds: a dash in the same 11-character width the
  // firearm cell occupies, so the readout stays aligned.
  if (b.magSize === 0) return '     —     ';
  return ` ${String(b.mag).padStart(2)}/${String(b.magSize).padStart(2)}` +
    `/${String(b.reserve).padStart(2)}` +
    `${b.reloading ? ' R' : '  '}`;
}
function updateBotDebug(): void {
  if (!import.meta.env.DEV || !session.debugView) {
    if (lastBotDebug !== '') {
      // Clearing the cache here is what lets the next activation rewrite an
      // unchanged string instead of early-returning against a hidden element.
      lastBotDebug = '';
      botDebug.style.display = 'none';
    }
    return;
  }
  const text = bots
    .map(b => `${b.name.padEnd(5)} y=${b.mesh.position.y.toFixed(2).padStart(5)}` +
              `${b.onGround ? '  G' : '  -'}${b.moveBlocked ? ' blk' : '    '}` +
              ` ${b.targetInRange ? 'r' : '-'}${b.targetLOS === true ? 's' : '-'}` +
              ` ${b.mode.padEnd(6)}` +
              ` ${WEAPONS[b.weapon].name.padEnd(8)}` +
              botAmmoCell(b) +
              `${b.alive ? '' : ' dead'}`)
    .join('\n');
  if (text === lastBotDebug) return;
  lastBotDebug = text;
  botDebug.textContent = text;
  botDebug.style.display = text ? 'block' : 'none';
}
