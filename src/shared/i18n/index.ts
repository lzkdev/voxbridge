import zhCN from "./zh-CN.json";
import en from "./en.json";

type LocaleMessages = Record<string, string>;

const locales: Record<string, LocaleMessages> = {
  "zh-CN": zhCN,
  en,
};

const STORAGE_KEY = "voxbridge-locale";

let currentLocale: string = detectLocale();

function detectLocale(): string {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && locales[saved]) return saved;

  const nav = navigator.language;
  if (nav.startsWith("zh")) return "zh-CN";
  if (nav.startsWith("en")) return "en";

  return "zh-CN";
}

/**
 * Translate a key, with optional interpolation.
 * Fallback chain: currentLocale -> zh-CN -> raw key
 */
export function t(key: string, params?: Record<string, string>): string {
  let msg = locales[currentLocale]?.[key]
    ?? locales["zh-CN"]?.[key]
    ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      msg = msg.replace(`{${k}}`, v);
    }
  }
  return msg;
}

export function getLocale(): string {
  return currentLocale;
}

export function setLocale(locale: string): void {
  if (!locales[locale]) return;
  currentLocale = locale;
  localStorage.setItem(STORAGE_KEY, locale);
}

export function getAvailableLocales(): { code: string; label: string }[] {
  return [
    { code: "zh-CN", label: "简体中文" },
    { code: "en", label: "English" },
  ];
}
