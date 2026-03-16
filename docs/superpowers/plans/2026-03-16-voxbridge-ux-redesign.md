# Voxbridge UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform Voxbridge from a single-window engineering tool into a macOS menu bar system utility with floating subtitle overlay.

**Architecture:** Multi-window Tauri v2 app — invisible main window, system tray icon, menu bar popup panel, transparent subtitle overlay, and settings window. Rust backend simplified to two workers (upstream/downstream) with file-based config. Frontend split into separate HTML/TS entry points per window.

**Tech Stack:** Tauri v2, Rust, TypeScript (vanilla), cpal, tokio-tungstenite, tauri-plugin-global-shortcut

---

## File Structure

### New Files

```
panel.html                    # Vite entry point for panel window (project root)
subtitle.html                 # Vite entry point for subtitle window (project root)
settings.html                 # Vite entry point for settings window (project root)
setup.html                    # Vite entry point for setup wizard (project root)

src/panel/                    # Menu bar panel window
  panel.ts                    # Logic: status display, toggle controls, language switching
  panel.css                   # Dark theme panel styles

src/subtitle/                 # Subtitle overlay window
  subtitle.ts                 # Logic: event polling, text pipeline, click-through control
  subtitle.css                # Translucent overlay styles

src/settings/                 # Settings window
  settings.ts                 # Logic: sidebar nav, config forms, device management
  settings.css                # Settings window styles

src/setup/                    # First launch wizard
  setup.ts                    # Logic: step flow, API validation, device setup
  setup.css                   # Wizard styles

src/shared/                   # Shared utilities
  ipc.ts                      # Typed wrappers for all Tauri invoke commands
  config-types.ts             # AppConfig type definition, shared across windows
  events.ts                   # Tauri emit/listen event type definitions
  theme.css                   # Shared dark theme CSS variables

src-tauri/src/config.rs       # File-based config: load, save, validate, defaults
src-tauri/src/commands.rs     # All Tauri IPC command handlers (extracted from lib.rs)
src-tauri/src/worker.rs       # Worker logic (extracted from lib.rs, mostly unchanged)
src-tauri/src/state.rs        # AppState, InnerState, WorkerHandle (extracted from lib.rs)
src-tauri/src/tray.rs         # System tray setup and event handling
```

### Modified Files

```
src-tauri/src/lib.rs          # Slim down to just pub fn run() wiring modules together
src-tauri/src/main.rs         # Unchanged (calls voxbridge_lib::run())
src-tauri/Cargo.toml          # Add tauri-plugin-global-shortcut dependency
src-tauri/tauri.conf.json     # Multi-window config, remove old single window
src-tauri/capabilities/default.json  # Add permissions for new plugins and windows
src-tauri/Info.plist          # Add LSUIElement = true
index.html                    # Delete (replaced by per-window HTML entry points)
vite.config.ts                # Multi-page build config for all HTML entry points
package.json                  # Add @tauri-apps/plugin-global-shortcut dependency
```

### Deleted Files

```
src/main.ts                   # Replaced by per-window entry points
src/style.css                 # Replaced by per-window + shared CSS
src/counter.ts                # Already deleted
```

---

## Chunk 1: Backend Restructure — Extract Modules and Add Config

### Task 1: Extract Rust state types into src-tauri/src/state.rs

**Files:**
- Create: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create state.rs with extracted types**

Extract `AudioDeviceInfo`, `UiEvent`, `EngineStatus`, `UpstreamStartRequest`, `DownstreamStartRequest`, `WorkerConfig`, `WorkerHandle`, `InnerState`, `AppState`, `InputConvertState` from `lib.rs`. **Keep `downstream_a` and `downstream_b` fields intact** — A/B removal happens in Task 4. Also keep `EngineStatus` with `downstream_a_running` / `downstream_b_running` for now.

