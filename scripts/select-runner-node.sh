#!/usr/bin/env bash
# Select the runner's pre-provisioned Node 22 without downloading an action or
# toolchain. Writes through GITHUB_PATH so subsequent workflow steps inherit it.
set -euo pipefail

node_dir=""
if command -v node >/dev/null &&
  test "$(node -p 'process.versions.node.split(".")[0]')" = 22; then
  node_dir="$(dirname "$(command -v node)")"
else
  case "${RUNNER_ARCH:-}" in
    X64) tool_arch=x64 ;;
    ARM64) tool_arch=arm64 ;;
    *) tool_arch="" ;;
  esac

  if test -n "$tool_arch" && test -d "${RUNNER_TOOL_CACHE:-}/node"; then
    node_dir="$(find "$RUNNER_TOOL_CACHE/node" -mindepth 3 -maxdepth 3 \
      -type d -path "*/22.*/$tool_arch/bin" -print | sort -V | tail -n 1)"
  fi
fi

if ! test -x "${node_dir:-}/node"; then
  echo "::error::Node 22 is not installed in the runner image or tool cache"
  exit 1
fi

echo "$node_dir" >> "$GITHUB_PATH"
"$node_dir/node" --version
