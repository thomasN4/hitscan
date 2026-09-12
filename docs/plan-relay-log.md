# Plan Relay log

Committed record of Plan Relay waves. The machine half of a run — cost, tokens,
per-turn timing, files touched, denied tool calls, gate verdict — is written
automatically to `.plan-relay/<run>/summary.json`, which is ignored and local;
if that write fails, the runner reports it and retains `events.jsonl` without
replacing the executor's exit status. This file is the half a machine cannot
write: which runs belonged to one wave, what deviated from the plan, what the
planner had to fix afterwards, and whether the relay was worth using for that
work.

Rules:

- **One entry per wave, appended at the end, never reordered.** A wave is one
  planner fanning one baseline out to N executors; a single executor is a wave
  of one, and its wave id is its run directory's name.
- **An entry must stand on its own.** It cites a run directory by name, but that
  directory is local, ignored and routinely pruned — every number the entry
  relies on has to be copied into the entry, not left behind a path.
- **Both versions, always.** `Relay vN` is the tooling
  (`scripts/planRelayVersion.mjs`, pinned by a source digest); `plan schema vN`
  is the plan document's `plan_relay_version`. They move independently, and a
  reader needs both to know what the numbers mean.
- **Version history is append-only and gapless.** Every relay version has a row,
  whether or not a wave ever ran on it.

`scripts/planRelayLog.test.mjs` enforces the structural half of these rules in
`npm test`; the judgment is yours.

## Version history

| Relay | Date | Change |
|---|---|---|
| v1 | 2026-08-30 | First digest-pinned version. Adds `summary.json` per run, the `PLAN_RELAY_WAVE` stamp, the fan-out protocol in AGENTS.md, and this log. The relay existed unversioned before this. |
| v2 | 2026-08-30 | Count a newly written file's lines. Only `edit` carries a `filediff`; a `write` reports content and `exists: false`, so v1 recorded every created file as +0/-0. A write over an existing file stays unattributed, since its deletions are not in the stream. |
| v3 | 2026-08-30 | Emit runner timestamps in UTC even under a non-UTC `TZ`, and count a newly written file containing one blank line as one addition. Clarify that every run attempts a summary, while summary failure preserves the executor status and retained event stream. |
| v4 | 2026-09-04 | Switch the pinned executor to Muse Spark 1.3 Contributor at `xhigh` reasoning and stamp that model/variant into every run summary. |
| v5 | 2026-09-04 | Accept OpenCode 1.18.28. The pin is an exact match on purpose — a relay run has to be attributable to one client build — but the client auto-updates itself, so the pinned build stopped being the installed one between two waves on the same day. Moving the number is the maintenance that design implies; widening it to a range would trade the attribution for never doing this again. Note that the version is written in THREE places that nothing checks against each other: the gate in `plan-relay.sh`, the stamp in `planRelaySummary.mjs`, and the fake binary in `planRelay.test.mjs`. Bumping only the first two shipped one run (`04f5bf3c3ebe.WZoGb4`) whose `summary.json` claims 1.18.25 for an executor the gate had just verified as 1.18.28 — read that run's version from this row, not from its file. |
| v6 | 2026-09-11 | Switch the pinned executor from OpenRouter `meta/muse-spark-1.3-contributor` to OpenCode Zen `muse-spark-1.3-contributor-free` at the same `xhigh` reasoning effort, and stamp that model into every run summary. The runner accepts `OPENCODE_API_KEY` with `OPENROUTER_API_KEY` as fallback during the transition. The CI reviewer (`opencode-review-config.json`, `review.yml`) moves to the same Zen model at `high` in the same change, but it is not a relay source so it versions nothing. |
| v7 | 2026-09-12 | Retry the executor once on OpenRouter `meta/muse-spark-1.3-contributor` when the Zen primary fails fast, at the same `xhigh` reasoning effort, and stamp whichever model actually ran into every run summary. Without a Zen key the runner starts on the fallback directly; a watchdog kill is never retried because the budget it consumed is gone. Every attempt is retained beside `events.jsonl` as evidence. The CI reviewer (`opencode-review-config.json`, `review.yml`) gets the same one-shot fallback at `high` in the same change, but it is not a relay source so it versions nothing on its own. Annotated after review: "fails fast" was wrong — any non-watchdog failure retried with a whole fresh budget, so a slow 502 death could double the watchdog ceiling while the summary stamped a single budget; and a failed append-mode recovery attempt lingered in `events.jsonl`. v8 fixes both. |
| v8 | 2026-09-12 | Review-driven corrections to the v7 fallback. The executor retry gets only the turn's remaining watchdog budget, never a fresh one; a failed append-mode recovery attempt is cut back out of `events.jsonl` (its bytes stay in its attempt file) so the gate keeps judging one stream. The reviewer now distinguishes a skipped primary (notice, fallback runs directly), a failed primary (warning, fallback retries) and no key at all (error naming both secrets) instead of reporting exit 2 for all three. Annotated after review: that last branch was still wrong — a failed primary with no fallback key configured fell into it and reported "No review API key is set" about a key that was set. v9 fixes it. |
| v9 | 2026-09-12 | Per-turn model attribution and a record of what the retry threw away. `--turn_models` stamps each launched turn with the model whose bytes it retained, so a run whose recovery turn changed provider is no longer credited wholly to whichever model finished it; top-level `model` still names that finishing model. `discarded_attempts` names every attempt cut out of the judged stream (file, model, exit status) — its cost stays out of `totals` by design, because merging two attempts would describe no single session, but it is no longer silently absent. Also in this change, outside the relay sources: the reviewer stops reporting a failed primary with no fallback key as a missing key, treats a zero exit that wrote no review as a failure worth retrying, and gets a behavioural test that runs the step's own bytes across the key/failure matrix instead of grepping the YAML for its messages. Annotated after review: the retry it left in place could still be handed a worktree the failed attempt had edited, and the cut-back fired even when no retry followed. v10 fixes both. |
| v10 | 2026-09-12 | An attempt that changed the worktree is never retried. Its edits outlive it on disk, so the retry would have started from a state the approved plan never described, while the record that the retry cut out of `events.jsonl` no longer matched the files the final diff showed — a run could pass the gate over a summary contradicting `git status`. Such a run now stops and keeps both its edits and its events for the planner. The runner fingerprints the worktree around every attempt (`git diff HEAD` plus hashes of what `ls-files --others` reports, over the clean start the runner already requires) to decide that. In the same change, an attempt leaves `events.jsonl` only when a retry is actually about to replace it: the append-mode cut-back previously fired on every failure, so a single-key run that failed lost its events from the judged stream for no reason. Two comment corrections ride along: the retry was never conditioned on failing "fast", which the function comment had claimed since v7 and the v7 row had already contradicted, and AGENTS.md's account of `summary.json` and `events.jsonl` now names `discarded_attempts` and the `attempt*.jsonl` files that hold a retried run's missing spend. |

