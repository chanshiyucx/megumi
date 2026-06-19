#!/usr/bin/env bash

set -euo pipefail

RESOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE="${MEGUMI_R2_REMOTE:-cf-r2:gallery}"
LOG="${MEGUMI_RCLONE_LOG:-$HOME/megumi-r2-sync.log}"

if [[ ! -f "$RESOURCE_DIR/manifest.json" ]]; then
  echo "error: manifest.json does not exist in: $RESOURCE_DIR" >&2
  echo "hint: run ./build.sh in the resource directory first" >&2
  exit 1
fi

echo "sync started: $(date '+%Y-%m-%d %H:%M:%S')"
echo "  local:  $RESOURCE_DIR"
echo "  remote: $REMOTE"
echo "  log:    $LOG"

rclone sync "$RESOURCE_DIR" "$REMOTE" \
  --progress \
  --exclude ".megumi/**" \
  --exclude ".DS_Store" \
  --exclude "build.sh" \
  --exclude "sync.sh" \
  --log-file="$LOG" \
  --log-level INFO

echo "sync completed: $(date '+%Y-%m-%d %H:%M:%S')"
