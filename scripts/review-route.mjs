// scripts/review-route.mjs — chooses the subscription-backed PR reviewer.
//
// Codex is the stable default. Claude remains available as an explicit repo
// variable override until its headless token can read subscription usage; issue
// #59 tracks restoring automatic quota-aware routing.

import { pathToFileURL } from 'node:url';

/** Selects the reviewer from the optional AI_REVIEWER repo Actions variable. */
export function selectReviewer(value) {
  const reviewer = value?.trim().toLowerCase();
  if (!reviewer) {
    return { reviewer: 'codex', reason: 'AI_REVIEWER is unset; defaulting to Codex' };
  }
  if (reviewer === 'codex') {
    return { reviewer, reason: 'AI_REVIEWER selects Codex' };
  }
  if (reviewer === 'claude') {
    return { reviewer, reason: 'AI_REVIEWER selects Claude' };
  }
  throw new Error(`Invalid AI_REVIEWER value ${JSON.stringify(value)}; expected "codex" or "claude"`);
}

function main() {
  const result = selectReviewer(process.env.AI_REVIEWER);
  console.error(`[review-route] ${result.reason}`);
  process.stdout.write(`${result.reviewer}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
