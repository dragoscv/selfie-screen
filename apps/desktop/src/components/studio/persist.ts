import { emitTo } from "@tauri-apps/api/event";
import { load } from "@tauri-apps/plugin-store";
import { parseSettings, type AudioSettings, type StudioSettings, type VisionSettings, type VoiceSettings } from "@tiksee/core";

export interface StudioPatch {
    studio?: Partial<StudioSettings>;
    vision?: Partial<VisionSettings>;
    /** Sound panel: the main window owns playback and the mic, it applies these live. */
    voice?: Partial<VoiceSettings>;
    audio?: Partial<AudioSettings>;
}

/** Fold `next` into `acc` (later keys win). */
export function mergePatch(acc: StudioPatch, next: StudioPatch): StudioPatch {
    return {
        ...(acc.studio || next.studio ? { studio: { ...acc.studio, ...next.studio } } : {}),
        ...(acc.vision || next.vision ? { vision: { ...acc.vision, ...next.vision } } : {}),
        ...(acc.voice || next.voice ? { voice: { ...acc.voice, ...next.voice } } : {}),
        ...(acc.audio || next.audio ? { audio: { ...acc.audio, ...next.audio } } : {}),
    };
}

/**
 * Debounced persistence of studio-side edits: merged into the Tauri store
 * (parsed for safety) and forwarded to the main window as `studio://patch`,
 * so its in-memory settings stay in step.
 */
export class SettingsPersister {
    #pending: StudioPatch = {};
    #timer = 0;
    readonly #delayMs: number;
    readonly #enabled: boolean;
    readonly #onError: (message: string) => void;

    constructor(enabled: boolean, onError: (message: string) => void, delayMs = 300) {
        this.#enabled = enabled;
        this.#onError = onError;
        this.#delayMs = delayMs;
    }

    queue(patch: StudioPatch): void {
        if (!this.#enabled) return;
        this.#pending = mergePatch(this.#pending, patch);
        window.clearTimeout(this.#timer);
        this.#timer = window.setTimeout(() => void this.flush(), this.#delayMs);
    }

    async flush(): Promise<void> {
        window.clearTimeout(this.#timer);
        const patch = this.#pending;
        this.#pending = {};
        if (!patch.studio && !patch.vision && !patch.voice && !patch.audio) return;
        try {
            const store = await load("settings.json", { autoSave: false });
            const current = parseSettings(await store.get("settings"));
            const next = parseSettings({
                ...current,
                studio: { ...current.studio, ...patch.studio },
                vision: { ...current.vision, ...patch.vision },
                voice: { ...current.voice, ...patch.voice },
                audio: { ...current.audio, ...patch.audio },
            });
            await store.set("settings", next);
            await store.save();
            await emitTo("main", "studio://patch", patch);
        } catch (e) {
            this.#onError(`persist: ${String(e)}`);
        }
    }
}
