// macOS LSUIElement apps lose the Edit menu, so Cmd+C/V/X don't work.
// This module restores clipboard shortcuts via Tauri's clipboard plugin.
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

export function setupClipboardShortcuts(): void {
  document.addEventListener("keydown", async (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const active = document.activeElement;
    const isInput =
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement;

    if (e.key === "v" && isInput) {
      e.preventDefault();
      try {
        const text = await readText();
        if (text) {
          const input = active as HTMLInputElement | HTMLTextAreaElement;
          const start = input.selectionStart ?? input.value.length;
          const end = input.selectionEnd ?? input.value.length;
          input.value =
            input.value.slice(0, start) + text + input.value.slice(end);
          input.selectionStart = input.selectionEnd = start + text.length;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } catch (_) {
        // ignore clipboard errors
      }
    } else if (e.key === "c" && isInput) {
      e.preventDefault();
      const input = active as HTMLInputElement | HTMLTextAreaElement;
      const start = input.selectionStart ?? 0;
      const end = input.selectionEnd ?? 0;
      if (start !== end) {
        await writeText(input.value.slice(start, end));
      }
    } else if (e.key === "x" && isInput) {
      e.preventDefault();
      const input = active as HTMLInputElement | HTMLTextAreaElement;
      const start = input.selectionStart ?? 0;
      const end = input.selectionEnd ?? 0;
      if (start !== end) {
        await writeText(input.value.slice(start, end));
        input.value = input.value.slice(0, start) + input.value.slice(end);
        input.selectionStart = input.selectionEnd = start;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } else if (e.key === "a" && isInput) {
      e.preventDefault();
      const input = active as HTMLInputElement | HTMLTextAreaElement;
      input.selectionStart = 0;
      input.selectionEnd = input.value.length;
    }
  });
}
