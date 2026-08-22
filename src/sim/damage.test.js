import { describe, expect, test } from 'vitest';
import { damageForPart, partForMesh } from './damage.js';
import { WEAPONS } from '../core/state.js';

const bot = { head: { id: 'h' }, torso: { id: 't' }, legs: { id: 'l' } };

describe('partForMesh', () => {
  test('identifies each zone by mesh identity', () => {
    expect(partForMesh(bot, bot.head)).toBe('head');
    expect(partForMesh(bot, bot.torso)).toBe('torso');
    expect(partForMesh(bot, bot.legs)).toBe('legs');
  });

  test('falls back to torso for an unrecognized mesh', () => {
    expect(partForMesh(bot, { id: 'other' })).toBe('torso');
  });
});

describe('damageForPart', () => {
  const rifle = { damage: 26, headshotMult: 4 };

  test('torso is the x1 reference', () => {
    expect(damageForPart(rifle, 'torso')).toBe(26);
  });

  test('legs are x0.75', () => {
    expect(damageForPart(rifle, 'legs')).toBe(19.5);
  });

  test('head uses the weapon own multiplier', () => {
    expect(damageForPart(rifle, 'head')).toBe(104);
  });
});

describe('balance intents from the WEAPONS comments', () => {
  test('every weapon one-taps on a headshot', () => {
    for (const w of WEAPONS) {
      expect(damageForPart(w, 'head')).toBeGreaterThanOrEqual(100);
    }
  });

  test('the sniper kills in two torso shots, the rifle does not', () => {
    const [rifle, sniper] = WEAPONS;
    expect(damageForPart(sniper, 'torso') * 2).toBeGreaterThanOrEqual(100);
    expect(damageForPart(rifle, 'torso') * 2).toBeLessThan(100);
  });

  test('leg hits never out-damage torso hits', () => {
    for (const w of WEAPONS) {
      expect(damageForPart(w, 'legs')).toBeLessThan(damageForPart(w, 'torso'));
    }
  });
});
