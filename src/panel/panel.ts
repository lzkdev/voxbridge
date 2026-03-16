import "./panel.css";
import { ipc } from "../shared/ipc";
import { EVENTS, listen, emit } from "../shared/events";
import { setupClipboardShortcuts } from "../shared/clipboard";
import type { AppConfig, EngineStatus, AudioDevice } from "../shared/config-types";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getLabelForCode, getSourceLanguages, getTargetsForSource, supportsAudio, getVoicesForLang } from "../shared/languages";
import { exit } from "@tauri-apps/plugin-process";
import { t, getLocale, setLocale, getAvailableLocales } from "../shared/i18n/index.ts";

setupClipboardShortcuts();

let config: AppConfig | null = null;
let status: EngineStatus = { upstream_running: false, downstream_running: false };

// DOM refs
let statusDot: HTMLElement;
let statusText: HTMLElement;
let upstreamCard: HTMLElement;
let downstreamCard: HTMLElement;
let upstreamToggle: HTMLElement;
let downstreamToggle: HTMLElement;

let upSrcSelect: HTMLSelectElement;
let upTgtSelect: HTMLSelectElement;
let upInputSelect: HTMLSelectElement;
let upOutputSelect: HTMLSelectElement;
let upVoiceSelect: HTMLSelectElement;

let downSrcSelect: HTMLSelectElement;
let downTgtSelect: HTMLSelectElement;
let downInputSelect: HTMLSelectElement;
let downVoiceToggle: HTMLElement;
let downVoiceOptions: HTMLElement;
let downOutputSelect: HTMLSelectElement;
let downVoiceSelect: HTMLSelectElement;
let downAudioWarn: HTMLElement;

// ─── helpers ────────────────────────────────────────────────────────────────

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

function buildToggle(on: boolean): HTMLElement {
  const btn = el("button", { class: on ? "toggle on" : "toggle" });
  btn.appendChild(el("div", { class: "toggle-knob" }));
  return btn;
}

function buildLangSelect(value: string, options: { code: string; label: string }[]): HTMLSelectElement {
  const sel = el("select", { class: "lang-select" }) as HTMLSelectElement;
  for (const opt of options) {
    const o = el("option", { value: opt.code }, opt.label);
    if (opt.code === value) o.selected = true;
    sel.appendChild(o);
  }
  return sel;
}

function repopulateSelect(
  sel: HTMLSelectElement,
  options: { code: string; label: string }[],
  preferred: string,
): void {
  while (sel.firstChild) sel.removeChild(sel.firstChild);
  for (const opt of options) {
    const o = el("option", { value: opt.code }, opt.label);
    if (opt.code === preferred) o.selected = true;
    sel.appendChild(o);
  }
}

function repopulateDeviceSelect(
  sel: HTMLSelectElement,
  devices: AudioDevice[],
  preferred: string,
): void {
  while (sel.firstChild) sel.removeChild(sel.firstChild);
  for (const d of devices) {
    const o = el("option", { value: d.name }, d.name);
    if (d.name === preferred) o.selected = true;
    sel.appendChild(o);
  }
}

function repopulateVoiceSelect(sel: HTMLSelectElement, langCode: string, preferred: string): void {
  while (sel.firstChild) sel.removeChild(sel.firstChild);
  const voices = getVoicesForLang(langCode);
  if (voices.length === 0) {
    sel.appendChild(el("option", { value: "" }, t("panel.noVoiceForLang")));
  } else {
    for (const v of voices) {
      const o = el("option", { value: v.id }, `${v.name} — ${v.desc}`);
      if (v.id === preferred) o.selected = true;
      sel.appendChild(o);
    }
  }
}

function buildDeviceRow(labelText: string, select: HTMLSelectElement): HTMLElement {
  const row = el("div", { class: "device-row" });
  row.appendChild(el("label", {}, labelText));
  row.appendChild(select);
  return row;
}

// ─── upstream card ──────────────────────────────────────────────────────────

