import "./settings.css";
import { ipc } from "../shared/ipc";
import { EVENTS, emit } from "../shared/events";
import { setupClipboardShortcuts } from "../shared/clipboard";
import type { AppConfig, AudioDevice } from "../shared/config-types";
import { t } from "../shared/i18n/index.ts";

setupClipboardShortcuts();

let config: AppConfig | null = null;

// ------- tiny helper -------
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    e.setAttribute(k, v);
  }
  if (text !== undefined) e.textContent = text;
  return e;
}

function buildToggleSwitch(on: boolean): HTMLButtonElement {
  const btn = el("button", { class: on ? "toggle on" : "toggle", type: "button" });
  const knob = el("div", { class: "toggle-knob" });
  btn.appendChild(knob);
  return btn;
}

// ------- persist helper -------
async function save(): Promise<void> {
  if (!config) return;
  try {
    await ipc.saveConfig(config);
    await emit(EVENTS.CONFIG_CHANGED, config);
  } catch (e) {
    console.error("save config error:", e);
  }
}

// ------- General tab -------
function buildGeneralTab(): HTMLElement {
  const section = el("div", { class: "tab-section", id: "tab-general" });
  const h2 = el("h2", {}, t("settings.general"));
  section.appendChild(h2);

  // API Key
  const apiGroup = el("div", { class: "form-group" });
  const apiLabel = el("label", {}, "DashScope API Key");
  const apiRow = el("div", { class: "api-key-display" });

  const apiInput = el("input", { type: "password", placeholder: "sk-..." });
  apiInput.value = config?.api_key ?? "";

  const editBtn = el("button", { type: "button" }, t("settings.apiKeyEdit"));
  let apiEditable = false;

  editBtn.addEventListener("click", () => {
    apiEditable = !apiEditable;
    apiInput.type = apiEditable ? "text" : "password";
    apiInput.readOnly = !apiEditable;
    editBtn.textContent = apiEditable ? t("settings.apiKeyDone") : t("settings.apiKeyEdit");
    if (apiEditable) apiInput.focus();
  });

  apiInput.readOnly = true;
  apiInput.addEventListener("change", () => {
    if (config) {
      config.api_key = apiInput.value;
      void save();
    }
  });

  apiRow.appendChild(apiInput);
  apiRow.appendChild(editBtn);
  apiGroup.appendChild(apiLabel);
  apiGroup.appendChild(apiRow);
  section.appendChild(apiGroup);

  const div1 = el("hr", { class: "section-divider" });
  section.appendChild(div1);

  // Launch at login
  const loginGroup = el("div", { class: "form-group" });
  const loginRow = el("div", { class: "toggle-row" });
  const loginLabel = el("span", { class: "toggle-row-label" }, t("settings.launchAtLogin"));

  const loginToggle = buildToggleSwitch(config?.launch_at_login ?? false);
  loginToggle.addEventListener("click", () => {
    if (!config) return;
    config.launch_at_login = !config.launch_at_login;
    loginToggle.className = config.launch_at_login ? "toggle on" : "toggle";
    void save();
  });

  loginRow.appendChild(loginLabel);
  loginRow.appendChild(loginToggle);
  loginGroup.appendChild(loginRow);
  section.appendChild(loginGroup);

  return section;
}

// ------- Audio Devices tab -------
function deviceOptionText(d: AudioDevice): string {
  return `${d.index} | ${d.name} (ch=${d.channels}, sr=${d.sample_rate})`;
}

function populateSelect(sel: HTMLSelectElement, devices: AudioDevice[], currentValue: string): void {
  while (sel.firstChild) sel.removeChild(sel.firstChild);
  const blank = el("option", { value: "" }, t("settings.unselected"));
  sel.appendChild(blank);
  for (const d of devices) {
    const opt = el("option", { value: d.name }, deviceOptionText(d));
    if (d.name === currentValue) opt.selected = true;
    sel.appendChild(opt);
  }
}

