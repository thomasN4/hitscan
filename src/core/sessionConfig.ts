// core/sessionConfig.ts — pure parse/serialize for the match-config query.
//
// The start menu commits settings by navigating to ONE query string
// (?map=&mode=&side=&tbots=&ctbots=&time=&tweap=&tsec=&ctweap=&ctsec=); main.ts parses it
// back once at startup and writes the result into `session`. Parsing lives here rather than in
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
// menu.ts. asMapName is shared for the same reason: menu.ts used to open-code
// its own `=== 'range' ? 'range' : 'arena'`, which silently drops any map
// added after it was written.
import type { BotSecondaryChoice, BotWeaponChoice, MapName, MatchMode, Team } from './state';
import { DOM_FLAGS, SESSION_DEFAULTS } from './state';

/** Everything the menu configures about a match; mirrors session's config fields. */
export interface SessionConfig {
  map: MapName;
  /** Match ruleset: kill-score TDM, or domination when the map has flags. */
  mode: MatchMode;
  /** Which side the player fights for; the other side is the enemy wave. */
  playerTeam: Team;
  /** T-side bot count (enemy on CT-side, allied on T-side). */
  botsT: number;
  /** CT-side bot count (allied on CT-side, enemy on T-side). */
  botsCt: number;
  /** Round length in seconds. */
  roundSeconds: number;
  /** Weapon every T-side bot carries in its PRIMARY position; 'mixed' draws independently per bot. */
  botWeaponT: BotWeaponChoice;
  /** Same for the CT side. */
  botWeaponCt: BotWeaponChoice;
  /** Sidearm for T-side bot loadouts; 'mixed' draws pistol/revolver per bot. */
  botSecondaryT: BotSecondaryChoice;
  /** Same for the CT side. */
  botSecondaryCt: BotSecondaryChoice;
}

// ---------- Accepted ranges ----------
// The menu's number inputs mirror these via their min/max attributes; the
// parser clamps independently of the DOM so a hand-edited URL is safe too.
// Limits are side-relative: the ENEMY wave needs at least 1 bot (zero enemies
// would fire checkRoundEnd instantly) and caps at 16, while the player's own
// side allows 0 and caps at 15 (the player fills the 16th slot). botLimits()
// picks which physical field gets which range.
/** Enemy-wave range (1..16) and allied-wave range (0..15), CT-player canonical. */
export const BOTS_T_LIMITS = { min: 1, max: 16 } as const;
/** Allied-wave range, CT-player canonical. */
export const BOTS_CT_LIMITS = { min: 0, max: 15 } as const;
/** Round length in seconds; the menu edits minutes within [0.5, 30]. */
export const TIME_LIMITS_S = { min: 30, max: 1800 } as const;

/**
 * Side-appropriate clamp ranges for the two bot-count fields. On CT-side the
 * T field is the enemy wave and the CT field the allies; on T-side it is the
 * reverse — enemy 6 / own 5 stays the default both ways.
 */
export function botLimits(playerTeam: Team): { limitT: Limits; limitCt: Limits } {
  if (playerTeam === 'T') return { limitT: BOTS_CT_LIMITS, limitCt: BOTS_T_LIMITS };
  return { limitT: BOTS_T_LIMITS, limitCt: BOTS_CT_LIMITS };
}

/**
 * Side-appropriate default bot counts: enemy 6, own side 5. SESSION_DEFAULTS
 * is the CT-player instance; T-side mirrors it.
 */
export function defaultBotCounts(playerTeam: Team): { botsT: number; botsCt: number } {
  if (playerTeam === 'T') return { botsT: SESSION_DEFAULTS.botsCt, botsCt: SESSION_DEFAULTS.botsT };
  return { botsT: SESSION_DEFAULTS.botsT, botsCt: SESSION_DEFAULTS.botsCt };
}

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

