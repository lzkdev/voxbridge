import "./setup.css";
import { ipc } from "../shared/ipc";
import { EVENTS, emit } from "../shared/events";
import { setupClipboardShortcuts } from "../shared/clipboard";
import type { AppConfig, AudioDevice } from "../shared/config-types";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { t } from "../shared/i18n/index.ts";

setupClipboardShortcuts();

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

// ------- State collected across steps -------
const collected: {
  apiKey: string;
  upstreamInput: string;
  upstreamOutput: string;
  downstreamInput: string;
} = {
  apiKey: "",
  upstreamInput: "",
  upstreamOutput: "",
  downstreamInput: "",
};

// ------- Step management -------
const TOTAL_STEPS = 4;
let currentStep = 1;

let stepDots: HTMLElement[] = [];
let stepEls: HTMLElement[] = [];

function updateDots(): void {
  for (let i = 0; i < TOTAL_STEPS; i++) {
    const dot = stepDots[i];
    if (!dot) continue;
    const stepNum = i + 1;
    if (stepNum < currentStep) {
      dot.className = "step-dot done";
    } else if (stepNum === currentStep) {
      dot.className = "step-dot active";
    } else {
      dot.className = "step-dot";
    }
  }
}

function goToStep(n: number): void {
  currentStep = n;
  for (let i = 0; i < stepEls.length; i++) {
    const stepEl = stepEls[i];
    if (stepEl) {
      stepEl.className = i + 1 === n ? "step active" : "step";
    }
  }
  updateDots();
}

// ------- Device option text -------
function deviceOptionText(d: AudioDevice): string {
  return `${d.index} | ${d.name} (ch=${d.channels}, sr=${d.sample_rate})`;
}

function autoSelectDevice(devices: AudioDevice[], preferKeywords: string[]): string {
  for (const kw of preferKeywords) {
    const found = devices.find((d) => d.name.toLowerCase().includes(kw.toLowerCase()));
    if (found) return found.name;
  }
  return devices[0]?.name ?? "";
}

function populateSelect(
  sel: HTMLSelectElement,
  devices: AudioDevice[],
  autoValue: string,
): void {
  while (sel.firstChild) sel.removeChild(sel.firstChild);
  const blank = el("option", { value: "" }, t("setup.unselected"));
  sel.appendChild(blank);
  for (const d of devices) {
    const opt = el("option", { value: d.name }, deviceOptionText(d));
    if (d.name === autoValue) opt.selected = true;
    sel.appendChild(opt);
  }
  if (autoValue) sel.value = autoValue;
}

// ------- Step 1: Welcome -------
function buildStep1(): HTMLElement {
  const step = el("div", { class: "step", id: "step-1" });

  const logo = el("div", { class: "logo" }, "Voxbridge");
  step.appendChild(logo);

  const tagline = el("div", { class: "tagline" }, "Real-time speech translation for your desktop");
  step.appendChild(tagline);

  const startBtn = el("button", { class: "btn-primary", type: "button" }, t("setup.startSetup"));
  startBtn.addEventListener("click", () => goToStep(2));
  step.appendChild(startBtn);

  return step;
}

