use serde::{Deserialize, Serialize};
use std::fs;

fn default_upstream_source() -> String {
    "yue".to_string()
}

fn default_upstream_target() -> String {
    "en".to_string()
}

fn default_voice() -> String {
    "Dylan".to_string()
}

fn default_downstream_source() -> String {
    "en".to_string()
}

fn default_downstream_target() -> String {
    "zh".to_string()
}

fn default_output_volume() -> f64 {
    1.0
}

fn default_subtitle_font_size() -> u32 {
    16
}

fn default_subtitle_opacity() -> f64 {
    0.75
}

fn default_subtitle_bilingual() -> bool {
    true
}

fn default_launch_at_login() -> bool {
    false
}

fn default_empty_string() -> String {
    String::new()
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
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

    #[serde(default)]
    pub upstream_input_device: String,

    #[serde(default)]
    pub upstream_output_device: String,

    #[serde(default)]
    pub downstream_input_device: String,

    #[serde(default)]
    pub downstream_output_device: String,

    #[serde(default)]
    pub downstream_voice_enabled: bool,

    #[serde(default = "default_output_volume")]
    pub output_volume: f64,

    #[serde(default = "default_subtitle_font_size")]
    pub subtitle_font_size: u32,

    #[serde(default = "default_subtitle_opacity")]
    pub subtitle_opacity: f64,

    #[serde(default = "default_subtitle_bilingual")]
    pub subtitle_bilingual: bool,

    #[serde(default)]
    pub subtitle_x: Option<f64>,

    #[serde(default)]
    pub subtitle_y: Option<f64>,

    #[serde(default)]
    pub subtitle_width: Option<f64>,

    #[serde(default)]
    pub subtitle_height: Option<f64>,

    #[serde(default = "default_launch_at_login")]
    pub launch_at_login: bool,

    #[serde(default = "default_empty_string")]
    pub shortcut_toggle: String,

    #[serde(default = "default_empty_string")]
    pub shortcut_subtitle: String,

    #[serde(default = "default_empty_string")]
    pub shortcut_bilingual: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            upstream_source: default_upstream_source(),
            upstream_target: default_upstream_target(),
            voice: default_voice(),
            downstream_source: default_downstream_source(),
            downstream_target: default_downstream_target(),
            upstream_input_device: String::new(),
            upstream_output_device: String::new(),
            downstream_input_device: String::new(),
            downstream_output_device: String::new(),
            downstream_voice_enabled: false,
            output_volume: default_output_volume(),
            subtitle_font_size: default_subtitle_font_size(),
            subtitle_opacity: default_subtitle_opacity(),
            subtitle_bilingual: default_subtitle_bilingual(),
            subtitle_x: None,
            subtitle_y: None,
            subtitle_width: None,
            subtitle_height: None,
            launch_at_login: default_launch_at_login(),
            shortcut_toggle: String::new(),
            shortcut_subtitle: String::new(),
            shortcut_bilingual: String::new(),
        }
    }
}

fn config_path() -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|d| d.join("voxbridge").join("config.json"))
}

pub fn load_config() -> AppConfig {
    let path = match config_path() {
        Some(p) => p,
        None => return AppConfig::default(),
    };
    let contents = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return AppConfig::default(),
    };
    serde_json::from_str(&contents).unwrap_or_default()
}

pub fn save_config(config: &AppConfig) -> Result<(), String> {
    let path = config_path().ok_or_else(|| "Could not determine config directory".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {}", e))?;
    }
    let json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write config: {}", e))?;
    Ok(())
}