```rust
// src-tauri/src/state.rs
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

#[derive(Clone, Serialize)]
pub struct AudioDeviceInfo {
    pub index: usize,
    pub name: String,
    pub channels: u16,
    pub sample_rate: u32,
}

#[derive(Clone, Serialize)]
pub struct UiEvent {
    pub id: u64,
    pub ts_ms: u64,
    pub worker: String,
    pub kind: String,
    pub text: String,
}

#[derive(Serialize)]
pub struct EngineStatus {
    pub upstream_running: bool,
    pub downstream_running: bool,
    pub downstream_a_running: bool,
    pub downstream_b_running: bool,
    pub last_error: Option<String>,
}

#[derive(Clone, Deserialize)]
pub struct UpstreamStartRequest {
    pub api_key: String,
    pub input_device: String,
    pub output_device: String,
    pub source_lang: String,
    pub target_lang: String,
    pub voice: String,
    pub model: Option<String>,
    pub ws_url: Option<String>,
}

#[derive(Clone, Deserialize)]
pub struct DownstreamStartRequest {
    pub api_key: String,
    pub input_device: String,
    pub source_lang: String,
    pub target_lang: String,
    pub show_source: bool,
    pub slot: Option<String>,
    pub model: Option<String>,
    pub ws_url: Option<String>,
}

#[derive(Clone)]
pub struct WorkerConfig {
    pub name: String,
    pub api_key: String,
    pub input_device: String,
    pub output_device: Option<String>,
    pub source_lang: String,
    pub target_lang: String,
    pub voice: Option<String>,
    pub model: String,
    pub ws_url: String,
    pub audio_output: bool,
    pub show_source: bool,
}

pub struct WorkerHandle {
    pub stop: Arc<AtomicBool>,
    pub join: std::thread::JoinHandle<()>,
}

#[derive(Default)]
pub struct InnerState {
    pub upstream: Option<WorkerHandle>,
    pub downstream_a: Option<WorkerHandle>,
    pub downstream_b: Option<WorkerHandle>,
    pub events: VecDeque<UiEvent>,
    pub next_event_id: u64,
    pub last_error: Option<String>,
}

#[derive(Default)]
pub struct AppState {
    pub inner: Mutex<InnerState>,
}

pub struct InputConvertState {
    pub in_rate: u32,
    pub phase: f64,
    pub prev: Option<f32>,
}

impl InputConvertState {
    pub fn new(in_rate: u32) -> Self {
        Self {
            in_rate,
            phase: 0.0,
            prev: None,
        }
    }
}
```

- [ ] **Step 2: Update lib.rs to use state module**

Add `pub mod state;` to lib.rs. Replace all inline type definitions with `use crate::state::*;`. Keep all existing `downstream_a` / `downstream_b` logic intact — it will be simplified in Task 4.

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles with no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/state.rs src-tauri/src/lib.rs
git commit -m "refactor: extract state types into state.rs"
```

---

### Task 2: Create file-based config module (src-tauri/src/config.rs)

**Files:**
- Create: `src-tauri/src/config.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create config.rs**

```rust
// src-tauri/src/config.rs
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default = "default_empty")]
    pub api_key: String,
    #[serde(default = "default_upstream_source")]
    pub upstream_source: String,
    #[serde(default = "default_upstream_target")]
    pub upstream_target: String,
    #[serde(default = "default_voice")]
    pub voice: String,
    #[serde(default = "default_downstream_source")]
    pub downstream_source: String,
    #[serde(default = "default_downstream_target")]
    pub downstream_target: String,
    #[serde(default = "default_empty")]
    pub upstream_input_device: String,
    #[serde(default = "default_empty")]
    pub upstream_output_device: String,
    #[serde(default = "default_empty")]
    pub downstream_input_device: String,
    #[serde(default = "default_subtitle_font_size")]
    pub subtitle_font_size: u32,
    #[serde(default = "default_subtitle_opacity")]
    pub subtitle_opacity: f64,
    #[serde(default = "default_true")]
    pub subtitle_bilingual: bool,
    #[serde(default)]
    pub subtitle_x: Option<f64>,
    #[serde(default)]
    pub subtitle_y: Option<f64>,
    #[serde(default)]
    pub subtitle_width: Option<f64>,
    #[serde(default)]
    pub subtitle_height: Option<f64>,
    #[serde(default)]
    pub launch_at_login: bool,
    #[serde(default = "default_empty")]
    pub shortcut_toggle: String,
    #[serde(default = "default_empty")]
    pub shortcut_subtitle: String,
    #[serde(default = "default_empty")]
    pub shortcut_bilingual: String,
}

fn default_empty() -> String { String::new() }
fn default_upstream_source() -> String { "yue".to_string() }
fn default_upstream_target() -> String { "en".to_string() }
fn default_voice() -> String { "Dylan".to_string() }
fn default_downstream_source() -> String { "en".to_string() }
fn default_downstream_target() -> String { "zh".to_string() }
fn default_subtitle_font_size() -> u32 { 16 }
fn default_subtitle_opacity() -> f64 { 0.75 }
fn default_true() -> bool { true }

impl Default for AppConfig {
    fn default() -> Self {
        serde_json::from_str("{}").unwrap()
    }
}

fn config_path() -> PathBuf {
    let dir = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("voxbridge");
    let _ = fs::create_dir_all(&dir);
    dir.join("config.json")
}

pub fn load_config() -> AppConfig {
    let path = config_path();
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|e| {
            log::warn!("config parse error, using defaults: {}", e);
            AppConfig::default()
        }),
        Err(_) => AppConfig::default(),
    }
}

pub fn save_config(config: &AppConfig) -> Result<(), String> {
    let path = config_path();
    let json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("serialize config: {}", e))?;
    fs::write(&path, json)
        .map_err(|e| format!("write config: {}", e))
}
```

- [ ] **Step 2: Add `dirs` crate to Cargo.toml**

