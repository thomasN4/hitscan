import { describe, expect, test } from 'vitest';
import { SWAP_DELAY, isDeploying } from './weaponSwap';

describe('weaponSwap deploy window', () => {
  test('the shared delay is CS-like and outlasts the fastest recoil drain', () => {
    // A full smg climb converted onto the sniper (3.6 units at 13/s) clears in
    // 0.277 s — the window must exceed that or 1-2-1 still refunds the climb
    // inside a human swap (issue #15).
    expect(SWAP_DELAY).toBe(0.4);
    expect(SWAP_DELAY).toBeGreaterThan(0.277);
  });

  test('deploying covers [switchedAt, switchedAt + SWAP_DELAY)', () => {
    expect(isDeploying(10, 10)).toBe(true);
    expect(isDeploying(10 + SWAP_DELAY - 1e-9, 10)).toBe(true);
    expect(isDeploying(10 + SWAP_DELAY, 10)).toBe(false);
    expect(isDeploying(11, 10)).toBe(false);
  });

  test('a fresh life is never deploying', () => {
    expect(isDeploying(0, -Infinity)).toBe(false);
    expect(isDeploying(123.456, -Infinity)).toBe(false);
  });

  test('a re-swap re-arms the window — the latest press wins', () => {
    // First swap at t=10 would be ready at 10.4; swapping again at 10.3
    // pushes readiness to 10.7 rather than queuing behind the first window.
    expect(isDeploying(10.35, 10.3)).toBe(true);
    expect(isDeploying(10.45, 10.3)).toBe(true);
    expect(isDeploying(10.75, 10.3)).toBe(false);
  });
});
