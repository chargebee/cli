#!/usr/bin/env bash
set -euo pipefail

REPO="chargebee/cli"
BIN_NAME="chargebee"

# Home directory to use for config/marker/skill writes. Under `sudo`, $HOME is
# root's home, so prefer the invoking user's home instead of writing there.
target_home() {
  if [[ "$(id -u)" -eq 0 && -n "${SUDO_USER:-}" ]]; then
    local h
    h=$(eval echo "~${SUDO_USER}" 2>/dev/null) || true
    if [[ -n "$h" && "$h" != "~${SUDO_USER}" ]]; then
      printf '%s' "$h"
      return
    fi
  fi
  printf '%s' "$HOME"
}

# True when this script runs as root on behalf of another user (`sudo`).
running_under_sudo() {
  [[ "$(id -u)" -eq 0 && -n "${SUDO_USER:-}" ]]
}

# Under `sudo`, anything this script creates inside the invoking user's home
# would be root-owned, so that user's own `chargebee` could not read or write
# its config dir afterwards. Hand those paths back to the invoking user.
own_as_target_user() {
  running_under_sudo || return 0
  chown -R "$SUDO_USER" "$@" 2>/dev/null || true
}

# Run a command as the invoking user under `sudo` (with that user's HOME), so
# skill files and shell-rc edits land in their home with their ownership.
run_as_target_user() {
  if running_under_sudo && command -v sudo >/dev/null 2>&1; then
    sudo -u "$SUDO_USER" -H -- "$@"
  else
    "$@"
  fi
}

# Prints the API asset URL (works for a private repo) whose "name" field is
# $2, from the release-by-tag JSON body $1. Empty if not found. The API serves
# the body as one compact line, so strip whitespace and split it into one line
# per JSON object; each asset's "url" and "name" then share a line.
find_asset_api_url() {
  local body="$1" name="$2"
  printf '%s' "$body" | tr -d ' \t\r\n' | tr '{' '\n' \
    | grep -F "\"name\":\"${name}\"" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p' | head -1 || true
}

# Verify $1 (the downloaded asset, named $2) against the SHA256SUMS.txt at
# URL $3. CHARGEBEE_CLI_SKIP_CHECKSUM=1 bypasses this with a warning;
# anything else missing or mismatched aborts the install. Uses $OS, set by
# main() before this is ever called.
verify_checksum() {
  local asset_path="$1" asset_name="$2" sums_url="$3"

  if [[ "${CHARGEBEE_CLI_SKIP_CHECKSUM:-}" == "1" ]]; then
    echo "Warning: skipping checksum verification (CHARGEBEE_CLI_SKIP_CHECKSUM=1)"
    return 0
  fi

  local sums_file verify_dir
  sums_file=$(mktemp)
  verify_dir=$(mktemp -d)

  if ! curl -fsSL -L --connect-timeout 15 --max-time 60 "${GH_AUTH_ARGS[@]+"${GH_AUTH_ARGS[@]}"}" -H "Accept: application/octet-stream" -o "$sums_file" "$sums_url"; then
    rm -f "$sums_file"
    rm -rf "$verify_dir"
    echo "Error: could not download SHA256SUMS.txt"
    echo "  Set CHARGEBEE_CLI_SKIP_CHECKSUM=1 to skip verification (not recommended)"
    exit 1
  fi

  cp "$asset_path" "$verify_dir/$asset_name"
  cp "$sums_file" "$verify_dir/SHA256SUMS.txt"

  local checker
  if [[ "$OS" == "darwin" ]]; then
    checker=(shasum -a 256 -c --ignore-missing SHA256SUMS.txt)
  else
    checker=(sha256sum -c --ignore-missing SHA256SUMS.txt)
  fi

  local ok=0
  (cd "$verify_dir" && "${checker[@]}" >/dev/null 2>&1) || ok=1
  rm -f "$sums_file"
  rm -rf "$verify_dir"

  if [[ "$ok" -ne 0 ]]; then
    echo "Error: checksum verification failed for $asset_name"
    echo "  Set CHARGEBEE_CLI_SKIP_CHECKSUM=1 to skip verification (not recommended)"
    exit 1
  fi
}

onboarding_env_on() {
  local v="${1:-}"
  v=$(printf '%s' "$v" | tr '[:upper:]' '[:lower:]')
  [[ -n "$v" && "$v" != "0" && "$v" != "false" && "$v" != "no" ]]
}

onboarding_can_prompt() {
  if onboarding_env_on "${CI:-}"; then return 1; fi
  if onboarding_env_on "${CHARGEBEE_CLI_NO_ONBOARDING:-}"; then return 1; fi
  [[ "${TERM:-}" != "dumb" ]] || return 1
  [[ -e /dev/tty ]] || return 1
  return 0
}

# Read y/n from the keyboard, not from curl|bash stdin. Empty = yes.
onboarding_prompt_yn() {
  local question="$1"
  local reply=""
  printf '%s [Y/n] ' "$question" > /dev/tty || return 1
  IFS= read -r reply < /dev/tty || return 1
  reply=$(printf '%s' "$reply" | tr '[:upper:]' '[:lower:]')
  [[ -z "$reply" || "$reply" == "y" || "$reply" == "yes" ]]
}

