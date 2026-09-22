// settingsMenu.ts — the settings screen (#settingsScreen) and the player's
// persisted preferences.
//
// A sanctioned DOM writer beside hud.ts, menu.ts and touchControls.ts,
// confined to #settingsScreen. It is also the ONE writer of
// core/state.ts:settings: it loads the stored copy at startup, and applies
// slider changes, resets and the layout editor's result. Storage IO lives
// here because state.ts must stay Node-pure; core/settings.ts:sanitizeSettings
// owns what may be applied, the same split the loadout uses (menu.ts +
// sanitizeLoadout).
//
// localStorage, not sessionStorage like the loadout: sensitivity and layout
// are the player's, and should outlive the tab.
//
// Opened from a Settings button in the start and pause menus. It overlays
// whichever one opened it, so Back just hides it again.
import { settings } from './core/state';
import { DEFAULT_SETTINGS, SETTING_LIMITS, sanitizeSettings, type Settings } from './core/settings';
import { requireEl } from './hud';
import { applyTouchSettings, startLayoutEdit } from './touchControls';

const SETTINGS_KEY = 'acsc.settings';

/** Replace the live slice's contents in place (every reader holds the same object). */
function assignSettings(next: Settings): void {
  Object.assign(settings, next);
}

/** Load the stored settings into the slice. Call early in startup, before anything reads them. */
export function loadStoredSettings(): void {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw !== null) assignSettings(sanitizeSettings(JSON.parse(raw)));
  } catch { /* storage unavailable or corrupt: keep the defaults */ }
}

function saveSettings(): void {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
}

interface Slider {
  id: string;
  lim: { min: number; max: number };
  step: number;
  get(s: Settings): number;
  set(s: Settings, v: number): void;
  fmt(v: number): string;
}

const times = (v: number): string => `${v.toFixed(2)}×`;

const SLIDERS: readonly Slider[] = [
  { id: 'setMouseSens', lim: SETTING_LIMITS.sens, step: 0.05, get: s => s.mouseSens, set: (s, v) => { s.mouseSens = v; }, fmt: times },
  { id: 'setHipSens', lim: SETTING_LIMITS.sens, step: 0.05, get: s => s.touch.hip.sens, set: (s, v) => { s.touch.hip.sens = v; }, fmt: times },
  { id: 'setHipAccel', lim: SETTING_LIMITS.accel, step: 0.05, get: s => s.touch.hip.accel, set: (s, v) => { s.touch.hip.accel = v; }, fmt: v => v.toFixed(2) },
  { id: 'setAdsSens', lim: SETTING_LIMITS.sens, step: 0.05, get: s => s.touch.ads.sens, set: (s, v) => { s.touch.ads.sens = v; }, fmt: times },
  { id: 'setAdsAccel', lim: SETTING_LIMITS.accel, step: 0.05, get: s => s.touch.ads.accel, set: (s, v) => { s.touch.ads.accel = v; }, fmt: v => v.toFixed(2) },
  { id: 'setOpacity', lim: SETTING_LIMITS.opacity, step: 0.05, get: s => s.touch.opacity, set: (s, v) => { s.touch.opacity = v; }, fmt: v => `${Math.round(v * 100)}%` },
  { id: 'setStick', lim: SETTING_LIMITS.stickRadius, step: 1, get: s => s.touch.stickRadius, set: (s, v) => { s.touch.stickRadius = v; }, fmt: v => `${v}px` },
];

let screen: HTMLElement, statusEl: HTMLElement, exportEl: HTMLTextAreaElement;
let touchMode = false;
const inputs: { slider: Slider; input: HTMLInputElement; out: HTMLElement }[] = [];

/** Push the slice's values into every slider and readout. */
function refreshForm(): void {
  for (const { slider, input, out } of inputs) {
    const v = slider.get(settings);
    input.value = String(v);
    out.textContent = slider.fmt(v);
  }
}

/** Apply a changed slice: persist it, and restyle the touch controls if they exist. */
function commit(): void {
  saveSettings();
  if (touchMode) applyTouchSettings();
}

/**
 * Copy the settings as JSON — the format a tuned copy is pasted back in as
 * the new defaults. The text box always shows the JSON too: the clipboard API
 * needs a secure context, and a phone testing a LAN dev server over plain
 * http has none, so the box is the path that always works.
 */
function exportSettings(): void {
  const json = JSON.stringify(settings, null, 2);
  exportEl.value = json;
  exportEl.style.display = 'block';
  exportEl.focus();
  exportEl.select();
  statusEl.textContent = 'Settings JSON is selected below.';
  const clip = (navigator as Partial<Navigator>).clipboard;
  if (clip === undefined) return;
  clip.writeText(json)
    .then(() => { statusEl.textContent = 'Copied to the clipboard (also shown below).'; })
    .catch(() => { /* not allowed here: the selected text box stands */ });
}

function openSettings(): void {
  refreshForm();
  statusEl.textContent = '';
  exportEl.style.display = 'none';
  screen.style.display = 'flex';
}

/** Resolve #settingsScreen, build the slider bindings and wire both menus' Settings buttons. */
export function initSettingsMenu(opts: { touch: boolean }): void {
  touchMode = opts.touch;
  screen = requireEl('settingsScreen');
  statusEl = requireEl('settingsStatus');
  exportEl = requireEl('settingsExport') as HTMLTextAreaElement;

  for (const slider of SLIDERS) {
    const input = requireEl(slider.id) as HTMLInputElement;
    const out = requireEl(`${slider.id}Out`);
    input.min = String(slider.lim.min);
    input.max = String(slider.lim.max);
    input.step = String(slider.step);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      slider.set(settings, v);
      out.textContent = slider.fmt(v);
      commit();
    });
    inputs.push({ slider, input, out });
  }

  requireEl('settingsBtn').onclick = openSettings;
  requireEl('settingsBtnPause').onclick = openSettings;
  requireEl('settingsBackBtn').onclick = () => { screen.style.display = 'none'; };
  requireEl('copySettingsBtn').onclick = exportSettings;
  requireEl('resetSettingsBtn').onclick = () => {
    assignSettings(sanitizeSettings(DEFAULT_SETTINGS));
    commit();
    refreshForm();
    statusEl.textContent = 'Settings reset to defaults.';
  };
  requireEl('editLayoutBtn').onclick = () => {
    if (!touchMode) return;
    startLayoutEdit(layout => {
      if (layout === null) return;
      settings.layout = layout;
      commit();
      statusEl.textContent = 'Layout saved.';
    });
  };
}
