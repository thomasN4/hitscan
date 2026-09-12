#!/usr/bin/env bash
# Plan Relay — run the repository's pinned OpenCode executor against one
# approved, baseline-bound plan. The ignored run directory retains the exact
# input and JSONL event stream for the planner's independent verification.
set -euo pipefail

usage() {
  echo "Usage: scripts/plan-relay.sh <plan.md>" >&2
  exit 2
}

if test "$#" -ne 1; then
  usage
fi

for command in git rg node timeout; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Plan Relay: required command not found: $command" >&2
    exit 2
  fi
done

opencode_bin="${OPENCODE_BIN:-opencode}"
if ! command -v "$opencode_bin" >/dev/null 2>&1; then
  echo "Plan Relay: OpenCode executable not found: $opencode_bin" >&2
  exit 2
fi
if test "$($opencode_bin --version)" != "1.18.28"; then
  echo "Plan Relay: OpenCode 1.18.28 is required" >&2
  exit 2
fi
if test -z "${OPENCODE_API_KEY:-}" && test -z "${OPENROUTER_API_KEY:-}"; then
  echo "Plan Relay: OPENCODE_API_KEY (or OPENROUTER_API_KEY as fallback) is not set" >&2
  exit 2
fi

# Watchdog ceiling for the whole executor session, in seconds, shared by the
# initial turn and its one possible recovery. Provider calls have
# been observed to hang for 15+ minutes before dying with a 502, and a healthy
# deep-reasoning session can legitimately take ~20 minutes; the default gives
# that more than 2x headroom.
timeout_secs="${OPENCODE_TIMEOUT:-2700}"
if ! [[ "$timeout_secs" =~ ^[0-9]+$ ]] || test "$timeout_secs" -eq 0; then
  echo "Plan Relay: OPENCODE_TIMEOUT must be a positive integer number of seconds" >&2
  exit 2
fi

# A wave is one planner fanning one baseline out to several executors, each in
# its own worktree. This stamp is the ONLY thing tying those runs together:
# there is no lock, no shared state and no registry, by design (AGENTS.md).
wave="${PLAN_RELAY_WAVE:-}"
if test -n "$wave" && ! [[ "$wave" =~ ^[A-Za-z0-9._-]{1,64}$ ]]; then
  echo "Plan Relay: PLAN_RELAY_WAVE must be 1-64 characters of [A-Za-z0-9._-]" >&2
  exit 2
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
executor_config="$script_dir/opencode-executor-config.json"
if ! test -r "$executor_config"; then
  echo "Plan Relay: executor config is missing: $executor_config" >&2
  exit 2
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Plan Relay: run this command inside a Git worktree" >&2
  exit 2
}
git_dir="$(git rev-parse --absolute-git-dir)"
common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
if test "$git_dir" = "$common_dir"; then
  echo "Plan Relay: the primary checkout is forbidden; use a linked worktree" >&2
  exit 2
fi

branch="$(git branch --show-current)"
if test -z "$branch" || test "$branch" = "main"; then
  echo "Plan Relay: a non-main feature branch is required" >&2
  exit 2
fi
if test -n "$(git status --porcelain --untracked-files=all)"; then
  echo "Plan Relay: worktree must be clean before execution" >&2
  exit 2
fi

# Parallel worktrees usually share one install via a node_modules symlink (see
# .gitignore), which also shares one node_modules/.vite cache. That is harmless
# for a solo run and a hazard for a wave, so warn only when a wave is declared.
# Never refuse: the planner owns that call.
node_modules_shared=false
if test -L "$repo_root/node_modules"; then
  node_modules_shared=true
  if test -n "$wave"; then
    echo "Plan Relay: node_modules is a symlink into another worktree; a fan-out wave needs its own install (AGENTS.md: Plan Relay fan-out)" >&2
  fi
fi

plan_source="$1"
if ! test -f "$plan_source" || ! test -r "$plan_source" || ! test -s "$plan_source"; then
  echo "Plan Relay: plan must be a readable, non-empty regular file: $plan_source" >&2
  exit 2
