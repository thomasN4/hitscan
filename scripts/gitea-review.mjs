// scripts/gitea-review.mjs — the Gitea half of the automated PR review.
//
// `.github/workflows/review.yml` runs `claude -p` to produce a markdown review,
// then hands it here to be posted. Split out of the workflow YAML because a
// shell one-liner buried in a `run:` block is neither readable nor runnable
// locally, and this file needs both:
//
//   GITEA_API=http://192.168.2.161:3000 GITEA_TOKEN="$(cat ../.gitea-access-token)" \
//   GITEA_REPO=thomasN4/another-cs-clone PR_INDEX=52 HEAD_SHA="$(git rev-parse HEAD)" \
//     node scripts/gitea-review.mjs already-reviewed
//
// `already-reviewed` is a plain GET, so it is the safe half to try by hand.
//
// Zero dependencies on purpose: the review job deliberately skips `npm ci`
// (it reads code, it does not run the suite), so this may use nothing beyond
// Node 22 built-ins and global fetch.
//
// Gitea has no commit-comment API, which is why the reviewer hangs off pull
// requests rather than pushes: `/pulls/{index}/reviews` is the only endpoint
// that puts prose next to a diff.
import { readFileSync } from 'node:fs';

// Marker appended to every posted body. It is what makes the job idempotent:
// the workflow's `edited` trigger fires on description edits too, so without
// a per-commit fingerprint, typo-fixing a PR body would post a second review
// of the same code. A marker in the body rather than the review's own
// `commit_id` field because this half controls the marker outright — nothing
// on the server decides what it means.
const marker = (sha) => `<!-- claude-review:${sha} -->`;

/** Reads an env var, or fails with a named error rather than a silent `undefined` in a URL. */
function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

/** `${server}/api/v1/repos/${owner}/${repo}/pulls/${index}/reviews`, from the env the workflow sets. */
function reviewsUrl() {
  const api = requireEnv('GITEA_API').replace(/\/+$/, '');
  const repo = requireEnv('GITEA_REPO');       // "owner/name", from github.repository
  const index = requireEnv('PR_INDEX');
  return `${api}/api/v1/repos/${repo}/pulls/${index}/reviews`;
}

function authHeaders() {
  // Gitea's PAT scheme is `token <pat>`, not `Bearer`.
  return { Authorization: `token ${requireEnv('GITEA_TOKEN')}` };
}

/** True when a review carrying this commit's marker is already on the PR. */
async function alreadyReviewed() {
  const sha = requireEnv('HEAD_SHA');
  const res = await fetch(`${reviewsUrl()}?limit=50`, { headers: authHeaders() });
  if (!res.ok) {
    throw new Error(`Listing reviews failed: ${res.status} ${res.statusText}\n${await res.text()}`);
  }
  const reviews = await res.json();
  return reviews.some((review) => typeof review.body === 'string' && review.body.includes(marker(sha)));
}

/**
 * Posts `body` as a COMMENT review — never APPROVE or REQUEST_CHANGES. This
 * reviewer is advisory: the user merges by hand in the Gitea UI (AGENTS.md
 * step 5), and an approval state from a bot would put a thumb on that scale.
 */
async function post(body) {
  const res = await fetch(reviewsUrl(), {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, event: 'COMMENT' }),
  });
  if (!res.ok) {
    throw new Error(`Posting review failed: ${res.status} ${res.statusText}\n${await res.text()}`);
  }
}

/**
 * Wraps the model's markdown for posting.
 *
 * A clean review still posts its one line. A bot that says nothing when it
 * finds nothing is indistinguishable from a bot that crashed, and the whole
 * point of the marker above is that this costs exactly one comment per commit.
 */
function composeBody(review, sha) {
  const findings = review.trim();
  // Refuse to stamp the marker onto nothing. `claude -p` can exit 0 having
  // written an empty final message, and because alreadyReviewed() keys off the
  // marker, posting that would pin a content-free review to this commit
  // permanently — no later event could replace it. Fail the step instead.
  if (!findings) throw new Error('Review file is empty — refusing to post a marker with no content');
  const header = findings === 'NO FINDINGS'
    ? '🤖 **Claude review** — no findings.'
    : `🤖 **Claude review** — advisory; \`ci.yml\` remains the gate.\n\n${findings}`;
  return `${header}\n\n${marker(sha)}\n`;
}

const [command, file] = process.argv.slice(2);

switch (command) {
  case 'already-reviewed':
    // stdout is consumed by the workflow's `$GITHUB_OUTPUT` step, so it is the
    // return channel; exit code stays 0 for both answers, leaving non-zero to
    // mean the API call itself failed.
    process.stdout.write(String(await alreadyReviewed()));
    break;

  case 'post': {
    if (!file) throw new Error('Usage: gitea-review.mjs post <review-file>');
    await post(composeBody(readFileSync(file, 'utf8'), requireEnv('HEAD_SHA')));
    break;
  }

  default:
    throw new Error(`Usage: gitea-review.mjs <already-reviewed|post <file>>, got ${command ?? 'nothing'}`);
}