Add under `[dependencies]`:
```toml
dirs = "6"
```

- [ ] **Step 3: Wire config module into lib.rs**

Add `pub mod config;` to lib.rs. Add two new Tauri commands:

```rust
#[tauri::command]
fn cmd_load_config() -> Result<config::AppConfig, String> {
    Ok(config::load_config())
}

#[tauri::command]
fn cmd_save_config(config: config::AppConfig) -> Result<(), String> {
    config::save_config(&config)
}

#[tauri::command]
fn validate_api_key(api_key: String) -> Result<bool, String> {
    // Simple non-empty check for now; real validation would hit the API
    Ok(!api_key.trim().is_empty())
}
```

Register in `tauri::generate_handler!`.

- [ ] **Step 4: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: Compiles with no errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/config.rs src-tauri/Cargo.toml src-tauri/src/lib.rs
git commit -m "feat: add file-based config module (~/.config/voxbridge/config.json)"
```

---

### Task 3: Add stop_worker IPC command and get_subtitle_events

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add stop_worker_by_name command**

Note: `state` is `tauri::State<'_, Arc<AppState>>`, which derefs to `Arc<AppState>`. The existing `push_event` takes `&Arc<AppState>`. Use `state.inner()` which returns `&Arc<AppState>`, matching existing patterns in the codebase (see `start_upstream` which already calls `state.inner()`).

```rust
#[tauri::command]
fn stop_worker_by_name(
    name: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let handle = {
        let mut guard = state
            .inner
            .lock()
            .map_err(|_| "state lock poisoned".to_string())?;
        match name.as_str() {
            "upstream" => guard.upstream.take(),
            "downstream" => guard.downstream.take(),
            _ => return Err(format!("unknown worker: {}", name)),
        }
    };
    if let Some(h) = handle {
        push_event(state.inner(), &name, "status", "stop_requested");
        stop_taken_worker(Some(h));
    }
    Ok(format!("{} stopped", name))
}
```

**Note:** This command uses `guard.downstream` which doesn't exist yet (still `downstream_a`). This will compile after Task 4 collapses A/B into single `downstream`. For now, add the function but comment it out with `// TODO: uncomment after Task 4`. Alternatively, temporarily use `downstream_a` and rename in Task 4.

- [ ] **Step 2: Add get_subtitle_events command**

Lightweight version of `poll_events` that returns subtitle-relevant events (both source and target, for bilingual mode):

```rust
#[tauri::command]
fn get_subtitle_events(
    after_id: Option<u64>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<UiEvent>, String> {
    let guard = state
        .inner
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    let min_id = after_id.unwrap_or(0);
    let subtitle_kinds = ["target_partial", "target_final", "source_partial", "source_final"];
    Ok(guard
        .events
        .iter()
        .filter(|e| e.id > min_id && subtitle_kinds.contains(&e.kind.as_str()))
        .cloned()
        .collect())
}
```

- [ ] **Step 3: Register new commands in generate_handler!**

Add `stop_worker_by_name`, `get_subtitle_events` to the handler macro. (`cmd_load_config`, `cmd_save_config`, `validate_api_key` were already registered in Task 2 Step 3.)

- [ ] **Step 4: Verify it compiles**

Run: `cd src-tauri && cargo check`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: add stop_worker_by_name and get_subtitle_events IPC commands"
```

---

### Task 4: Simplify start_downstream (remove A/B slot logic)

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Simplify start_downstream**

Remove `slot` parameter handling from `start_downstream`. Always use worker name `"downstream"` and the `gummy-realtime-v1` model. In `state.rs`: remove `slot` field from `DownstreamStartRequest`, collapse `downstream_a` / `downstream_b` into single `downstream: Option<WorkerHandle>` in `InnerState`, simplify `EngineStatus` to just `upstream_running` and `downstream_running` (remove `downstream_a_running` / `downstream_b_running`). Update `start_downstream` to use `guard.downstream`. Also uncomment `stop_worker_by_name` if it was commented out in Task 3.

- [ ] **Step 2: Simplify stop_all**

Remove `downstream_b` references. Only stop `upstream` and `downstream`.

- [ ] **Step 3: Simplify read_status**

Return simplified `EngineStatus` with `upstream_running` and `downstream_running` (no more `downstream_a_running` / `downstream_b_running`).

- [ ] **Step 4: Verify it compiles**

Run: `cd src-tauri && cargo check`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/state.rs
git commit -m "refactor: simplify downstream to single worker, remove A/B slot logic"
```

---

## Chunk 2: Tauri Multi-Window Setup and System Tray

