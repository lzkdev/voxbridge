pub mod config;
pub mod state;
pub mod tray;

use base64::Engine;
use tauri::Manager;
use config::AppConfig;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use state::{
    AppState, AudioDeviceInfo, DownstreamStartRequest, EngineStatus, InputConvertState, UiEvent,
    UpstreamStartRequest, WorkerConfig, WorkerHandle,
};
use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::net::{lookup_host, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::client_async_tls_with_config;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

const DEFAULT_WS_URL: &str = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
const DEFAULT_MODEL: &str = "qwen3-livetranslate-flash-realtime";
const GUMMY_WS_URL: &str = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
const GUMMY_MODEL: &str = "gummy-realtime-v1";
const DEFAULT_OUTPUT_RATE: u32 = 24000;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn push_event(state: &Arc<AppState>, worker: &str, kind: &str, text: impl Into<String>) {
    let mut guard = match state.inner.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    guard.next_event_id += 1;
    let event_id = guard.next_event_id;
    guard.events.push_back(UiEvent {
        id: event_id,
        ts_ms: now_ms(),
        worker: worker.to_string(),
        kind: kind.to_string(),
        text: text.into(),
    });
    while guard.events.len() > 2000 {
        let _ = guard.events.pop_front();
    }
}

fn set_last_error(state: &Arc<AppState>, message: String) {
    if let Ok(mut guard) = state.inner.lock() {
        guard.last_error = Some(message);
    }
}

fn clear_last_error(state: &Arc<AppState>) {
    if let Ok(mut guard) = state.inner.lock() {
        guard.last_error = None;
    }
}

fn select_input_device(selector: &str) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    let devices: Vec<cpal::Device> = host
        .input_devices()
        .map_err(|e| format!("List input devices failed: {}", e))?
        .collect();
    if devices.is_empty() {
        return Err("No input device found.".to_string());
    }
    if let Ok(idx) = selector.trim().parse::<usize>() {
        if let Some(dev) = devices.get(idx) {
            return Ok(dev.clone());
        }
    }
    for dev in &devices {
        let name = dev.name().unwrap_or_else(|_| "".to_string());
        if name == selector || name.contains(selector) {
            return Ok(dev.clone());
        }
    }
    Err(format!("Input device not found: {}", selector))
}

fn select_output_device(selector: &str) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    // Special value: use system default output
    if selector == "__default__" || selector.is_empty() || selector.starts_with("🔊") {
        return host
            .default_output_device()
            .ok_or_else(|| "No default output device found.".to_string());
    }
    let devices: Vec<cpal::Device> = host
        .output_devices()
        .map_err(|e| format!("List output devices failed: {}", e))?
        .collect();
    if devices.is_empty() {
        return Err("No output device found.".to_string());
    }
    if let Ok(idx) = selector.trim().parse::<usize>() {
        if let Some(dev) = devices.get(idx) {
            return Ok(dev.clone());
        }
    }
    for dev in &devices {
        let name = dev.name().unwrap_or_else(|_| "".to_string());
        if name == selector || name.contains(selector) {
            return Ok(dev.clone());
        }
    }
    // Fallback to system default output device
    eprintln!("[audio] Output device '{}' not found, falling back to default", selector);
    host.default_output_device()
        .ok_or_else(|| format!("Output device not found: {} (and no default available)", selector))
}

fn choose_input_config(
    device: &cpal::Device,
) -> Result<(cpal::StreamConfig, cpal::SampleFormat), String> {
    if let Ok(configs) = device.supported_input_configs() {
        for range in configs {
            if range.min_sample_rate().0 <= 16000 && 16000 <= range.max_sample_rate().0 {
                let cfg = range.with_sample_rate(cpal::SampleRate(16000)).config();
                return Ok((cfg, range.sample_format()));
            }
        }
    }
    let cfg = device
        .default_input_config()
        .map_err(|e| format!("default_input_config failed: {}", e))?;
    Ok((cfg.config(), cfg.sample_format()))
}

fn choose_output_config(
    device: &cpal::Device,
) -> Result<(cpal::StreamConfig, cpal::SampleFormat), String> {
    if let Ok(configs) = device.supported_output_configs() {
        for range in configs {
            if range.min_sample_rate().0 <= DEFAULT_OUTPUT_RATE
                && DEFAULT_OUTPUT_RATE <= range.max_sample_rate().0
            {
                let cfg = range
                    .with_sample_rate(cpal::SampleRate(DEFAULT_OUTPUT_RATE))
                    .config();
                return Ok((cfg, range.sample_format()));
            }
        }
    }
    let cfg = device
        .default_output_config()
        .map_err(|e| format!("default_output_config failed: {}", e))?;
    Ok((cfg.config(), cfg.sample_format()))
}

fn float_to_i16(v: f32) -> i16 {
    let clamped = v.clamp(-1.0, 1.0);
    (clamped * 32767.0) as i16
}

fn mono_f32_from_i16(data: &[i16], channels: u16) -> Vec<f32> {
    let c = usize::from(channels.max(1));
    let mut out = Vec::with_capacity(data.len() / c + 1);
    for frame in data.chunks(c) {
        let mut sum = 0.0f32;
        for &s in frame {
            sum += (s as f32) / 32768.0;
        }
        out.push(sum / c as f32);
    }
    out
}

fn mono_f32_from_u16(data: &[u16], channels: u16) -> Vec<f32> {
    let c = usize::from(channels.max(1));
    let mut out = Vec::with_capacity(data.len() / c + 1);
    for frame in data.chunks(c) {
        let mut sum = 0.0f32;
        for &s in frame {
            sum += ((s as f32) - 32768.0) / 32768.0;
        }
        out.push(sum / c as f32);
    }
    out
}

fn mono_f32_from_f32(data: &[f32], channels: u16) -> Vec<f32> {
    let c = usize::from(channels.max(1));
    let mut out = Vec::with_capacity(data.len() / c + 1);
    for frame in data.chunks(c) {
        let mut sum = 0.0f32;
        for &s in frame {
            sum += s;
        }
        out.push(sum / c as f32);
    }
    out
}

