import "server-only";

import type enDict from "../../dictionaries/en.json";

export type Dictionary = typeof enDict;
export type Locale = "en" | "cs" | "de" | "fr" | "es" | "zh";

const dictionaries: Record<Locale, () => Promise<Dictionary>> = {
  en: () =>
    import("../../dictionaries/en.json").then((m) => m.default as Dictionary),
  cs: () =>
    import("../../dictionaries/cs.json").then((m) => m.default as Dictionary),
  de: () =>
    import("../../dictionaries/de.json").then((m) => m.default as Dictionary),
  fr: () =>
    import("../../dictionaries/fr.json").then((m) => m.default as Dictionary),
  es: () =>
    import("../../dictionaries/es.json").then((m) => m.default as Dictionary),
  zh: () =>
    import("../../dictionaries/zh.json").then((m) => m.default as Dictionary),
};

export const LOCALES: Locale[] = ["en", "cs", "de", "fr", "es", "zh"];
export const DEFAULT_LOCALE: Locale = "en";

export function isLocale(value: string): value is Locale {
  return (LOCALES as string[]).includes(value);
}

export async function getDictionary(locale: Locale): Promise<Dictionary> {
  return dictionaries[locale]();
}
