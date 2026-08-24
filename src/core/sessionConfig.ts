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

const MAPS: readonly MapName[] = ['arena', 'range'];

/** Minimal read-only view over a param bag. */
export interface ParamSource {
  get(name: string): string | null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Numeric param → finite number or null. Empty string counts as absent;
 * Number('') is 0, which would otherwise masquerade as a real choice.
 */
function numParam(src: ParamSource, name: string): number | null {
  const raw = src.get(name);
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Parse the committed query into a fully-clamped SessionConfig. */
export function parseSessionConfig(src: ParamSource): SessionConfig {
  const mapRaw = src.get('map');
  const map: MapName =
    mapRaw !== null && (MAPS as readonly string[]).includes(mapRaw)
      ? mapRaw
      : SESSION_DEFAULTS.map;

  const botsTRaw = numParam(src, 'tbots');
  const botsCtRaw = numParam(src, 'ctbots');
  const timeRaw = numParam(src, 'time');

  return {
    map,
    botsT:
      botsTRaw === null
        ? SESSION_DEFAULTS.botsT
        : Math.round(clamp(botsTRaw, BOTS_T_LIMITS.min, BOTS_T_LIMITS.max)),
    botsCt:
      botsCtRaw === null
        ? SESSION_DEFAULTS.botsCt
        : Math.round(clamp(botsCtRaw, BOTS_CT_LIMITS.min, BOTS_CT_LIMITS.max)),
    roundSeconds:
      timeRaw === null
        ? SESSION_DEFAULTS.roundSeconds
        : Math.round(clamp(timeRaw, TIME_LIMITS_S.min, TIME_LIMITS_S.max)),
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
