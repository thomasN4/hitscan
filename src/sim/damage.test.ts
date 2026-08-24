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
  const headShots = (id: keyof typeof WEAPONS): number =>
    Math.ceil(100 / damageForPart(WEAPONS[id], 'head'));
  const torsoShots = (id: keyof typeof WEAPONS): number =>
    Math.ceil(100 / damageForPart(WEAPONS[id], 'torso'));

  test('one-tap headshot weapons: sniper, revolver, shotgun (per pull)', () => {
    expect(headShots('sniper')).toBe(1);
    expect(headShots('revolver')).toBe(1);
    // Pellet weapons fire several rays per pull: the intent is per TRIGGER
    // PULL, so the shotgun qualifies when enough pellets land together.
    const perPull =
      damageForPart(WEAPONS.shotgun, 'head') * (WEAPONS.shotgun.pellets ?? 1);
    expect(perPull).toBeGreaterThanOrEqual(100);
  });

  test('two-tap headshot weapons: smg and pistol (playtest round 1)', () => {
    expect(headShots('smg')).toBe(2);
    expect(headShots('pistol')).toBe(2);
    // Pin the old one-tap intent as GONE, not merely absent from the count.
    expect(damageForPart(WEAPONS.smg, 'head')).toBeLessThan(100);
    expect(damageForPart(WEAPONS.pistol, 'head')).toBeLessThan(100);
  });

  test('the knife pays NO head premium — two swings to kill, any zone', () => {
    // The arc strikes the nearest part and point-blank that is usually the
    // head, so a multiplier there is really a point-blank one-tap multiplier
    // (measured -120 hp in the smoke phase). Pinned as GONE, like the smg's
    // retired one-tap above: heads cut for exactly torso damage.
    expect(damageForPart(WEAPONS.knife, 'head')).toBe(damageForPart(WEAPONS.knife, 'torso'));
    expect(headShots('knife')).toBe(2);
    expect(torsoShots('knife')).toBe(2);
  });

  test('torso shots to kill match the stated intents', () => {
    expect(torsoShots('sniper')).toBe(2);
    expect(torsoShots('revolver')).toBe(2);
    expect(torsoShots('smg')).toBe(4);
    expect(torsoShots('pistol')).toBe(3);
  });

  test('leg hits never out-damage torso hits', () => {
    for (const w of Object.values(WEAPONS)) {
      expect(damageForPart(w, 'legs')).toBeLessThan(damageForPart(w, 'torso'));
    }
  });
});