## Waves

<!--
Append entries below, oldest first. The shape the gate expects:

### YYYY-MM-DD — wave `<id>` — N executors

Relay vN, plan schema vN. Baseline `<short sha>`. Wall clock <T> against <T> of
summed executor time.

| # | Branch | Run | Turns | Duration | Cost | Files | Outcome |
|---|---|---|---|---|---|---|---|
| 1 | `feat/x` | `<run dir>` | 1 | 22m 10s | $0.31 | 4 (+180/-12) | pass |

Verdict: what merged, what deviated, what you fixed by hand, what to change in
the next wave's plans.
-->

### 2026-08-30 — wave `smoke-1` — 1 executor

Relay v1, plan schema v1. Baseline `f24c8699a869`. A wave of one, run to
validate the relay's own new instrumentation end to end; wall clock 3m 38s.

| # | Branch | Run | Turns | Duration | Cost | Files | Outcome |
|---|---|---|---|---|---|---|---|
| 1 | `feat/relay-smoke` | `f24c8699a869.oF3akb` | 1 | 3m 38s | $0.0082 | 2 (+58/-0) | pass |

Verdict: merged nothing — this branch is scratch — but the run earned its cost
twice. The executor followed the plan exactly (two new files, no existing file
touched, 14 steps, 17 tool calls), and `npm test`, `npm run lint` and
`npm run typecheck` all passed on an independent rerun.

Two findings. First, the run exposed a bug in v1's own accounting: it recorded
both created files as `+0/-0`, because only `edit` carries a `filediff` and a
whole-file `write` does not. v2 fixes that, and the `+58` above is the run
re-summarized under v2 — the one number in this table that its own
`summary.json` does not contain. Second, both denied calls were `bash`
commands chaining with `;` (`ls -ld node_modules && env | rg ...`); the
allowlist takes one command per call, and a plan that invites a chain wastes a
step. Next wave: say so in the Test Plan, as this plan already did for pipes.

### 2026-09-04 — wave `37e8eb6a8e4d.0sGfqJ` — 1 executor

