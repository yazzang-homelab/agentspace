#!/usr/bin/env bash
# Run the upstream ego-browser real-browser E2E suite (69 cases) against this
# implementation. The runner invokes `<cli> nodejs --sdk-path <sdk>`; the
# e2e-cli shim maps that onto `agentspace run`.
#
#   AGENTSPACE_UPSTREAM_DIR=/path/to/ego-lite  reuse a patched upstream checkout
#   EGO_BROWSER_REAL_E2E_ONLY="case a,case b"  run selected cases
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_REPO="${AGENTSPACE_UPSTREAM_REPO:-https://github.com/citrolabs/ego-lite.git}"
UPSTREAM_COMMIT="${AGENTSPACE_UPSTREAM_COMMIT:-$(node -p "require('$ROOT/sdk/UPSTREAM.json').commit")}"

if [ -n "${AGENTSPACE_UPSTREAM_DIR:-}" ]; then
  UPSTREAM="$AGENTSPACE_UPSTREAM_DIR"
else
  UPSTREAM="$(mktemp -d)/ego-lite"
  trap 'rm -rf "$(dirname "$UPSTREAM")"' EXIT
  git clone --quiet --filter=blob:none "$UPSTREAM_REPO" "$UPSTREAM"
  git -C "$UPSTREAM" checkout --quiet "$UPSTREAM_COMMIT"
  for patch in "$ROOT"/patches/*.patch; do
    git -C "$UPSTREAM" apply --whitespace=nowarn "$patch"
  done
fi

cd "$UPSTREAM/package/ego-browser"
[ -d node_modules ] || CI=true npm ci --no-audit --no-fund --silent
EGO_BROWSER_REAL_E2E_CLI="$ROOT/scripts/e2e-cli" npm run --silent e2e
