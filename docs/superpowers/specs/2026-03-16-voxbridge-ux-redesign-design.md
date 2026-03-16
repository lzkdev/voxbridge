# Voxbridge UX Redesign — Design Spec

## Summary

Redesign Voxbridge from a single-window engineering tool into a macOS system utility with three independent interfaces: a menu bar panel for daily control, a floating translucent subtitle overlay, and a settings window accessible on demand.

## Goals

- Transform from "developer tool" to "system plugin" UX
- Settings hidden after initial setup, subtitles always accessible
- Native macOS feel: menu bar app, no Dock icon, dark theme

## Non-Goals

- A/B model comparison (removed)
- Multi-platform support (macOS only for now)
- Custom model selection UI (upstream uses qwen3, downstream uses gummy, hardcoded)

## Architecture

### Window System

| Window | Type | Purpose |
|--------|------|---------|
| Menu bar panel | NSPopover-style dropdown (~320px wide) | Daily control center: status, start/stop toggles, language switching |
| Subtitle overlay | Independent transparent window | Real-time subtitle display, always-on-top + click-through |
| Settings window | Standard window (~500×480px, on demand) | API Key, audio devices, subtitle styling, shortcuts, about |
| Setup wizard | Modal window (first launch only) | Guided initial configuration |

### Technical Implementation

- Tauri v2 multi-window: main window set to `visible: false`
- Menu bar icon via Tauri v2 built-in `tauri::tray::TrayIconBuilder` (no plugin needed)
- Subtitle window: `transparent: true`, `alwaysOnTop: true`, `decorations: false`
- Global shortcuts via `tauri-plugin-global-shortcut` (new dependency)
- App hidden from Dock: macOS `LSUIElement = true` in `Info.plist`
- Each window is a separate Tauri WebviewWindow with its own HTML entry point

## Menu Bar Panel

### Layout

Dark theme dropdown panel with two sections:

1. **Status header** — App name + status indicator (green dot when running, gray when stopped)
2. **Worker cards** — One card per worker (upstream / downstream), each containing:
   - Toggle switch (independent start/stop)
   - Language pair tags (clickable to switch)
   - Audio device info (shown when running)
3. **Footer** — "Settings" and "Quit" links

### States

- **Idle**: Both toggles off, gray status dot, no device info shown
- **Running**: Active toggles green, green status dot with glow, device routing info displayed
- **Partial**: Only one worker running, mixed state display

### Interactions

- Toggle switch: starts/stops individual worker
- Language tags: click to expand inline language selector
- Settings link: opens settings window
- Quit: terminates the application

## Subtitle Overlay Window

### Visual Design

- Semi-transparent dark background with backdrop blur (frosted glass effect)
- `background: rgba(10, 10, 20, 0.75)` with `backdrop-filter: blur(20px)`
- Rounded corners (12px), subtle border
- High-contrast white text for readability

### Display Modes

1. **Bilingual**: Source text (smaller, semi-transparent) + translated text (larger, full opacity)
2. **Translation only**: Just the translated text, more compact

User can toggle between modes from the hover control bar or settings.

### Three Interaction States

1. **Normal (click-through)**: Mouse events pass through to underlying apps via `set_ignore_cursor_events(true)`. No visible controls. This is the default state.
2. **Hover (controls visible)**: When mouse approaches the window edge, a control bar appears above the window with:
   - **Aa** — Font size adjustment
   - **Bilingual/Translation** — Display mode toggle
   - **Opacity slider** — Background transparency control
   - **Pin icon** — Lock position (prevent accidental dragging)
   - **Resize handle** — Bottom-right corner for resizing
3. **Translation-only mode**: Same as normal but with compact single-line display

Control bar auto-hides 1.5 seconds after mouse leaves.

### Click-Through ↔ Hover Transition

The subtitle window uses a thin invisible border region (8px inset from window edges) that keeps `ignore_cursor_events(false)`. This border acts as a hover sentinel — when the mouse enters this border zone, it triggers the control bar to appear and temporarily disables click-through for the full window. When the mouse leaves the window and the control bar auto-hides (1.5s), click-through re-enables via `set_ignore_cursor_events(true)`.