fn resample_to_16k(samples: &[f32], state: &mut InputConvertState) -> Vec<i16> {
    if state.in_rate == 16000 {
        return samples.iter().map(|&v| float_to_i16(v)).collect();
    }
    let mut src = Vec::with_capacity(samples.len() + 1);
    if let Some(prev) = state.prev {
        src.push(prev);
    }
    src.extend_from_slice(samples);
    if src.len() < 2 {
        state.prev = src.last().copied();
        return Vec::new();
    }

    let step = state.in_rate as f64 / 16000.0;
    let upper = (src.len() - 1) as f64;
    let mut pos = state.phase;
    let mut out =
        Vec::with_capacity((samples.len() as f64 * 16000.0 / state.in_rate as f64) as usize + 4);
    while pos < upper {
        let i = pos.floor() as usize;
        let frac = (pos - i as f64) as f32;
        let v = src[i] * (1.0 - frac) + src[i + 1] * frac;
        out.push(float_to_i16(v));
        pos += step;
    }
    state.phase = pos - upper;
    state.prev = src.last().copied();
    out
}

fn start_input_stream(
    cfg: &WorkerConfig,
    stop: Arc<AtomicBool>,
    tx: mpsc::UnboundedSender<Vec<i16>>,
) -> Result<cpal::Stream, String> {
    let device = select_input_device(&cfg.input_device)?;
    let (stream_cfg, fmt) = choose_input_config(&device)?;
    let channels = stream_cfg.channels;
    let in_rate = stream_cfg.sample_rate.0;
    let mut convert_state = InputConvertState::new(in_rate);

    let on_error = move |err| {
        eprintln!("[input-stream] {}", err);
    };

    let tx_i16 = tx.clone();
    let stop_i16 = stop.clone();
    let mut state_i16 = InputConvertState::new(in_rate);
    let tx_u16 = tx.clone();
    let stop_u16 = stop.clone();
    let mut state_u16 = InputConvertState::new(in_rate);
    let tx_f32 = tx;
    let stop_f32 = stop;

    match fmt {
        cpal::SampleFormat::I16 => device
            .build_input_stream(
                &stream_cfg,
                move |data: &[i16], _| {
                    if stop_i16.load(Ordering::SeqCst) {
                        return;
                    }
                    let mono = mono_f32_from_i16(data, channels);
                    let pcm16 = resample_to_16k(&mono, &mut state_i16);
                    if !pcm16.is_empty() {
                        let _ = tx_i16.send(pcm16);
                    }
                },
                on_error,
                None,
            )
            .map_err(|e| format!("build_input_stream i16 failed: {}", e)),
        cpal::SampleFormat::U16 => device
            .build_input_stream(
                &stream_cfg,
                move |data: &[u16], _| {
                    if stop_u16.load(Ordering::SeqCst) {
                        return;
                    }
                    let mono = mono_f32_from_u16(data, channels);
                    let pcm16 = resample_to_16k(&mono, &mut state_u16);
                    if !pcm16.is_empty() {
                        let _ = tx_u16.send(pcm16);
                    }
                },
                on_error,
                None,
            )
            .map_err(|e| format!("build_input_stream u16 failed: {}", e)),
        cpal::SampleFormat::F32 => device
            .build_input_stream(
                &stream_cfg,
                move |data: &[f32], _| {
                    if stop_f32.load(Ordering::SeqCst) {
                        return;
                    }
                    let mono = mono_f32_from_f32(data, channels);
                    let pcm16 = resample_to_16k(&mono, &mut convert_state);
                    if !pcm16.is_empty() {
                        let _ = tx_f32.send(pcm16);
                    }
                },
                on_error,
                None,
            )
            .map_err(|e| format!("build_input_stream f32 failed: {}", e)),
        _ => Err("Unsupported input sample format.".to_string()),
    }
}

fn resample_i16_linear(input: &[i16], in_rate: u32, out_rate: u32) -> Vec<i16> {
    if input.is_empty() || in_rate == out_rate {
        return input.to_vec();
    }
    let step = in_rate as f64 / out_rate as f64;
    let mut pos = 0.0f64;
    let upper = (input.len().saturating_sub(1)) as f64;
    let mut out =
        Vec::with_capacity((input.len() as f64 * out_rate as f64 / in_rate as f64) as usize + 8);
    while pos < upper {
        let i = pos.floor() as usize;
        let frac = (pos - i as f64) as f32;
        let a = input[i] as f32;
        let b = input[i + 1] as f32;
        out.push((a * (1.0 - frac) + b * frac) as i16);
        pos += step;
    }
    out
}

