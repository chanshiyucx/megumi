#!/usr/bin/env bash

set -euo pipefail

PROJECT_DIR="${MEGUMI_PROJECT_DIR:-/Users/xin/Developer/shiyu/megumi}"
RESOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -f "$PROJECT_DIR/backend/Cargo.toml" ]]; then
  echo "error: could not find backend/Cargo.toml in: $PROJECT_DIR" >&2
  echo "hint: set MEGUMI_PROJECT_DIR if the project has moved" >&2
  exit 1
fi

cd "$PROJECT_DIR"
exec cargo run --manifest-path "$PROJECT_DIR/backend/Cargo.toml" --release -- build --source "$RESOURCE_DIR" "$@"