fi

frontmatter_end="$(awk 'NR > 1 && $0 == "---" { print NR; exit }' "$plan_source")"
if test "$(sed -n '1p' "$plan_source")" != "---" || test -z "$frontmatter_end"; then
  echo "Plan Relay: plan must begin with closed YAML frontmatter" >&2
  exit 2
fi
frontmatter="$(sed -n "2,$((frontmatter_end - 1))p" "$plan_source")"
if test "$(printf '%s\n' "$frontmatter" | rg --count '^plan_relay_version: ' || true)" != "1" ||
   test "$(printf '%s\n' "$frontmatter" | rg --count '^baseline_commit: ' || true)" != "1"; then
  echo "Plan Relay: plan requires exactly one version and baseline field" >&2
  exit 2
fi
plan_version="$(printf '%s\n' "$frontmatter" | sed -n 's/^plan_relay_version: //p')"
baseline="$(printf '%s\n' "$frontmatter" | sed -n 's/^baseline_commit: //p')"
if test "$plan_version" != "1"; then
  echo "Plan Relay: unsupported plan_relay_version: $plan_version" >&2
  exit 2
fi
if [[ ! "$baseline" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Plan Relay: baseline_commit must be a lowercase 40-character Git SHA" >&2
  exit 2
fi
head_sha="$(git rev-parse HEAD)"
if test "$baseline" != "$head_sha"; then
  echo "Plan Relay: baseline mismatch (plan $baseline, worktree $head_sha)" >&2
  exit 2
fi

for heading in "## Summary" "## Interfaces" "## Implementation" "## Test Plan" "## Assumptions"; do
  if ! rg --quiet --fixed-strings --line-regexp "$heading" "$plan_source"; then
    echo "Plan Relay: missing required heading: $heading" >&2
    exit 2
  fi
done

run_root="$repo_root/.plan-relay"
mkdir -p "$run_root"
run_dir="$(mktemp -d "$run_root/${baseline:0:12}.XXXXXX")"
# A solo run's wave is itself. Defaulting to anything shared-looking would make
# a log entry claim a fan-out that never happened.
test -n "$wave" || wave="$(basename "$run_dir")"
plan_copy="$run_dir/plan.md"
events="$run_dir/events.jsonl"
runtime="$run_dir/runtime"
mkdir -p "$runtime/config" "$runtime/data" "$runtime/cache" "$runtime/state"
cp -- "$plan_source" "$plan_copy"

echo "Plan Relay run: ${run_dir#"$repo_root"/}" >&2
allowed_commands="$(node "$script_dir/planRelayPrompt.mjs" "$executor_config")"
executor_prompt="Implement the attached approved Plan Relay document against baseline $baseline.

AGENTS.md and the plan are binding. Make only the planned repository changes, run every permitted validation command named by the plan, and do not commit, push, publish, or edit the plan. If repository truth conflicts with the plan or a required action is not permitted, stop and report the blocker instead of redesigning the task. In the final response, list changed files, validation results, and any deviation from the plan.

The bash tool is restricted. Allowed commands are: $allowed_commands. All unlisted shell commands are denied and return no output, so do not retry them. Use the read tool with offsets and limits for file contents. The generic grep tool is denied because a file path may broaden to its parent directory; use rg with an explicit, narrow file or directory path. Keep reconnaissance targeted to the plan's named interfaces, and begin with the smallest planned edit once those interfaces are confirmed."

relay_started_at=$SECONDS
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Executor models: OpenCode Zen is primary, OpenRouter's copy of the same Muse
# Spark contributor tier is the one-shot fallback. Without a Zen key the
# primary cannot authenticate, so start on the fallback instead of spending an
# invocation learning that.
primary_model="opencode/muse-spark-1.3-contributor-free"
fallback_model="openrouter/meta/muse-spark-1.3-contributor"
model_variant="xhigh"
active_model="$primary_model"
if test -z "${OPENCODE_API_KEY:-}"; then
  active_model="$fallback_model"
fi
model_used="$active_model"
attempt_seq=0

# Run one executor turn on the active model, retrying once on the other model
# when the attempt fails fast. The retry gets only the turn's remaining budget
# — never a fresh one — and a watchdog kill (124) is never retried at all:
# both rules keep a run inside the documented watchdog ceiling. Every attempt
# is retained beside the events file as evidence; the events file itself always
# holds the latest attempt's bytes — an abandoned append-mode attempt is cut
# back to the pre-attempt size first — so the gate and the summary below keep
# judging one stream.
# Usage: invoke_executor <events-file> <overwrite|append> <budget-secs> <opencode args...>
invoke_executor() {
  local events_file="$1"
  local append_mode="$2"
  local budget="$3"
  shift 3
  attempt_seq=$((attempt_seq + 1))
  local turn_start=$SECONDS
  local tried=""
  local status=2
  local candidate role attempt_file attempts=0
  # A scalar, not an array: "${empty_array[@]}" is an unbound-variable error
  # under `set -u` on bash older than 4.4, while an unquoted-but-set scalar
  # expands to zero words everywhere.
  local tee_flag=""
  if test "$append_mode" = "append"; then
    tee_flag="-a"
  fi
  for candidate in "$active_model" "$primary_model" "$fallback_model"; do
    case "$tried" in
      *"|$candidate|"*) continue ;;
    esac
    tried="$tried|$candidate|"
    case "$candidate" in
      "$primary_model")
        if test -z "${OPENCODE_API_KEY:-}"; then
          continue
        fi
        role="primary"
        ;;
      *)
        if test -z "${OPENROUTER_API_KEY:-}"; then
          continue
        fi
        role="fallback"
        ;;
    esac
    attempt_file="$run_dir/attempt${attempt_seq}-${role}.jsonl"
    attempts=$((attempts + 1))
    if test "$attempts" -gt 1; then
      echo "Plan Relay: retrying on $candidate with ${budget}s of watchdog budget left" >&2
    fi
    # In append mode the failed attempt below would linger in the events file
    # and the retry would concatenate after it, so remember the pre-attempt
    # size for the cut-back afterwards. Overwrite mode truncates by itself.
    local events_bytes=0
    if test "$append_mode" = "append"; then
      events_bytes=$(wc -c < "$events_file" 2>/dev/null || echo 0)
    fi
    set +e
    OPENCODE_CONFIG_CONTENT="$(< "$executor_config")" \
    XDG_CONFIG_HOME="$runtime/config" \
    XDG_DATA_HOME="$runtime/data" \
    XDG_CACHE_HOME="$runtime/cache" \
    XDG_STATE_HOME="$runtime/state" \
    OPENCODE_CONFIG_DIR="$runtime/config" \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    NO_COLOR=1 \
    CI=true \
    timeout --kill-after=30s "$budget" "$opencode_bin" --pure run \
      --model "$candidate" \
      --variant "$model_variant" \
      "$@" | tee $tee_flag "$events_file" "$attempt_file"
    status="${PIPESTATUS[0]}"
    # No `set -e` here: the caller invokes this function under `set +e` and
    # that mode must survive the return, because a nonzero status below is a
    # retry-or-propagate value rather than a script failure.
    active_model="$candidate"
    model_used="$candidate"
    if test "$status" -eq 0; then
      return 0
    fi
    if test "$status" -eq 124; then
      echo "Plan Relay: executor hung and was killed by the watchdog on $candidate; not retrying" >&2
      return "$status"
    fi
    if test "$append_mode" = "append"; then
      # Cut the abandoned attempt back out so the retry appends onto the
      # pre-attempt stream. The attempt file beside the events file keeps the
      # removed bytes as evidence.
      head -c "$events_bytes" "$events_file" > "$events_file.trunc" && mv -- "$events_file.trunc" "$events_file"
    fi
    echo "Plan Relay: executor failed on $candidate (exit $status)" >&2
    budget=$((budget - (SECONDS - turn_start)))
    if test "$budget" -le 0; then
      echo "Plan Relay: no watchdog budget remains for a retry" >&2
      return "$status"
    fi
  done
  return "$status"
}

