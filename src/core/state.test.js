// Proves core/state.js is importable WITHOUT a browser — no renderer, no
// DOM. The bare `import` below IS that assertion: this suite runs in plain
// Node, so anything browser-only leaking back into state.js at module scope
// makes every test here fail to even load, and the unit-test layer is lost.
// (Browser globals inside a state.js *function* body are not caught here —
// they are caught by review and by scripts/smoke-test.mjs.)
import { describe, expect, test, beforeEach } from 'vitest';
import { WEAPONS, ammoStore, weapon, resetAmmo, game, player } from './state.js';

describe('state module purity', () => {
  // main.js overwrites game.map from ?map= at startup; the pure default the
  // module ships with must be the arena.
  test('defaults to the arena map', () => {
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
    const smg = WEAPONS[0];
    expect(weapon.name).toBe(smg.name);
    expect(weapon.mag).toBe(smg.magSize);
    expect(weapon.reserve).toBe(smg.reserveMax);
    expect(weapon.damage).toBe(smg.damage);
    expect(weapon.recoilRecover).toBe(smg.recoilRecover);
    expect(weapon.reloading).toBe(false);
  });
});

describe('player entity', () => {
  test('pos is the EYE position, resting at eyeHeight', () => {
    expect(player.pos.y).toBe(player.eyeHeight);
  });
});
