#!/usr/bin/env bash
# After an install-channel smoke, `chargebee` must be on PATH.
# Usage: install-smoke-assert.sh [expected-version-substring]
set -euo pipefail

BIN="${CHARGEBEE_CLI_SMOKE_BIN:-chargebee}"
# A release tag (v1.2.3) and the CLI's own version string (1.2.3) differ only by
# the leading v, so the comparison ignores it on both sides.
EXPECTED="${1:-}"
EXPECTED="${EXPECTED#v}"

if ! command -v "$BIN" >/dev/null 2>&1; then
  echo "::error::$BIN is not on PATH"
  exit 1
fi

CONFIG="${CHARGEBEE_CONFIG_DIR:-$(mktemp -d)}"
mkdir -p "$CONFIG"
export CHARGEBEE_CONFIG_DIR="$CONFIG"
printf '%s\n' '{"enabled":false,"notice_shown":true,"anonymous_id":""}' > "$CONFIG/telemetry.json"
export CHARGEBEE_SITE=""
export CHARGEBEE_API_KEY=""

ver_out="$("$BIN" --version)"
printf '%s\n' "$ver_out"
if [[ -z "$(printf '%s' "$ver_out" | tr -d '[:space:]')" ]]; then
  echo "::error::--version printed nothing"
  exit 1
fi
if [[ -n "$EXPECTED" ]] && ! printf '%s\n' "${ver_out#v}" | grep -F -q "$EXPECTED"; then
  echo "::error::--version did not contain ${EXPECTED}"
  exit 1
fi

help_out="$("$BIN" --help)"
printf '%s\n' "$help_out" | grep -q USAGE

cfg_out="$("$BIN" auth add --help)"
printf '%s\n' "$cfg_out" | grep -qi "API key"

set +e
"$BIN" foobarbaz >"$CONFIG/out.txt" 2>"$CONFIG/err.txt"
code=$?
set -e
test "$code" -eq 1
grep -q "unknown command" "$CONFIG/err.txt"
if grep -E 'Bun v|[.](ts|js):[0-9]+:[0-9]+' "$CONFIG/out.txt" "$CONFIG/err.txt"; then
  echo "::error::installed CLI printed a runtime stack"
  exit 1
fi
