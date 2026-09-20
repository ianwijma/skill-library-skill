#!/usr/bin/env bash
set -euo pipefail

# skill-library installer: build the binary, install it (+ sli alias), copy the
# two wrapper skills into opencode's skill dir, create the store. Idempotent.

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${SLI_BIN_DIR:-$HOME/.local/bin}"
SKILLS_DIR="${OPENCODE_SKILLS_DIR:-$HOME/.config/opencode/skills}"
STORE_DIR="${SKILL_LIBRARY_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/skill-library}"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun >= 1.3 is required to build skill-library (https://bun.sh)" >&2
  exit 1
fi

echo "==> building skill-library"
mkdir -p "$REPO_DIR/dist"
bun build --compile "$REPO_DIR/src/index.ts" --outfile "$REPO_DIR/dist/skill-library"

echo "==> installing binary to $BIN_DIR (alias: sli)"
mkdir -p "$BIN_DIR"
install -m 755 "$REPO_DIR/dist/skill-library" "$BIN_DIR/skill-library"
ln -sfn skill-library "$BIN_DIR/sli"

echo "==> installing wrapper skills to $SKILLS_DIR"
for name in skill-library skill-library-query skill-library-list skill-library-get \
            skill-library-add skill-library-update skill-library-remove \
            skill-importer skill-importer-undo; do
  mkdir -p "$SKILLS_DIR/$name"
  cp -f "$REPO_DIR/skills/$name/SKILL.md" "$SKILLS_DIR/$name/SKILL.md"
done

echo "==> creating store at $STORE_DIR"
mkdir -p "$STORE_DIR/skills"

"$BIN_DIR/skill-library" --version

cat <<'EOF'

Done. Restart opencode so the new skills are picked up (not hot-reloaded).
Quick checks:
  skill-library list
  skill-library query "fix a failing next.js build"   # needs TYPESAFE_API_KEY
EOF