fn start_output_stream(
    output_device: &str,
    queue: Arc<Mutex<VecDeque<i16>>>,
    stop: Arc<AtomicBool>,
) -> Result<(cpal::Stream, u32), String> {
    let device = select_output_device(output_device)?;
    let (stream_cfg, fmt) = choose_output_config(&device)?;
    let out_rate = stream_cfg.sample_rate.0;
    let channels = stream_cfg.channels as usize;

    let queue_f32 = queue.clone();
    let stop_f32 = stop.clone();
    let ch_f32 = channels;
    let queue_i16 = queue.clone();
    let stop_i16 = stop.clone();
    let ch_i16 = channels;
    let queue_u16 = queue;
    let stop_u16 = stop;
    let ch_u16 = channels;

    let on_error = move |err| {
        eprintln!("[output-stream] {}", err);
    };

    // Audio from API is mono — duplicate to all output channels
    let stream = match fmt {
        cpal::SampleFormat::F32 => device
            .build_output_stream(
                &stream_cfg,
                move |data: &mut [f32], _| {
                    if stop_f32.load(Ordering::SeqCst) {
                        for s in data.iter_mut() {
                            *s = 0.0;
                        }
                        return;
                    }
                    let mut q = match queue_f32.lock() {
                        Ok(g) => g,
                        Err(_) => return,
                    };
                    for frame in data.chunks_mut(ch_f32) {
                        let val = q.pop_front().map(|v| (v as f32) / 32768.0).unwrap_or(0.0);
                        for s in frame.iter_mut() {
                            *s = val;
                        }
                    }
                },
                on_error,
                None,
            )
            .map_err(|e| format!("build_output_stream f32 failed: {}", e))?,
        cpal::SampleFormat::I16 => device
            .build_output_stream(
                &stream_cfg,
                move |data: &mut [i16], _| {
                    if stop_i16.load(Ordering::SeqCst) {
                        for s in data.iter_mut() {
                            *s = 0;
                        }
                        return;
                    }
                    let mut q = match queue_i16.lock() {
                        Ok(g) => g,
                        Err(_) => return,
                    };
                    for frame in data.chunks_mut(ch_i16) {
                        let val = q.pop_front().unwrap_or(0);
                        for s in frame.iter_mut() {
                            *s = val;
                        }
                    }
                },
                on_error,
                None,
            )
            .map_err(|e| format!("build_output_stream i16 failed: {}", e))?,
        cpal::SampleFormat::U16 => device
            .build_output_stream(
                &stream_cfg,
                move |data: &mut [u16], _| {
                    if stop_u16.load(Ordering::SeqCst) {
                        for s in data.iter_mut() {
                            *s = 32768;
                        }
                        return;
                    }
                    let mut q = match queue_u16.lock() {
                        Ok(g) => g,
                        Err(_) => return,
                    };
                    for frame in data.chunks_mut(ch_u16) {
                        let v = q.pop_front().unwrap_or(0);
                        let val = ((v as i32) + 32768).clamp(0, 65535) as u16;
                        for s in frame.iter_mut() {
                            *s = val;
                        }
                    }
                },
                on_error,
                None,
            )
            .map_err(|e| format!("build_output_stream u16 failed: {}", e))?,
        _ => return Err("Unsupported output sample format.".to_string()),
    };
    Ok((stream, out_rate))
}

