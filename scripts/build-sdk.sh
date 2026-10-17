#!/usr/bin/env bash
# Build the ego-browser JavaScript runtime (MIT, citrolabs/ego-lite
# package/ego-browser) at a pinned commit and vendor it into sdk/.
set -euo pipefail

UPSTREAM_REPO="${AGENTSPACE_UPSTREAM_REPO:-https://github.com/citrolabs/ego-lite.git}"
UPSTREAM_COMMIT="${AGENTSPACE_UPSTREAM_COMMIT:-4cf79356509bccdead17863250b442f60a881c25}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git clone --quiet --filter=blob:none "$UPSTREAM_REPO" "$WORK/ego-lite"
git -C "$WORK/ego-lite" checkout --quiet "$UPSTREAM_COMMIT"
# Linux support the upstream SDK lacks (see patches/README.md).
for patch in "$ROOT"/patches/*.patch; do
  git -C "$WORK/ego-lite" apply --whitespace=nowarn "$patch"
done
(
  cd "$WORK/ego-lite/package/ego-browser"
  CI=true npm ci --no-audit --no-fund --silent
  npm run --silent build
)

rm -rf "$ROOT/sdk"
cp -R "$WORK/ego-lite/package/ego-browser/dist/out" "$ROOT/sdk"
cp "$WORK/ego-lite/LICENSE" "$ROOT/sdk/LICENSE"
cat > "$ROOT/sdk/UPSTREAM.json" <<JSON
{
  "repository": "$UPSTREAM_REPO",
  "commit": "$UPSTREAM_COMMIT",
  "package": "package/ego-browser",
  "patches": [$(cd "$ROOT/patches" && ls *.patch | sed 's/.*/"&"/' | paste -sd, -)],
  "license": "MIT"
}
JSON
echo "Vendored ego-browser SDK at $UPSTREAM_COMMIT into $ROOT/sdk"