### Task 5: Configure multi-window in tauri.conf.json

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/Info.plist`
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Update tauri.conf.json**

Replace single window with multi-window config. All windows created programmatically in Rust `setup`, but we need the build config for multiple HTML entry points:

```json
{
  "$schema": "../node_modules/@tauri-apps/cli/config.schema.json",
  "productName": "Voxbridge",
  "version": "0.1.0",
  "identifier": "com.github.lzkdev.voxbridge",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:1420",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build"
  },
  "app": {
    "windows": [],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": ["app"],
    "macOS": {
      "infoPlist": "Info.plist"
    },
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

Key change: `"windows": []` — no auto-created windows, all programmatic.

- [ ] **Step 2: Add LSUIElement to Info.plist**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>LSUIElement</key>
  <true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>Voxbridge needs microphone access to capture your speech and meeting audio for real-time translation.</string>
</dict>
</plist>
```

- [ ] **Step 3: Update capabilities/default.json**

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Voxbridge capabilities",
  "windows": ["panel", "subtitle", "settings", "setup"],
  "permissions": [
    "core:default",
    "core:window:allow-close",
    "core:window:allow-hide",
    "core:window:allow-show",
    "core:window:allow-set-focus",
    "core:window:allow-set-size",
    "core:window:allow-set-position",
    "core:window:allow-set-always-on-top",
    "core:window:allow-set-ignore-cursor-events",
    "core:window:allow-center",
    "core:window:allow-is-visible",
    "global-shortcut:allow-is-registered",
    "global-shortcut:allow-register",
    "global-shortcut:allow-unregister"
  ]
}
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/tauri.conf.json src-tauri/Info.plist src-tauri/capabilities/default.json
git commit -m "config: multi-window setup, LSUIElement, capabilities for overlay and shortcuts"
```

---

### Task 6: Add system tray and programmatic window creation

**Files:**
- Create: `src-tauri/src/tray.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add dependencies to Cargo.toml**

Add under `[dependencies]`, update tauri features for tray-icon:
```toml
tauri = { version = "2.10.3", features = ["tray-icon"] }
```

Add global shortcut plugin:
```toml
[target.'cfg(any(target_os = "macos", windows, target_os = "linux"))'.dependencies]
tauri-plugin-global-shortcut = "2"
```

- [ ] **Step 2: Create tray.rs**

```rust
// src-tauri/src/tray.rs
use tauri::{
    tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState},
    AppHandle, Manager,
};

pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let _tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().cloned().unwrap())
        .tooltip("Voxbridge")
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(panel) = app.get_webview_window("panel") {
                    if panel.is_visible().unwrap_or(false) {
                        let _ = panel.hide();
                    } else {
                        let _ = panel.show();
                        let _ = panel.set_focus();
                    }
                }
            }
        })
        .build(app)?;
    Ok(())
}
```

- [ ] **Step 3: Add `pub mod tray;` to lib.rs and update setup**

Add `pub mod tray;` alongside existing module declarations in `lib.rs`. Then rewrite the `run()` function:

```rust
pub fn run() {
    let mut builder = tauri::Builder::default()
        .manage(Arc::new(AppState::default()));

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_global_shortcut::init());
    }

    builder
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // System tray
            tray::setup_tray(app.handle())?;

            // Menu bar panel window (hidden, toggled by tray click)
            let panel = tauri::WebviewWindowBuilder::new(
                app,
                "panel",
                tauri::WebviewUrl::App("panel.html".into()),
            )
            .title("Voxbridge")
            .inner_size(320.0, 380.0)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .visible(false)
            .build()?;

            // Auto-hide panel when it loses focus
            let panel_clone = panel.clone();
            panel.on_window_event(move |event| {
                if let tauri::WindowEvent::Focused(false) = event {
                    let _ = panel_clone.hide();
                }
            });

            // Subtitle overlay window
            let _subtitle = tauri::WebviewWindowBuilder::new(
                app,
                "subtitle",
                tauri::WebviewUrl::App("subtitle.html".into()),
            )
            .title("Voxbridge Subtitles")
            .inner_size(600.0, 120.0)
            .min_inner_size(300.0, 60.0)
            .max_inner_size(1920.0, 400.0)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .visible(false)
            .build()?;

            // Check if first launch (no API key)
            let cfg = config::load_config();
            if cfg.api_key.is_empty() {
                let _setup = tauri::WebviewWindowBuilder::new(
                    app,
                    "setup",
                    tauri::WebviewUrl::App("setup.html".into()),
                )
                .title("Voxbridge Setup")
                .inner_size(480.0, 400.0)
                .resizable(false)
                .center()
                .build()?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_input_devices,
            list_output_devices,
            start_upstream,
            start_downstream,
            stop_all,
            stop_worker_by_name,
            read_status,
            poll_events,
            get_subtitle_events,
            cmd_load_config,
            cmd_save_config,
            validate_api_key
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 4: Verify it compiles**

Run: `cd src-tauri && cargo check`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/tray.rs src-tauri/src/lib.rs src-tauri/Cargo.toml
git commit -m "feat: system tray icon and programmatic multi-window creation"
```

---

### Task 7: Configure Vite multi-page build

**Files:**
- Modify: `vite.config.ts`
- Modify: `package.json`
- Modify: `index.html`

- [ ] **Step 1: Create HTML entry points at project root**

Vite multi-page build outputs files relative to the project root. Tauri's `WebviewUrl::App("panel.html")` expects `dist/panel.html`. So HTML entry points must be at the project root (not inside `src/`).

Create these files:
- `panel.html` — loads `src/panel/panel.ts`
- `subtitle.html` — loads `src/subtitle/subtitle.ts`
- `settings.html` — loads `src/settings/settings.ts`
- `setup.html` — loads `src/setup/setup.ts`

Example `panel.html`:
```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Voxbridge</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/src/panel/panel.ts"></script>
</body>
</html>
```

Same pattern for `subtitle.html`, `settings.html`, `setup.html` (each loading its respective TS entry).

- [ ] **Step 2: Update vite.config.ts for multi-page**

```typescript
import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      input: {
        panel: resolve(__dirname, "panel.html"),
        subtitle: resolve(__dirname, "subtitle.html"),
        settings: resolve(__dirname, "settings.html"),
        setup: resolve(__dirname, "setup.html"),
      },
    },
  },
});
```

- [ ] **Step 3: Add @tauri-apps/plugin-global-shortcut to package.json**

Run: `npm install @tauri-apps/plugin-global-shortcut`

- [ ] **Step 4: Delete old index.html**

```bash
rm index.html
```

- [ ] **Step 5: Commit**

```bash
git add panel.html subtitle.html settings.html setup.html vite.config.ts package.json package-lock.json
git rm index.html
git commit -m "config: vite multi-page build for panel, subtitle, settings, setup windows"
```

---

## Chunk 3: Shared Frontend Utilities

### Task 8: Create shared TypeScript utilities

**Files:**
- Create: `src/shared/config-types.ts`
- Create: `src/shared/ipc.ts`
- Create: `src/shared/events.ts`
- Create: `src/shared/theme.css`

- [ ] **Step 1: Create config-types.ts**

```typescript
// src/shared/config-types.ts
export type AppConfig = {
  api_key: string;
  upstream_source: string;
  upstream_target: string;
  voice: string;
  downstream_source: string;
  downstream_target: string;
  upstream_input_device: string;
  upstream_output_device: string;
  downstream_input_device: string;
  subtitle_font_size: number;
  subtitle_opacity: number;
  subtitle_bilingual: boolean;
  subtitle_x: number | null;
  subtitle_y: number | null;
  subtitle_width: number | null;
  subtitle_height: number | null;
  launch_at_login: boolean;
  shortcut_toggle: string;
  shortcut_subtitle: string;
  shortcut_bilingual: string;
};

export type AudioDevice = {
  index: number;
  name: string;
  channels: number;
  sample_rate: number;
};

export type EngineStatus = {
  upstream_running: boolean;
  downstream_running: boolean;
  last_error?: string | null;
};

export type UiEvent = {
  id: number;
  ts_ms: number;
  worker: string;
  kind: string;
  text: string;
};
```

- [ ] **Step 2: Create ipc.ts**

```typescript
// src/shared/ipc.ts
import { invoke } from "@tauri-apps/api/core";
import type { AppConfig, AudioDevice, EngineStatus, UiEvent } from "./config-types";

export const ipc = {
  loadConfig: () => invoke<AppConfig>("cmd_load_config"),
  saveConfig: (config: AppConfig) => invoke<void>("cmd_save_config", { config }),
  validateApiKey: (apiKey: string) => invoke<boolean>("validate_api_key", { apiKey }),
  listInputDevices: () => invoke<AudioDevice[]>("list_input_devices"),
  listOutputDevices: () => invoke<AudioDevice[]>("list_output_devices"),
  startUpstream: (req: {
    api_key: string;
    input_device: string;
    output_device: string;
    source_lang: string;
    target_lang: string;
    voice: string;
    model: string | null;
    ws_url: string | null;
  }) => invoke<string>("start_upstream", { req }),
  startDownstream: (req: {
    api_key: string;
    input_device: string;
    source_lang: string;
    target_lang: string;
    show_source: boolean;
    model: string | null;
    ws_url: string | null;
  }) => invoke<string>("start_downstream", { req }),
  stopAll: () => invoke<string>("stop_all"),
  stopWorker: (name: string) => invoke<string>("stop_worker_by_name", { name }),
  readStatus: () => invoke<EngineStatus>("read_status"),
  pollEvents: (afterId: number) => invoke<UiEvent[]>("poll_events", { afterId }),
  getSubtitleEvents: (afterId: number) => invoke<UiEvent[]>("get_subtitle_events", { afterId }),
};
```

- [ ] **Step 3: Create events.ts**

```typescript
// src/shared/events.ts
import { listen, emit } from "@tauri-apps/api/event";

