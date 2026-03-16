#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -d "$ROOT/.rustup-local/toolchains" ]]; then
  export RUSTUP_HOME="$ROOT/.rustup-local"
fi
if [[ -d "$ROOT/.cargo-local" ]]; then
  export CARGO_HOME="$ROOT/.cargo-local"
fi

cd "$ROOT"
exec npx tauri build --debug
