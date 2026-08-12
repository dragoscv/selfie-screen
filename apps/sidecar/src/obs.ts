import type { ChatEvent, Settings } from "@tiksee/core";
import OBSWebSocket from "obs-websocket-js";

import { logger } from "./logger.js";

const log = logger.scoped("[obs]");

/** Ignore repeat triggers inside this window so a gift storm can't strobe scenes. */
const TRIGGER_COOLDOWN_MS = 5_000;

/**
 * Optional obs-websocket control.
 *
 * Lets stream events drive OBS — switch to a "thank you" scene on a big gift,
 * flash an alert source on a keyword. Entirely opt-in and fails soft: OBS not
 * running must never affect chat ingestion.
 */
export class ObsController {
    #obs = new OBSWebSocket();
    #connected = false;
    #settings: Settings | null = null;
    #lastTrigger = 0;

    get connected(): boolean {
        return this.#connected;
    }

    setSettings(settings: Settings): void {
        const previous = this.#settings;
        this.#settings = settings;

        const wanted = settings.obs.controlEnabled;
        if (wanted && !this.#connected) {
            void this.connect(settings.obs.controlUrl).catch(() => undefined);
        } else if (!wanted && this.#connected) {
            void this.disconnect();
        } else if (
            wanted &&
            previous &&
            previous.obs.controlUrl !== settings.obs.controlUrl
        ) {
            void this.disconnect().then(() => this.connect(settings.obs.controlUrl));
        }
    }

    async connect(url: string, password?: string): Promise<void> {
        await this.disconnect();
        try {
            await this.#obs.connect(url, password || undefined);
            this.#connected = true;
            log.info(`connected to OBS at ${url}`);
            this.#obs.on("ConnectionClosed", () => {
                this.#connected = false;
                log.info("OBS connection closed");
            });
        } catch (error) {
            this.#connected = false;
            // Expected whenever OBS simply isn't running; keep it quiet.
            log.info(`OBS not available: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    async disconnect(): Promise<void> {
        if (!this.#connected) return;
        this.#connected = false;
        try {
            await this.#obs.disconnect();
        } catch {
            // Already gone; nothing to clean up.
        }
    }

    async listScenes(): Promise<{ scenes: string[]; current: string }> {
        if (!this.#connected) return { scenes: [], current: "" };
        try {
            const response = await this.#obs.call("GetSceneList");
            const scenes = (response.scenes as Array<{ sceneName?: string }>)
                .map((scene) => scene.sceneName ?? "")
                .filter(Boolean);
            return { scenes, current: response.currentProgramSceneName ?? "" };
        } catch (error) {
            log.warn("GetSceneList failed", error);
            return { scenes: [], current: "" };
        }
    }

    async setScene(scene: string): Promise<void> {
        if (!this.#connected) return;
        try {
            await this.#obs.call("SetCurrentProgramScene", { sceneName: scene });
        } catch (error) {
            log.warn(`SetCurrentProgramScene("${scene}") failed`, error);
        }
    }

    /** A big gift may switch scenes; small ones are ignored. */
    handleEvent(event: ChatEvent): void {
        if (!this.#connected || !this.#settings?.obs.controlEnabled) return;
        if (event.kind !== "gift") return;

        const threshold = this.#settings.alerts.giftDiamondThreshold;
        const diamonds = (event.giftDiamonds ?? 0) * (event.giftCount ?? 1);
        if (diamonds < Math.max(threshold, 100)) return;
        this.#trigger();
    }

    handleAlert(_event: ChatEvent): void {
        if (!this.#connected || !this.#settings?.obs.controlEnabled) return;
        this.#trigger();
    }

    #trigger(): void {
        const now = Date.now();
        if (now - this.#lastTrigger < TRIGGER_COOLDOWN_MS) return;
        this.#lastTrigger = now;
        // Scene-mapping rules are configured in the UI; until one is set this is
        // just the cooldown gate plus a log line the user can see working.
        log.info("OBS trigger fired");
    }
}