// Event names for cross-window communication
export const EVENTS = {
  CONFIG_CHANGED: "voxbridge://config-changed",
  STATUS_CHANGED: "voxbridge://status-changed",
  SHOW_SETTINGS: "voxbridge://show-settings",
  SHOW_SUBTITLE: "voxbridge://show-subtitle",
  HIDE_SUBTITLE: "voxbridge://hide-subtitle",
} as const;

export { listen, emit };
```

- [ ] **Step 4: Create theme.css**

```css
/* src/shared/theme.css */
:root {
  --bg: #1a1a2e;
  --bg-card: #222240;
  --bg-input: #222240;
  --bg-hover: #2a2a4a;
  --ink: #e0e0e0;
  --muted: #888;
  --line: rgba(255, 255, 255, 0.06);
  --line-hover: rgba(255, 255, 255, 0.12);
  --green: #4ade80;
  --green-dim: rgba(74, 222, 128, 0.08);
  --green-border: #2d4a2d;
  --green-bg: #1e2a1e;
  --red: #f87171;
  --brand: #60a5fa;
  --font: -apple-system, "PingFang SC", "Segoe UI", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}

* { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  font-family: var(--font);
  font-size: 13px;
  color: var(--ink);
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
}

button {
  font: inherit;
  cursor: pointer;
  border: 1px solid var(--line);
  background: var(--bg-card);
  color: var(--ink);
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 12px;
}
button:hover { border-color: var(--line-hover); background: var(--bg-hover); }
button:disabled { opacity: 0.5; cursor: default; }

input, select {
  font: inherit;
  width: 100%;
  height: 32px;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  padding: 0 10px;
  background: var(--bg-input);
  color: var(--ink);
  font-size: 12px;
}
input:focus, select:focus { outline: 1px solid var(--brand); }

label {
  display: block;
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 4px;
}
```

- [ ] **Step 5: Commit**

```bash
git add src/shared/
git commit -m "feat: shared frontend utilities — types, IPC wrappers, events, theme CSS"
```

---

## Chunk 4: Menu Bar Panel Window

### Task 9: Build the menu bar panel UI

**Files:**
- Create: `src/panel/panel.html`
- Create: `src/panel/panel.ts`
- Create: `src/panel/panel.css`

- [ ] **Step 1: Create panel.css**

Import shared theme and add panel-specific styles. Key classes: `.panel` (16px padding), `.status-header` (flex row with status dot and app name), `.worker-card` (dark card with toggle, active state has green bg/border), `.toggle` (36x20px pill switch, green when `.on`), `.lang-tag` (inline pill, clickable), `.panel-footer` (flex row with settings/quit links). See mockup in brainstorm session for exact visual reference.

- [ ] **Step 2: Create panel.ts — render and status polling**

Build the panel DOM using `document.createElement` (avoid innerHTML for security). Key structure:
1. On load: `ipc.loadConfig()` and `ipc.readStatus()` to populate state
2. Build DOM: status header (green/gray dot), upstream card (toggle + language tags), downstream card (same), footer (settings + quit)
3. Toggle click → `ipc.startUpstream(...)` or `ipc.stopWorker("upstream")` depending on state; same for downstream
4. Settings button → open settings window via `WebviewWindow.getByLabel("settings")` or create new
5. Quit button → `exit(0)` from `@tauri-apps/plugin-process`
6. Poll `ipc.readStatus()` every 500ms, update toggle/dot states
7. Listen `EVENTS.CONFIG_CHANGED` → reload config and update language tags

Use `@tauri-apps/api/webviewWindow` for dynamic window creation.

- [ ] **Step 3: Add `@tauri-apps/plugin-process` dependency**

Run: `npm install @tauri-apps/plugin-process`

(Needed for `exit(0)` in quit button. Also add `"process:default"` to capabilities.)

- [ ] **Step 4: Verify dev mode works**

Run: `npm run tauri:dev`
Expected: App launches with tray icon. Click tray icon → panel appears.

- [ ] **Step 5: Commit**

```bash
git add src/panel/
git commit -m "feat: menu bar panel window — status, toggles, language switching"
```

---

## Chunk 5: Subtitle Overlay Window

### Task 10: Build the subtitle overlay

**Files:**
- Create: `src/subtitle/subtitle.html`
- Create: `src/subtitle/subtitle.ts`
- Create: `src/subtitle/subtitle.css`

- [ ] **Step 1: Create subtitle.html**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Voxbridge Subtitles</title>
  <link rel="stylesheet" href="./subtitle.css" />
</head>
<body>
  <div id="subtitle-root">
    <div id="control-bar" class="control-bar hidden">
      <button id="btn-font" class="ctrl-btn">Aa</button>
      <div class="ctrl-divider"></div>
      <button id="btn-mode" class="ctrl-btn">双语</button>
      <div class="ctrl-divider"></div>
      <div class="ctrl-opacity">
        <span class="ctrl-icon">◐</span>
        <input id="opacity-slider" type="range" min="20" max="100" value="75" />
      </div>
      <div class="ctrl-divider"></div>
      <button id="btn-pin" class="ctrl-btn">📌</button>
    </div>
    <div id="subtitle-body">
      <div id="source-text" class="source-text"></div>
      <div id="target-text" class="target-text"></div>
    </div>
    <div id="border-sentinel" class="border-sentinel"></div>
    <div id="resize-handle" class="resize-handle"></div>
  </div>
  <script type="module" src="./subtitle.ts"></script>
</body>
</html>
```

