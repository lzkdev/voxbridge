import { invoke } from "@tauri-apps/api/core";
import type { AppConfig, AudioDevice, EngineStatus, UiEvent } from "./config-types";

export const ipc = {
  loadConfig: () => invoke<AppConfig>("cmd_load_config"),
  saveConfig: (cfg: AppConfig) => invoke<void>("cmd_save_config", { cfg }),
  validateApiKey: (apiKey: string) => invoke<boolean>("validate_api_key", { apiKey }),
  listInputDevices: () => invoke<AudioDevice[]>("list_input_devices"),
  listOutputDevices: () => invoke<AudioDevice[]>("list_output_devices"),
  startUpstream: (req: {
    api_key: string; input_device: string; output_device: string;
    source_lang: string; target_lang: string; voice: string;
    model: string | null; ws_url: string | null;
  }) => invoke<string>("start_upstream", { req }),
  startDownstream: (req: {
    api_key: string; input_device: string;
    source_lang: string; target_lang: string; show_source: boolean;
    output_device: string | null; voice: string | null;
    model: string | null; ws_url: string | null;
  }) => invoke<string>("start_downstream", { req }),
  stopAll: () => invoke<string>("stop_all"),
  stopWorker: (name: string) => invoke<string>("stop_worker_by_name", { name }),
  readStatus: () => invoke<EngineStatus>("read_status"),
  pollEvents: (afterId: number) => invoke<UiEvent[]>("poll_events", { afterId }),
  getSubtitleEvents: (afterId: number) => invoke<UiEvent[]>("get_subtitle_events", { afterId }),
  setVolume: (volume: number) => invoke<void>("set_volume", { volume }),
};
