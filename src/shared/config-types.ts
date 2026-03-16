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
  downstream_output_device: string;
  downstream_voice_enabled: boolean;
  output_volume: number;
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