- [ ] **Step 2: Create subtitle.css**

Key styles:
- `body`: transparent background, no margin
- `#subtitle-root`: position relative, full window
- `#subtitle-body`: `background: rgba(10,10,20,var(--opacity))`, `backdrop-filter: blur(20px)`, `border-radius: 12px`, padding, text styles
- `.source-text`: smaller font, `opacity: 0.7`
- `.target-text`: larger font, full white
- `.control-bar`: positioned above subtitle body, dark bg with backdrop blur, flex row, hidden by default
- `.control-bar.visible`: shown with fade-in
- `.border-sentinel`: position absolute, inset 0, transparent, pointer-events auto (8px border zone), rest pointer-events none
- `.resize-handle`: bottom-right corner, 12px, cursor nwse-resize

- [ ] **Step 3: Create subtitle.ts**

Core logic:
1. On load: `getCurrentWindow().setIgnoreCursorEvents(true)` for click-through
2. Load config for font size, opacity, bilingual mode, window position/size
3. If saved position exists, move window to that position
4. **Border sentinel hover detection**: `mouseenter` on `#border-sentinel` → show control bar + `setIgnoreCursorEvents(false)`
5. **Mouse leave**: start 1.5s timer → hide control bar + `setIgnoreCursorEvents(true)`
6. **Control bar interactions**:
   - `btn-font`: cycle through 14/16/18/20px
   - `btn-mode`: toggle bilingual ↔ translation-only, update config
   - `opacity-slider`: update CSS variable + save to config
   - `btn-pin`: toggle position lock (disable drag when pinned)
7. **Resize handle**: mousedown → track mousemove → resize window via `getCurrentWindow().setSize()`, clamp to min/max. On mouseup save size to config.
8. **Drag**: mousedown on subtitle body (when controls visible and not pinned) → `getCurrentWindow().startDragging()`
9. **Subtitle text pipeline** (simplified from old `src/main.ts`):
   - Poll `ipc.getSubtitleEvents(lastEventId)` every 300ms
   - `target_partial` → update `#target-text` (and `#source-text` if bilingual + source data available)
   - `target_final` → commit text, clear partial
   - Same dedup logic: `normalizeSubtitleText`, `stripCommittedPrefix`, `collapseRepeatedLead`, `mergeLiveText`
   - Auto-commit partials after 1.4s idle
10. Listen for `EVENTS.HIDE_SUBTITLE` / `EVENTS.SHOW_SUBTITLE` to toggle visibility
11. Listen for `EVENTS.CONFIG_CHANGED` to refresh style settings

- [ ] **Step 4: Verify subtitle overlay works**

Run: `npm run tauri:dev`
Expected: Subtitle window appears transparent on top. Mouse passes through. Hover near edge → control bar appears.

- [ ] **Step 5: Commit**

```bash
git add src/subtitle/
git commit -m "feat: subtitle overlay — transparent, click-through, hover controls, text pipeline"
```

---

## Chunk 6: Settings Window

### Task 11: Build the settings window

**Files:**
- Create: `src/settings/settings.html`
- Create: `src/settings/settings.ts`
- Create: `src/settings/settings.css`

- [ ] **Step 1: Create settings.html**

Standard HTML with sidebar nav (5 tabs: General, Audio Devices, Subtitle Style, Shortcuts, About) and content area.

- [ ] **Step 2: Create settings.css**

Sidebar-content layout: sidebar 140px fixed, dark bg, active tab highlighted with green left border. Content area with form groups. Consistent with dark theme.

- [ ] **Step 3: Create settings.ts**

Logic:
1. On load: `ipc.loadConfig()` to populate all form fields
2. Sidebar tab navigation: click tab → show corresponding content section, hide others
3. **General tab**: API Key masked input with edit/reveal button. Language pair dropdowns. Voice input. Launch at login toggle.
4. **Audio Devices tab**: Three device selects (upstream in, upstream out, downstream in) populated via `ipc.listInputDevices()` / `ipc.listOutputDevices()`. Refresh button.
5. **Subtitle Style tab**: Font size slider, opacity slider, display mode toggle, reset position button.
6. **Shortcuts tab**: Three shortcut input fields (click to record key combination). Use `@tauri-apps/plugin-global-shortcut` to register/unregister.
7. **About tab**: Static content — version from package.json, Apache-2.0 license, GitHub link.
8. On any form change: `ipc.saveConfig(updatedConfig)` + `emit(EVENTS.CONFIG_CHANGED, updatedConfig)` to notify other windows.

