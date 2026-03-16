import "./subtitle.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, LogicalPosition } from "@tauri-apps/api/dpi";
import { ipc } from "../shared/ipc";
import { EVENTS, listen } from "../shared/events";
import type { AppConfig } from "../shared/config-types";
import { t } from "../shared/i18n/index.ts";

// ─── constants ────────────────────────────────────────────────────────────────
const FONT_SIZES = [12, 13, 14, 16, 18] as const;
const POLL_INTERVAL_MS = 300;

// ─── subtitle text pipeline helpers ──────────────────────────────────────────

function normalizeSubtitleText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function overlapSuffixPrefix(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  for (let size = max; size > 0; size -= 1) {
    if (left.slice(-size) === right.slice(0, size)) {
      return size;
    }
  }
  return 0;
}

function collapseRepeatedLead(text: string): string {
  const normalized = normalizeSubtitleText(text);
  if (normalized.length < 48) return normalized;
  const anchorLength = Math.min(32, Math.max(16, Math.floor(normalized.length / 6)));
  const anchor = normalized.slice(0, anchorLength);
  const repeatedAt = normalized.lastIndexOf(anchor);
  if (repeatedAt <= 0) return normalized;
  const collapsed = normalized.slice(repeatedAt).trim();
  return collapsed.length >= anchorLength ? collapsed : normalized;
}

function stripCommittedPrefix(committed: string, text: string): string {
  const normalized = normalizeSubtitleText(text);
  if (!normalized) return "";
  if (!committed) return normalized;
  if (normalized === committed) return "";
  if (committed.includes(normalized)) return "";
  if (normalized.startsWith(committed)) {
    return normalizeSubtitleText(normalized.slice(committed.length));
  }
  const overlap = overlapSuffixPrefix(committed, normalized);
  if (overlap >= Math.min(24, normalized.length)) {
    return normalizeSubtitleText(normalized.slice(overlap));
  }
  return normalized;
}

// ─── state ───────────────────────────────────────────────────────────────────
let lastEventId = 0;
let committedTranscript = "";  // all text committed to history (for gummy dedup)
let lastFinalText = "";

let config: AppConfig | null = null;
let fontSizeIndex = 1;
let bilingual = false;

const win = getCurrentWindow();

// ─── DOM construction ────────────────────────────────────────────────────────

const appEl = document.getElementById("app");
if (!appEl) throw new Error("Missing #app");

// --- Control bar ---
const controlBar = document.createElement("div");
controlBar.className = "control-bar";

function ctrlBtn(text: string, cls = ""): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = `ctrl-btn ${cls}`.trim();
  btn.textContent = text;
  return btn;
}
function ctrlDivider(): HTMLDivElement {
  const d = document.createElement("div");
  d.className = "ctrl-divider";
  return d;
}

const fontBtn = ctrlBtn("Aa");
const modeBtn = ctrlBtn(t("subtitle.bilingual"));
const closeBtn = ctrlBtn("✕");

const opacityWrapper = document.createElement("div");
opacityWrapper.className = "ctrl-opacity";
const opacityLabel = document.createElement("label");
opacityLabel.textContent = "◐";
const opacitySlider = document.createElement("input");
opacitySlider.type = "range";
opacitySlider.min = "0.2";
opacitySlider.max = "1";
opacitySlider.step = "0.05";
opacitySlider.value = "0.75";
opacityWrapper.appendChild(opacityLabel);
opacityWrapper.appendChild(opacitySlider);

// Entire control bar is draggable (except buttons)
controlBar.addEventListener("mousedown", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest(".ctrl-btn") || target.closest("input")) return;
  e.preventDefault();
  void win.startDragging().then(() => { void saveSubtitleConfig(); });
});
const clearBtn = ctrlBtn(t("subtitle.clear"));

controlBar.appendChild(fontBtn);
controlBar.appendChild(ctrlDivider());
controlBar.appendChild(modeBtn);
controlBar.appendChild(ctrlDivider());
controlBar.appendChild(opacityWrapper);
controlBar.appendChild(ctrlDivider());
controlBar.appendChild(clearBtn);
controlBar.appendChild(ctrlDivider());
controlBar.appendChild(closeBtn);

