#!/bin/bash
# LiveScribe native-messaging installer (macOS).
#
# Usage:  ./native-host/install.sh <EXTENSION_ID>
#
# Get <EXTENSION_ID> from chrome://extensions after "Load unpacked"
# (the 32-letter id under the LiveScribe card, e.g. abcdefghijklmnopabcdefghijklmnop).
#
# What it does:
#   1. Resolves absolute paths to `node` and `claude` in YOUR shell (Chrome's
#      launched process has a minimal PATH and can't find them otherwise).
#   2. Writes a wrapper script that bakes in those paths + HOME.
#   3. Installs the native-messaging host manifest into every Chromium-based
#      browser found, whitelisting your extension id.

set -euo pipefail

HOST_NAME="com.livescribe.summarizer"
EXT_ID="${1:-}"

if [ -z "$EXT_ID" ]; then
  echo "ERROR: pass your extension id."
  echo "  1) chrome://extensions -> enable Developer mode -> Load unpacked -> pick the livescribe/ folder"
  echo "  2) copy the 32-letter ID shown on the LiveScribe card"
  echo "  3) re-run:  ./native-host/install.sh <EXTENSION_ID>"
  exit 1
fi

DIR="$(cd "$(dirname "$0")" && pwd)"        # .../livescribe/native-host
HOST_JS="$DIR/host.js"

NODE_BIN="$(command -v node || true)"
CLAUDE_BIN="$(command -v claude || true)"
CODEX_BIN="$(command -v codex || true)"
[ -z "$NODE_BIN" ]   && { echo "ERROR: node not found on PATH."; exit 1; }
if [ -z "$CLAUDE_BIN" ] && [ -z "$CODEX_BIN" ]; then
  echo "ERROR: neither claude nor codex found on PATH. Install and log in to at least one."; exit 1
fi
[ -z "$CLAUDE_BIN" ] && echo "note: claude CLI not found — the Claude option will not work"
[ -z "$CODEX_BIN" ]  && echo "note: codex CLI not found — the ChatGPT option will not work"

echo "node   : $NODE_BIN"
echo "claude : ${CLAUDE_BIN:-(none)}"
echo "codex  : ${CODEX_BIN:-(none)}"
echo "host.js: $HOST_JS"
echo "ext id : $EXT_ID"

# 1) wrapper the manifest will point at (absolute paths + clean env)
WRAPPER="$DIR/run-host.sh"
cat > "$WRAPPER" <<EOF
#!/bin/bash
# Chrome launches native hosts with a minimal environment. claude reads its
# subscription credentials from the macOS login Keychain, which needs USER/
# LOGNAME/HOME present — so bake them in explicitly (this was the "Not logged in"
# gotcha). PATH is set so any tools claude shells out to are found.
export HOME="$HOME"
export USER="$USER"
export LOGNAME="$USER"
export LANG="${LANG:-en_US.UTF-8}"
export LS_CLAUDE_BIN="$CLAUDE_BIN"
export LS_CODEX_BIN="$CODEX_BIN"
export LS_CODEX_MODEL="${LS_CODEX_MODEL:-}"   # empty = try account default, then 5.6, then 5.5
export PATH="$(dirname "${CLAUDE_BIN:-$NODE_BIN}"):$(dirname "${CODEX_BIN:-$NODE_BIN}"):$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin:\$PATH"
exec "$NODE_BIN" "$HOST_JS"
EOF
chmod +x "$WRAPPER"
echo "wrote wrapper: $WRAPPER"

# 2) manifest content
read -r -d '' MANIFEST <<EOF || true
{
  "name": "$HOST_NAME",
  "description": "LiveScribe summarizer (runs claude -p via your subscription)",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF

# 3) install into each browser that exists
BASE="$HOME/Library/Application Support"
declare -a PRODUCTS=(
  "Google/Chrome"
  "Google/Chrome Beta"
  "Google/Chrome Canary"
  "Chromium"
  "Microsoft Edge"
  "BraveSoftware/Brave-Browser"
  "Arc/User Data"
)

installed=0
for p in "${PRODUCTS[@]}"; do
  if [ -d "$BASE/$p" ]; then
    target_dir="$BASE/$p/NativeMessagingHosts"
    mkdir -p "$target_dir"
    echo "$MANIFEST" > "$target_dir/$HOST_NAME.json"
    echo "installed -> $target_dir/$HOST_NAME.json"
    installed=$((installed+1))
  fi
done

if [ "$installed" -eq 0 ]; then
  echo "WARNING: no supported browser profile dir found under $BASE."
  echo "If you use Chrome, open it once so the folder exists, then re-run."
  exit 1
fi

echo ""
echo "Done. Reload LiveScribe, open its Settings page, click the hidden bottom-left"
echo "debug area, choose Codex or Claude Code, and click Test Companion."
