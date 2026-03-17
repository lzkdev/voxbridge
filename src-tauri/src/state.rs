use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32};
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
    pub output_device: Option<String>,
    pub voice: Option<String>,
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
    pub volume: f32,
}

pub struct WorkerHandle {
    pub stop: Arc<AtomicBool>,
    pub join: std::thread::JoinHandle<()>,
}

#[derive(Default)]
pub struct InnerState {
    pub upstream: Option<WorkerHandle>,
    pub downstream: Option<WorkerHandle>,
    pub events: VecDeque<UiEvent>,
    pub next_event_id: u64,
    pub last_error: Option<String>,
}

pub struct AppState {
    pub inner: Mutex<InnerState>,
    pub volume: AtomicU32,
}

impl Default for AppState {
    fn default() -> Self {
        let vol = crate::config::load_config().output_volume as f32;
        Self {
            inner: Mutex::default(),
            volume: AtomicU32::new(vol.to_bits()),
        }
    }
}

impl AppState {
    pub fn get_volume(&self) -> f32 {
        f32::from_bits(self.volume.load(std::sync::atomic::Ordering::Relaxed))
    }
    pub fn set_volume(&self, vol: f32) {
        self.volume.store(vol.to_bits(), std::sync::atomic::Ordering::Relaxed);
    }
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
