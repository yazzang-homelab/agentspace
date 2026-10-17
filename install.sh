#!/usr/bin/env bash
# Install agentspace for the current user.
#
#   ./install.sh            install (idempotent; rerun after git pull)
#   ./install.sh --uninstall
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_VERSION="${AGENTSPACE_NODE_VERSION:-v24.11.1}"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SKILL_DIR="$HOME/.agents/skills/ego-browser"

say() { printf '==> %s\n' "$*"; }

node_major() {
  "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

if [ "${1:-}" = "--uninstall" ]; then
  "$ROOT/bin/ego-browser" stop >/dev/null 2>&1 || true
  if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
    systemctl --user disable --now agentspace.service >/dev/null 2>&1 || true
  fi
  rm -f "$BIN_DIR/ego-browser" "$APP_DIR/agentspace.desktop" "$UNIT_DIR/agentspace.service"
  rm -rf "$SKILL_DIR"
  say "Removed agentspace. Profiles and Spaces remain in ${AGENTSPACE_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/agentspace}."
  exit 0
fi

# 1. Chromium
if ! command -v chromium >/dev/null && ! command -v chromium-browser >/dev/null \
  && ! command -v google-chrome-stable >/dev/null && ! command -v google-chrome >/dev/null \
  && ! command -v brave-browser >/dev/null && ! command -v microsoft-edge-stable >/dev/null \
  && [ -z "${AGENTSPACE_CHROMIUM:-}" ]; then
  echo "No Chromium-based browser found. Install one first, for example:" >&2
  echo "  Debian/Ubuntu: sudo apt install chromium" >&2
  echo "  Fedora:        sudo dnf install chromium" >&2
  echo "  Arch:          sudo pacman -S chromium" >&2
  echo "or set AGENTSPACE_CHROMIUM=/path/to/chrome." >&2
  exit 1
fi

# 2. Node.js >= 22 (the ego-browser SDK requires it)
SYSTEM_NODE="$(command -v node || true)"
if [ -n "${AGENTSPACE_NODE:-}" ] && [ "$(node_major "$AGENTSPACE_NODE")" -ge 22 ]; then
  say "Using AGENTSPACE_NODE=$AGENTSPACE_NODE"
elif [ -n "$SYSTEM_NODE" ] && [ "$(node_major "$SYSTEM_NODE")" -ge 22 ]; then
  say "Using system Node.js $("$SYSTEM_NODE" --version)"
elif [ -x "$ROOT/runtime/node/bin/node" ] && [ "$(node_major "$ROOT/runtime/node/bin/node")" -ge 22 ]; then
  say "Using bundled Node.js $("$ROOT/runtime/node/bin/node" --version)"
else
  case "$(uname -m)" in
    x86_64) ARCH=x64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) echo "Unsupported CPU $(uname -m); install Node.js >= 22 and rerun." >&2; exit 1 ;;
  esac
  NAME="node-$NODE_VERSION-linux-$ARCH"
  say "Downloading Node.js $NODE_VERSION ($ARCH) into runtime/node"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$NAME.tar.xz" -o "$TMP/node.tar.xz"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  (cd "$TMP" && grep " $NAME.tar.xz\$" SHASUMS256.txt | sed "s/$NAME.tar.xz/node.tar.xz/" | sha256sum -c --quiet -)
  rm -rf "$ROOT/runtime/node"
  mkdir -p "$ROOT/runtime/node"
  tar -xJf "$TMP/node.tar.xz" -C "$ROOT/runtime/node" --strip-components=1
fi

# 3. CLI on PATH
mkdir -p "$BIN_DIR"
ln -sfn "$ROOT/bin/ego-browser" "$BIN_DIR/ego-browser"
say "Linked $BIN_DIR/ego-browser"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "    Add $BIN_DIR to PATH to run ego-browser directly." ;;
esac

# 4. Agent skill (the CLI help points agents at this path)
rm -rf "$SKILL_DIR"
mkdir -p "$(dirname "$SKILL_DIR")"
cp -R "$ROOT/sdk/agent-skills/ego-browser" "$SKILL_DIR"
say "Installed the ego-browser agent skill into $SKILL_DIR"

# 5. Desktop entry (lets `import` register agentspace as the default browser)
mkdir -p "$APP_DIR"
cat > "$APP_DIR/agentspace.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=agentspace
Comment=Browser for you and your AI agents
Exec=$ROOT/bin/ego-browser open %u
Terminal=false
Categories=Network;WebBrowser;
MimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;
Actions=Panel;

[Desktop Action Panel]
Name=Spaces panel
Exec=$ROOT/bin/ego-browser panel
DESKTOP
command -v update-desktop-database >/dev/null && update-desktop-database "$APP_DIR" >/dev/null 2>&1 || true
say "Installed $APP_DIR/agentspace.desktop"

# 6. systemd user service, so the daemon outlives the shell that started it
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/agentspace.service" <<UNIT
[Unit]
Description=agentspace browser service
After=graphical-session.target
PartOf=graphical-session.target

[Service]
ExecStart=$ROOT/bin/ego-browser daemon
Restart=on-failure

[Install]
WantedBy=graphical-session.target
UNIT
if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user daemon-reload
  systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XAUTHORITY 2>/dev/null || true
  systemctl --user enable agentspace.service >/dev/null 2>&1 || true
  say "Enabled the agentspace user service (starts with your graphical session)"
else
  say "No systemd user session; ego-browser starts the daemon on demand"
fi

say "Done. Try: ego-browser nodejs -e 'console.log(await profiles())'"