function buildUpstreamCard(): HTMLElement {
  const cfg = config!;
  const card = el("div", { class: status.upstream_running ? "worker-card active" : "worker-card" });

  const header = el("div", { class: "worker-card-header" });
  header.appendChild(el("span", { class: "worker-title" }, t("panel.speechTranslation")));
  upstreamToggle = buildToggle(status.upstream_running);
  upstreamToggle.addEventListener("click", () => void handleUpstreamToggle());
  header.appendChild(upstreamToggle);
  card.appendChild(header);

  const langRow = el("div", { class: "lang-row" });
  upSrcSelect = buildLangSelect(cfg.upstream_source, getSourceLanguages());
  upTgtSelect = buildLangSelect(cfg.upstream_target, getTargetsForSource(cfg.upstream_source).map(c => ({ code: c, label: getLabelForCode(c) })));

  upSrcSelect.addEventListener("change", async () => {
    if (!config) return;
    config.upstream_source = upSrcSelect.value;
    repopulateSelect(upTgtSelect, getTargetsForSource(upSrcSelect.value).map(c => ({ code: c, label: getLabelForCode(c) })), upTgtSelect.value);
    config.upstream_target = upTgtSelect.value;
    repopulateVoiceSelect(upVoiceSelect, config.upstream_target, config.voice);
    await ipc.saveConfig(config);
  });
  upTgtSelect.addEventListener("change", async () => {
    if (!config) return;
    config.upstream_target = upTgtSelect.value;
    repopulateVoiceSelect(upVoiceSelect, config.upstream_target, config.voice);
    await ipc.saveConfig(config);
  });

  langRow.appendChild(upSrcSelect);
  langRow.appendChild(el("span", { class: "lang-arrow" }, "\u2192"));
  langRow.appendChild(upTgtSelect);
  card.appendChild(langRow);

  upInputSelect = el("select", { class: "device-select" }) as HTMLSelectElement;
  upInputSelect.addEventListener("change", async () => { if (config) { config.upstream_input_device = upInputSelect.value; await ipc.saveConfig(config); } });
  card.appendChild(buildDeviceRow(t("panel.inputDevice.mic"), upInputSelect));

  upOutputSelect = el("select", { class: "device-select" }) as HTMLSelectElement;
  upOutputSelect.addEventListener("change", async () => { if (config) { config.upstream_output_device = upOutputSelect.value; await ipc.saveConfig(config); } });
  card.appendChild(buildDeviceRow(t("panel.outputDevice.virtual"), upOutputSelect));

  upVoiceSelect = el("select", { class: "device-select" }) as HTMLSelectElement;
  repopulateVoiceSelect(upVoiceSelect, cfg.upstream_target, cfg.voice);
  upVoiceSelect.addEventListener("change", async () => { if (config) { config.voice = upVoiceSelect.value; await ipc.saveConfig(config); } });
  card.appendChild(buildDeviceRow(t("panel.voice"), upVoiceSelect));

  return card;
}

// ─── downstream card ─────────────────────────────────────────────────────────