### Resize Constraints

- Minimum size: 300×60px (enough for one line of text)
- Maximum size: 90% of screen width × 400px
- Text reflows on resize (font size stays fixed, line wrapping adjusts)
- Current position and size persisted to config on change

### Subtitle Text Pipeline

Simplified from current implementation (no A/B dedup needed):
- `poll_events` at ~300ms interval, filtered to `target_partial` / `target_final` only
- Partial results displayed in real-time, committed on sentence-ending punctuation or 1.4s idle
- Deduplication: strip committed prefix, normalize whitespace, collapse repeated leads (gummy model quirk)

## Settings Window

### Layout

macOS-standard sidebar navigation (left) + content area (right), dark theme.

### Tabs

**General**
- DashScope API Key (masked display, edit button)
- Upstream default language pair (source → target)
- Downstream default language pair (source → target)
- TTS Voice selection (used by upstream worker for translated speech output)
- Launch at login toggle

**Audio Devices**
- Upstream input device (microphone)
- Upstream output device (virtual audio device)
- Downstream input device (audio bus)
- Refresh devices button
- Device info display (channels, sample rate)

**Subtitle Style**
- Font family and size
- Default background opacity
- Default window position and size
- Default display mode (bilingual / translation only)

**Shortcuts**
- Global start/stop shortcut
- Show/hide subtitle window
- Toggle bilingual/translation mode

**About**
- Version number
- Apache-2.0 license
- GitHub repository link

## First Launch Setup Wizard

Triggered when no API Key is found (first launch or after reset).

### Steps

1. **Welcome** — Logo, one-line intro, "Get Started" button
2. **API Key** — Input field, validate connectivity with DashScope API. On failure: inline error message with retry button. User can skip and configure later from settings.
3. **Audio Devices** — Auto-detect and recommend device configuration (mic, virtual audio device), user confirms or modifies
4. **Done** — "All Set" confirmation, display key shortcuts, "Start Using" button

After completion, wizard closes and Voxbridge enters menu bar resident mode.

## Data Flow and State Management

### Configuration

- File-based storage: `~/.config/voxbridge/config.json`
- Shared across all windows via Rust backend
- Config changes broadcast to all windows via Tauri `emit` events
- On load: missing fields filled with defaults, corrupted file replaced with defaults (log warning)
- No migration from `localStorage` needed — this is a full redesign, existing users re-enter settings via setup wizard

### Backend (Rust)

- Single `AppState` with two workers: `upstream` (qwen3-livetranslate-flash-realtime) and `downstream` (gummy-realtime-v1)
- Each worker runs in a dedicated OS thread with its own Tokio runtime (unchanged)
- Worker lifecycle managed via `Arc<AtomicBool>` stop flags (unchanged)

### IPC Commands

| Retained | New | Removed |
|----------|-----|---------|
| `list_input_devices` | `save_config` / `load_config` (file persistence) | `start_downstream` slot/compare params |
| `list_output_devices` | `get_subtitle_events` (lightweight, subtitle-window-only) | A/B comparison logic |
| `start_upstream` | `validate_api_key` (setup wizard) | |
| `start_downstream` | | |
| `stop_all` | `stop_worker(name)` (stop individual upstream/downstream) | |
| `read_status` | | |

### Multi-Window Communication

- Menu bar panel ↔ Backend: Tauri IPC (`invoke`)
- Settings window ↔ Backend: Tauri IPC, broadcasts config changes via `emit`
- Backend → Subtitle window: Subtitle window polls `get_subtitle_events` independently
- Cross-window sync: Tauri `emit` / `listen` for state changes (start/stop, config updates)

## Models

- **Upstream**: `qwen3-livetranslate-flash-realtime` via `wss://dashscope.aliyuncs.com/api-ws/v1/realtime`
- **Downstream**: `gummy-realtime-v1` via `wss://dashscope.aliyuncs.com/api-ws/v1/inference`
