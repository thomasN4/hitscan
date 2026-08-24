import { describe, expect, test } from 'vitest';
import { damageForPart, partForMesh } from './damage';
import { WEAPONS } from '../core/state';

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
  const smg = { damage: 26, headshotMult: 4 };

  test('torso is the x1 reference', () => {
    expect(damageForPart(smg, 'torso')).toBe(26);
  });

  test('legs are x0.75', () => {
    expect(damageForPart(smg, 'legs')).toBe(19.5);
  });

  test('head uses the weapon own multiplier', () => {
    expect(damageForPart(smg, 'head')).toBe(104);
  });
});

describe('balance intents from the WEAPONS comments', () => {
  test('every weapon one-taps on a headshot', () => {
    for (const w of Object.values(WEAPONS)) {
      // Pellet weapons fire several rays per pull: the intent is per TRIGGER
      // PULL, so the shotgun qualifies when enough pellets land together.
      const perPull = damageForPart(w, 'head') * (w.pellets ?? 1);
      expect(perPull).toBeGreaterThanOrEqual(100);
    }
  });

  test('the sniper kills in two torso shots, the smg does not', () => {
    const smg = WEAPONS.smg;
    const sniper = WEAPONS.sniper;
    expect(damageForPart(sniper, 'torso') * 2).toBeGreaterThanOrEqual(100);
    expect(damageForPart(smg, 'torso') * 2).toBeLessThan(100);
  });

  test('leg hits never out-damage torso hits', () => {
    for (const w of Object.values(WEAPONS)) {
      expect(damageForPart(w, 'legs')).toBeLessThan(damageForPart(w, 'torso'));
    }
  });
});