- [ ] **Step 4: Wire settings window opening from panel**

The settings window is created on demand. In `panel.ts`, the "Settings" button should:
```typescript
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

const existing = await WebviewWindow.getByLabel("settings");
if (existing) {
  await existing.show();
  await existing.setFocus();
} else {
  new WebviewWindow("settings", {
    url: "settings/settings.html",
    title: "Voxbridge Settings",
    width: 500,
    height: 480,
    resizable: false,
    center: true,
  });
}
```

- [ ] **Step 5: Verify settings window works**

Run: `npm run tauri:dev`
Expected: Click "Settings" in panel → settings window opens. Change config → other windows react.

- [ ] **Step 6: Commit**

```bash
git add src/settings/
git commit -m "feat: settings window — general, audio, subtitle style, shortcuts, about"
```

---

## Chunk 7: Setup Wizard and Cleanup

### Task 12: Build the first-launch setup wizard

**Files:**
- Create: `src/setup/setup.html`
- Create: `src/setup/setup.ts`
- Create: `src/setup/setup.css`

- [ ] **Step 1: Create setup.html**

Single page with step container. Steps rendered dynamically via JS.

- [ ] **Step 2: Create setup.css**

Centered card layout, step indicators (dots or numbers), form styling consistent with dark theme. Transition between steps.

- [ ] **Step 3: Create setup.ts**

4-step flow:
1. **Welcome**: Logo + "Real-time speech translation for your desktop" + "Get Started" button
2. **API Key**: Input field + "Validate" button. On click: `ipc.validateApiKey(key)`. Success → green check, enable "Next". Failure → inline error + retry. "Skip" link → proceed without key.
3. **Audio Devices**: Auto-populate with `ipc.listInputDevices()` / `ipc.listOutputDevices()`. Pre-select recommended devices (MacBook mic for upstream input, BlackHole for upstream output and downstream input). User can change. "Next" saves selections.
4. **Done**: "All Set!" + show key shortcuts summary + "Start Using" button → save config, close setup window, show panel via tray.

On completion: `ipc.saveConfig(config)` + `emit(EVENTS.CONFIG_CHANGED)` + close this window.

- [ ] **Step 4: Verify wizard works**

Delete `~/.config/voxbridge/config.json`, run `npm run tauri:dev`.
Expected: Setup wizard appears on launch. Complete steps → wizard closes, tray icon active.

- [ ] **Step 5: Commit**

```bash
git add src/setup/
git commit -m "feat: first-launch setup wizard — 4-step guided configuration"
```

---

### Task 13: Delete old single-window frontend

**Files:**
- Delete: `src/main.ts`
- Delete: `src/style.css`
- Delete: `src/assets/` (unused template assets)

- [ ] **Step 1: Remove old files**

```bash
rm src/main.ts src/style.css
rm -rf src/assets/
```

- [ ] **Step 2: Verify build works**

Run: `npm run tauri:dev`
Expected: App launches with tray, panel, subtitle overlay. No old single-window UI.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "cleanup: remove old single-window frontend"
```

---

### Task 14: End-to-end verification

- [ ] **Step 1: Test first launch flow**

Delete config, launch app. Verify: wizard appears → enter API key → select devices → complete → tray icon active.

- [ ] **Step 2: Test menu bar panel**

Click tray icon → panel shows. Toggle upstream on → verify worker starts (check logs). Toggle downstream on. Toggle off individually. Change language → verify config saved.

- [ ] **Step 3: Test subtitle overlay**

Start downstream → subtitle window should show translated text. Verify click-through works. Hover edge → control bar appears. Change opacity, font size, bilingual mode. Pin position. Resize window.

- [ ] **Step 4: Test settings window**

Open from panel. Change API key, devices, subtitle style. Verify changes propagate to other windows via events.

- [ ] **Step 5: Test app quit**

Click "Quit" in panel → app exits completely (no orphan processes, no tray icon remaining).

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: Voxbridge UX redesign complete — menu bar app with subtitle overlay"
```

---

## Summary

| Chunk | Tasks | Description |
|-------|-------|-------------|
| 1 | 1–4 | Backend restructure: extract modules, config, new IPC commands, simplify downstream |
| 2 | 5–7 | Multi-window Tauri setup, system tray, Vite multi-page build |
| 3 | 8 | Shared frontend utilities (types, IPC, events, theme) |
| 4 | 9 | Menu bar panel window |
| 5 | 10 | Subtitle overlay window |
| 6 | 11 | Settings window |
| 7 | 12–14 | Setup wizard, cleanup old frontend, end-to-end verification |