function buildDownstreamCard(): HTMLElement {
  const cfg = config!;
  const card = el("div", { class: status.downstream_running ? "worker-card active" : "worker-card" });

  const header = el("div", { class: "worker-card-header" });
  header.appendChild(el("span", { class: "worker-title" }, t("panel.subtitleTranslation")));
  downstreamToggle = buildToggle(status.downstream_running);
  downstreamToggle.addEventListener("click", () => void handleDownstreamToggle());
  header.appendChild(downstreamToggle);
  card.appendChild(header);

  const langRow = el("div", { class: "lang-row" });
  downSrcSelect = buildLangSelect(cfg.downstream_source, getSourceLanguages());
  downTgtSelect = buildLangSelect(cfg.downstream_target, getTargetsForSource(cfg.downstream_source).map(c => ({ code: c, label: getLabelForCode(c) })));

  downSrcSelect.addEventListener("change", async () => {
    if (!config) return;
    config.downstream_source = downSrcSelect.value;
    repopulateSelect(downTgtSelect, getTargetsForSource(downSrcSelect.value).map(c => ({ code: c, label: getLabelForCode(c) })), downTgtSelect.value);
    config.downstream_target = downTgtSelect.value;
    updateDownVoiceSection();
    await ipc.saveConfig(config);
  });
  downTgtSelect.addEventListener("change", async () => {
    if (!config) return;
    config.downstream_target = downTgtSelect.value;
    updateDownVoiceSection();
    await ipc.saveConfig(config);
  });

  langRow.appendChild(downSrcSelect);
  langRow.appendChild(el("span", { class: "lang-arrow" }, "\u2192"));
  langRow.appendChild(downTgtSelect);
  card.appendChild(langRow);

  downInputSelect = el("select", { class: "device-select" }) as HTMLSelectElement;
  downInputSelect.addEventListener("change", async () => { if (config) { config.downstream_input_device = downInputSelect.value; await ipc.saveConfig(config); } });
  card.appendChild(buildDeviceRow(t("panel.inputDevice.audioBus"), downInputSelect));

  // voice output section
  const voiceSection = el("div", { class: "voice-section" });
  const voiceToggleRow = el("div", { class: "voice-toggle-row" });
  voiceToggleRow.appendChild(el("span", { class: "voice-label" }, t("panel.voiceOutput")));
  downVoiceToggle = buildToggle(cfg.downstream_voice_enabled);
  downVoiceToggle.addEventListener("click", async () => {
    if (!config) return;
    const tgt = config.downstream_target;
    if (!config.downstream_voice_enabled && !supportsAudio(tgt)) return;
    config.downstream_voice_enabled = !config.downstream_voice_enabled;
    downVoiceToggle.className = config.downstream_voice_enabled ? "toggle on" : "toggle";
    downVoiceOptions.style.display = config.downstream_voice_enabled ? "block" : "none";
    await ipc.saveConfig(config);
    await restartDownstreamIfRunning();
  });
  voiceToggleRow.appendChild(downVoiceToggle);
  voiceSection.appendChild(voiceToggleRow);

  downVoiceOptions = el("div", { class: "voice-options" });
  downVoiceOptions.style.display = cfg.downstream_voice_enabled ? "block" : "none";

  downOutputSelect = el("select", { class: "device-select" }) as HTMLSelectElement;
  downOutputSelect.addEventListener("change", async () => { if (config) { config.downstream_output_device = downOutputSelect.value; await ipc.saveConfig(config); await restartDownstreamIfRunning(); } });
  downVoiceOptions.appendChild(buildDeviceRow(t("panel.outputDevice"), downOutputSelect));

  downVoiceSelect = el("select", { class: "device-select" }) as HTMLSelectElement;
  repopulateVoiceSelect(downVoiceSelect, cfg.downstream_target, cfg.voice ?? "Cherry");
  downVoiceSelect.addEventListener("change", async () => { if (config) { config.voice = downVoiceSelect.value; await ipc.saveConfig(config); await restartDownstreamIfRunning(); } });
  downVoiceOptions.appendChild(buildDeviceRow(t("panel.voice"), downVoiceSelect));

  const volRow = el("div", { class: "device-row" });
  volRow.appendChild(el("label", {}, t("panel.volume")));
  const volSlider = el("input", { type: "range", min: "0", max: "200", step: "5", class: "device-select vol-slider" }) as HTMLInputElement;
  volSlider.value = String(Math.round((cfg.output_volume ?? 1) * 100));
  const volValue = el("span", { class: "vol-value" }, volSlider.value + "%");
  volSlider.addEventListener("input", () => { volValue.textContent = volSlider.value + "%"; });
  volSlider.addEventListener("change", async () => { if (config) { config.output_volume = parseInt(volSlider.value) / 100; await ipc.saveConfig(config); await restartDownstreamIfRunning(); } });
  const volInner = el("div", { class: "vol-inner" });
  volInner.appendChild(volSlider);
  volInner.appendChild(volValue);
  volRow.appendChild(volInner);
  downVoiceOptions.appendChild(volRow);

  downAudioWarn = el("div", { class: "voice-warn" });
  downVoiceOptions.appendChild(downAudioWarn);
  voiceSection.appendChild(downVoiceOptions);
  card.appendChild(voiceSection);

  return card;
}

