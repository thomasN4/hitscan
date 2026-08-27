#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "Usage: prepare-opencode-review.sh <base-sha> <head-sha> <empty-output-directory>" >&2
  exit 2
fi

base_sha="$1"
head_sha="$2"
review_root="$3"

if [ ! -d "$review_root" ] || [ -n "$(find "$review_root" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
  echo "Review output directory must exist and be empty: $review_root" >&2
  exit 2
fi

merge_base="$(git merge-base "$base_sha" "$head_sha")"
mkdir "$review_root/base" "$review_root/head"
git archive "$merge_base" | tar -x -C "$review_root/base"
git archive "$head_sha" | tar -x -C "$review_root/head"
git diff --binary --no-ext-diff "$merge_base" "$head_sha" > "$review_root/changes.diff"

# OpenCode loads this root file as its trusted repository instructions. The
# copies nested under base/ and head/ remain review data, not active rules.
git show "$base_sha:AGENTS.md" > "$review_root/AGENTS.md"

printf '%s\n' "$merge_base"