// ------- Step 2: API Key -------
function buildStep2(): HTMLElement {
  const step = el("div", { class: "step", id: "step-2" });

  const formGroup = el("div", { class: "form-group" });
  const label = el("label", {}, "DashScope API Key");
  const apiInput = el("input", { type: "password", placeholder: "sk-..." }) as HTMLInputElement;
  formGroup.appendChild(label);
  formGroup.appendChild(apiInput);
  step.appendChild(formGroup);

  const validateBtn = el("button", { class: "btn-primary", type: "button" }, t("setup.validate"));
  step.appendChild(validateBtn);

  const feedbackEl = el("div", {});
  step.appendChild(feedbackEl);

  let nextBtn: HTMLButtonElement | null = null;

  validateBtn.addEventListener("click", async () => {
    const val = apiInput.value.trim();
    if (!val) {
      while (feedbackEl.firstChild) feedbackEl.removeChild(feedbackEl.firstChild);
      const err = el("div", { class: "error-msg" }, t("setup.apiKeyEmpty"));
      feedbackEl.appendChild(err);
      return;
    }

    validateBtn.disabled = true;
    validateBtn.textContent = t("setup.validating");
    while (feedbackEl.firstChild) feedbackEl.removeChild(feedbackEl.firstChild);

    try {
      const ok = await ipc.validateApiKey(val);
      validateBtn.disabled = false;
      validateBtn.textContent = t("setup.validate");

      if (ok) {
        collected.apiKey = val;
        while (feedbackEl.firstChild) feedbackEl.removeChild(feedbackEl.firstChild);
        const check = el("div", { class: "success-msg" }, t("setup.apiKeySuccess"));
        feedbackEl.appendChild(check);

        if (!nextBtn) {
          nextBtn = el("button", { class: "btn-primary btn-primary--mt", type: "button" }, t("setup.next")) as HTMLButtonElement;
          nextBtn.addEventListener("click", () => goToStep(3));
          step.appendChild(nextBtn);
        }
      } else {
        while (feedbackEl.firstChild) feedbackEl.removeChild(feedbackEl.firstChild);
        const err = el("div", { class: "error-msg" }, t("setup.apiKeyEmpty"));
        feedbackEl.appendChild(err);
      }
    } catch (_e) {
      validateBtn.disabled = false;
      validateBtn.textContent = t("setup.validate");
      while (feedbackEl.firstChild) feedbackEl.removeChild(feedbackEl.firstChild);
      const err = el("div", { class: "error-msg" }, t("setup.validateFailed"));
      feedbackEl.appendChild(err);
    }
  });

  const skipBtn = el("button", { class: "btn-skip", type: "button" }, t("setup.skip"));
  skipBtn.addEventListener("click", () => goToStep(3));
  step.appendChild(skipBtn);

  return step;
}

// ------- Step 3: Audio Devices -------
function buildStep3(): { step: HTMLElement; loadDevices: () => Promise<void> } {
  const step = el("div", { class: "step", id: "step-3" });

  const heading = el("div", { class: "logo logo--sub" }, t("setup.audioDevices"));
  step.appendChild(heading);

  const tagline = el("div", { class: "tagline" }, t("setup.selectAudioDevices"));
  step.appendChild(tagline);

  // Upstream input (mic)
  const upInGroup = el("div", { class: "device-select" });
  const upInLabel = el("label", {}, t("setup.upstreamInput"));
  const upInSel = el("select", {}) as HTMLSelectElement;
  upInSel.addEventListener("change", () => { collected.upstreamInput = upInSel.value; });
  upInGroup.appendChild(upInLabel);
  upInGroup.appendChild(upInSel);
  step.appendChild(upInGroup);

  // Upstream output (virtual device)
  const upOutGroup = el("div", { class: "device-select" });
  const upOutLabel = el("label", {}, t("setup.upstreamOutput"));
  const upOutSel = el("select", {}) as HTMLSelectElement;
  upOutSel.addEventListener("change", () => { collected.upstreamOutput = upOutSel.value; });
  upOutGroup.appendChild(upOutLabel);
  upOutGroup.appendChild(upOutSel);
  step.appendChild(upOutGroup);

  // Downstream input (meeting audio)
  const downInGroup = el("div", { class: "device-select" });
  const downInLabel = el("label", {}, t("setup.downstreamInput"));
  const downInSel = el("select", {}) as HTMLSelectElement;
  downInSel.addEventListener("change", () => { collected.downstreamInput = downInSel.value; });
  downInGroup.appendChild(downInLabel);
  downInGroup.appendChild(downInSel);
  step.appendChild(downInGroup);

  const nextBtn = el("button", { class: "btn-primary", type: "button" }, t("setup.next"));
  nextBtn.addEventListener("click", () => {
    // Capture final selected values before moving on
    collected.upstreamInput = upInSel.value;
    collected.upstreamOutput = upOutSel.value;
    collected.downstreamInput = downInSel.value;
    goToStep(4);
  });
  step.appendChild(nextBtn);

  async function loadDevices(): Promise<void> {
    try {
      const [inputs, outputs] = await Promise.all([
        ipc.listInputDevices(),
        ipc.listOutputDevices(),
      ]);

      const upInAuto = autoSelectDevice(inputs, ["macbook", "built-in"]);
      const upOutAuto = autoSelectDevice(outputs, ["blackhole", "voicemod"]);
      const downInAuto = autoSelectDevice(inputs, ["blackhole", "voicemod"]);

      populateSelect(upInSel, inputs, upInAuto);
      populateSelect(upOutSel, outputs, upOutAuto);
      populateSelect(downInSel, inputs, downInAuto);

      collected.upstreamInput = upInSel.value;
      collected.upstreamOutput = upOutSel.value;
      collected.downstreamInput = downInSel.value;
    } catch (e) {
      console.error("listDevices error:", e);
    }
  }

  return { step, loadDevices };
}

