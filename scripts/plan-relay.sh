#!/usr/bin/env bash
# Plan Relay — run the repository's pinned OpenCode executor against one
# approved, baseline-bound Codex plan. The ignored run directory retains the
# exact input and JSONL event stream for Codex's independent verification.
set -euo pipefail

usage() {
  echo "Usage: scripts/plan-relay.sh <plan.md>" >&2
  exit 2
}

if test "$#" -ne 1; then
  usage
fi

for command in git rg; do
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
if test "$($opencode_bin --version)" != "1.18.23"; then
  echo "Plan Relay: OpenCode 1.18.23 is required" >&2
  exit 2
fi
if test -z "${OPENROUTER_API_KEY:-}"; then
  echo "Plan Relay: OPENROUTER_API_KEY is not set" >&2
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
plan_copy="$run_dir/plan.md"
events="$run_dir/events.jsonl"
runtime="$run_dir/runtime"
mkdir -p "$runtime/config" "$runtime/data" "$runtime/cache" "$runtime/state"
cp -- "$plan_source" "$plan_copy"

echo "Plan Relay run: ${run_dir#"$repo_root"/}" >&2
executor_prompt="Implement the attached approved Plan Relay document against baseline $baseline.

AGENTS.md and the plan are binding. Make only the planned repository changes, run every permitted validation command named by the plan, and do not commit, push, publish, or edit the plan. If repository truth conflicts with the plan or a required action is not permitted, stop and report the blocker instead of redesigning the task. In the final response, list changed files, validation results, and any deviation from the plan."

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
"$opencode_bin" --pure run \
  --dir "$repo_root" \
  --agent executor \
  --model openrouter/z-ai/glm-5.3-flash \
  --variant max \
  --file "$plan_copy" \
  --format json \
  --title "Plan Relay: ${branch#*/}" \
  "$executor_prompt" | tee "$events"
status="${PIPESTATUS[0]}"
set -e

echo "Plan Relay events: ${events#"$repo_root"/}" >&2
exit "$status"
