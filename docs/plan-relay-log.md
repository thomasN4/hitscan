# Plan Relay log

Committed record of Plan Relay waves. The machine half of a run — cost, tokens,
per-turn timing, files touched, denied tool calls, gate verdict — is written
automatically to `.plan-relay/<run>/summary.json`, which is ignored and local.
This file is the half a machine cannot write: which runs belonged to one wave,
what deviated from the plan, what the planner had to fix afterwards, and whether
the relay was worth using for that work.

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