function updateDownVoiceSection(): void {
  if (!config) return;
  const tgt = config.downstream_target;
  repopulateVoiceSelect(downVoiceSelect, tgt, config.voice ?? "Cherry");
  if (!supportsAudio(tgt)) {
    downAudioWarn.textContent = t("panel.voiceNotSupported", { lang: getLabelForCode(tgt) });
    downAudioWarn.style.display = "block";
    if (config.downstream_voice_enabled) {
      config.downstream_voice_enabled = false;
      downVoiceToggle.className = "toggle";
      downVoiceOptions.style.display = "none";
      void ipc.saveConfig(config);
    }
  } else {
    downAudioWarn.style.display = "none";
  }
}

// ─── settings tab ───────────────────────────────────────────────────────────

function buildSettingsTab(): HTMLElement {
  const wrap = el("div", { class: "settings-tab" });

  // API Key
  const apiGroup = el("div", { class: "settings-group" });
  apiGroup.appendChild(el("label", {}, "DashScope API Key"));
  const apiRow = el("div", { class: "api-key-row" });
  const apiInput = el("input", { type: "password", placeholder: "sk-...", class: "device-select" });
  apiInput.value = config?.api_key ?? "";
  const editBtn = el("button", { type: "button", class: "api-edit-btn" }, t("settings.apiKeyEdit"));
  let apiEditable = false;

  editBtn.addEventListener("click", () => {
    apiEditable = !apiEditable;
    apiInput.type = apiEditable ? "text" : "password";
    apiInput.readOnly = !apiEditable;
    editBtn.textContent = apiEditable ? t("settings.apiKeyDone") : t("settings.apiKeyEdit");
    if (apiEditable) apiInput.focus();
  });
  apiInput.readOnly = true;
  apiInput.addEventListener("change", async () => {
    if (config) {
      config.api_key = apiInput.value;
      await ipc.saveConfig(config);
      await emit(EVENTS.CONFIG_CHANGED, config);
    }
  });

  apiRow.appendChild(apiInput);
  apiRow.appendChild(editBtn);
  apiGroup.appendChild(apiRow);
  wrap.appendChild(apiGroup);

  // Language
  const langGroup = el("div", { class: "settings-group" });
  langGroup.appendChild(el("label", {}, t("settings.language")));
  const langSelect = el("select", { class: "device-select" }) as HTMLSelectElement;
  const currentLocale = getLocale();
  for (const loc of getAvailableLocales()) {
    const o = el("option", { value: loc.code }, loc.label);
    if (loc.code === currentLocale) o.selected = true;
    langSelect.appendChild(o);
  }
  langSelect.addEventListener("change", () => {
    setLocale(langSelect.value);
    location.reload();
  });
  langGroup.appendChild(langSelect);
  wrap.appendChild(langGroup);

  // About
  const aboutGroup = el("div", { class: "settings-group about-group" });
  aboutGroup.appendChild(el("div", { class: "about-name" }, "Voxbridge"));
  const infoLine = el("div", { class: "about-info" });
  infoLine.appendChild(el("span", { class: "about-muted" }, t("settings.aboutVersion") + " 0.1.0"));
  infoLine.appendChild(el("span", { class: "about-muted" }, " \u00b7 "));
  infoLine.appendChild(el("span", { class: "about-muted" }, t("settings.aboutLicense") + " MIT"));
  aboutGroup.appendChild(infoLine);
  aboutGroup.appendChild(el("div", { class: "about-desc" }, t("settings.aboutDesc")));
  wrap.appendChild(aboutGroup);

  return wrap;
}

// ─── full panel build ────────────────────────────────────────────────────────