Relay v4, plan schema v1. Baseline `37e8eb6a8e4d`. A wave of one; wall clock
1s against 0s of executor event time.

| # | Branch | Run | Turns | Duration | Cost | Files | Outcome |
|---|---|---|---|---|---|---|---|
| 1 | `feat/hearing-followup` | `37e8eb6a8e4d.0sGfqJ` | 1 | 0s | n/a | 0 (+0/-0) | fail — provider guardrail |

Verdict: merged nothing and changed no files. OpenRouter rejected Muse before
its first step because the account's paid-model-training privacy setting
excluded the only endpoint. The relay preserved the failure with exit 1 and a
skipped liveness gate; there were 0 tool calls, 0 denied calls and no reported
token or cost usage. The user enabled the required setting before the retry.
This attempt was not useful as implementation, but it did verify that the
provider privacy guardrail fails closed and remains visible in the run record.

### 2026-09-04 — wave `37e8eb6a8e4d.X8IV7S` — 1 executor

Relay v4, plan schema v1. Baseline `37e8eb6a8e4d`. A wave of one; wall clock
11m 15s against 11m 12s of executor event time.

| # | Branch | Run | Turns | Duration | Cost | Files | Outcome |
|---|---|---|---|---|---|---|---|
| 1 | `feat/hearing-followup` | `37e8eb6a8e4d.X8IV7S` | 1 | 11m 12s | $0.0427 | 3 (+184/-58) | pass |

Verdict: Muse Spark 1.3 Contributor at `xhigh` implemented the approved 6b
follow-up in the three owned files, with 37 steps, 41 tool calls, 13 edits and
0 denied calls. It reported 3,418,723 total tokens, including 3,092,580 cache
reads, and independently passed 682 tests, lint, typecheck and build. Its first
test rewrite accidentally made the intended 3D and newest-on-tie expectations
contradict their fixtures; the targeted test run caught both, and the executor
corrected them without planner intervention. One reconnaissance call chained
three read-only Git commands with `&&` despite the plan's separate-command
instruction. The planner then corrected two stale priority comments, clarified
the implementation status and historical rationale in the plan, and made the
selector's first-candidate branch readable; behavior did not change. The
planner independently reran all 682 tests, lint, typecheck and build, then
passed the full browser smoke suite on an isolated server with no console or
page errors. The relay was worth using: the implementation stayed inside its
file boundary, exercised its own test-first correction loop and reached a
passing liveness gate.

### 2026-09-04 — wave `3a9f79281cab.RgqTjB` — 1 executor

Relay v4, plan schema v1. Baseline `3a9f79281cab`. A wave of one for review
round two; wall clock 1m 56s against 1m 54s of executor event time.

| # | Branch | Run | Turns | Duration | Cost | Files | Outcome |
|---|---|---|---|---|---|---|---|
| 1 | `feat/hearing-followup` | `3a9f79281cab.RgqTjB` | 1 | 1m 54s | $0.0000 | 1 (+11/-5) | pass |

Verdict: Muse Spark 1.3 Contributor at `xhigh` resolved both stale-policy
findings from review round one without changing behavior or leaving its single
owned file. The run used 16 steps, 17 tool calls and 2 edits with 0 denied calls;
it reported 397,358 total tokens, including 313,759 cache reads. The executor
passed 682 tests, lint, typecheck, build and diff hygiene, and the planner
independently reran the same gates successfully. As in the preceding run, the
initial read-only baseline check chained Git commands with `&&` despite the
plan's separate-command instruction; it did not obscure a failure, but the
repetition shows that prose alone is not reliably enforcing this convention.
The relay was still worth using: it produced a minimal correction for both
review findings and passed its liveness gate in under two minutes.

### 2026-09-04 — wave `04f5bf3c3ebe.WZoGb4` — 1 executor

Relay v5, plan schema v1. Baseline `04f5bf3c3ebe`. A wave of one for tranche 7b
part A (a bot may hold the knife); wall clock 25m 09s against 25m 04s of
executor event time.

| # | Branch | Run | Turns | Duration | Cost | Files | Outcome |
|---|---|---|---|---|---|---|---|
| 1 | `feat/bot-loadouts` | `04f5bf3c3ebe.WZoGb4` | 1 | 25m 04s | $0.1198 | 12 (+576/-147) | pass |