/**
 * Narrow an untrusted string to MapName, falling back to the default map for
 * anything unrecognized.
 *
 * Shared with the start menu's candidateConfig(), exactly like numOr/clampTo:
 * the form's <select> and the URL parser must agree on what counts as a map,
 * and a second literal comparison in menu.ts is how they would drift apart the
 * next time a map is added.
 *
 * Membership goes through an exhaustive Record rather than a literal chain so
 * widening MapName fails to compile HERE too, not just at BUILDERS / SPAWN /
 * SUBTITLES. The cast is the unavoidable cost of runtime narrowing (`in` can't
 * narrow a bare string); hasOwn rather than `in` keeps prototype keys like
 * 'toString' from passing the guard and reaching the builder lookup.
 */
const IS_MAP_NAME: Record<MapName, true> = {
  arena: true,
  range: true,
  elevation: true,
  warehouse1: true,
  warehouse2: true,
};

export function asMapName(raw: string | null | undefined): MapName {
  return typeof raw === 'string' && Object.hasOwn(IS_MAP_NAME, raw)
    ? (raw as MapName)
    : SESSION_DEFAULTS.map;
}

/**
 * Narrow an untrusted string to Team, falling back for anything unrecognized.
 *
 * Shared with the start menu's candidateConfig() like asMapName: the form's
 * <select> and the URL parser must agree on what counts as a side. Accepts
 * 't'/'ct' case-insensitively (the canonical query writes lowercase); a stale
 * or garbage value falls back rather than throwing.
 */
const IS_TEAM: Record<Team, true> = {
  T: true,
  CT: true,
};

export function asTeam(raw: string | null | undefined, fallback: Team): Team {
  if (typeof raw !== 'string') return fallback;
  const n = raw.trim().toUpperCase();
  return Object.hasOwn(IS_TEAM, n) ? (n as Team) : fallback;
}

/**
 * Narrow an untrusted string to a bot-PRIMARY setting, falling back to
 * `fallback` for anything unrecognized.
 *
 * Exhaustive Record and hasOwn for exactly asMapName's reasons — widening the
 * primary union must fail to compile HERE too, and a prototype key like
 * 'toString' must not pass the guard and reach a Record lookup.
 *
 * Only primary firearms are keys: sidearms belong to the secondary position
 * and the blade is every loadout's fallback, so naming either here would ask
 * for something the menu never offered. Stale values (a ?tweap=knife
 * bookmark from when the blade was a legal primary) fall back rather than
 * throwing — a hand-typed garbage URL must still boot a playable match.
 *
 * `fallback` is a parameter rather than SESSION_DEFAULTS, so the start menu
 * can keep the currently-applied value on garbage input exactly as numOr
 * does for the number fields.
 */
const IS_BOT_WEAPON: Record<BotWeaponChoice, true> = {
  mixed: true, ak47: true, smg: true, sniper: true, shotgun: true,
};

export function asBotWeapon(
  raw: string | null | undefined,
  fallback: BotWeaponChoice,
): BotWeaponChoice {
  return typeof raw === 'string' && Object.hasOwn(IS_BOT_WEAPON, raw)
    ? (raw as BotWeaponChoice)
    : fallback;
}

/**
 * Narrow an untrusted string to a bot SECONDARY setting, falling back to
 * `fallback` for anything unrecognized.
 *
 * Exhaustive Record and hasOwn for exactly asMapName's reasons. Only the two
 * sidearms are keys: primaries belong to the primary position, and the blade
 * is already the last position of every loadout
 * (sim/botWeapons.ts:makeBotLoadout), so naming either here would ask for a
 * duplicate the loadout then drops — a silently ignored setting is worse
 * than one that falls back.
 */
const IS_BOT_SECONDARY: Record<BotSecondaryChoice, true> = {
  mixed: true, pistol: true, revolver: true,
};

export function asBotSecondary(
  raw: string | null | undefined,
  fallback: BotSecondaryChoice,
): BotSecondaryChoice {
  return typeof raw === 'string' && Object.hasOwn(IS_BOT_SECONDARY, raw)
    ? (raw as BotSecondaryChoice)
    : fallback;
}

