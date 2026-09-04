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