function buildAudioTab(): { section: HTMLElement; refresh: () => Promise<void> } {
  const section = el("div", { class: "tab-section", id: "tab-audio" });
  const h2 = el("h2", {}, t("settings.audioDevices"));
  section.appendChild(h2);

  // Upstream Input
  const upInGroup = el("div", { class: "form-group" });
  const upInLabel = el("label", {}, t("settings.upstreamInput"));
  const upInSel = el("select", {});
  upInSel.addEventListener("change", () => {
    if (config) { config.upstream_input_device = upInSel.value; void save(); }
  });
  upInGroup.appendChild(upInLabel);
  upInGroup.appendChild(upInSel);
  section.appendChild(upInGroup);

  // Upstream Output
  const upOutGroup = el("div", { class: "form-group" });
  const upOutLabel = el("label", {}, t("settings.upstreamOutput"));
  const upOutSel = el("select", {});
  upOutSel.addEventListener("change", () => {
    if (config) { config.upstream_output_device = upOutSel.value; void save(); }
  });
  upOutGroup.appendChild(upOutLabel);
  upOutGroup.appendChild(upOutSel);
  section.appendChild(upOutGroup);

  // Downstream Input
  const downInGroup = el("div", { class: "form-group" });
  const downInLabel = el("label", {}, t("settings.downstreamInput"));
  const downInSel = el("select", {});
  downInSel.addEventListener("change", () => {
    if (config) { config.downstream_input_device = downInSel.value; void save(); }
  });
  downInGroup.appendChild(downInLabel);
  downInGroup.appendChild(downInSel);
  section.appendChild(downInGroup);

  // Refresh button
  const refreshBtn = el("button", { type: "button" }, t("settings.refreshDevices"));

  async function refresh(): Promise<void> {
    try {
      const [inputs, outputs] = await Promise.all([
        ipc.listInputDevices(),
        ipc.listOutputDevices(),
      ]);
      populateSelect(upInSel, inputs, config?.upstream_input_device ?? "");
      populateSelect(upOutSel, outputs, config?.upstream_output_device ?? "");
      populateSelect(downInSel, inputs, config?.downstream_input_device ?? "");
    } catch (e) {
      console.error("list devices error:", e);
    }
  }

  refreshBtn.addEventListener("click", () => void refresh());
  section.appendChild(refreshBtn);

  return { section, refresh };
}

// ------- Shortcuts tab -------
function buildShortcutsTab(): HTMLElement {
  const section = el("div", { class: "tab-section", id: "tab-shortcuts" });
  const h2 = el("h2", {}, t("settings.shortcuts"));
  section.appendChild(h2);

  type ShortcutKey = "shortcut_toggle" | "shortcut_subtitle" | "shortcut_bilingual";

  const shortcuts: { label: string; key: ShortcutKey }[] = [
    { label: t("settings.shortcutToggle"), key: "shortcut_toggle" },
    { label: t("settings.shortcutSubtitle"), key: "shortcut_subtitle" },
    { label: t("settings.shortcutBilingual"), key: "shortcut_bilingual" },
  ];

  for (const { label, key } of shortcuts) {
    const group = el("div", { class: "form-group" });
    const lbl = el("label", {}, label);
    const input = el("input", { type: "text", placeholder: "e.g. CommandOrControl+Shift+T" });
    input.value = config?.[key] ?? "";
    input.addEventListener("change", () => {
      if (config) {
        (config[key] as string) = input.value;
        void save();
      }
    });
    group.appendChild(lbl);
    group.appendChild(input);
    section.appendChild(group);
  }

  return section;
}

