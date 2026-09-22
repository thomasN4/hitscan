import { describe, expect, test } from 'vitest';
import { DEFAULT_SETTINGS, SETTING_LIMITS, TOUCH_CONTROL_IDS, defaultLayout, sanitizeSettings } from './settings';

describe('sanitizeSettings', () => {
  test('garbage of any shape yields the defaults', () => {
    for (const raw of [undefined, null, 42, 'x', [], {}, { touch: 'no', layout: [] }]) {
      expect(sanitizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
    }
  });

  test('a valid object round-trips unchanged, through JSON too', () => {
    const tuned = sanitizeSettings({
      mouseSens: 1.4,
      touch: { hip: { sens: 1.3, accel: 0.6 }, ads: { sens: 0.7, accel: 0 }, opacity: 0.6, stickRadius: 70 },
      layout: { ...DEFAULT_SETTINGS.layout, fireR: { x: 0.8, y: 0.7, scale: 1.3 } },
    });
    expect(sanitizeSettings(JSON.parse(JSON.stringify(tuned)))).toEqual(tuned);
    expect(tuned.layout.fireR).toEqual({ x: 0.8, y: 0.7, scale: 1.3 });
  });

  test('clamps out-of-range values and falls back per field', () => {
    const s = sanitizeSettings({
      mouseSens: 99,
      touch: { hip: { sens: -1, accel: 'fast' }, opacity: 0, stickRadius: Infinity },
      layout: { jump: { x: 2, y: -1, scale: 9 } },
    });
    expect(s.mouseSens).toBe(SETTING_LIMITS.sens.max);
    expect(s.touch.hip).toEqual({ sens: SETTING_LIMITS.sens.min, accel: DEFAULT_SETTINGS.touch.hip.accel });
    expect(s.touch.ads).toEqual(DEFAULT_SETTINGS.touch.ads);
    expect(s.touch.opacity).toBe(SETTING_LIMITS.opacity.min);
    expect(s.touch.stickRadius).toBe(DEFAULT_SETTINGS.touch.stickRadius);
    expect(s.layout.jump).toEqual({ x: 1, y: 0, scale: SETTING_LIMITS.scale.max });
  });

  test('missing controls are filled from the defaults, unknown keys dropped', () => {
    const s = sanitizeSettings({ layout: { fireL: { x: 0.2, y: 0.5, scale: 1 }, bogus: { x: 0 } }, extra: true });
    expect(Object.keys(s.layout).sort()).toEqual([...TOUCH_CONTROL_IDS].sort());
    expect(s.layout.fireL).toEqual({ x: 0.2, y: 0.5, scale: 1 });
    expect(s.layout.ads).toEqual(DEFAULT_SETTINGS.layout.ads);
    expect('extra' in s).toBe(false);
  });

  test('never aliases the shared defaults', () => {
    const a = sanitizeSettings(undefined);
    a.layout.fireR.x = 0;
    a.touch.hip.sens = 3;
    expect(DEFAULT_SETTINGS.layout.fireR.x).not.toBe(0);
    expect(DEFAULT_SETTINGS.touch.hip.sens).toBe(1);
    expect(defaultLayout()).toEqual(DEFAULT_SETTINGS.layout);
  });
});