print_onboarding_hints() {
  echo ""
  echo "  Using an AI agent? Install the Chargebee CLI skill:"
  echo "    chargebee skills add"
  echo "  Prefer a shorter command?"
  echo "    chargebee alias set"
}

# Everything below runs only once the whole script (through the final
# `main "$@"` call) has been read: a `curl | bash` stream truncated partway
# through leaves this function undefined and unrun instead of executing a
# prefix of it.
main() {
  local FORCE_ALIAS=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --force) FORCE_ALIAS=(--force) ;;
      -h|--help)
        echo "Usage: install.sh [--force]"
        echo "  --force  Replace an existing alias if you choose to add the cb shortcut."
        return 0
        ;;
      *) echo "Error: unknown installer option: $1" >&2; return 1 ;;
    esac
    shift
  done

  # A token lets this script resolve a private repo's release assets through
  # the API (the plain releases/download/ URL only works for a public repo).
  local TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  GH_AUTH_ARGS=()
  [[ -n "$TOKEN" ]] && GH_AUTH_ARGS=(-H "Authorization: Bearer ${TOKEN}")

  # Detect OS
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  if [[ "$OS" != "darwin" && "$OS" != "linux" ]]; then
    echo "Unsupported OS: $OS (Windows: irm https://raw.githubusercontent.com/$REPO/main/install.ps1 | iex)"
    exit 1
  fi

  # Detect architecture
  local ARCH
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64)         ARCH="x64" ;;
    arm64|aarch64)  ARCH="arm64" ;;
    *)
      echo "Unsupported architecture: $ARCH"
      exit 1
      ;;
  esac

  # Pick install dir — CI may pin CHARGEBEE_CLI_BIN_DIR. Otherwise prefer
  # /usr/local/bin when writable, else ~/.local/bin (no sudo).
  local BIN_DIR
  if [[ -n "${CHARGEBEE_CLI_BIN_DIR:-}" ]]; then
    BIN_DIR="$CHARGEBEE_CLI_BIN_DIR"
    mkdir -p "$BIN_DIR"
  elif [[ -w "/usr/local/bin" ]]; then
    BIN_DIR="/usr/local/bin"
  else
    BIN_DIR="$HOME/.local/bin"
    mkdir -p "$BIN_DIR"
  fi

  local ASSET="chargebee-cli-${OS}-${ARCH}"

  # Show current version if already installed
  local PREV_VERSION=""
  if command -v chargebee &>/dev/null; then
    PREV_VERSION=$(chargebee --version 2>/dev/null | head -1 || true)
    echo "Updating chargebee CLI (${PREV_VERSION:-unknown} → latest)..."
  else
    echo "Installing chargebee CLI for ${OS}/${ARCH}..."
  fi

  # Download to a temp file (or copy CHARGEBEE_CLI_INSTALL_FILE in CI snapshot jobs).
  # Global (not `local`): the EXIT trap below still needs it after main() returns.
  TMP=$(mktemp)
  trap 'rm -f "$TMP"' EXIT

  if [[ -n "${CHARGEBEE_CLI_INSTALL_FILE:-}" ]]; then
    if [[ ! -f "$CHARGEBEE_CLI_INSTALL_FILE" ]]; then
      echo "Error: CHARGEBEE_CLI_INSTALL_FILE is not a file: $CHARGEBEE_CLI_INSTALL_FILE"
      exit 1
    fi
    cp "$CHARGEBEE_CLI_INSTALL_FILE" "$TMP"
  else
    local TAG
    # CHARGEBEE_CLI_VERSION pins a release tag (e.g. v1.2.3); `chargebee update`
    # prints it so a re-run installs exactly the version it reported.
    if [[ -n "${CHARGEBEE_CLI_VERSION:-}" ]]; then
      TAG="$CHARGEBEE_CLI_VERSION"
      [[ "$TAG" == v* ]] || TAG="v$TAG"
    else
      # Default to stable; a prerelease requires an explicit version pin.
      local API_URL="https://api.github.com/repos/${REPO}/releases/latest"
      TAG=$(curl -fsSL --connect-timeout 15 --max-time 60 "${GH_AUTH_ARGS[@]+"${GH_AUTH_ARGS[@]}"}" -H "Accept: application/vnd.github+json" -H "User-Agent: chargebee-cli-installer" "$API_URL" \
        | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1) || true
      if [[ -z "$TAG" || "$TAG" == *-* ]]; then
        echo "Error: could not resolve the latest stable release of $REPO"
        echo "  Pin one with CHARGEBEE_CLI_VERSION=vX.Y.Z or see https://github.com/${REPO}/releases"
        exit 1
      fi
    fi

    # The plain releases/download/ URL only serves a public repo. With a token,
    # resolve both assets through the release-by-tag API instead, which works
    # for a private repo too.
    local ASSET_URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"
    local SUMS_URL="https://github.com/${REPO}/releases/download/${TAG}/SHA256SUMS.txt"
    if [[ -n "$TOKEN" ]]; then
      local RELEASE_JSON FOUND_ASSET_URL FOUND_SUMS_URL
      RELEASE_JSON=$(curl -fsSL --connect-timeout 15 --max-time 60 "${GH_AUTH_ARGS[@]+"${GH_AUTH_ARGS[@]}"}" -H "Accept: application/vnd.github+json" -H "User-Agent: chargebee-cli-installer" \
        "https://api.github.com/repos/${REPO}/releases/tags/${TAG}") || true
      FOUND_ASSET_URL=$(find_asset_api_url "$RELEASE_JSON" "$ASSET")
      [[ -n "$FOUND_ASSET_URL" ]] && ASSET_URL="$FOUND_ASSET_URL"
      FOUND_SUMS_URL=$(find_asset_api_url "$RELEASE_JSON" "SHA256SUMS.txt")
      [[ -n "$FOUND_SUMS_URL" ]] && SUMS_URL="$FOUND_SUMS_URL"
    fi

    local HTTP_CODE
    HTTP_CODE=$(curl -fsSL -L --connect-timeout 15 --max-time 300 "${GH_AUTH_ARGS[@]+"${GH_AUTH_ARGS[@]}"}" -H "Accept: application/octet-stream" -w "%{http_code}" -o "$TMP" "$ASSET_URL") || true

    if [[ "$HTTP_CODE" != "200" ]]; then
      echo "Error: failed to download $ASSET (HTTP ${HTTP_CODE:-000})"
      echo "  See https://github.com/${REPO}/releases"
      exit 1
    fi

    verify_checksum "$TMP" "$ASSET" "$SUMS_URL"
  fi

  chmod 0755 "$TMP"
  mv "$TMP" "$BIN_DIR/$BIN_NAME"

  local TARGET_HOME
  TARGET_HOME=$(target_home)

  # MARKER_ROOT is the topmost directory the marker write may create, the one
  # handed back to the invoking user under sudo.
  local MARKER_DIR MARKER_ROOT
  if [[ -n "${CHARGEBEE_CONFIG_DIR:-}" ]]; then
    MARKER_DIR="$CHARGEBEE_CONFIG_DIR"
    MARKER_ROOT="$MARKER_DIR"
  else
    MARKER_ROOT="$TARGET_HOME/.chargebee"
    MARKER_DIR="$MARKER_ROOT/cli"
  fi
  (mkdir -p -m 0700 "$MARKER_DIR" && printf 'github\n' > "$MARKER_DIR/install-method") || true
  own_as_target_user "$MARKER_ROOT"

  local NEW_VERSION
  NEW_VERSION=$("$BIN_DIR/$BIN_NAME" --version 2>/dev/null | head -1 || true)

  if [[ -n "$PREV_VERSION" ]]; then
    echo "Updated: ${PREV_VERSION} → ${NEW_VERSION:-done}"
  else
    echo "Installed: ${NEW_VERSION:-chargebee} → $BIN_DIR/$BIN_NAME"
  fi

  # Warn if BIN_DIR isn't in PATH
  if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
    echo ""
    echo "  Add this to your shell profile (~/.zshrc or ~/.bashrc):"
    echo "    export PATH=\"$BIN_DIR:\$PATH\""
  fi

  local CHARGEBEE="$BIN_DIR/$BIN_NAME"

  if onboarding_can_prompt; then
    # main's installer can install an older release (including a pinned tag).
    # Select flags from the installed binary, not the installer's version.
    local SKILL_SCOPE=(--global) SKILL_HELP
    SKILL_HELP=$(run_as_target_user "$CHARGEBEE" skills add --help 2>/dev/null) || SKILL_HELP=""
    if [[ "$SKILL_HELP" != *"--global"* ]]; then
      SKILL_SCOPE=(--path "$TARGET_HOME" --no-gitignore)
    fi
    echo ""
    if onboarding_prompt_yn "Install the Chargebee CLI skill for your coding agent?"; then
      run_as_target_user "$CHARGEBEE" skills add "${SKILL_SCOPE[@]}" || true
    else
      printf '  Later: chargebee skills add'; printf ' %q' "${SKILL_SCOPE[@]}"; printf '\n'
    fi
    if onboarding_prompt_yn "Add a cb shortcut for the chargebee command?"; then
      run_as_target_user "$CHARGEBEE" alias set "${FORCE_ALIAS[@]+"${FORCE_ALIAS[@]}"}" || true
    else
      echo "  Later: chargebee alias set"
    fi
    (mkdir -p -m 0700 "$MARKER_DIR" && printf '%s\n' '{"offered":true}' > "$MARKER_DIR/onboarding.json") || true
    own_as_target_user "$MARKER_ROOT"
  else
    print_onboarding_hints
  fi

  echo ""
  echo "Get started:"
  echo "  chargebee auth add"
}

main "$@"
