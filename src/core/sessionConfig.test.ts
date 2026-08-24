// core/sessionConfig.test.ts — parse/clamp/serialize matrix for the menu's
// committed query string. Pure Node: the source is a plain object, no
// location anywhere.
import { describe, expect, it } from 'vitest';
import {
  BOTS_CT_LIMITS,
  BOTS_T_LIMITS,
  TIME_LIMITS_S,
  configsEqual,
  configToQuery,
  parseSessionConfig,
  type ParamSource,
  type SessionConfig,
} from './sessionConfig';
import { SESSION_DEFAULTS } from './state';

/** Bag-style source: absent names behave exactly like URLSearchParams.get. */
function src(params: Record<string, string>): ParamSource {
  return { get: name => params[name] ?? null };
}

function srcFromQuery(q: string): ParamSource {
  return { get: name => new URLSearchParams(q).get(name) };
}

const CFG: SessionConfig = {
  map: 'range',
  botsT: 10,
  botsCt: 3,
  roundSeconds: 90,
};

const CFG_QUERY = '?map=range&tbots=10&ctbots=3&time=90';

describe('parseSessionConfig', () => {
  it('empty source yields every default', () => {
    expect(parseSessionConfig(src({}))).toEqual({ ...SESSION_DEFAULTS });
  });

  it('valid params pass through', () => {
    expect(parseSessionConfig(srcFromQuery(CFG_QUERY))).toEqual(CFG);
  });

  // ---------- map ----------
  it('accepts both map values verbatim', () => {
    expect(parseSessionConfig(src({ map: 'arena' })).map).toBe('arena');
    expect(parseSessionConfig(src({ map: 'range' })).map).toBe('range');
  });
  it.each([null, '', 'Arena', 'deathmatch', 'arena '])(
    'unknown map %j falls back to default',
    raw => {
      const got = parseSessionConfig(src(raw === null ? {} : { map: raw }));
      expect(got.map).toBe(SESSION_DEFAULTS.map);
    },
  );

  // ---------- bot counts ----------
  it('clamps tbots into [1,12] both ways', () => {
    expect(parseSessionConfig(src({ tbots: '-4' })).botsT).toBe(BOTS_T_LIMITS.min);
    expect(parseSessionConfig(src({ tbots: '99' })).botsT).toBe(BOTS_T_LIMITS.max);
  });
  it('rounds fractional bot counts', () => {
    expect(parseSessionConfig(src({ tbots: '7.6' })).botsT).toBe(8);
    expect(parseSessionConfig(src({ ctbots: '2.2' })).botsCt).toBe(2);
  });
  it('allows ctbots = 0 but clamps negatives up to it', () => {
    expect(parseSessionConfig(src({ ctbots: '0' })).botsCt).toBe(0);
    expect(parseSessionConfig(src({ ctbots: '-1' })).botsCt).toBe(BOTS_CT_LIMITS.min);
    expect(parseSessionConfig(src({ ctbots: '50' })).botsCt).toBe(BOTS_CT_LIMITS.max);
  });

  // ---------- time ----------
  it('clamps round seconds into [30,1800] both ways', () => {
    expect(parseSessionConfig(src({ time: '5' })).roundSeconds).toBe(TIME_LIMITS_S.min);
    expect(parseSessionConfig(src({ time: '9999' })).roundSeconds).toBe(TIME_LIMITS_S.max);
  });
  it('keeps whole-second values exact', () => {
    expect(parseSessionConfig(src({ time: '115' })).roundSeconds).toBe(115);
  });

  // ---------- garbage never throws ----------
  it.each([
    ['tbots', 'abc'],
    ['tbots', 'NaN'],
    ['ctbots', '1e999'], // Number() → Infinity → not finite
    ['ctbots', ''],
    ['ctbots', '   '],
    ['time', '30s'],
    ['time', 'Infinity'],
  ])('garbage %s=%j falls back to default', (name, raw) => {
    const got = parseSessionConfig(src({ [name]: raw }));
    const expected =
      name === 'tbots'
        ? SESSION_DEFAULTS.botsT
        : name === 'ctbots'
          ? SESSION_DEFAULTS.botsCt
          : SESSION_DEFAULTS.roundSeconds;
    const key =
      name === 'time'
        ? ('roundSeconds' as const)
        : name === 'tbots'
          ? ('botsT' as const)
          : ('botsCt' as const);
    expect(got[key]).toBe(expected);
  });

  it('one bad param does not poison the others', () => {
    const got = parseSessionConfig(src({ map: 'range', tbots: 'junk', time: '60' }));
    expect(got).toMatchObject({ map: 'range', botsT: SESSION_DEFAULTS.botsT, roundSeconds: 60 });
  });
});

describe('configToQuery', () => {
  it('encodes all four params canonically', () => {
    expect(configToQuery(CFG)).toBe(CFG_QUERY);
  });

  it('round-trips through the parser unchanged', () => {
    expect(parseSessionConfig(srcFromQuery(configToQuery(CFG)))).toEqual(CFG);
  });
});

describe('configsEqual', () => {
  it('is true only when every field matches', () => {
    expect(configsEqual(CFG, { ...CFG })).toBe(true);
    expect(configsEqual(CFG, { ...CFG, botsT: 9 })).toBe(false);
    expect(configsEqual(CFG, { ...CFG, map: 'arena' })).toBe(false);
    expect(configsEqual(CFG, { ...CFG, botsCt: 0 })).toBe(false);
    expect(configsEqual(CFG, { ...CFG, roundSeconds: 91 })).toBe(false);
  });
});
