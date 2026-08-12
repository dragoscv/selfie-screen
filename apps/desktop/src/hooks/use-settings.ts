import { useCallback, useEffect, useRef } from "react";

import { applyAppearance, wantsNativeBackdrop } from "@tiksee/ui";
import type { Settings } from "@tiksee/core";
import { invoke } from "@tauri-apps/api/core";
import { load, type Store } from "@tauri-apps/plugin-store";

import { setLocale } from "../i18n/index.js";
import { useAppStore } from "../store/app-store.js";

const STORE_FILE = "settings.json";
const STORE_KEY = "settings";
const SAVE_DEBOUNCE_MS = 350;

/**
 * Loads settings once, then keeps three things in sync with every change:
 * the persisted store, the `<html>` theme attributes, and the native Windows
 * backdrop.
 *
 * Writes are debounced because sliders commit rapidly and each save is a disk
 * round-trip.
 */
export function useSettingsSync(): void {
    const settings = useAppStore((state) => state.settings);
    const loaded = useAppStore((state) => state.settingsLoaded);
    const hydrate = useAppStore((state) => state.hydrateSettings);

    const storeRef = useRef<Store | null>(null);
    const saveTimer = useRef<number | null>(null);
    const lastBackdrop = useRef<string>("");

    // ---- initial load -------------------------------------------------
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const store = await load(STORE_FILE, { autoSave: false });
                if (cancelled) return;
                storeRef.current = store;
                hydrate(await store.get(STORE_KEY));
            } catch {
                // A missing or corrupt store must not block startup; defaults apply.
                console.error("[settings] store load failed; using defaults");
                if (!cancelled) hydrate(undefined);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [hydrate]);

    // ---- persist (debounced) ------------------------------------------
    useEffect(() => {
        if (!loaded) return;
        if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => {
            void (async () => {
                const store = storeRef.current;
                if (!store) return;
                try {
                    await store.set(STORE_KEY, settings);
                    await store.save();
                } catch (error) {
                    console.error("[settings] save failed", error);
                }
            })();
        }, SAVE_DEBOUNCE_MS);

        return () => {
            if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
        };
    }, [settings, loaded]);

    // ---- theme + locale + native backdrop ------------------------------
    useEffect(() => {
        const { mode } = applyAppearance(settings.appearance);
        setLocale(settings.appearance.locale);

        // Only re-invoke the shell when the effective backdrop actually changes;
        // reapplying mica on every keystroke causes a visible flicker.
        const key = `${settings.appearance.surface}:${mode}`;
        if (key !== lastBackdrop.current) {
            lastBackdrop.current = key;
            void invoke("set_surface", { surface: settings.appearance.surface, dark: mode === "dark" })
                .catch(() => undefined);
        }
    }, [settings.appearance]);

    // ---- follow the OS theme while set to "system" ---------------------
    useEffect(() => {
        if (settings.appearance.mode !== "system") return;
        const media = window.matchMedia("(prefers-color-scheme: dark)");
        const onChange = () => {
            const { mode } = applyAppearance(settings.appearance);
            if (wantsNativeBackdrop(settings.appearance.surface)) {
                void invoke("set_surface", {
                    surface: settings.appearance.surface,
                    dark: mode === "dark",
                }).catch(() => undefined);
            }
        };
        media.addEventListener("change", onChange);
        return () => media.removeEventListener("change", onChange);
    }, [settings.appearance]);
}

/**
 * Ergonomic section updater: `update("voice", { enabled: false })`.
 *
 * Constrained to the object-valued sections; `version` is a literal and is not
 * user-editable, so excluding it keeps the spread provably safe.
 */
type SettingsSection = {
    [K in keyof Settings]: Settings[K] extends object ? K : never;
}[keyof Settings];

export function useSettingsUpdate() {
    const updateSettings = useAppStore((state) => state.updateSettings);
    return useCallback(
        <K extends SettingsSection>(section: K, patch: Partial<Settings[K]>) => {
            updateSettings((current) => ({
                ...current,
                [section]: { ...current[section], ...patch },
            }));
        },
        [updateSettings],
    );
}
