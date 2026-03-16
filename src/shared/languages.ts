import { t } from "./i18n/index.ts";

export const ALL_LANGUAGE_CODES = [
  "zh", "yue", "en", "ja", "ko", "fr", "de", "es",
  "ru", "it", "pt", "id", "ar", "th", "hi", "da",
  "ur", "tr", "nl", "ms", "vi", "el",
] as const;

export function getAllLanguages(): { code: string; label: string }[] {
  return ALL_LANGUAGE_CODES.map((code) => ({
    code,
    label: t(`lang.${code}`),
  }));
}

// Languages that support audio output (TTS) with qwen3 model
export const AUDIO_SUPPORTED_LANGS = new Set([
  "en", "zh", "ru", "fr", "de", "pt", "es", "it", "ko", "ja", "yue",
]);

export function supportsAudio(langCode: string): boolean {
  return AUDIO_SUPPORTED_LANGS.has(langCode);
}

// Available voices — id + supported languages (display name/desc via i18n)
const VOICE_IDS = ["Cherry", "Nofish", "Jada", "Dylan", "Sunny", "Peter", "Kiki", "Eric"] as const;

const VOICE_LANGS: Record<string, string[]> = {
  Cherry: ["zh", "en", "fr", "de", "ru", "it", "es", "pt", "ja", "ko"],
  Nofish: ["zh", "en", "fr", "de", "ru", "it", "es", "pt", "ja", "ko"],
  Jada: ["zh"],
  Dylan: ["zh"],
  Sunny: ["zh"],
  Peter: ["zh"],
  Kiki: ["yue"],
  Eric: ["zh"],
};

export function getVoices(): { id: string; name: string; desc: string; langs: string[] }[] {
  return VOICE_IDS.map((id) => ({
    id,
    name: t(`voice.${id}.name`),
    desc: t(`voice.${id}.desc`),
    langs: VOICE_LANGS[id],
  }));
}

export function getVoicesForLang(langCode: string): { id: string; name: string; desc: string; langs: string[] }[] {
  return getVoices().filter(v => v.langs.includes(langCode));
}

export const TRANSLATION_PAIRS: Record<string, string[]> = {
  zh: ["en", "ja", "ko", "fr", "de", "es", "ru", "it"],
  yue: ["zh", "en"],
  en: ["zh", "yue", "ja", "ko", "pt", "fr", "de", "ru", "vi", "es", "nl", "da", "ar", "it", "hi", "tr", "ms", "ur"],
  ja: ["th", "en", "zh", "vi", "fr", "it", "de", "es"],
  ko: ["th", "en", "zh", "vi", "fr", "es", "ru", "de"],
  fr: ["th", "en", "ja", "zh", "vi", "de", "it", "es", "ru", "pt"],
  de: ["th", "en", "ja", "zh", "fr", "vi", "ru", "es", "it", "pt"],
  es: ["th", "en", "ja", "zh", "fr", "vi", "it", "de", "ru", "pt"],
  ru: ["th", "en", "ja", "zh", "yue", "fr", "vi", "de", "es", "it", "pt"],
  it: ["th", "en", "ja", "zh", "fr", "vi", "es", "ru", "de"],
  pt: ["en"],
  id: ["en"],
  ar: ["en"],
  th: ["ja", "vi", "fr"],
  hi: ["en"],
  da: ["en"],
  ur: ["en"],
  tr: ["en"],
  nl: ["en"],
  ms: ["en"],
  vi: ["ja", "fr"],
};

export function getTargetsForSource(source: string): string[] {
  return TRANSLATION_PAIRS[source] ?? [];
}

export function getLabelForCode(code: string): string {
  return t(`lang.${code}`) !== `lang.${code}` ? t(`lang.${code}`) : code;
}

export function getSourceLanguages(): { code: string; label: string }[] {
  return Object.keys(TRANSLATION_PAIRS).map((code) => ({
    code,
    label: getLabelForCode(code),
  }));
}
