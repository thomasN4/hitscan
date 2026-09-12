// scripts/elevatorSmoke.test.mjs — the bot-transport legs run on the game clock.
//
// Issue #101: the 45 s wall budget flaked under full-suite headless load
// because game time (clamped at 0.05 s/frame in main.ts) can only ever lag
// wall time — the same wall-vs-game class the smoke test's [qcancel] phase
// documents. The legs now fail on game-budget exhaustion with wall time as a
// failsafe and a shared total deadline; this exercises the serialized waiter
// and pins the budgets' derivation
// from the warehouse2 lift spec.
import { test, expect, vi, afterEach } from 'vitest';
import {
  ELEVATOR_SMOKE_WALL_BUDGET_MS,
  BOT_TRANSPORT_WALL_BUDGET_MS,
  BOT_TRANSPORT_GAME_BUDGET_SEC,
  createElevatorWaiter,
  ELEVATOR_SMOKE_TOTAL_WALL_MS,
  SMOKE_PROTOCOL_TIMEOUT_MS,
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

afterEach(() => vi.useRealTimers());

function fixture({ totalWallMs = ELEVATOR_SMOKE_TOTAL_WALL_MS, frames = true } = {}) {
  vi.useFakeTimers();
  let game = 0;
  // Exercise the same serialization boundary as page.evaluate, with no module closure.
  const factory = new Function(`return (${createElevatorWaiter.toString()})`)();
  const wait = factory({ wallNow: () => Date.now(), gameNow: () => game,
    requestFrame: cb => frames ? setTimeout(cb, 10) : undefined,
    cancelFrame: id => clearTimeout(id), snapshot: () => 'bots=test elevators=test', totalWallMs });
  return { wait, setGame: value => { game = value; } };
}
const transportBudget = { wallMs: BOT_TRANSPORT_WALL_BUDGET_MS, gameSec: BOT_TRANSPORT_GAME_BUDGET_SEC,
  detail: () => 'phases=[wait,board]' };

test('slow game time can pass the old wall limit and still complete; timers are cleaned up', async () => {
  const { wait, setGame } = fixture();
  let done = false;
  const pending = wait(() => done, 'bot upper', undefined, transportBudget);
  setGame(1);
  await vi.advanceTimersByTimeAsync(ELEVATOR_SMOKE_WALL_BUDGET_MS + 1000);
  done = true;
  await vi.advanceTimersByTimeAsync(10);
  await pending;
  expect(vi.getTimerCount()).toBe(0);
});

test('game exhaustion reports label, snapshot, phases and elapsed clocks', async () => {
  const { wait, setGame } = fixture();
  const pending = wait(() => false, 'bot upper', undefined, transportBudget);
  const assertion = expect(pending).rejects.toThrow(/bot upper: bots=test elevators=test phases=\[wait,board\] timeout=game wallElapsedMs=10 gameElapsedSec=30.00/);
  setGame(30);
  await vi.advanceTimersByTimeAsync(10);
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
});

test('wall failsafe fires even when animation frames never arrive', async () => {
  const { wait } = fixture({ frames: false });
  const pending = wait(() => false, 'stalled bot', undefined, transportBudget);
  const assertion = expect(pending).rejects.toThrow(/stalled bot:.*timeout=leg-wall.*gameElapsedSec=0.00/);
  await vi.advanceTimersByTimeAsync(BOT_TRANSPORT_WALL_BUDGET_MS);
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
});

test('late legs use the remaining total budget before the protocol timeout', async () => {
  const { wait } = fixture({ frames: false });
  await vi.advanceTimersByTimeAsync(ELEVATOR_SMOKE_TOTAL_WALL_MS - 5000);
  const pending = wait(() => false, 'fourth leg', undefined, transportBudget);
  const assertion = expect(pending).rejects.toThrow(/fourth leg:.*timeout=total-wall wallElapsedMs=5000/);
  await vi.advanceTimersByTimeAsync(5000);
  await assertion;
  expect(ELEVATOR_SMOKE_TOTAL_WALL_MS).toBeLessThan(SMOKE_PROTOCOL_TIMEOUT_MS);
  await expect(wait(() => true, 'expired suite', undefined, transportBudget)).rejects.toThrow('timeout=total-wall');
  expect(vi.getTimerCount()).toBe(0);
});

test('wall-only checks ignore game elapsed but propagate observer errors and clean timers', async () => {
  const { wait, setGame } = fixture();
  const pending = wait(() => true, 'player', undefined, { wallMs: ELEVATOR_SMOKE_WALL_BUDGET_MS });
  setGame(100);
  await vi.advanceTimersByTimeAsync(10);
  await pending;
  const broken = wait(() => false, 'support', () => { throw new Error('lost support'); }, transportBudget);
  const assertion = expect(broken).rejects.toThrow('lost support');
  await vi.advanceTimersByTimeAsync(10);
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
});
