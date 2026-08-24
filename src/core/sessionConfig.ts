// core/sessionConfig.ts — pure parse/serialize for the match-config query.
//
// The start menu commits settings by navigating to ONE query string
// (?map=&tbots=&ctbots=&time=); main.ts parses it back once at startup and
// writes the result into `session`. Parsing lives here rather than in
// main.ts so the clamp/fallback matrix is unit-testable in plain Node: the
// input is a minimal `{ get(name) }` view (URLSearchParams satisfies it
// structurally), never `location` — core/state.ts must stay browser-free.
//
// The parser NEVER throws: any absent, non-numeric or out-of-range param
// falls back / clamps to a value in SESSION_DEFAULTS's shape. A hand-typed
// garbage URL must still boot a playable match.
//
// The numeric plumbing here (numOr/clampTo below) is ALSO what the start
// menu's candidateConfig() runs the form fields through, so the form and the
// URL parser cannot drift apart — there is deliberately no second copy in
// menu.ts.
import type { MapName } from './state';
import { SESSION_DEFAULTS } from './state';

/** Everything the menu configures about a match; mirrors session's config fields. */
export interface SessionConfig {
  map: MapName;
  /** Enemy (T-side) bot count. */
  botsT: number;
  /** Allied (CT-side) bot count — stored only until allied bots exist. */
  botsCt: number;
  /** Round length in seconds. */
  roundSeconds: number;
}

// ---------- Accepted ranges ----------
// The menu's number inputs mirror these via their min/max attributes; the
// parser clamps independently of the DOM so a hand-edited URL is safe too.
/** Enemy bots. Minimum 1: zero enemies would fire checkRoundEnd instantly. */
export const BOTS_T_LIMITS = { min: 1, max: 12 } as const;
/** Allied bots — stored only this tranche; 0 means none configured. */
export const BOTS_CT_LIMITS = { min: 0, max: 12 } as const;
/** Round length in seconds; the menu edits minutes within [0.5, 30]. */
export const TIME_LIMITS_S = { min: 30, max: 1800 } as const;

/** Minimal read-only view over a param bag. */
export interface ParamSource {
  get(name: string): string | null;
}

/** Numeric range to clamp into; the exported *LIMITS consts all fit this shape. */
export interface Limits {
  min: number;
  max: number;
}

/** Clamp `n` into limits.min..limits.max. */
export function clampTo(n: number, lim: Limits): number {
  return Math.min(lim.max, Math.max(lim.min, n));
}

/**
 * Raw field/param value → finite number, or `fallback` when absent, empty or
 * non-numeric. Empty string counts as absent: Number('') is 0, which would
 * otherwise masquerade as a real choice.
 */
export function numOr(raw: string | null | undefined, fallback: number): number {
  if (raw === null || raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Seconds → minutes string for the menu's time input, float noise trimmed
 * (115 s would otherwise render 1.9166666666666667). Two decimals keep the
 * round-trip exact — round(label*60) === seconds for every integer second —
 * so a prefilled form stays equal to the applied config and Play won't
 * navigate.
 */
export function secondsToMinutesLabel(seconds: number): string {
  return String(Math.round((seconds / 60) * 100) / 100);
}

/** Literal comparison narrows to MapName; anything else falls back. */
function parseMap(raw: string | null): MapName {
  return raw === 'arena' || raw === 'range' ? raw : SESSION_DEFAULTS.map;
}

/** Parse the committed query into a fully-clamped SessionConfig. */
export function parseSessionConfig(src: ParamSource): SessionConfig {
  return {
    map: parseMap(src.get('map')),
    botsT: Math.round(clampTo(numOr(src.get('tbots'), SESSION_DEFAULTS.botsT), BOTS_T_LIMITS)),
    botsCt: Math.round(clampTo(numOr(src.get('ctbots'), SESSION_DEFAULTS.botsCt), BOTS_CT_LIMITS)),
    roundSeconds: Math.round(
      clampTo(numOr(src.get('time'), SESSION_DEFAULTS.roundSeconds), TIME_LIMITS_S),
    ),
  };
}

/**
 * Serialize to the canonical committed query string (leading '?', every param
 * present). Always encoding all four keeps URLs canonical and makes "form
 * differs from applied config" a plain field comparison in menu.ts.
 */
export function configToQuery(cfg: SessionConfig): string {
  const p = new URLSearchParams();
  p.set('map', cfg.map);
  p.set('tbots', String(cfg.botsT));
  p.set('ctbots', String(cfg.botsCt));
  p.set('time', String(cfg.roundSeconds));
  return '?' + p.toString();
}

/** Field-by-field equality; used to decide Play vs commit-navigation. */
export function configsEqual(a: SessionConfig, b: SessionConfig): boolean {
  return (
    a.map === b.map &&
    a.botsT === b.botsT &&
    a.botsCt === b.botsCt &&
    a.roundSeconds === b.roundSeconds
  );
}