fn extract_text(payload: &serde_json::Value) -> String {
    let candidates = [
        payload.get("text").and_then(|v| v.as_str()),
        payload.get("transcript").and_then(|v| v.as_str()),
        payload.get("delta").and_then(|v| v.as_str()),
        payload
            .get("part")
            .and_then(|v| v.get("text"))
            .and_then(|v| v.as_str()),
        payload
            .pointer("/response/output/0/content/0/text")
            .and_then(|v| v.as_str()),
    ];
    for c in candidates {
        if let Some(s) = c {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    String::new()
}

fn extract_audio_transcript_delta(payload: &serde_json::Value) -> String {
    let text = payload
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim();
    let stash = payload
        .get("stash")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim();
    match (stash.is_empty(), text.is_empty()) {
        (true, true) => String::new(),
        (false, true) => stash.to_string(),
        (true, false) => text.to_string(),
        (false, false) => format!("{}{}", stash, text),
    }
}

fn extract_response_done_text(payload: &serde_json::Value) -> String {
    let candidates = [
        payload
            .pointer("/response/output/0/content/0/transcript")
            .and_then(|v| v.as_str()),
        payload
            .pointer("/response/output/0/content/0/text")
            .and_then(|v| v.as_str()),
        payload
            .pointer("/item/content/0/transcript")
            .and_then(|v| v.as_str()),
        payload
            .pointer("/item/content/0/text")
            .and_then(|v| v.as_str()),
    ];
    for c in candidates {
        if let Some(s) = c {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    String::new()
}

fn normalize_lang(code: &str) -> String {
    let raw = code.trim().to_lowercase();
    match raw.as_str() {
        "zh-cn" | "zh-hans" => "zh".to_string(),
        _ => raw,
    }
}

fn is_gummy_model(model: &str) -> bool {
    model.trim().eq_ignore_ascii_case(GUMMY_MODEL)
}

fn default_ws_url_for_model(model: &str) -> String {
    if is_gummy_model(model) {
        GUMMY_WS_URL.to_string()
    } else {
        DEFAULT_WS_URL.to_string()
    }
}

fn request_host_port(
    request: &tokio_tungstenite::tungstenite::http::Request<()>,
) -> Result<(String, u16), String> {
    let uri = request.uri();
    let host = uri
        .host()
        .ok_or_else(|| "request uri missing host".to_string())?
        .to_string();
    let port = uri.port_u16().unwrap_or_else(|| match uri.scheme_str() {
        Some("wss") => 443,
        Some("ws") => 80,
        _ => 443,
    });
    Ok((host, port))
}

async fn connect_ws_stream(
    request: tokio_tungstenite::tungstenite::http::Request<()>,
    state: &Arc<AppState>,
    worker: &str,
) -> Result<
    (
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>,
        tokio_tungstenite::tungstenite::handshake::client::Response,
    ),
    String,
> {
    let (host, port) = request_host_port(&request)?;
    push_event(
        state,
        worker,
        "status",
        format!("ws_resolving {}:{}", host, port),
    );

    let resolved: Vec<SocketAddr> =
        tokio::time::timeout(Duration::from_secs(5), lookup_host((host.as_str(), port)))
            .await
            .map_err(|_| "DNS resolve timeout".to_string())?
            .map_err(|e| format!("DNS resolve failed: {}", e))?
            .collect();
    if resolved.is_empty() {
        return Err(format!(
            "DNS resolve returned no address for {}:{}",
            host, port
        ));
    }

    let mut ordered = resolved;
    ordered.sort_by_key(|addr| if addr.is_ipv4() { 0 } else { 1 });
    let printable = ordered
        .iter()
        .map(|addr| addr.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    push_event(
        state,
        worker,
        "status",
        format!("ws_resolved {}", printable),
    );

    let mut last_err = String::new();
    for addr in ordered {
        push_event(state, worker, "status", format!("tcp_connect {}", addr));
        let socket =
            match tokio::time::timeout(Duration::from_secs(4), TcpStream::connect(addr)).await {
                Ok(Ok(stream)) => stream,
                Ok(Err(err)) => {
                    last_err = format!("tcp connect {} failed: {}", addr, err);
                    push_event(state, worker, "status", last_err.clone());
                    continue;
                }
                Err(_) => {
                    last_err = format!("tcp connect {} timeout", addr);
                    push_event(state, worker, "status", last_err.clone());
                    continue;
                }
            };
        socket
            .set_nodelay(true)
            .map_err(|e| format!("set_nodelay failed: {}", e))?;
        push_event(state, worker, "status", format!("tcp_connected {}", addr));

        match tokio::time::timeout(
            Duration::from_secs(8),
            client_async_tls_with_config(request.clone(), socket, None, None),
        )
        .await
        {
            Ok(Ok(pair)) => {
                push_event(state, worker, "status", "tls_ready".to_string());
                return Ok(pair);
            }
            Ok(Err(err)) => {
                last_err = format!("tls/websocket handshake failed on {}: {}", addr, err);
                push_event(state, worker, "status", last_err.clone());
            }
            Err(_) => {
                last_err = format!("tls/websocket handshake timeout on {}", addr);
                push_event(state, worker, "status", last_err.clone());
            }
        }
    }

    Err(if last_err.is_empty() {
        "websocket connect failed".to_string()
    } else {
        last_err
    })
}

async fn run_qwen_worker(
    config: WorkerConfig,
    state: Arc<AppState>,
    stop: Arc<AtomicBool>,
) -> Result<(), String> {
    let worker = config.name.clone();
    push_event(
        &state,
        &worker,
        "status",
        format!(
            "connecting {} {}->{}",
            config.model, config.source_lang, config.target_lang
        ),
    );

    let (audio_tx, mut audio_rx) = mpsc::unbounded_channel::<Vec<i16>>();
    let input_stream = start_input_stream(&config, stop.clone(), audio_tx)?;
    input_stream
        .play()
        .map_err(|e| format!("input stream play failed: {}", e))?;
    push_event(&state, &worker, "status", "input_ready".to_string());

    let playback_queue: Option<Arc<Mutex<VecDeque<i16>>>> = if config.audio_output {
        Some(Arc::new(Mutex::new(VecDeque::with_capacity(24000))))
    } else {
        None
    };
    let (output_stream, out_rate) = if let (true, Some(device), Some(queue)) = (
        config.audio_output,
        config.output_device.clone(),
        playback_queue.clone(),
    ) {
        let (stream, rate) = start_output_stream(&device, queue, stop.clone())?;
        stream
            .play()
            .map_err(|e| format!("output stream play failed: {}", e))?;
        (Some(stream), Some(rate))
    } else {
        (None, None)
    };

    let ws_url = format!(
        "{}?model={}",
        config.ws_url,
        urlencoding::encode(&config.model)
    );
    push_event(&state, &worker, "status", "ws_connecting".to_string());
    let mut request = ws_url
        .into_client_request()
        .map_err(|e| format!("Invalid websocket URL: {}", e))?;
    let auth = format!("Bearer {}", config.api_key);
    request
        .headers_mut()
        .insert("Authorization", auth.parse().map_err(|e| format!("{}", e))?);
    let (ws_stream, _) = connect_ws_stream(request, &state, &worker).await?;
    push_event(&state, &worker, "status", "ws_connected".to_string());
    let (mut ws_write, mut ws_read) = ws_stream.split();

    let mut event_seq: u64 = 1;
    let next_event_id = |seq: &mut u64| {
        let id = format!("evt_{}", *seq);
        *seq += 1;
        id
    };

    let wants_streaming_transcript = config.audio_output || config.name == "downstream";
    let mut session_payload = json!({
        "modalities": if wants_streaming_transcript { json!(["text", "audio"]) } else { json!(["text"]) },
        "input_audio_format": "pcm16",
        "output_audio_format": "pcm24",
        "translation": {"language": normalize_lang(&config.target_lang)},
        "input_audio_transcription": {
            "model": "qwen3-asr-flash-realtime",
            "language": normalize_lang(&config.source_lang)
        }
    });
    if config.audio_output {
        session_payload["voice"] =
            json!(config.voice.clone().unwrap_or_else(|| "Dylan".to_string()));
    }

    let session = json!({
        "event_id": next_event_id(&mut event_seq),
        "type": "session.update",
        "session": session_payload
    });
    ws_write
        .send(Message::Text(session.to_string().into()))
        .await
        .map_err(|e| format!("session.update send failed: {}", e))?;
    push_event(&state, &worker, "status", "session_sent".to_string());

    push_event(
        &state,
        &worker,
        "status",
        "waiting_session_ready".to_string(),
    );

    let mut last_source_partial = String::new();
    let mut last_target_partial = String::new();
    let mut last_target_final = String::new();
    let mut session_ready = false;
    let session_wait_deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut last_audio_level_ms = 0u64;

    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        if !session_ready && tokio::time::Instant::now() > session_wait_deadline {
            return Err("session.updated timeout".to_string());
        }
        tokio::select! {
            maybe_audio = audio_rx.recv() => {
                if let Some(audio) = maybe_audio {
                    let now = now_ms();
                    if now.saturating_sub(last_audio_level_ms) >= 1000 {
                        let energy = audio
                            .iter()
                            .map(|s| {
                                let v = (*s as f32) / 32768.0;
                                v * v
                            })
                            .sum::<f32>();
                        let rms = if audio.is_empty() {
                            0.0
                        } else {
                            (energy / audio.len() as f32).sqrt()
                        };
                        push_event(&state, &worker, "audio_level", format!("rms={:.4}", rms));
                        last_audio_level_ms = now;
                    }
                    if !session_ready {
                        continue;
                    }
                    let mut bytes = Vec::with_capacity(audio.len() * 2);
                    for s in audio {
                        bytes.extend_from_slice(&s.to_le_bytes());
                    }
                    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
                    let event = json!({
                        "event_id": next_event_id(&mut event_seq),
                        "type":"input_audio_buffer.append",
                        "audio":b64
                    });
                    if let Err(err) = ws_write.send(Message::Text(event.to_string().into())).await {
                        return Err(format!("send audio failed: {}", err));
                    }
                } else {
                    break;
                }
            }
            maybe_msg = ws_read.next() => {
                let Some(msg_result) = maybe_msg else {
                    return Err("WebSocket closed.".to_string());
                };
                let msg = match msg_result {
                    Ok(m) => m,
                    Err(e) => return Err(format!("ws read error: {}", e)),
                };
                let Message::Text(txt) = msg else {
                    continue;
                };
                let payload: serde_json::Value = match serde_json::from_str(&txt) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let event_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or_default();
                match event_type {
                    "session.created" => {
                        push_event(&state, &worker, "status", "session_created".to_string());
                    }
                    "session.updated" => {
                        session_ready = true;
                        push_event(&state, &worker, "status", "running".to_string());
                    }
                    "session.finished" => {
                        if !last_target_partial.is_empty() && last_target_partial != last_target_final {
                            last_target_final = last_target_partial.clone();
                            push_event(&state, &worker, "target_final", last_target_partial.clone());
                            last_target_partial.clear();
                        }
                        push_event(&state, &worker, "status", "session_finished".to_string());
                        break;
                    }
                    "input_audio_buffer.speech_started" => {
                        push_event(&state, &worker, "speech", "speech_started".to_string());
                    }
                    "input_audio_buffer.speech_stopped" => {
                        if !last_target_partial.is_empty() && last_target_partial != last_target_final {
                            last_target_final = last_target_partial.clone();
                            push_event(&state, &worker, "target_final", last_target_partial.clone());
                            last_target_partial.clear();
                        }
                        push_event(&state, &worker, "speech", "speech_stopped".to_string());
                    }
                    "response.created" => {
                        push_event(&state, &worker, "status", "response_created".to_string());
                    }
                    "response.output_item.added" => {
                        push_event(&state, &worker, "status", "output_item_added".to_string());
                    }
                    "error" => {
                        let code = payload.pointer("/error/code").and_then(|v| v.as_str()).unwrap_or("");
                        let message = payload.pointer("/error/message").and_then(|v| v.as_str()).unwrap_or("");
                        let merged = format!("{} {}", code, message).trim().to_string();
                        push_event(&state, &worker, "error", merged.clone());
                        return Err(merged);
                    }
                    "conversation.item.input_audio_transcription.text" => {
                        let text = extract_text(&payload);
                        if !text.is_empty() && text != last_source_partial {
                            last_source_partial = text.clone();
                            if config.show_source {
                                push_event(&state, &worker, "source_partial", text);
                            }
                        }
                    }
                    "conversation.item.input_audio_transcription.completed" => {
                        let text = extract_text(&payload);
                        if !text.is_empty() {
                            if config.show_source {
                                push_event(&state, &worker, "source_final", text);
                            }
                            last_source_partial.clear();
                        }
                    }
                    "response.text.text" | "response.audio_transcript.text" => {
                        let text = if event_type == "response.audio_transcript.text" {
                            extract_audio_transcript_delta(&payload)
                        } else {
                            extract_text(&payload)
                        };
                        if !text.is_empty() && text != last_target_partial {
                            last_target_partial = text.clone();
                            push_event(&state, &worker, "target_partial", text);
                        }
                    }
                    "response.text.done" | "response.audio_transcript.done" => {
                        let text = extract_text(&payload);
                        if !text.is_empty() && text != last_target_final {
                            last_target_final = text.clone();
                            push_event(&state, &worker, "target_final", text);
                            last_target_partial.clear();
                        }
                    }
                    "response.output_item.done" | "response.done" => {
                        let text = extract_response_done_text(&payload);
                        if !text.is_empty() && text != last_target_final {
                            last_target_final = text.clone();
                            push_event(&state, &worker, "target_final", text);
                            last_target_partial.clear();
                        }
                    }
                    "response.audio.delta" if config.audio_output => {
                        let delta = payload.get("delta").and_then(|v| v.as_str()).unwrap_or("");
                        if delta.is_empty() {
                            continue;
                        }
                        let bytes = match base64::engine::general_purpose::STANDARD.decode(delta) {
                            Ok(v) => v,
                            Err(_) => continue,
                        };
                        let mut pcm = Vec::with_capacity(bytes.len() / 2);
                        for chunk in bytes.chunks_exact(2) {
                            pcm.push(i16::from_le_bytes([chunk[0], chunk[1]]));
                        }
                        if let (Some(queue), Some(orate)) = (playback_queue.as_ref(), out_rate) {
                            let out_pcm = resample_i16_linear(&pcm, DEFAULT_OUTPUT_RATE, orate);
                            let vol = state.get_volume();
                            if let Ok(mut q) = queue.lock() {
                                for s in out_pcm {
                                    let scaled = ((s as f32) * vol).clamp(-32768.0, 32767.0) as i16;
                                    q.push_back(scaled);
                                }
                                while q.len() > (orate as usize * 4) {
                                    let _ = q.pop_front();
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(40)) => {}
        }
    }

    // Release microphone IMMEDIATELY before WebSocket cleanup
    drop(input_stream);
    drop(output_stream);

    let _ = ws_write
        .send(Message::Text(
            json!({
                "event_id": next_event_id(&mut event_seq),
                "type":"session.finish"
            })
            .to_string()
            .into(),
        ))
        .await;
    if !last_target_partial.is_empty() && last_target_partial != last_target_final {
        push_event(&state, &worker, "target_final", last_target_partial.clone());
    }
    push_event(&state, &worker, "status", "stopped".to_string());
    Ok(())
}

async fn run_gummy_worker(
    config: WorkerConfig,
    state: Arc<AppState>,
    stop: Arc<AtomicBool>,
) -> Result<(), String> {
    let worker = config.name.clone();
    push_event(
        &state,
        &worker,
        "status",
        format!(
            "connecting {} {}->{}",
            config.model, config.source_lang, config.target_lang
        ),
    );

    let (audio_tx, mut audio_rx) = mpsc::unbounded_channel::<Vec<i16>>();
    let input_stream = start_input_stream(&config, stop.clone(), audio_tx)?;
    input_stream
        .play()
        .map_err(|e| format!("input stream play failed: {}", e))?;
    push_event(&state, &worker, "status", "input_ready".to_string());

    push_event(&state, &worker, "status", "ws_connecting".to_string());
    let mut request = config
        .ws_url
        .clone()
        .into_client_request()
        .map_err(|e| format!("Invalid websocket URL: {}", e))?;
    let auth = format!("Bearer {}", config.api_key);
    request
        .headers_mut()
        .insert("Authorization", auth.parse().map_err(|e| format!("{}", e))?);
    let (ws_stream, _) = connect_ws_stream(request, &state, &worker).await?;
    push_event(&state, &worker, "status", "ws_connected".to_string());
    let (mut ws_write, mut ws_read) = ws_stream.split();

    let task_id = format!("{}-{}", worker, now_ms());
    let run_task = json!({
        "header": {
            "action": "run-task",
            "task_id": task_id,
            "streaming": "duplex"
        },
        "payload": {
            "task_group": "audio",
            "task": "asr",
            "function": "recognition",
            "model": config.model,
            "input": {},
            "parameters": {
                "format": "pcm",
                "sample_rate": 16000,
                "source_language": normalize_lang(&config.source_lang),
                "transcription_enabled": config.show_source,
                "translation_enabled": true,
                "translation_target_languages": [normalize_lang(&config.target_lang)],
                "sentence_end": true
            }
        }
    });
    ws_write
        .send(Message::Text(run_task.to_string().into()))
        .await
        .map_err(|e| format!("run-task send failed: {}", e))?;
    push_event(&state, &worker, "status", "task_sent".to_string());

    let mut task_started = false;
    let task_wait_deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut last_audio_level_ms = 0u64;
    let mut last_source_partial = String::new();
    let mut last_target_partial = String::new();
    let mut last_target_final = String::new();
    let stop_check = stop.clone();

    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        if !task_started && tokio::time::Instant::now() > task_wait_deadline {
            return Err("task-started timeout".to_string());
        }

        tokio::select! {
            _ = async {
                loop {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    if stop_check.load(Ordering::SeqCst) { break; }
                }
            } => {
                break;
            }
            maybe_audio = audio_rx.recv() => {
                if let Some(audio) = maybe_audio {
                    let now = now_ms();
                    if now.saturating_sub(last_audio_level_ms) >= 1000 {
                        let energy = audio
                            .iter()
                            .map(|s| {
                                let v = (*s as f32) / 32768.0;
                                v * v
                            })
                            .sum::<f32>();
                        let rms = if audio.is_empty() { 0.0 } else { (energy / audio.len() as f32).sqrt() };
                        push_event(&state, &worker, "audio_level", format!("rms={:.4}", rms));
                        last_audio_level_ms = now;
                    }
                    if !task_started {
                        continue;
                    }
                    let mut bytes = Vec::with_capacity(audio.len() * 2);
                    for s in audio {
                        bytes.extend_from_slice(&s.to_le_bytes());
                    }
                    if let Err(err) = ws_write.send(Message::Binary(bytes.into())).await {
                        return Err(format!("send audio failed: {}", err));
                    }
                } else {
                    break;
                }
            }
            maybe_msg = ws_read.next() => {
                let Some(msg_result) = maybe_msg else {
                    return Err("WebSocket closed.".to_string());
                };
                let msg = match msg_result {
                    Ok(m) => m,
                    Err(e) => return Err(format!("ws read error: {}", e)),
                };
                let Message::Text(txt) = msg else {
                    continue;
                };
                let payload: serde_json::Value = match serde_json::from_str(&txt) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let event_type = payload
                    .pointer("/header/event")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                match event_type {
                    "task-started" => {
                        task_started = true;
                        push_event(&state, &worker, "status", "running".to_string());
                    }
                    "result-generated" => {
                        // Debug log
                        let se_trans = payload.pointer("/payload/output/translations/0/sentence_end");
                        let se_asr = payload.pointer("/payload/output/transcription/sentence_end");
                        log::info!("[gummy] sentence_end: asr={:?} trans={:?}", se_asr, se_trans);

                        if config.show_source {
                            let source_text = payload
                                .pointer("/payload/output/transcription/text")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .trim()
                                .to_string();
                            if !source_text.is_empty() && source_text != last_source_partial {
                                last_source_partial = source_text.clone();
                                push_event(&state, &worker, "source_partial", source_text);
                            }
                        }

                        let translation = payload
                            .pointer("/payload/output/translations/0/text")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .trim()
                            .to_string();
                        let sentence_end = payload
                            .pointer("/payload/output/transcription/sentence_end")
                            .or_else(|| payload.pointer("/payload/output/translations/0/sentence_end"))
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);

                        if !translation.is_empty() {
                            if sentence_end {
                                if translation != last_target_final {
                                    last_target_final = translation.clone();
                                    last_target_partial.clear();
                                    push_event(&state, &worker, "target_final", translation);
                                }
                            } else if translation != last_target_partial {
                                last_target_partial = translation.clone();
                                push_event(&state, &worker, "target_partial", translation);
                            }
                        }
                    }
                    "task-finished" => {
                        if !last_target_partial.is_empty() && last_target_partial != last_target_final {
                            last_target_final = last_target_partial.clone();
                            push_event(&state, &worker, "target_final", last_target_partial.clone());
                            last_target_partial.clear();
                        }
                        push_event(&state, &worker, "status", "task_finished".to_string());
                        break;
                    }
                    "task-failed" => {
                        let code = payload.pointer("/header/error_code").and_then(|v| v.as_str()).unwrap_or("");
                        let message = payload.pointer("/header/error_message").and_then(|v| v.as_str()).unwrap_or("");
                        let merged = format!("{} {}", code, message).trim().to_string();
                        push_event(&state, &worker, "error", merged.clone());
                        return Err(merged);
                    }
                    _ => {}
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(40)) => {}
        }
    }

    // Release microphone IMMEDIATELY before WebSocket cleanup
    drop(input_stream);

    let finish_task = json!({
        "header": {
            "action": "finish-task",
            "task_id": task_id,
            "streaming": "duplex"
        },
        "payload": {
            "input": {}
        }
    });
    let _ = ws_write
        .send(Message::Text(finish_task.to_string().into()))
        .await;
    if !last_target_partial.is_empty() && last_target_partial != last_target_final {
        push_event(&state, &worker, "target_final", last_target_partial.clone());
    }
    push_event(&state, &worker, "status", "stopped".to_string());
    Ok(())
}

async fn run_worker(
    config: WorkerConfig,
    state: Arc<AppState>,
    stop: Arc<AtomicBool>,
) -> Result<(), String> {
    if is_gummy_model(&config.model) {
        run_gummy_worker(config, state, stop).await
    } else {
        run_qwen_worker(config, state, stop).await
    }
}

fn stop_worker(slot: &mut Option<WorkerHandle>) {
    if let Some(worker) = slot.take() {
        worker.stop.store(true, Ordering::SeqCst);
        // Block until worker exits (with 2s timeout)
        let handle = worker.join;
        let start = std::time::Instant::now();
        while !handle.is_finished() {
            if start.elapsed() > std::time::Duration::from_secs(2) {
                log::warn!("stop_worker: timeout waiting for worker to finish");
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        if handle.is_finished() {
            let _ = handle.join();
        }
    }
}

fn stop_taken_worker(worker: Option<WorkerHandle>) {
    if let Some(worker) = worker {
        worker.stop.store(true, Ordering::SeqCst);
        // Join with a timeout so we don't block forever if the worker is stuck
        std::thread::spawn(move || {
            let handle = worker.join;
            // Wait up to 3 seconds for worker to finish, then let it be dropped
            let start = std::time::Instant::now();
            while !handle.is_finished() {
                if start.elapsed() > std::time::Duration::from_secs(3) {
                    log::warn!("worker thread did not finish in 3s, dropping handle");
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            if handle.is_finished() {
                let _ = handle.join();
            }
        });
    }
}

#[tauri::command]
fn list_input_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    let host = cpal::default_host();
    let mut out = Vec::new();
    let devices = host
        .input_devices()
        .map_err(|e| format!("List input devices failed: {}", e))?;
    for (idx, dev) in devices.enumerate() {
        let name = dev.name().unwrap_or_else(|_| "<unknown>".to_string());
        let cfg = dev.default_input_config().ok();
        let channels = cfg.as_ref().map(|c| c.channels()).unwrap_or(0);
        let sr = cfg.as_ref().map(|c| c.sample_rate().0).unwrap_or(0);
        out.push(AudioDeviceInfo {
            index: idx,
            name,
            channels,
            sample_rate: sr,
        });
    }
    Ok(out)
}

#[tauri::command]
fn list_output_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    let host = cpal::default_host();
    let mut out = Vec::new();

    // Add system default as first option
    if let Some(default_dev) = host.default_output_device() {
        let default_name = default_dev.name().unwrap_or_else(|_| "System Default".to_string());
        let cfg = default_dev.default_output_config().ok();
        out.push(AudioDeviceInfo {
            index: 0,
            name: format!("🔊 系統默認 ({})", default_name),
            channels: cfg.as_ref().map(|c| c.channels()).unwrap_or(0),
            sample_rate: cfg.as_ref().map(|c| c.sample_rate().0).unwrap_or(0),
        });
    }

    let devices = host
        .output_devices()
        .map_err(|e| format!("List output devices failed: {}", e))?;
    for (idx, dev) in devices.enumerate() {
        let name = dev.name().unwrap_or_else(|_| "<unknown>".to_string());
        log::info!("[output-devices] #{}: {}", idx, name);
        let cfg = dev.default_output_config().ok();
        let channels = cfg.as_ref().map(|c| c.channels()).unwrap_or(0);
        let sr = cfg.as_ref().map(|c| c.sample_rate().0).unwrap_or(0);
        out.push(AudioDeviceInfo {
            index: idx + 1,
            name,
            channels,
            sample_rate: sr,
        });
    }
    log::info!("[output-devices] total: {} devices", out.len());
    Ok(out)
}

#[tauri::command]
fn start_upstream(
    req: UpstreamStartRequest,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    if req.api_key.trim().is_empty() {
        return Err("api_key is empty".to_string());
    }
    if req.input_device.trim().is_empty() {
        return Err("input_device is empty".to_string());
    }
    if req.output_device.trim().is_empty() {
        return Err("output_device is empty".to_string());
    }
    let mut guard = state
        .inner
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    stop_worker(&mut guard.upstream);
    drop(guard);
    clear_last_error(state.inner());

    let model = req.model.unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let cfg = WorkerConfig {
        name: "upstream".to_string(),
        api_key: req.api_key,
        input_device: req.input_device,
        output_device: Some(req.output_device),
        source_lang: req.source_lang,
        target_lang: req.target_lang,
        voice: Some(if req.voice.trim().is_empty() {
            "Dylan".to_string()
        } else {
            req.voice
        }),
        model: model.clone(),
        ws_url: req
            .ws_url
            .unwrap_or_else(|| default_ws_url_for_model(&model)),
        audio_output: true,
        show_source: false,
        volume: {
            let c = config::load_config();
            c.output_volume as f32
        },
    };
    let app_state = state.inner().clone();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_task = stop.clone();
    let cfg_for_task = cfg.clone();
    let join = std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        let Ok(rt) = rt else {
            set_last_error(&app_state, "tokio runtime build failed".to_string());
            push_event(
                &app_state,
                "upstream",
                "error",
                "tokio runtime build failed",
            );
            return;
        };
        if let Err(err) = rt.block_on(run_worker(
            cfg_for_task,
            app_state.clone(),
            stop_for_task.clone(),
        )) {
            set_last_error(&app_state, err.clone());
            push_event(&app_state, "upstream", "error", err);
        }
    });
    let mut guard = state
        .inner
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    guard.upstream = Some(WorkerHandle { stop, join });
    Ok("upstream started".to_string())
}

#[tauri::command]
fn start_downstream(
    req: DownstreamStartRequest,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    if req.api_key.trim().is_empty() {
        return Err("api_key is empty".to_string());
    }
    if req.input_device.trim().is_empty() {
        return Err("input_device is empty".to_string());
    }
    let worker_name = "downstream".to_string();
    let old_worker = {
        let mut guard = state
            .inner
            .lock()
            .map_err(|_| "state lock poisoned".to_string())?;
        guard.downstream.take()
    };
    // Signal old worker to stop (if any)
    if let Some(ref w) = old_worker {
        w.stop.store(true, Ordering::SeqCst);
    }
    clear_last_error(state.inner());

    let has_audio_output = req.output_device.as_ref().map_or(false, |d| !d.trim().is_empty());
    // Use qwen3 model when audio output is needed, gummy otherwise
    let model = req.model.unwrap_or_else(|| {
        if has_audio_output { DEFAULT_MODEL.to_string() } else { GUMMY_MODEL.to_string() }
    });
    let cfg = WorkerConfig {
        name: worker_name.clone(),
        api_key: req.api_key,
        input_device: req.input_device,
        output_device: req.output_device.filter(|d| !d.trim().is_empty()),
        source_lang: req.source_lang,
        target_lang: req.target_lang,
        voice: req.voice.filter(|v| !v.trim().is_empty()),
        model: model.clone(),
        ws_url: req
            .ws_url
            .unwrap_or_else(|| default_ws_url_for_model(&model)),
        audio_output: has_audio_output,
        show_source: req.show_source,
        volume: {
            let c = config::load_config();
            c.output_volume as f32
        },
    };
    let app_state = state.inner().clone();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_task = stop.clone();
    let cfg_for_task = cfg.clone();
    let join = std::thread::spawn(move || {
        // Wait for old worker to fully stop before starting new one
        if let Some(old) = old_worker {
            let start = std::time::Instant::now();
            while !old.join.is_finished() {
                if start.elapsed() > std::time::Duration::from_secs(3) {
                    log::warn!("old downstream worker did not finish in 3s");
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            if old.join.is_finished() {
                let _ = old.join.join();
            }
        }

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        let Ok(rt) = rt else {
            set_last_error(&app_state, "tokio runtime build failed".to_string());
            push_event(
                &app_state,
                &worker_name,
                "error",
                "tokio runtime build failed",
            );
            return;
        };
        if let Err(err) = rt.block_on(run_worker(
            cfg_for_task,
            app_state.clone(),
            stop_for_task.clone(),
        )) {
            set_last_error(&app_state, err.clone());
            push_event(&app_state, &worker_name, "error", err);
        }
    });
    let mut guard = state
        .inner
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    guard.downstream = Some(WorkerHandle { stop, join });
    Ok("downstream started".to_string())
}

#[tauri::command]
fn stop_all(state: tauri::State<'_, Arc<AppState>>) -> Result<String, String> {
    let (upstream, downstream) = {
        let mut guard = state
            .inner
            .lock()
            .map_err(|_| "state lock poisoned".to_string())?;
        guard.last_error = None;
        (guard.upstream.take(), guard.downstream.take())
    };

    if upstream.is_some() {
        push_event(
            state.inner(),
            "upstream",
            "status",
            "stop_requested".to_string(),
        );
    }
    if downstream.is_some() {
        push_event(
            state.inner(),
            "downstream",
            "status",
            "stop_requested".to_string(),
        );
    }

    stop_taken_worker(upstream);
    stop_taken_worker(downstream);
    Ok("stopped".to_string())
}

#[tauri::command]
fn read_status(state: tauri::State<'_, Arc<AppState>>) -> Result<EngineStatus, String> {
    let guard = state
        .inner
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    Ok(EngineStatus {
        upstream_running: guard.upstream.is_some(),
        downstream_running: guard.downstream.is_some(),
        last_error: guard.last_error.clone(),
    })
}

#[tauri::command]
fn poll_events(
    after_id: Option<u64>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<UiEvent>, String> {
    let guard = state
        .inner
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    let min_id = after_id.unwrap_or(0);
    Ok(guard
        .events
        .iter()
        .filter(|e| e.id > min_id)
        .cloned()
        .collect())
}

#[tauri::command]
fn stop_worker_by_name(
    name: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let worker = {
        let mut guard = state
            .inner
            .lock()
            .map_err(|_| "state lock poisoned".to_string())?;
        match name.as_str() {
            "upstream" => guard.upstream.take(),
            "downstream" => guard.downstream.take(),
            other => return Err(format!("unknown worker: {}", other)),
        }
    };
    if worker.is_some() {
        push_event(state.inner(), &name, "status", "stop_requested".to_string());
    }
    stop_taken_worker(worker);
    Ok(format!("{} stopped", name))
}

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

#[tauri::command]
fn cmd_load_config() -> Result<AppConfig, String> {
    Ok(config::load_config())
}

#[tauri::command]
fn cmd_save_config(cfg: AppConfig) -> Result<(), String> {
    config::save_config(&cfg)
}

#[tauri::command]
fn validate_api_key(api_key: String) -> Result<bool, String> {
    Ok(!api_key.trim().is_empty())
}

#[tauri::command]
fn set_volume(state: tauri::State<'_, Arc<AppState>>, volume: f64) {
    state.set_volume(volume as f32);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    builder = builder.plugin(tauri_plugin_process::init());
    builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    builder = builder.plugin(tauri_plugin_clipboard_manager::init());

    // macOS: add default Edit menu so Cmd+C/V/X/A work in webview inputs
    #[cfg(target_os = "macos")]
    {
        use tauri::menu::{MenuBuilder, SubmenuBuilder};
        builder = builder.menu(|app| {
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            MenuBuilder::new(app).item(&edit_menu).build()
        });
    }

    builder
        .manage(Arc::new(AppState::default()))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            tray::setup_tray(app.handle())?;

            // Make subtitle window visible on all workspaces (macOS)
            #[cfg(target_os = "macos")]
            if let Some(subtitle_win) = app.handle().get_webview_window("subtitle") {
                let _ = subtitle_win.set_visible_on_all_workspaces(true);
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
            validate_api_key,
            set_volume
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
