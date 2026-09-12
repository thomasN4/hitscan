// scripts/elevatorSmoke.test.mjs — the bot-transport legs run on the game clock.
//
// Issue #101: the 45 s wall budget flaked under full-suite headless load
// because game time (clamped at 0.05 s/frame in main.ts) can only ever lag
// wall time — the same wall-vs-game class the smoke test's [qcancel] phase
// documents. The legs now fail on game-budget exhaustion with wall time as a
// dead-man failsafe; this pins that contract plus the budgets' derivation
// from the warehouse2 lift spec.
import { test, expect } from 'vitest';
import {
  ELEVATOR_SMOKE_WALL_BUDGET_MS,
  BOT_TRANSPORT_WALL_BUDGET_MS,
  BOT_TRANSPORT_GAME_BUDGET_SEC,
  transportWaitExhausted,
} from './elevator-smoke.mjs';

test('player-leg wall budget is unchanged', () => {
  expect(ELEVATOR_SMOKE_WALL_BUDGET_MS).toBe(45000);
});

test('transport game budget covers the worst-case warehouse2 leg', () => {
  // maps/warehouse2.ts: PAD_H 0.25, DECK_Y 5.1, LIFT_SPEED 1.5, LIFT_DWELL 2.
  const travel = (5.1 - 0.25) / 1.5;
  const worstWait = 2 * travel + 2; // arrive just as the deck departs the source
  const walkBoardExitMargin = 8;
  expect(BOT_TRANSPORT_GAME_BUDGET_SEC).toBeGreaterThanOrEqual(Math.ceil(worstWait + travel + walkBoardExitMargin));
});

test('transport wall failsafe is strictly looser than the leg wall budget', () => {
  expect(BOT_TRANSPORT_WALL_BUDGET_MS).toBeGreaterThan(ELEVATOR_SMOKE_WALL_BUDGET_MS);
});

test('load lag within the failsafe never exhausts: only a spent game budget or a tripped failsafe fails', () => {
  const wall = BOT_TRANSPORT_WALL_BUDGET_MS, game = BOT_TRANSPORT_GAME_BUDGET_SEC;
  expect(transportWaitExhausted(0, 0, wall, game)).toBe(false);
  // Slow frames: wall nearly spent, game barely advanced — keep waiting.
  expect(transportWaitExhausted(wall - 1, game - 1, wall, game)).toBe(false);
  expect(transportWaitExhausted(wall * 0.99, 1, wall, game)).toBe(false);
  // The real assertion: game budget spent.
  expect(transportWaitExhausted(1000, game, wall, game)).toBe(true);
  expect(transportWaitExhausted(1000, game + 5, wall, game)).toBe(true);
  // Dead sim: wall failsafe trips even with the game clock stalled.
  expect(transportWaitExhausted(wall, 0, wall, game)).toBe(true);
  // Boundary exhausts (>=, matching the loop's exit condition).
  expect(transportWaitExhausted(wall, game, wall, game)).toBe(true);
});
