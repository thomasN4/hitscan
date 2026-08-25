import { describe, expect, test } from 'vitest';
import { decideWinner, eliminationEndsMatch } from './match';

describe('decideWinner', () => {
  test('higher CT score wins', () => {
    expect(decideWinner(10, 3)).toBe('CT');
  });

  test('higher T score wins', () => {
    expect(decideWinner(3, 10)).toBe('T');
  });

  test('equal scores draw', () => {
    expect(decideWinner(0, 0)).toBe('draw');
    expect(decideWinner(7, 7)).toBe('draw');
  });
});

describe('eliminationEndsMatch', () => {
  test('a wave of two or more ends the match when wiped', () => {
    expect(eliminationEndsMatch(2)).toBe(true);
    expect(eliminationEndsMatch(5)).toBe(true);
  });

  test('1v1 keeps the wave-respawn loop — only the clock can end it', () => {
    expect(eliminationEndsMatch(1)).toBe(false);
  });

  test('zero enemies (range) never triggers elimination', () => {
    expect(eliminationEndsMatch(0)).toBe(false);
  });
});