appEl.appendChild(controlBar);

// --- Subtitle content area ---
const contentEl = document.createElement("div");
contentEl.className = "subtitle-content";

const historyEl = document.createElement("div");
historyEl.className = "subtitle-history";

const liveEl = document.createElement("div");
liveEl.className = "subtitle-live";

contentEl.appendChild(historyEl);
contentEl.appendChild(liveEl);
appEl.appendChild(contentEl);

// Allow dragging from content area
contentEl.addEventListener("mousedown", (e) => {
  const target = e.target as HTMLElement;
  // Don't drag if clicking on text (allow text selection)
  if (target.closest(".subtitle-line") || target.closest(".subtitle-live")) return;
  e.preventDefault();
  void win.startDragging().then(() => { void saveSubtitleConfig(); });
});

// ─── hover detection for control bar ─────────────────────────────────────────

appEl.addEventListener("mouseenter", () => {
  controlBar.classList.add("visible");
});

appEl.addEventListener("mouseleave", () => {
  controlBar.classList.remove("visible");
});

// ─── apply styles from config ────────────────────────────────────────────────

function applyFontSize(size: number): void {
  const lines = historyEl.querySelectorAll(".subtitle-line");
  for (const line of lines) {
    (line as HTMLElement).style.fontSize = `${size}px`;
  }
  liveEl.style.fontSize = `${size}px`;
}

function applyBilingual(value: boolean): void {
  bilingual = value;
  modeBtn.textContent = value ? t("subtitle.bilingual") : t("subtitle.translationOnly");
}

// ─── config load / save ──────────────────────────────────────────────────────

async function loadAndApplyConfig(): Promise<void> {
  try {
    config = await ipc.loadConfig();

    const savedSize = config.subtitle_font_size ?? 16;
    fontSizeIndex = FONT_SIZES.findIndex((s) => s === savedSize);
    if (fontSizeIndex < 0) fontSizeIndex = 1;
    applyFontSize(FONT_SIZES[fontSizeIndex]);

    const opacity = config.subtitle_opacity ?? 0.75;
    opacitySlider.value = String(opacity);
    contentEl.style.setProperty("--bg-opacity", String(opacity));

    applyBilingual(config.subtitle_bilingual ?? false);

    // Restore saved size
    if (config.subtitle_width != null && config.subtitle_height != null) {
      await win.setSize(new LogicalSize(config.subtitle_width, config.subtitle_height));
    }
    // Restore saved position, but verify it's on-screen
    if (config.subtitle_x != null && config.subtitle_y != null) {
      const x = config.subtitle_x;
      const y = config.subtitle_y;
      // Basic sanity check: position should be non-negative and not too far off
      if (x >= 0 && y >= 0 && x < 5000 && y < 3000) {
        await win.setPosition(new LogicalPosition(x, y));
      }
    }
  } catch (e) {
    console.error("loadAndApplyConfig error:", e);
  }
}

async function saveSubtitleConfig(): Promise<void> {
  if (!config) return;
  try {
    const size = await win.outerSize();
    const pos = await win.outerPosition();
    const scale = await win.scaleFactor();
    config.subtitle_font_size = FONT_SIZES[fontSizeIndex];
    config.subtitle_opacity = parseFloat(opacitySlider.value);
    config.subtitle_bilingual = bilingual;
    config.subtitle_width = Math.round(size.width / scale);
    config.subtitle_height = Math.round(size.height / scale);
    config.subtitle_x = Math.round(pos.x / scale);
    config.subtitle_y = Math.round(pos.y / scale);
    await ipc.saveConfig(config);
  } catch (e) {
    console.error("saveSubtitleConfig error:", e);
  }
}

// ─── control bar handlers ────────────────────────────────────────────────────

fontBtn.addEventListener("click", () => {
  fontSizeIndex = (fontSizeIndex + 1) % FONT_SIZES.length;
  applyFontSize(FONT_SIZES[fontSizeIndex]);
  void saveSubtitleConfig();
});

