"use client";
import { createContext, useContext } from "react";
import type { Dictionary, Locale } from "@/app/[lang]/dictionaries";

type I18nContextValue = {
  dict: Dictionary;
  locale: Locale;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export const I18nProvider = ({
  dict,
  locale,
  children,
}: {
  dict: Dictionary;
  locale: Locale;
  children: React.ReactNode;
}) => (
  <I18nContext.Provider value={{ dict, locale }}>
    {children}
  </I18nContext.Provider>
);

function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside I18nProvider");
  return ctx;
}

export function useLocale(): Locale {
  return useI18n().locale;
}

type NestedValue = string | Record<string, unknown>;
function getPath(obj: Record<string, unknown>, path: string): string {
  const parts = path.split(".");
  let cur: NestedValue = obj;
  for (const part of parts) {
    if (typeof cur !== "object" || cur === null) return path;
    cur = (cur as Record<string, NestedValue>)[part];
  }
  return typeof cur === "string" ? cur : path;
}

export function useT() {
  const { dict } = useI18n();
  return (key: string, vars?: Record<string, string | number>): string => {
    let str = getPath(dict as unknown as Record<string, unknown>, key);
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        str = str.replaceAll(`{${k}}`, String(v));
      }
    }
    return str;
  };
}