// ------- About tab -------
function buildAboutTab(): HTMLElement {
  const section = el("div", { class: "tab-section", id: "tab-about" });
  const h2 = el("h2", {}, t("settings.about"));
  section.appendChild(h2);

  const about = el("div", { class: "about-section" });

  const appName = el("div", { class: "about-app-name" }, "Voxbridge");
  about.appendChild(appName);

  const rows: [string, string][] = [
    [t("settings.aboutVersion"), "0.1.0"],
    [t("settings.aboutLicense"), "MIT"],
    ["GitHub", "https://github.com/lzkdev/voxbridge"],
  ];

  for (const [key, value] of rows) {
    const row = el("div");
    const keySpan = el("span", { class: "about-key" }, key + ": ");
    const valSpan = el("span", {}, value);
    row.appendChild(keySpan);
    row.appendChild(valSpan);
    about.appendChild(row);
  }

  const divider = el("hr", { class: "section-divider" });
  about.appendChild(divider);

  const desc = el("div");
  desc.textContent = t("settings.aboutDesc");
  about.appendChild(desc);

  section.appendChild(about);
  return section;
}

// ------- Build full settings UI -------
function buildSettings(): { refreshAudio: () => Promise<void> } {
  const app = document.getElementById("app");
  if (!app) return { refreshAudio: async () => {} };

  const layout = el("div", { class: "settings-layout" });

  // Sidebar
  const sidebar = el("div", { class: "sidebar" });

  const tabs = [
    { id: "general", label: t("settings.general") },
    { id: "audio", label: t("settings.audioDevices") },
    { id: "shortcuts", label: t("settings.shortcuts") },
    { id: "about", label: t("settings.about") },
  ];

  // Content area
  const content = el("div", { class: "content" });

  // Build tab sections
  const generalSection = buildGeneralTab();
  const { section: audioSection, refresh: refreshAudio } = buildAudioTab();
  const shortcutsSection = buildShortcutsTab();
  const aboutSection = buildAboutTab();

  const sectionMap: Record<string, HTMLElement> = {
    general: generalSection,
    audio: audioSection,
    shortcuts: shortcutsSection,
    about: aboutSection,
  };

  content.appendChild(generalSection);
  content.appendChild(audioSection);
  content.appendChild(shortcutsSection);
  content.appendChild(aboutSection);

  // Sidebar items + click handlers
  function activateTab(tabId: string): void {

    for (const item of sidebar.querySelectorAll(".sidebar-item")) {
      const itemEl = item as HTMLElement;
      const isActive = itemEl.dataset["tab"] === tabId;
      itemEl.className = isActive ? "sidebar-item active" : "sidebar-item";
    }

    for (const [id, sec] of Object.entries(sectionMap)) {
      sec.className = id === tabId ? "tab-section active" : "tab-section";
    }
  }

  for (const tab of tabs) {
    const item = el("div", { class: "sidebar-item" }, tab.label);
    item.dataset["tab"] = tab.id;
    item.addEventListener("click", () => activateTab(tab.id));
    sidebar.appendChild(item);
  }

  // Activate first tab
  activateTab("general");

  layout.appendChild(sidebar);
  layout.appendChild(content);
  app.appendChild(layout);

  return { refreshAudio };
}

// ------- Init -------
async function init(): Promise<void> {
  try {
    config = await ipc.loadConfig();
  } catch (e) {
    console.error("loadConfig error:", e);
    config = {
      api_key: "",
      upstream_source: "zh",
      upstream_target: "en",
      downstream_source: "en",
      downstream_target: "zh",
      voice: "alloy",
      upstream_input_device: "",
      upstream_output_device: "",
      downstream_input_device: "",
      downstream_output_device: "",
      downstream_voice_enabled: false,
      output_volume: 1,
      subtitle_font_size: 16,
      subtitle_opacity: 80,
      subtitle_bilingual: true,
      subtitle_x: null,
      subtitle_y: null,
      subtitle_width: null,
      subtitle_height: null,
      launch_at_login: false,
      shortcut_toggle: "CommandOrControl+Shift+T",
      shortcut_subtitle: "CommandOrControl+Shift+S",
      shortcut_bilingual: "CommandOrControl+Shift+B",
    };
  }

  const { refreshAudio } = buildSettings();

  // Pre-populate audio devices
  await refreshAudio();
}

void init();
