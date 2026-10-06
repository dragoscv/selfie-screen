import type { Locale } from "@tiksee/core";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./en.json";
import ro from "./ro.json";
import studioEn from "./studio.en.json";
import studioRo from "./studio.ro.json";
import visionEn from "./vision.en.json";
import visionRo from "./vision.ro.json";

/** Per-area string files (one owner each), merged under their own top-level key. */
export const AREA_BUNDLES = {
    en: { studio: studioEn, vision: visionEn },
    ro: { studio: studioRo, vision: visionRo },
} as const;

export const SUPPORTED_LOCALES = ["en", "ro"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Map the stored preference (which may be `system`) to a concrete locale. */
export function resolveLocale(locale: Locale): SupportedLocale {
    if (locale === "en" || locale === "ro") return locale;
    const preferred = typeof navigator === "undefined" ? "en" : navigator.language;
    return preferred.toLowerCase().startsWith("ro") ? "ro" : "en";
}

void i18n.use(initReactI18next).init({
    resources: {
        en: { translation: { ...en, ...AREA_BUNDLES.en } },
        ro: { translation: { ...ro, ...AREA_BUNDLES.ro } },
    },
    lng: "en",
    fallbackLng: "en",
    // Romanian has a three-form plural (1 / 2–19 / 20+); i18next's CLDR rules
    // handle it via the `_one` / `_few` / `_other` suffixes in ro.json.
    interpolation: { escapeValue: false },
    returnNull: false,
});

export function setLocale(locale: Locale): SupportedLocale {
    const resolved = resolveLocale(locale);
    if (i18n.language !== resolved) void i18n.changeLanguage(resolved);
    document.documentElement.lang = resolved;
    return resolved;
}

export default i18n;
