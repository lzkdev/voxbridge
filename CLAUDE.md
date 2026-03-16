# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Voxbridge — a Tauri v2 + Rust desktop app for real-time speech translation. Uses DashScope (Alibaba Cloud) WebSocket API for live translation with two supported models: `qwen3-livetranslate-flash-realtime` and `gummy-realtime-v1`.

**Upstream**: Mic audio → real-time translation → English speech → virtual output device (for Zoom/Meet/WeChat mic input).
**Downstream**: Meeting/video audio bus → real-time translation → Chinese subtitle display (supports A/B model comparison).

## Development Commands

```bash
npm install                    # Install frontend deps
npm run tauri:dev              # Dev mode (Vite dev server + Tauri app)
npm run tauri:build            # Production build (.app bundle)
npm run tauri:dev:local        # Dev with local Rust toolchain (.rustup-local/.cargo-local)
npm run tauri:build:debug:local # Debug build with local toolchain
npm run dev                    # Vite dev server only (no Tauri)
npm run build                  # Frontend build only (tsc + vite)
```

Prerequisites: Node.js, npm, Rust toolchain (rustc >= 1.88 recommended).

## Architecture

### Two-layer structure
- **Frontend** (`src/`): Vanilla TypeScript + Vite. Single-page app rendered into `#app` in `index.html`. No framework — DOM manipulation via `document.querySelector`. Config persisted in `localStorage` under key `live-translate-rust-config-v2`.
- **Backend** (`src-tauri/src/lib.rs`): All Rust logic lives in a single `lib.rs` file (~1580 lines). Tauri v2 manages the window; `main.rs` just calls `app_lib::run()`.

### Tauri IPC Commands (frontend → backend)
- `list_input_devices` / `list_output_devices` — enumerate audio devices via `cpal`
- `start_upstream` — launch upstream translation worker (mic → translated speech → output device)
- `start_downstream` — launch downstream translation worker (audio bus → subtitles), supports slot `"a"` or `"b"` for A/B comparison
- `stop_all` — stop all running workers
- `read_status` — poll engine state (which workers are running, last error)
- `poll_events` — fetch UI events since a given event ID (subtitles, status, errors)

### Backend Worker Model
Each upstream/downstream session runs as a dedicated OS thread (`std::thread::spawn`) with its own Tokio runtime. Workers:
1. Open a cpal audio input stream capturing PCM data
2. Connect to DashScope WebSocket API (different URL/protocol for gummy vs qwen3 models)
3. Stream base64-encoded audio chunks to the API
4. Receive translation results and push `UiEvent`s to a shared `VecDeque`
5. For upstream: play translated audio back through an output device

Worker lifecycle is managed via `Arc<AtomicBool>` stop flags and `WorkerHandle` structs stored in `AppState`.

### Frontend Subtitle Pipeline
The frontend polls `poll_events` every 350ms. Subtitle text goes through a deduplication/merge pipeline:
- `sanitizeIncomingSubtitle` → `stripCommittedPrefix` → `mergeLiveText` for partial results
- Partial results are auto-committed after 1400ms idle or on sentence-ending punctuation
- Separate tracking per worker (`downstream_a` / `downstream_b`) for A/B comparison display

### Key Rust Dependencies
- `cpal` — cross-platform audio I/O
- `tokio-tungstenite` — async WebSocket client (with native-tls)
- `tauri` v2 — desktop app framework
- Audio format: 16kHz mono S16LE for input, 24kHz for output playback

### DashScope API Details
Two different WebSocket protocols are used depending on model:
- **qwen3 models**: `wss://dashscope.aliyuncs.com/api-ws/v1/realtime` — uses `session.update` for config, `input_audio_buffer.append` for audio
- **gummy model**: `wss://dashscope.aliyuncs.com/api-ws/v1/inference` — uses `run-task` header with `start-task`/`continue-task` events, binary audio frames

## Platform Notes

- macOS only (uses `NSMicrophoneUsageDescription` in Info.plist for mic permission)
- Virtual audio device (BlackHole/Voicemod/Loopback) required for routing audio between this app and meeting software
- Vite dev server runs on port 1420 (strict)