set +e
invoke_executor "$events" overwrite "$timeout_secs" \
  --dir "$repo_root" \
  --agent executor \
  --file "$plan_copy" \
  --format json \
  --title "Plan Relay: ${branch#*/}" \
  "$executor_prompt"
status="$?"
turns_launched=1
# The summary splits the concatenated stream at this line. wc -l under-counts by
# one when the final line lacks a newline, which happens only on a kill — and a
# killed turn never gets a turn 2, so the boundary is not consulted then.
turn1_lines="$(wc -l < "$events" 2>/dev/null || echo 0)"
recovery="not-applicable"

# A length-truncated turn with no completed edit is the one observed failure
# that a procedural nudge can safely recover. Continue the same isolated
# session once — the approved plan and its inspection history are already in
# context — and force the transition from reconnaissance to implementation.
recovery_session=""
if test "$status" -eq 0; then
  recovery_session="$(node "$script_dir/planRelayGate.mjs" --recovery-session "$events")"
fi
if test -n "$recovery_session"; then
  recovery_timeout=$((timeout_secs - (SECONDS - relay_started_at)))
  if test "$recovery_timeout" -gt 0; then
    echo "Plan Relay: continuing no-edit length-truncated session once with ${recovery_timeout}s remaining: $recovery_session" >&2
    recovery_prompt="Your previous turn ended before implementation. Repository inspection is complete. Do not reread files already inspected. Begin with the smallest edit required by the attached approved plan now, then continue its implementation and validation. The same plan remains binding. If blocked, report the blocker."
    invoke_executor "$events" append "$recovery_timeout" \
      --dir "$repo_root" \
      --agent executor \
      --session "$recovery_session" \
      --format json \
      "$recovery_prompt"
    status="$?"
    turns_launched=2
    recovery="taken"
  else
    echo "Plan Relay: no watchdog budget remains for recovery" >&2
    recovery="declined-no-budget"
  fi