Verdict: merged as `f3e2622`. Muse Spark 1.3 Contributor at `xhigh` implemented
the whole of part A inside its twelve owned files and touched nothing else, in
124 steps, 141 tool calls and 69 edits, reporting 18,139,722 total tokens
including 17,365,451 cache reads. It passed 692 tests, lint, typecheck and
build, and the planner reran all four independently. Note the run's own
`summary.json` records `opencode: 1.18.25` — that field was a third, unbumped
copy of the version pin and is wrong; the executor ran under 1.18.28, as the v5
row above now explains.

Splitting the tranche at the type boundary was the decision that made this run
tractable. Widening `BotWeaponId` breaks every `Record` over it at once, so part
A had to land the blade whole; the loadout and the dry swap are a second plan
against this commit as their baseline, and neither half ever left the tree
uncompilable.

Three planner corrections afterwards, none behavioural: the melee controller
silenced its unused parameters with `void x;` where omitting them is what the
repository's own stub does (and the test helper's return type then had to be
the interface rather than the class, which is the surface those tests should
hold anyway); `makeFireController` shipped undocumented; and the backstab
branch was written twice, once per victim kind, where one pair of ternaries
says the same thing and puts the two facing conventions side by side. The
planner also wrote the `[botKnife]` browser phase, which the plan had reserved
rather than delegated — the executor cannot run a browser, so a phase it wrote
blind would be the planner's to debug anyway.

One denied call, and the same one as the last three waves: a reconnaissance
`rg … | head -n 120`. The allowlist takes one command per call, and the plan
said so in its Test Plan in bold. Prose is now demonstrably not fixing this;
the next relay change worth making is an allowlist entry for a bounded `rg`
rather than another sentence.

The relay was worth using: 25 minutes and twelve cents for a twelve-file
type-widening that compiled, passed its own new pins, and needed only comment-
level correction.

### 2026-09-04 — wave `d78f09828e52.2lSRdF` — 1 executor

Relay v5, plan schema v1. Baseline `d78f09828e52`. A wave of one for tranche 7b
part B (the loadout and the dry swap); wall clock 45m 01s — the watchdog
ceiling — against 42m 35s of executor event time.

| # | Branch | Run | Turns | Duration | Cost | Files | Outcome |
|---|---|---|---|---|---|---|---|
| 1 | `feat/bot-loadouts` | `d78f09828e52.2lSRdF` | 1 | 42m 35s | $0.7140 | 10 (+428/-71) | fail — watchdog timeout at 2700 s |

Verdict: **killed, and kept.** `OPENCODE_TIMEOUT` fired at 45 minutes with exit
124 and a skipped liveness gate, after 82 steps, 95 tool calls, 51 edits and 0
denied calls, reporting 13,229,548 total tokens for $0.71 — six times part A's
cost for a comparable diff. The planner finished the work by hand rather than
re-running: the expensive half was already on disk, and a second run would have
spent another 45 minutes re-deriving it.

What the kill left behind is the useful record here. Ten of the plan's twelve
files were complete and correct — `BotLoadout`, the one-draw `arm()`, the dry
swap, the brain's params resync, the silhouette rebuild, `tsec`/`ctsec` through
the parser, menu, facade and smoke config phase. What was missing or damaged:

- **`src/bots.ts` was left syntactically invalid.** The class's closing brace
  landed above `rebuildAimGroup()`, orphaning the method and re-indenting
  `spawnBots` as though it were a member. An edit interrupted between its two
  halves is the failure mode a watchdog produces, and it is not visible in the
  file list — only `npm run typecheck` names it.
- **A JSDoc line and a header comment were truncated mid-sentence**, one of them
  ending on an unclosed parenthesis.
- **Neither test file was reached.** `botWeapons.test.ts` and
  `sessionConfig.test.ts` got zero edits, so the tranche's new pins — the
  one-draw contract, the swap conditions, `makeBotLoadout`'s cases, the
  `tsec`/`ctsec` matrix — did not exist, while three EXISTING sessionConfig
  tests failed against the widened config. A run that dies before its tests is
  strictly worse than one that dies before its implementation: the code looks
  finished and nothing pins it.

The planner wrote all of that (25 new pins, 717 tests total), repaired the four
damaged sites, and reverted one unrelated comment rewrite the executor had made
outside the plan.

Two lessons for the next wave. **The timeout is the plan's problem, not the
runner's**: part A took 25 minutes for twelve files, so a twelve-file part B at
the same rate had no headroom, and the plan should either have been split again
or launched with a raised `OPENCODE_TIMEOUT`. **Order the Implementation section
so tests come before the last of the wiring** — the plan listed them last, which
is exactly the order that loses them to a kill.