function buildPanel(): void {
  const app = document.getElementById("app");
  if (!app) return;

  const panel = el("div", { class: "panel" });

  // Status header
  const header = el("div", { class: "status-header" });
  statusDot = el("div", { class: "status-dot" });
  header.appendChild(statusDot);
  header.appendChild(el("span", { class: "app-name" }, "Voxbridge"));
  statusText = el("span", { class: "status-text" }, t("panel.idle"));
  header.appendChild(statusText);
  panel.appendChild(header);

  // Tab bar
  const tabBar = el("div", { class: "tab-bar" });
  const tabTranslate = el("button", { class: "tab-btn active", type: "button" }, t("panel.tabTranslation"));
  const tabSettings = el("button", { class: "tab-btn", type: "button" }, t("panel.tabSettings"));
  tabBar.appendChild(tabTranslate);
  tabBar.appendChild(tabSettings);
  panel.appendChild(tabBar);

  // Tab content: Translation
  const translateContent = el("div", { class: "tab-content active", id: "tab-translate" });
  upstreamCard = buildUpstreamCard();
  translateContent.appendChild(upstreamCard);
  downstreamCard = buildDownstreamCard();
  translateContent.appendChild(downstreamCard);

  const refreshRow = el("div", { class: "refresh-row" });
  const refreshBtn = el("button", { type: "button", class: "refresh-btn" }, t("panel.refreshDevices"));
  refreshBtn.addEventListener("click", () => void loadDevices());
  refreshRow.appendChild(refreshBtn);
  translateContent.appendChild(refreshRow);
  panel.appendChild(translateContent);

  // Tab content: Settings
  const settingsContent = el("div", { class: "tab-content", id: "tab-settings" });
  settingsContent.appendChild(buildSettingsTab());
  panel.appendChild(settingsContent);

  // Tab switching
  tabTranslate.addEventListener("click", () => {
    tabTranslate.className = "tab-btn active";
    tabSettings.className = "tab-btn";
    translateContent.className = "tab-content active";
    settingsContent.className = "tab-content";
  });
  tabSettings.addEventListener("click", () => {
    tabTranslate.className = "tab-btn";
    tabSettings.className = "tab-btn active";
    translateContent.className = "tab-content";
    settingsContent.className = "tab-content active";
  });

  // Footer
  const footer = el("div", { class: "panel-footer" });
  const quitBtn = el("button", { type: "button", class: "footer-quit-btn" }, t("panel.quit"));
  quitBtn.addEventListener("click", () => void exit(0));
  footer.appendChild(quitBtn);
  panel.appendChild(footer);

  app.appendChild(panel);
}

// ─── toggle handlers ─────────────────────────────────────────────────────────

async function handleUpstreamToggle(): Promise<void> {
  if (!config) return;
  if (status.upstream_running) {
    try { await ipc.stopWorker("upstream"); } catch (e) { console.error("stop upstream:", e); }
  } else {
    try {
      await ipc.startUpstream({
        api_key: config.api_key, input_device: config.upstream_input_device,
        output_device: config.upstream_output_device, source_lang: config.upstream_source,
        target_lang: config.upstream_target, voice: config.voice, model: null, ws_url: null,
      });
    } catch (e) { console.error("start upstream:", e); }
  }
  await refreshStatus();
}

async function handleDownstreamToggle(): Promise<void> {
  if (!config) return;
  if (status.downstream_running) {
    try { await ipc.stopWorker("downstream"); } catch (e) { console.error("stop downstream:", e); }
  } else {
    try {
      await ipc.startDownstream({
        api_key: config.api_key, input_device: config.downstream_input_device,
        source_lang: config.downstream_source, target_lang: config.downstream_target,
        show_source: config.subtitle_bilingual,
        output_device: config.downstream_voice_enabled ? config.downstream_output_device : null,
        voice: config.downstream_voice_enabled ? (config.voice || "Cherry") : null,
        model: null, ws_url: null,
      });
    } catch (e) { console.error("start downstream:", e); }
    await showSubtitleWindow();
  }
  await refreshStatus();
  if (!status.downstream_running) {
    const sub = await WebviewWindow.getByLabel("subtitle");
    if (sub) await sub.hide();
  }
}

