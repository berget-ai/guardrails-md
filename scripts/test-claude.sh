#!/bin/sh
# `claude plugin test` runs every *.test.ts under the plugin folder, vitest's
# included, so the mod and its tests are copied to a folder of their own.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
mkdir "$dir/.claude-plugin" "$dir/hooks"
cp "$root/.claude-plugin/plugin.json" "$dir/.claude-plugin/"
cp "$root/hooks/hooks.json" "$root/hooks/register.ts" "$dir/hooks/"
cp "$root"/test/claude/*.test.ts "$dir/hooks/"
claude plugin test "$dir"