fi
set -e

echo "Plan Relay events: ${events#"$repo_root"/}" >&2
# A nonzero status (executor failure or watchdog kill, exit 124) propagates
# as-is. A zero exit still has to prove the combined session did something:
# opencode exits 0 after a length-truncated final turn, so the gate judges the
# retained stream instead.
gate_verdict="skipped"
if test "$status" -eq 0; then
  if node "$script_dir/planRelayGate.mjs" "$events"; then
    gate_verdict="pass"
  else
    gate_verdict="fail"
    echo "Plan Relay: executor session failed the liveness gate" >&2
    status=1
  fi
fi

# Every run attempts a machine record, the failures most of all: a watchdog kill
# or a gate rejection is the run whose cost, last tool call and denied commands
# the planner actually needs. Every path that created a run directory funnels
# here, and every early exit 2 happens before one exists.
#
# `set -e` is back on, so the summary's own failure must not become the run's
# exit status — that is lesson 22 (a wrapper eating a gate's result), and the
# `if` is what prevents it.
summary_script="${PLAN_RELAY_SUMMARY:-$script_dir/planRelaySummary.mjs}"
summary="$run_dir/summary.json"
if node "$summary_script" "$events" "$summary" \
  --plan_document_version="$plan_version" \
  --run="$(basename "$run_dir")" \
  --wave="$wave" \
  --worktree="$repo_root" \
  --branch="$branch" \
  --baseline="$baseline" \
  --model_used="$model_used" \
  --node_modules_shared="$node_modules_shared" \
  --started_at="$started_at" \
  --ended_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --duration_s="$((SECONDS - relay_started_at))" \
  --watchdog_s="$timeout_secs" \
  --turns_launched="$turns_launched" \
  --turn1_lines="$turn1_lines" \
  --recovery="$recovery" \
  --recovery_session="$recovery_session" \
  --exit_status="$status" \
  --gate="$gate_verdict"; then
  echo "Plan Relay summary: ${summary#"$repo_root"/}" >&2
else
  echo "Plan Relay: summary could not be written; run status unchanged ($status)" >&2
fi
exit "$status"