/**
 * Narrow an untrusted string to MatchMode, falling back for anything
 * unrecognized. Shared with the start menu's candidateConfig() like
 * asMapName: the form's <select> and the URL parser must agree on what
 * counts as a mode.
 */
const IS_MATCH_MODE: Record<MatchMode, true> = {
  tdm: true,
  dom: true,
};

export function asMatchMode(raw: string | null | undefined, fallback: MatchMode): MatchMode {
  return typeof raw === 'string' && Object.hasOwn(IS_MATCH_MODE, raw)
    ? (raw as MatchMode)
    : fallback;
}

/** Parse the committed query into a fully-clamped SessionConfig. */
export function parseSessionConfig(src: ParamSource): SessionConfig {
  // Side first: bot-count fallbacks AND clamp ranges both mirror off it, so
  // ?side=t alone yields 5 own-side Ts and 6 enemy CTs.
  const playerTeam = asTeam(src.get('side'), SESSION_DEFAULTS.playerTeam);
  const limits = botLimits(playerTeam);
  const defaults = defaultBotCounts(playerTeam);
  const map = asMapName(src.get('map'));
  // Domination needs flags: a map with none (every map but elevation for now)
  // falls back to TDM rather than booting a flagless domination match.
  const mode = DOM_FLAGS[map].length > 0
    ? asMatchMode(src.get('mode'), SESSION_DEFAULTS.mode)
    : 'tdm';
  return {
    map,
    mode,
    botsT: Math.round(clampTo(numOr(src.get('tbots'), defaults.botsT), limits.limitT)),
    botsCt: Math.round(clampTo(numOr(src.get('ctbots'), defaults.botsCt), limits.limitCt)),
    roundSeconds: Math.round(
      clampTo(numOr(src.get('time'), SESSION_DEFAULTS.roundSeconds), TIME_LIMITS_S),
    ),
    botWeaponT: asBotWeapon(src.get('tweap'), SESSION_DEFAULTS.botWeaponT),
    botSecondaryT: asBotSecondary(src.get('tsec'), SESSION_DEFAULTS.botSecondaryT),
    botWeaponCt: asBotWeapon(src.get('ctweap'), SESSION_DEFAULTS.botWeaponCt),
    botSecondaryCt: asBotSecondary(src.get('ctsec'), SESSION_DEFAULTS.botSecondaryCt),
  };
}

/**
 * Serialize to the canonical committed query string (leading '?', every param
 * present). Always encoding every field keeps URLs canonical and makes "form
 * differs from applied config" a plain field comparison in menu.ts.
 */
export function configToQuery(cfg: SessionConfig): string {
  const p = new URLSearchParams();
  p.set('map', cfg.map);
  p.set('mode', cfg.mode);
  p.set('side', cfg.playerTeam.toLowerCase());
  p.set('tbots', String(cfg.botsT));
  p.set('ctbots', String(cfg.botsCt));
  p.set('time', String(cfg.roundSeconds));
  p.set('tweap', cfg.botWeaponT);
  p.set('tsec', cfg.botSecondaryT);
  p.set('ctweap', cfg.botWeaponCt);
  p.set('ctsec', cfg.botSecondaryCt);
  return '?' + p.toString();
}

/** Field-by-field equality; used to decide Play vs commit-navigation. */
export function configsEqual(a: SessionConfig, b: SessionConfig): boolean {
  return (
    a.map === b.map &&
    a.mode === b.mode &&
    a.playerTeam === b.playerTeam &&
    a.botsT === b.botsT &&
    a.botsCt === b.botsCt &&
    a.roundSeconds === b.roundSeconds &&
    a.botWeaponT === b.botWeaponT &&
    a.botSecondaryT === b.botSecondaryT &&
    a.botWeaponCt === b.botWeaponCt &&
    a.botSecondaryCt === b.botSecondaryCt
  );
}
