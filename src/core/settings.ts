// core/settings.ts — player preferences: look sensitivity/acceleration, and
// the touch controls' opacity, stick size and on-screen layout.
//
// Pure and Node-importable, like sessionConfig.ts: the live slice is
// core/state.ts:settings, localStorage IO lives in settingsMenu.ts, and this
// module owns the shape, the defaults and the one gate everything loaded or
// pasted in must pass (sanitizeSettings). Unlike match config, settings are
// not in the URL — they are the player's, not the match's.
//
// Export is the whole point of the format: the settings menu copies this
// object as JSON, and a tuned copy pasted back becomes DEFAULT_SETTINGS. So
// every value is in a human-readable unit — sensitivities are multipliers of
// sim/look.ts's bases (1.0 = the shipped feel), and layout positions are
// fractions of the screen's safe area, so a layout carries across phones.
import type { LookTuning } from '../sim/look';

/** Every movable touch control. The movement stick is not one: it floats to wherever the thumb lands. */
export const TOUCH_CONTROL_IDS = ['fireR', 'fireL', 'ads', 'zoom', 'reload', 'jump', 'crouch', 'pause', 'weapons'] as const;
export type TouchControlId = typeof TOUCH_CONTROL_IDS[number];

/** Where a control sits: its CENTRE as a 0..1 fraction of the safe area, and a size multiplier. */
export interface ControlPlacement {
  x: number;
  y: number;
  scale: number;
}

export type TouchLayout = Record<TouchControlId, ControlPlacement>;

export interface TouchSettings {
  /** Look tuning with the sights down. */
  hip: LookTuning;
  /** Look tuning with the sights (or scope) up; blended by wpn.adsLerp. */
  ads: LookTuning;
  /** Opacity of every touch control, 0..1. */
  opacity: number;
  /** Stick travel in CSS px before the knob clamps; the rim (sprint) sits at its edge. */
  stickRadius: number;
}

export interface Settings {
  /** Bumped only by a shape change a sanitizer cannot bridge. */
  version: 1;
  /** Multiplier of sim/look.ts:MOUSE_BASE_SENS. */
  mouseSens: number;
  touch: TouchSettings;
  layout: TouchLayout;
}

interface Limits { min: number; max: number }

export const SETTING_LIMITS = {
  sens: { min: 0.1, max: 5 },
  accel: { min: 0, max: 3 },
  opacity: { min: 0.15, max: 1 },
  stickRadius: { min: 32, max: 110 },
  position: { min: 0, max: 1 },
  scale: { min: 0.5, max: 2 },
} as const satisfies Record<string, Limits>;

/**
 * Shipped defaults. The layout reproduces the original hand-placed CSS on an
 * 844×390 landscape phone (centres converted to fractions).
 */
export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  mouseSens: 1,
  touch: {
    hip: { sens: 1, accel: 0 },
    ads: { sens: 1, accel: 0 },
    opacity: 1,
    stickRadius: 56,
  },
  layout: {
    fireR: { x: 0.905, y: 0.579, scale: 1 },
    fireL: { x: 0.079, y: 0.385, scale: 1 },
    ads: { x: 0.917, y: 0.328, scale: 1 },
    zoom: { x: 0.833, y: 0.31, scale: 1 },
    reload: { x: 0.799, y: 0.544, scale: 1 },
    jump: { x: 0.915, y: 0.846, scale: 1 },
    crouch: { x: 0.815, y: 0.846, scale: 1 },
    pause: { x: 0.043, y: 0.082, scale: 1 },
    weapons: { x: 0.859, y: 0.077, scale: 1 },
  },
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A finite number clamped into `lim`, or the fallback for anything else. */
function num(v: unknown, lim: Limits, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(lim.max, Math.max(lim.min, v)) : fallback;
}

function field(obj: unknown, key: string): unknown {
  return isRecord(obj) ? obj[key] : undefined;
}

function tuning(raw: unknown, def: LookTuning): LookTuning {
  return {
    sens: num(field(raw, 'sens'), SETTING_LIMITS.sens, def.sens),
    accel: num(field(raw, 'accel'), SETTING_LIMITS.accel, def.accel),
  };
}

function placement(raw: unknown, def: ControlPlacement): ControlPlacement {
  return {
    x: num(field(raw, 'x'), SETTING_LIMITS.position, def.x),
    y: num(field(raw, 'y'), SETTING_LIMITS.position, def.y),
    scale: num(field(raw, 'scale'), SETTING_LIMITS.scale, def.scale),
  };
}

/** A fresh default layout (never the shared DEFAULT_SETTINGS object). */
export function defaultLayout(): TouchLayout {
  return sanitizeLayout(undefined);
}

export function sanitizeLayout(raw: unknown): TouchLayout {
  const out = {} as TouchLayout;
  for (const id of TOUCH_CONTROL_IDS) out[id] = placement(field(raw, id), DEFAULT_SETTINGS.layout[id]);
  return out;
}

/**
 * Rebuild a complete, in-range Settings from anything — stored JSON, a pasted
 * export, garbage. Never throws: every missing, mistyped or out-of-range field
 * falls back or clamps independently, so one bad value costs that value only,
 * and unknown keys are dropped.
 */
export function sanitizeSettings(raw: unknown): Settings {
  const touch = field(raw, 'touch');
  const d = DEFAULT_SETTINGS;
  return {
    version: 1,
    mouseSens: num(field(raw, 'mouseSens'), SETTING_LIMITS.sens, d.mouseSens),
    touch: {
      hip: tuning(field(touch, 'hip'), d.touch.hip),
      ads: tuning(field(touch, 'ads'), d.touch.ads),
      opacity: num(field(touch, 'opacity'), SETTING_LIMITS.opacity, d.touch.opacity),
      stickRadius: num(field(touch, 'stickRadius'), SETTING_LIMITS.stickRadius, d.touch.stickRadius),
    },
    layout: sanitizeLayout(field(raw, 'layout')),
  };
}
