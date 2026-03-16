import { listen, emit } from "@tauri-apps/api/event";

export const EVENTS = {
  CONFIG_CHANGED: "voxbridge://config-changed",
  STATUS_CHANGED: "voxbridge://status-changed",
  SHOW_SETTINGS: "voxbridge://show-settings",
  SHOW_SUBTITLE: "voxbridge://show-subtitle",
  HIDE_SUBTITLE: "voxbridge://hide-subtitle",
} as const;

export { listen, emit };
