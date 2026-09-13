import { expect, test } from 'vitest';
import { movementRegressions } from './botMovementMetrics.mjs';

const row = { fixture: 'corner', seed: 1, hz: 60, speed: 3.9, offset: 0,
  engage: false, arrived: true, loss: 0.05, longestStall: 0.1, elapsed: 5,
  engageTime: 0, transportSeen: false };

test('partial sliding is a regression even when travel is faster and no step fully jams', () => {
  expect(movementRegressions([row], [{ ...row, loss: 0.3, elapsed: 4, longestStall: 0 }]))
    .toEqual([expect.stringContaining('collision loss')]);
});
test('a failed route cannot disappear into an average', () => {
  expect(movementRegressions([row], [{ ...row, arrived: false }]))
    .toEqual([expect.stringContaining('did not arrive')]);
});
test('less movement caused by abandoning engagement is not an improvement', () => {
  const combat = { ...row, engage: true, engageTime: 12 };
  expect(movementRegressions([combat], [{ ...combat, loss: 0, engageTime: 2 }]))
    .toEqual([expect.stringContaining('abandoning engagement')]);
});
test('paired comparisons refuse missing or different trials', () => {
  expect(() => movementRegressions([row], [])).toThrow('Missing');
  expect(() => movementRegressions([row], [{ ...row, seed: 2 }])).toThrow('Unpaired');
  expect(movementRegressions([row], [{ ...row, loss: 0.01, elapsed: 4.5 }])).toEqual([]);
});

test('invalid telemetry cannot silently pass comparisons', () => {
  expect(() => movementRegressions([row], [{ ...row, loss: NaN }])).toThrow('Invalid');
  expect(() => movementRegressions([row, row], [row])).toThrow('Duplicate');
});