// ------- Step 4: Done -------
function buildStep4(): HTMLElement {
  const step = el("div", { class: "step", id: "step-4" });

  const icon = el("div", { class: "success-icon" });
  step.appendChild(icon);

  const heading = el("div", { class: "logo logo--done" }, t("setup.allSet"));
  step.appendChild(heading);

  const hintHeading = el("div", { class: "tagline tagline--hint" }, t("setup.shortcutHints"));
  step.appendChild(hintHeading);

  const hints = [
    t("setup.hint1"),
    t("setup.hint2"),
    t("setup.hint3"),
    t("setup.hint4"),
  ];
  const ul = el("ul", { class: "shortcut-list" });
  for (const hint of hints) {
    const li = el("li", {}, hint);
    ul.appendChild(li);
  }
  step.appendChild(ul);

  const startBtn = el("button", { class: "btn-primary btn-primary--spaced", type: "button" }, t("setup.startUsing"));
  startBtn.addEventListener("click", () => void finish());
  step.appendChild(startBtn);

  return step;
}

// ------- Finish -------
async function finish(): Promise<void> {
  try {
    // Load existing config as base, then overlay collected values
    let config: AppConfig;
    try {
      config = await ipc.loadConfig();
    } catch (_e) {
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

    if (collected.apiKey) config.api_key = collected.apiKey;
    if (collected.upstreamInput) config.upstream_input_device = collected.upstreamInput;
    if (collected.upstreamOutput) config.upstream_output_device = collected.upstreamOutput;
    if (collected.downstreamInput) config.downstream_input_device = collected.downstreamInput;

    await ipc.saveConfig(config);
    await emit(EVENTS.CONFIG_CHANGED, config);
    await getCurrentWindow().close();
  } catch (e) {
    console.error("finish error:", e);
  }
}

// ------- Build UI -------
async function init(): Promise<void> {
  const app = document.getElementById("app");
  if (!app) return;

  const container = el("div", { class: "setup-container" });

  // Step indicators
  const indicators = el("div", { class: "step-indicators" });
  for (let i = 0; i < TOTAL_STEPS; i++) {
    const dot = el("div", { class: "step-dot" });
    stepDots.push(dot);
    indicators.appendChild(dot);
  }
  container.appendChild(indicators);

  // Build steps
  const step1 = buildStep1();
  const step2 = buildStep2();
  const { step: step3, loadDevices } = buildStep3();
  const step4 = buildStep4();

  stepEls = [step1, step2, step3, step4];
  for (const s of stepEls) container.appendChild(s);

  app.appendChild(container);

  // Start at step 1
  goToStep(1);

  // Pre-load devices in background so step 3 is ready
  void loadDevices();
}

void init();