async function restartDownstreamIfRunning(): Promise<void> {
  if (!config) return;
  try { const st = await ipc.readStatus(); if (!st.downstream_running) return; } catch (_) { return; }
  try {
    await ipc.startDownstream({
      api_key: config.api_key, input_device: config.downstream_input_device,
      source_lang: config.downstream_source, target_lang: config.downstream_target,
      show_source: config.subtitle_bilingual,
      output_device: config.downstream_voice_enabled ? config.downstream_output_device : null,
      voice: config.downstream_voice_enabled ? (config.voice || "Cherry") : null,
      model: null, ws_url: null,
    });
  } catch (e) { console.error("restart downstream:", e); }
  await refreshStatus();
}

// ─── device loading ──────────────────────────────────────────────────────────

async function loadDevices(): Promise<void> {
  try {
    const [inputs, outputs] = await Promise.all([ipc.listInputDevices(), ipc.listOutputDevices()]);
    repopulateDeviceSelect(upInputSelect, inputs, config?.upstream_input_device ?? "");
    repopulateDeviceSelect(upOutputSelect, outputs, config?.upstream_output_device ?? "");
    repopulateDeviceSelect(downInputSelect, inputs, config?.downstream_input_device ?? "");
    repopulateDeviceSelect(downOutputSelect, outputs, config?.downstream_output_device ?? "");
  } catch (e) { console.error("loadDevices error:", e); }
}

// ─── status / config UI updates ──────────────────────────────────────────────

function updateStatusUi(): void {
  const anyActive = status.upstream_running || status.downstream_running;
  statusDot.className = anyActive ? "status-dot active" : "status-dot";
  statusText.textContent = anyActive ? t("panel.running") : t("panel.idle");
  upstreamToggle.className = status.upstream_running ? "toggle on" : "toggle";
  upstreamCard.className = status.upstream_running ? "worker-card active" : "worker-card";
  downstreamToggle.className = status.downstream_running ? "toggle on" : "toggle";
  downstreamCard.className = status.downstream_running ? "worker-card active" : "worker-card";
}

function updateConfigUi(): void {
  if (!config) return;
  upSrcSelect.value = config.upstream_source;
  repopulateSelect(upTgtSelect, getTargetsForSource(config.upstream_source).map(c => ({ code: c, label: getLabelForCode(c) })), config.upstream_target);
  repopulateVoiceSelect(upVoiceSelect, config.upstream_target, config.voice);
  downSrcSelect.value = config.downstream_source;
  repopulateSelect(downTgtSelect, getTargetsForSource(config.downstream_source).map(c => ({ code: c, label: getLabelForCode(c) })), config.downstream_target);
  repopulateVoiceSelect(downVoiceSelect, config.downstream_target, config.voice ?? "Cherry");
  downVoiceToggle.className = config.downstream_voice_enabled ? "toggle on" : "toggle";
  downVoiceOptions.style.display = config.downstream_voice_enabled ? "block" : "none";
  upInputSelect.value = config.upstream_input_device;
  upOutputSelect.value = config.upstream_output_device;
  downInputSelect.value = config.downstream_input_device;
  downOutputSelect.value = config.downstream_output_device;
  updateDownVoiceSection();
}

async function refreshStatus(): Promise<void> {
  try { status = await ipc.readStatus(); updateStatusUi(); } catch (e) { console.error("read status error:", e); }
}

async function showSubtitleWindow(): Promise<void> {
  try {
    const sub = await WebviewWindow.getByLabel("subtitle");
    if (sub) { await sub.show(); await sub.setFocus(); }
  } catch (e) { console.error("showSubtitleWindow error:", e); }
}

// ─── init ────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  try {
    [config, status] = await Promise.all([ipc.loadConfig(), ipc.readStatus()]);
  } catch (e) {
    console.error("init error:", e);
    config = null;
    status = { upstream_running: false, downstream_running: false };
  }

  buildPanel();
  updateStatusUi();
  await loadDevices();
  setInterval(() => void refreshStatus(), 500);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void loadDevices();
  });

  await listen(EVENTS.CONFIG_CHANGED, async () => {
    try { config = await ipc.loadConfig(); updateConfigUi(); await loadDevices(); } catch (e) { console.error("config reload error:", e); }
  });
}

void init();
