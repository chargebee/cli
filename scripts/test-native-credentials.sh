#!/usr/bin/env bash
set -euo pipefail

case "${CREDENTIAL_TEST_SUITE:-test:os}" in
  test:os|test:live) ;;
  *) echo 'Unsupported credential test suite' >&2; exit 1 ;;
esac

export CHARGEBEE_TEST_OS_KEYCHAIN=1
case "${RUNNER_OS:-$(uname -s)}" in
  Linux)
    if [[ "${CB_SECRET_SESSION:-}" != 1 ]]; then
      exec dbus-run-session -- env CB_SECRET_SESSION=1 bash "$0"
    fi
    KEYRING_HOME="$(mktemp -d)"
    trap 'rm -rf "$KEYRING_HOME"' EXIT
    export XDG_DATA_HOME="$KEYRING_HOME/data"
    export XDG_RUNTIME_DIR="$KEYRING_HOME/runtime"
    mkdir -p "$XDG_DATA_HOME" "$XDG_RUNTIME_DIR"
    chmod 700 "$XDG_RUNTIME_DIR"
    # Disposable runner-only keyring; no account credentials in this password.
    printf '%s' 'chargebee-ci-disposable' | gnome-keyring-daemon --unlock --components=secrets >/dev/null
    ;;
  macOS|Darwin)
    KEYCHAIN_DIR="$(mktemp -d)"
    KEYCHAIN="$KEYCHAIN_DIR/chargebee-ci.keychain-db"
    ORIGINAL_DEFAULT="$(security default-keychain -d user | sed 's/^[[:space:]]*"//;s/"$//')"
    ORIGINAL_SEARCH=()
    while IFS= read -r path; do ORIGINAL_SEARCH+=("$path"); done < <(security list-keychains -d user | sed 's/^[[:space:]]*"//;s/"$//')
    cleanup() {
      security default-keychain -d user -s "$ORIGINAL_DEFAULT"
      security list-keychains -d user -s "${ORIGINAL_SEARCH[@]}"
      security delete-keychain "$KEYCHAIN"
      rm -rf "$KEYCHAIN_DIR"
    }
    security create-keychain -p 'chargebee-ci-disposable' "$KEYCHAIN"
    trap cleanup EXIT
    security unlock-keychain -p 'chargebee-ci-disposable' "$KEYCHAIN"
    security set-keychain-settings -lut 3600 "$KEYCHAIN"
    security list-keychains -d user -s "$KEYCHAIN" "${ORIGINAL_SEARCH[@]}"
    security default-keychain -d user -s "$KEYCHAIN"
    ;;
  Windows|MINGW*|MSYS*) ;;
  *) echo 'Unsupported credential test OS' >&2; exit 1 ;;
esac

bun run test:os
if [[ "${CREDENTIAL_TEST_SUITE:-test:os}" == test:live ]]; then
  bun run test:live
fi
