// core/sessionConfig.test.ts — parse/clamp/serialize matrix for the menu's
// committed query string. Pure Node: the source is a plain object, no
// location anywhere.
import { describe, expect, it } from 'vitest';
import {
  BOTS_CT_LIMITS,
  asBotWeapon,
  asBotSecondary,
  asTeam,
  BOTS_T_LIMITS,
  TIME_LIMITS_S,
  botLimits,
  clampTo,
  configsEqual,
  configToQuery,
  defaultBotCounts,
  numOr,
  parseSessionConfig,
  secondsToMinutesLabel,
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
  // The range has no flags, so even an explicit dom request falls back —
  // the round trip below pins mode=tdm surviving the query.
  mode: 'tdm',
  playerTeam: 'CT',
  botsT: 10,
  botsCt: 3,
  roundSeconds: 90,
  botWeaponT: 'sniper',
  botSecondaryT: 'revolver',
  botWeaponCt: 'mixed',
  botSecondaryCt: 'mixed',
};

// Each side's pair is adjacent, which is the order configToQuery writes.
const CFG_QUERY =
  '?map=range&mode=tdm&side=ct&tbots=10&ctbots=3&time=90&tweap=sniper&tsec=revolver&ctweap=mixed&ctsec=mixed';

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
  it('clamps tbots into [1,16] both ways', () => {
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

  // ---------- side mirroring ----------
  it('bare ?side=t mirrors defaults to 5 own-side Ts and 6 enemy CTs', () => {
    expect(parseSessionConfig(src({ side: 't' }))).toMatchObject({
      playerTeam: 'T', botsT: 5, botsCt: 6,
    });
  });
  it('explicit counts on T-side are preserved, not swapped', () => {
    expect(parseSessionConfig(src({ side: 't', tbots: '4', ctbots: '8' }))).toMatchObject({
      playerTeam: 'T', botsT: 4, botsCt: 8,
    });
  });
  it('T-side clamps mirror: own Ts 0..15, enemy CTs 1..16', () => {
    expect(parseSessionConfig(src({ side: 't', tbots: '99' })).botsT).toBe(15);
    expect(parseSessionConfig(src({ side: 't', tbots: '-4' })).botsT).toBe(0);
    expect(parseSessionConfig(src({ side: 't', ctbots: '99' })).botsCt).toBe(16);
    expect(parseSessionConfig(src({ side: 't', ctbots: '0' })).botsCt).toBe(1);
  });
  it('garbage counts on T-side fall back to the mirrored defaults', () => {
    expect(parseSessionConfig(src({ side: 't', tbots: 'junk' })).botsT).toBe(5);
    expect(parseSessionConfig(src({ side: 't', ctbots: 'junk' })).botsCt).toBe(6);
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
  it('encodes every param canonically', () => {
    expect(configToQuery(CFG)).toBe(CFG_QUERY);
  });

  it('round-trips through the parser unchanged', () => {
    expect(parseSessionConfig(srcFromQuery(configToQuery(CFG)))).toEqual(CFG);
  });

  it('round-trips a T-side config unchanged', () => {
    const tCfg: SessionConfig = { ...CFG, playerTeam: 'T', botsT: 5, botsCt: 6 };
    expect(parseSessionConfig(srcFromQuery(configToQuery(tCfg)))).toEqual(tCfg);
  });
});

describe('configsEqual', () => {
  it('is true only when every field matches', () => {
    expect(configsEqual(CFG, { ...CFG })).toBe(true);
    expect(configsEqual(CFG, { ...CFG, playerTeam: 'T' })).toBe(false);
    expect(configsEqual(CFG, { ...CFG, botsT: 9 })).toBe(false);
    expect(configsEqual(CFG, { ...CFG, map: 'arena' })).toBe(false);
    expect(configsEqual(CFG, { ...CFG, botsCt: 0 })).toBe(false);
    expect(configsEqual(CFG, { ...CFG, roundSeconds: 91 })).toBe(false);
    expect(configsEqual(CFG, { ...CFG, botWeaponT: 'smg' })).toBe(false);
    expect(configsEqual(CFG, { ...CFG, botWeaponCt: 'smg' })).toBe(false);
    expect(configsEqual(CFG, { ...CFG, botSecondaryT: 'pistol' })).toBe(false);
    expect(configsEqual(CFG, { ...CFG, botSecondaryCt: 'pistol' })).toBe(false);
    expect(configsEqual(CFG, { ...CFG, mode: 'dom' })).toBe(false);
  });
});

describe('asTeam', () => {
  it('accepts t/ct case-insensitively', () => {
    expect(asTeam('t', 'CT')).toBe('T');
    expect(asTeam('T', 'CT')).toBe('T');
    expect(asTeam('ct', 'T')).toBe('CT');
    expect(asTeam('CT', 'T')).toBe('CT');
    expect(asTeam(' t ', 'CT')).toBe('T');
  });

  it('falls back for absent, empty and garbage values', () => {
    expect(asTeam(null, 'CT')).toBe('CT');
    expect(asTeam(undefined, 'T')).toBe('T');
    expect(asTeam('', 'CT')).toBe('CT');
    expect(asTeam('terrorist', 'CT')).toBe('CT');
    expect(asTeam('toString', 'CT')).toBe('CT');
  });

  it('parses side independently of the other params', () => {
    expect(parseSessionConfig(src({ side: 't' })).playerTeam).toBe('T');
    expect(parseSessionConfig(src({ side: 'nope' })).playerTeam).toBe(SESSION_DEFAULTS.playerTeam);
    expect(parseSessionConfig(src({})).playerTeam).toBe('CT');
  });
});

describe('botLimits/defaultBotCounts', () => {
  it('CT-side: enemy Ts 1..16, allied CTs 0..15', () => {
    expect(botLimits('CT')).toEqual({ limitT: BOTS_T_LIMITS, limitCt: BOTS_CT_LIMITS });
    expect(defaultBotCounts('CT')).toEqual({ botsT: 6, botsCt: 5 });
  });

  it('T-side mirrors: allied Ts 0..15, enemy CTs 1..16, defaults 5/6', () => {
    expect(botLimits('T')).toEqual({ limitT: BOTS_CT_LIMITS, limitCt: BOTS_T_LIMITS });
    expect(defaultBotCounts('T')).toEqual({ botsT: 5, botsCt: 6 });
  });
});

describe('asBotSecondary', () => {
  it('accepts both sidearms, plus mixed', () => {
    for (const id of ['mixed', 'pistol', 'revolver'] as const) {
      expect(asBotSecondary(id, 'pistol')).toBe(id);
    }
  });

  it('refuses primaries, the blade, and none — none of them belong here', () => {
    // Primaries belong to the primary position; the blade is already every
    // loadout's last position, so accepting it would name a duplicate the
    // loadout then drops; and 'none' is gone entirely — every bot always
    // carries a sidearm. A silently ignored setting is worse than a fallback.
    for (const id of ['ak47', 'smg', 'sniper', 'shotgun', 'knife', 'none']) {
      expect(asBotSecondary(id, 'pistol')).toBe('pistol');
    }
  });

  it('falls back for absent, empty and garbage values', () => {
    expect(asBotSecondary(null, 'revolver')).toBe('revolver');
    expect(asBotSecondary('', 'revolver')).toBe('revolver');
    expect(asBotSecondary('rocket', 'revolver')).toBe('revolver');
  });

  it('refuses prototype keys rather than passing them to a Record lookup', () => {
    expect(asBotSecondary('toString', 'pistol')).toBe('pistol');
    expect(asBotSecondary('constructor', 'pistol')).toBe('pistol');
  });

  it('parses tsec and ctsec independently, each with its own fallback', () => {
    const got = parseSessionConfig(src({ tsec: 'revolver', ctsec: 'nope' }));
    expect(got.botSecondaryT).toBe('revolver');
    expect(got.botSecondaryCt).toBe(SESSION_DEFAULTS.botSecondaryCt);
  });

  it('defaults both sides to mixed, so a default match varies its sidearms', () => {
    const got = parseSessionConfig(src({}));
    expect(got.botSecondaryT).toBe(SESSION_DEFAULTS.botSecondaryT);
    expect(got.botSecondaryCt).toBe(SESSION_DEFAULTS.botSecondaryCt);
    expect(SESSION_DEFAULTS.botSecondaryT).toBe('mixed');
  });
});

describe('asBotWeapon', () => {
  it('accepts every primary firearm, and mixed', () => {
    for (const id of ['mixed', 'ak47', 'smg', 'sniper', 'shotgun'] as const) {
      expect(asBotWeapon(id, 'smg')).toBe(id);
    }
  });

  it('refuses sidearms and the blade — neither belongs in the primary position', () => {
    // Sidearms arrive via the secondary position and the blade via every
    // loadout's fallback; a stale ?tweap=knife bookmark from when the blade
    // was a legal primary falls back rather than throwing.
    for (const id of ['pistol', 'revolver', 'knife']) {
      expect(asBotWeapon(id, 'mixed')).toBe('mixed');
    }
  });

  it('falls back for absent, empty and garbage values', () => {
    expect(asBotWeapon(null, 'smg')).toBe('smg');
    expect(asBotWeapon(undefined, 'smg')).toBe('smg');
    expect(asBotWeapon('', 'smg')).toBe('smg');
    expect(asBotWeapon('bazooka', 'smg')).toBe('smg');
  });

  it('does not let a prototype key pass the guard', () => {
    // hasOwn rather than `in`, exactly as asMapName does: 'toString' would
    // otherwise narrow to a weapon and reach a Record lookup that has no such
    // entry.
    expect(asBotWeapon('toString', 'smg')).toBe('smg');
    expect(asBotWeapon('constructor', 'smg')).toBe('smg');
  });

  it('parses both sides independently, defaulting to a mixed field', () => {
    expect(parseSessionConfig(src({ tweap: 'shotgun' }))).toMatchObject({
      botWeaponT: 'shotgun', botWeaponCt: SESSION_DEFAULTS.botWeaponCt,
    });
    expect(parseSessionConfig(src({ ctweap: 'shotgun' }))).toMatchObject({
      botWeaponT: SESSION_DEFAULTS.botWeaponT, botWeaponCt: 'shotgun',
    });
    expect(parseSessionConfig(src({ tweap: 'nope' })).botWeaponT).toBe(SESSION_DEFAULTS.botWeaponT);
  });

  it('still falls back for genuine garbage', () => {
    expect(parseSessionConfig(src({ tweap: 'rocket' })).botWeaponT).toBe(SESSION_DEFAULTS.botWeaponT);
  });
});

describe('mode', () => {
  it('parses dom on a map with flags', () => {
    expect(parseSessionConfig(src({ map: 'elevation', mode: 'dom' })).mode).toBe('dom');
  });

  it('falls back to tdm on a map without flags', () => {
    // Arena has no DOM_FLAGS entry with flags: an explicit dom request must
    // not boot a flagless domination match.
    expect(parseSessionConfig(src({ map: 'arena', mode: 'dom' })).mode).toBe('tdm');
  });

  it('falls back for absent/garbage values', () => {
    expect(parseSessionConfig(src({ map: 'elevation' })).mode).toBe(SESSION_DEFAULTS.mode);
    expect(parseSessionConfig(src({ map: 'elevation', mode: 'koth' })).mode).toBe(SESSION_DEFAULTS.mode);
  });

  it('round-trips dom through the query', () => {
    const dom = { ...CFG, map: 'elevation' as const, mode: 'dom' as const };
    expect(parseSessionConfig(srcFromQuery(configToQuery(dom)))).toEqual(dom);
  });
});

describe('clampTo', () => {
  it('passes in-range values through and clamps both ways', () => {
    expect(clampTo(5, BOTS_T_LIMITS)).toBe(5);
    expect(clampTo(-4, BOTS_T_LIMITS)).toBe(BOTS_T_LIMITS.min);
    expect(clampTo(99, BOTS_T_LIMITS)).toBe(BOTS_T_LIMITS.max);
    expect(clampTo(0.4, TIME_LIMITS_S)).toBe(TIME_LIMITS_S.min);
  });
});

describe('numOr', () => {
  it('parses finite numbers', () => {
    expect(numOr('7', 0)).toBe(7);
    expect(numOr('2.5', 0)).toBe(2.5);
    expect(numOr('-3', 0)).toBe(-3);
  });
  it.each([null, undefined, '', '   ', 'abc', 'NaN', 'Infinity', '1e999', '30s'])(
    'absent/garbage %j yields the fallback',
    raw => {
      expect(numOr(raw, 42)).toBe(42);
    },
  );
});

describe('secondsToMinutesLabel', () => {
  it('formats clean values without noise', () => {
    expect(secondsToMinutesLabel(120)).toBe('2');
    expect(secondsToMinutesLabel(90)).toBe('1.5');
    expect(secondsToMinutesLabel(30)).toBe('0.5');
  });

  it('trims float noise (115 s is not 1.9166666666666667)', () => {
    expect(secondsToMinutesLabel(115)).toBe('1.92');
  });

  // The reason the label exists: a prefilled form must compare equal to the
  // applied config so Play re-locks instead of navigating. Sweep every
  // clamped-legal second value.
  it('round-trips every legal second value exactly', () => {
    for (let seconds = TIME_LIMITS_S.min; seconds <= TIME_LIMITS_S.max; seconds++) {
      expect(Math.round(Number(secondsToMinutesLabel(seconds)) * 60)).toBe(seconds);
    }
  });
});
