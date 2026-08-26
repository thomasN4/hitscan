// scripts/review-route.mjs — chooses the subscription-backed PR reviewer.
//
// Claude Code 2.1.246 reads these same fields from this endpoint for its usage
// display. Anthropic does not document the endpoint as a public API, so every
// fetch or schema failure deliberately routes to Codex rather than spending
// Claude capacity whose remaining amount cannot be proved.

import { pathToFileURL } from 'node:url';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const FIVE_HOUR_LIMIT = 80;
const SEVEN_DAY_LIMIT = 90;
const FETCH_TIMEOUT_MS = 10_000;

function utilization(window, name) {
  if (!window || typeof window !== 'object') throw new Error(`Missing ${name} usage window`);
  const value = window.utilization;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${name}.utilization`);
  }
  return value;
}

/** Selects the reviewer from Claude's account-wide subscription windows. */
export function selectReviewer(usage) {
  if (!usage || typeof usage !== 'object') throw new Error('Usage response is not an object');
  const fiveHour = utilization(usage.five_hour, 'five_hour');
  const sevenDay = utilization(usage.seven_day, 'seven_day');
  const reviewer = fiveHour > FIVE_HOUR_LIMIT || sevenDay > SEVEN_DAY_LIMIT ? 'codex' : 'claude';
  const reason = reviewer === 'codex'
    ? `Claude usage is above reserve threshold (5h ${fiveHour}%, 7d ${sevenDay}%)`
    : `Claude usage is within reserve threshold (5h ${fiveHour}%, 7d ${sevenDay}%)`;
  return {
    reviewer,
    reason,
    fiveHour,
    sevenDay,
    fiveHourResetsAt: usage.five_hour.resets_at,
    sevenDayResetsAt: usage.seven_day.resets_at,
  };
}

/** Fetches usage and conservatively returns Codex whenever it cannot be trusted. */
export async function routeReview({
  token,
  fetchImpl = fetch,
  signal = AbortSignal.timeout(FETCH_TIMEOUT_MS),
} = {}) {
  if (!token) return { reviewer: 'codex', reason: 'CLAUDE_CODE_OAUTH_TOKEN is unavailable' };

  try {
    const response = await fetchImpl(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'user-agent': 'claude-code/2.1.246',
      },
      signal,
    });
    if (!response.ok) throw new Error(`Usage endpoint returned HTTP ${response.status}`);
    return selectReviewer(await response.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { reviewer: 'codex', reason: `Claude usage is unavailable: ${message}` };
  }
}

function resetText(value) {
  return typeof value === 'string' && value ? `, resets ${value}` : '';
}

async function main() {
  const result = await routeReview({ token: process.env.CLAUDE_CODE_OAUTH_TOKEN });
  console.error(`[review-route] ${result.reason}`);
  if (result.fiveHour !== undefined) {
    console.error(`[review-route] five-hour ${result.fiveHour}%${resetText(result.fiveHourResetsAt)}`);
    console.error(`[review-route] seven-day ${result.sevenDay}%${resetText(result.sevenDayResetsAt)}`);
  }
  process.stdout.write(`${result.reviewer}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
