// Proves core/state.ts is importable WITHOUT a browser — no renderer, no
// DOM. The bare `import` below IS that assertion: this suite runs in plain
// Node, so anything browser-only leaking back into state.ts at module scope
// makes every test here fail to even load, and the unit-test layer is lost.
// (Browser globals inside a state.ts *function* body are not caught here —
// they are caught by review and by scripts/smoke-test.mjs.)
import { describe, expect, test, beforeEach } from 'vitest';
import { WEAPONS, ammoStore, weapon, loadout, lastLoadout, setLoadout, armLoadout,
         sanitizeLoadout, session, player, equippedId } from './state';

describe('state module purity', () => {
  // main.ts overwrites session's config fields from the URL query at startup;
  // the pure defaults the module ships with must be the plain arena match.
  test('ships with match-config defaults', () => {
    expect(session.map).toBe('arena');
    expect(session.botsT).toBe(6);
    expect(session.botsCt).toBe(0);
    expect(session.roundSeconds).toBe(120);
  });

  test('ships with a full primary/secondary catalog split', () => {
    // The picker's two columns and the class-validated setLoadout both rest on
    // this split: at least two options per column, no weapon in both.
    const primaries = Object.values(WEAPONS).filter(d => d.class === 'primary');
    const secondaries = Object.values(WEAPONS).filter(d => d.class === 'secondary');
    expect(primaries.length).toBeGreaterThanOrEqual(2);
    expect(secondaries.length).toBeGreaterThanOrEqual(2);
  });

  test('exactly one melee weapon, and it sits in neither picker column', () => {
    // The knife is always carried (slot 2) and never picked — the class
    // split is what keeps a corrupted loadout from naming it.
    const melee = Object.values(WEAPONS).filter(d => d.class === 'melee');
    expect(melee).toHaveLength(1);
    expect(melee[0]!.name).toBe('KNIFE');
  });

  test('position 2 is always the knife, whatever the loadout', () => {
    setLoadout('sniper', 'revolver');
    expect(equippedId(0)).toBe('sniper');
    expect(equippedId(1)).toBe('revolver');
    expect(equippedId(2)).toBe('knife');
    setLoadout('smg', 'pistol');
    expect(equippedId(2)).toBe('knife');
  });
});

describe('armLoadout', () => {
  beforeEach(() => {
    // Dirty every field armLoadout is responsible for restoring.
    setLoadout('smg', 'pistol');
    ammoStore[0].mag = 3; ammoStore[0].reserve = 7;
    ammoStore[1].mag = 1; ammoStore[1].reserve = 2;
    Object.assign(weapon, { name: 'SNIPER', mag: 0, reserve: 0, reloading: true, nextRoundAt: 42 });
    armLoadout();
  });

  test('refills every POSITION from its equipped def', () => {
    expect(ammoStore[0].mag).toBe(WEAPONS[loadout.primary].magSize);
    expect(ammoStore[0].reserve).toBe(WEAPONS[loadout.primary].reserveMax);
    expect(ammoStore[1].mag).toBe(WEAPONS[loadout.secondary].magSize);
    expect(ammoStore[1].reserve).toBe(WEAPONS[loadout.secondary].reserveMax);
  });

  test('leaves the knife position alone — a blade holds no rounds', () => {
    // armLoadout covers the PICKED positions only; slot 2 stays zeroed no
    // matter what was deployed.
    ammoStore[2].mag = 5; // even a corrupted value survives untouched
    setLoadout('shotgun', 'revolver');
    expect([ammoStore[2].mag, ammoStore[2].reserve]).toEqual([5, 0]);
  });

  test('mirrors the PRIMARY into the live weapon and clears an in-flight reload', () => {
    const primary = WEAPONS[loadout.primary];
    expect(weapon.name).toBe(primary.name);
    expect(weapon.mag).toBe(primary.magSize);
    expect(weapon.reserve).toBe(primary.reserveMax);
    expect(weapon.damage).toBe(primary.damage);
    expect(weapon.recoilRecover).toBe(primary.recoilRecover);
    expect(weapon.reloading).toBe(false);
    expect(weapon.nextRoundAt).toBe(0); // the per-round transfer schedule resets with the reload flag
  });

  test('only shotgun and revolver reload per round', () => {
    const perRound = Object.values(WEAPONS).filter(d => d.perRound).map(d => d.name).sort();
    expect(perRound).toEqual(['REVOLVER', 'SHOTGUN']);
  });

  test('follows a changed loadout', () => {
    setLoadout('shotgun', 'revolver');
    expect(weapon.name).toBe('SHOTGUN');
    expect(weapon.magSize).toBe(WEAPONS.shotgun.magSize);
    expect(ammoStore[1].mag).toBe(WEAPONS.revolver.magSize);
  });
});

describe('setLoadout', () => {
  test('enforces the class split with a named error', () => {
    expect(() => setLoadout('revolver', 'smg')).toThrow('not a primary');
    expect(() => setLoadout('sniper', 'sniper')).toThrow('not a secondary');
    // The melee class passes neither column — the knife cannot be picked.
    expect(() => setLoadout('knife', 'pistol')).toThrow('not a primary');
    expect(() => setLoadout('smg', 'knife')).toThrow('not a secondary');
    // Rejected calls must not have touched state.
    expect(loadout.primary).not.toBe('revolver');
  });

  test('records the deployment as the next picker pre-fill', () => {
    setLoadout('sniper', 'revolver');
    expect(lastLoadout).toEqual({ primary: 'sniper', secondary: 'revolver' });
  });
});

describe('sanitizeLoadout', () => {
  test('accepts a valid persisted pair', () => {
    expect(sanitizeLoadout({ primary: 'sniper', secondary: 'revolver' }))
      .toEqual({ primary: 'sniper', secondary: 'revolver' });
  });

  test.each([
    undefined,
    null,
    'sniper',
    {},
    { primary: 'sniper' },
    { primary: 'sniper', secondary: 'shotgun' },   // wrong classes
    { primary: 'axe', secondary: 'pistol' },       // unknown ids
    { primary: 3, secondary: 'pistol' },
  ])('rejects %j', v => {
    expect(sanitizeLoadout(v)).toBeUndefined();
  });
});

describe('player entity', () => {
  test('pos is the EYE position; feet rest at support height (y=0 on open ground)', () => {
    // The initial spawn sits on open ground, so eye = eyeHeight exactly.
    // On stairs/platforms pos.y rides higher: feet = pos.y - eyeHeight is
    // what collision.ts resolves against (see collision.test.ts).
    expect(player.pos.y).toBe(player.eyeHeight);
    expect(player.pos.y - player.eyeHeight).toBe(0);
  });
});
