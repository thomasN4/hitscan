// Proves core/state.js is importable WITHOUT a browser — no renderer, no
// DOM. If this file starts failing to import, something browser-only leaked
// back into the pure state module and the whole unit-test layer is lost.
import { describe, expect, test, beforeEach } from 'vitest';
import { WEAPONS, ammoStore, weapon, resetAmmo, game, player } from './state.js';

describe('state module purity', () => {
  test('imports in Node with no DOM globals present', () => {
    expect(typeof document).toBe('undefined');
    expect(typeof window).toBe('undefined');
  });

  test('defaults to the arena map when there is no ?map= param', () => {
    expect(game.map).toBe('arena');
  });
});

describe('resetAmmo', () => {
  beforeEach(() => {
    // Dirty every field resetAmmo is responsible for restoring.
    ammoStore[0].mag = 3; ammoStore[0].reserve = 7;
    ammoStore[1].mag = 1; ammoStore[1].reserve = 2;
    Object.assign(weapon, { name: 'SNIPER', mag: 0, reserve: 0, reloading: true });
    resetAmmo();
  });

  test('refills every slot to its full loadout', () => {
    WEAPONS.forEach((def, i) => {
      expect(ammoStore[i].mag).toBe(def.magSize);
      expect(ammoStore[i].reserve).toBe(def.reserveMax);
    });
  });

  test('mirrors slot 0 into the live weapon and clears an in-flight reload', () => {
    const rifle = WEAPONS[0];
    expect(weapon.name).toBe(rifle.name);
    expect(weapon.mag).toBe(rifle.magSize);
    expect(weapon.reserve).toBe(rifle.reserveMax);
    expect(weapon.damage).toBe(rifle.damage);
    expect(weapon.recoilRecover).toBe(rifle.recoilRecover);
    expect(weapon.reloading).toBe(false);
  });
});

describe('player entity', () => {
  test('pos is the EYE position, resting at eyeHeight', () => {
    expect(player.pos.y).toBe(player.eyeHeight);
  });
});