modeBtn.addEventListener("click", () => {
  applyBilingual(!bilingual);
  void saveSubtitleConfig();
});

opacitySlider.addEventListener("input", () => {
  contentEl.style.setProperty("--bg-opacity", opacitySlider.value);
});

opacitySlider.addEventListener("change", () => {
  void saveSubtitleConfig();
});

clearBtn.addEventListener("click", () => {
  historyEl.replaceChildren();

  committedTranscript = "";
  lastFinalText = "";
  liveEl.textContent = "";
  liveEl.className = "subtitle-live";
});

closeBtn.addEventListener("click", async () => {
  // Stop downstream translation and hide window
  try { await ipc.stopWorker("downstream"); } catch (_) {}
  await win.hide();
});

// ─── subtitle text pipeline ─────────────────────────────────────────────────

function commitToHistory(text: string): void {
  if (!text.trim()) return;
  // Remove placeholder if present
  const placeholder = historyEl.querySelector(".subtitle-placeholder");
  if (placeholder) placeholder.remove();

  const row = document.createElement("div");
  row.className = "subtitle-line";
  row.style.fontSize = `${FONT_SIZES[fontSizeIndex]}px`;
  row.textContent = text.trim();
  historyEl.appendChild(row);
  historyEl.scrollTop = historyEl.scrollHeight;
}

function handleTargetPartial(text: string): void {
  let normalized = normalizeSubtitleText(text);
  if (!normalized) return;
  normalized = collapseRepeatedLead(normalized);

  // Strip already-committed text (gummy sends full cumulative text)
  if (committedTranscript) {
    const stripped = stripCommittedPrefix(committedTranscript, normalized);
    if (stripped) normalized = stripped;
  }

  // Remove placeholder on first real content
  const placeholder = historyEl.querySelector(".subtitle-placeholder");
  if (placeholder) placeholder.remove();

  // Just show in live area — target_final handles committing
  liveEl.textContent = normalized;
  liveEl.className = "subtitle-live active";
}

function handleTargetFinal(text: string): void {
  const normalized = normalizeSubtitleText(text);
  if (!normalized) {
  
    liveEl.textContent = "";
    liveEl.className = "subtitle-live";
    return;
  }
  // Dedup: skip if same as last final
  if (lastFinalText === normalized) {
  
    liveEl.textContent = "";
    liveEl.className = "subtitle-live";
    return;
  }
  lastFinalText = normalized;
  // Strip already-committed prefix (gummy finals may contain earlier text)
  let toCommit = normalized;
  if (committedTranscript) {
    const stripped = stripCommittedPrefix(committedTranscript, normalized);
    if (stripped) toCommit = stripped;
  }
  commitToHistory(toCommit);
  committedTranscript += toCommit;

  liveEl.textContent = "";
  liveEl.className = "subtitle-live";
}

// No auto-commit — only API's target_final commits to history

async function poll(): Promise<void> {
  try {
    const events = await ipc.getSubtitleEvents(lastEventId);
    for (const ev of events) {
      lastEventId = Math.max(lastEventId, ev.id);
      switch (ev.kind) {
        case "target_partial":
          handleTargetPartial(ev.text);
          break;
        case "target_final":
          handleTargetFinal(ev.text);
          break;
        default:
          break;
      }
    }
  } catch (e) {
    console.error("subtitle poll error:", e);
  }
}

// ─── init ────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  console.log("[subtitle] init start");

  // Show placeholder
  const placeholder = document.createElement("div");
  placeholder.className = "subtitle-placeholder";
  placeholder.textContent = t("subtitle.placeholder");
  historyEl.appendChild(placeholder);

  try {
    await loadAndApplyConfig();
    console.log("[subtitle] config loaded");
  } catch (e) {
    console.error("[subtitle] config error:", e);
  }

  await listen(EVENTS.HIDE_SUBTITLE, async () => {
    await win.hide();
  });

  await listen(EVENTS.CONFIG_CHANGED, async () => {
    await loadAndApplyConfig();
  });

  // Start polling
  setInterval(() => {
    void poll();
  }, POLL_INTERVAL_MS);

  console.log("[subtitle] init complete");
}

void init();
