import { describe, expect, test, vi } from 'vitest';
import { routeReview, selectReviewer } from './review-route.mjs';

const usage = (fiveHour, sevenDay) => ({
  five_hour: { utilization: fiveHour, resets_at: '2026-08-26T18:00:00Z' },
  seven_day: { utilization: sevenDay, resets_at: '2026-09-01T00:00:00Z' },
});

describe('selectReviewer', () => {
  test.each([
    [0, 0],
    [80, 90],
    [79.9, 89.9],
  ])('keeps Claude at 5h=%s and 7d=%s', (fiveHour, sevenDay) => {
    expect(selectReviewer(usage(fiveHour, sevenDay)).reviewer).toBe('claude');
  });

  test.each([
    [80.1, 0],
    [0, 90.1],
    [100, 100],
  ])('routes to Codex at 5h=%s and 7d=%s', (fiveHour, sevenDay) => {
    expect(selectReviewer(usage(fiveHour, sevenDay)).reviewer).toBe('codex');
  });

  test.each([
    undefined,
    {},
    { five_hour: null, seven_day: {} },
    usage(Number.NaN, 2),
    usage(-1, 2),
  ])('rejects an untrustworthy usage shape', (value) => {
    expect(() => selectReviewer(value)).toThrow();
  });
});

describe('routeReview', () => {
  test('authenticates the usage request and returns its selection', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: () => usage(10, 20) });
    await expect(routeReview({ token: 'secret', fetchImpl, signal: undefined })).resolves.toMatchObject({
      reviewer: 'claude',
      fiveHour: 10,
      sevenDay: 20,
    });
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('/api/oauth/usage'), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
    }));
  });

  test.each([
    ['missing token', { token: undefined }],
    ['HTTP failure', { token: 'secret', fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 503 }) }],
    ['malformed JSON', { token: 'secret', fetchImpl: vi.fn().mockResolvedValue({ ok: true, json: () => { throw new Error('bad JSON'); } }) }],
    ['network failure', { token: 'secret', fetchImpl: vi.fn().mockRejectedValue(new Error('offline')) }],
    ['timeout', { token: 'secret', fetchImpl: vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError')) }],
    ['missing window', { token: 'secret', fetchImpl: vi.fn().mockResolvedValue({ ok: true, json: () => ({ five_hour: null }) }) }],
  ])('routes to Codex on %s', async (_name, options) => {
    await expect(routeReview({ signal: undefined, ...options })).resolves.toMatchObject({ reviewer: 'codex' });
  });
});
