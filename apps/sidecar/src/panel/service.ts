import type { ChatEvent, ConnectionState, PanelStatus, Settings } from "@tiksee/core";

import { logger } from "../logger.js";
import { PanelRenderer } from "./render.js";
import { TuringPanel, findPanelPort, listPorts, type PanelPortInfo } from "./turing.js";

const log = logger.scoped("[panel-service]");

/** Idle repaint cadence — enough to keep the clock and status honest. */
const IDLE_TICK_MS = 1_000;
/** Repaint cadence while speaking, so the highlight animates. */
const ACTIVE_TICK_MS = 120;
/** Events retained for the panel; it can only show a handful anyway. */
const PANEL_BUFFER = 24;

export interface PanelServiceSinks {
    onStatus: (status: PanelStatus) => void;
    onPreview: (dataUrl: string) => void;
}

/**
 * Owns the LCD panel: connection, the render loop and frame throttling.
 *
 * The loop is dirty-key driven rather than fixed-rate — the panel only
 * repaints when something it displays actually changed, which is what keeps a
 * serial-attached 320×480 display feeling responsive.
 */
export class PanelService {
    #panel: TuringPanel | null = null;
    #renderer = new PanelRenderer();
    #events: ChatEvent[] = [];
    #state: ConnectionState = "offline";
    #settings: Settings;
    #sinks: PanelServiceSinks;

    #timer: NodeJS.Timeout | null = null;
    #lastKey = "";
    #speakingId: string | undefined;
    #queued = 0;
    #error: string | undefined;

    #fpsWindowStart = Date.now();
    #fpsFrames = 0;
    #fps = 0;
    /** Frames are pushed serially; a new frame while busy replaces the pending one. */
    #pushing = false;

    constructor(settings: Settings, sinks: PanelServiceSinks) {
        this.#settings = settings;
        this.#sinks = sinks;
    }

    get connected(): boolean {
        return this.#panel?.connected === true;
    }

    setSettings(settings: Settings): void {
        const wasEnabled = this.#settings.panel.enabled;
        this.#settings = settings;

        if (settings.panel.enabled && !wasEnabled) void this.connect(settings.panel.portPath);
        else if (!settings.panel.enabled && wasEnabled) void this.disconnect();
        else if (this.connected) void this.#panel?.setBrightness(settings.panel.brightness);
    }

    setSpeaking(eventId: string | undefined, queued: number): void {
        this.#speakingId = eventId;
        this.#queued = queued;
    }

    setState(state: ConnectionState): void {
        this.#state = state;
    }

    /** Fed from the stream manager's tap. */
    push(event: ChatEvent): void {
        this.#events.push(event);
        if (this.#events.length > PANEL_BUFFER) {
            this.#events.splice(0, this.#events.length - PANEL_BUFFER);
        }
    }

    listPorts(): Promise<PanelPortInfo[]> {
        return listPorts();
    }

    async connect(portPath?: string): Promise<void> {
        await this.disconnect();

        const path = portPath?.trim() || (await findPanelPort());
        if (!path) {
            this.#error = "No Turing panel found on any serial port";
            log.warn(this.#error);
            this.#emitStatus();
            return;
        }

        try {
            const panel = new TuringPanel(path);
            await panel.open();
            await panel.setBrightness(this.#settings.panel.brightness);
            this.#panel = panel;
            this.#error = undefined;
            this.#lastKey = "";
            this.#startLoop();
            log.info(`connected on ${path}`);
        } catch (error) {
            this.#error = error instanceof Error ? error.message : String(error);
            log.warn(`connect failed on ${path}: ${this.#error}`);
        }
        this.#emitStatus();
    }

    async disconnect(): Promise<void> {
        this.#stopLoop();
        const panel = this.#panel;
        this.#panel = null;
        if (panel) await panel.close().catch(() => undefined);
        this.#emitStatus();
    }

    async setBrightness(level: number): Promise<void> {
        await this.#panel?.setBrightness(level);
    }

    async setPower(on: boolean): Promise<void> {
        if (!this.#panel) return;
        await (on ? this.#panel.screenOn() : this.#panel.screenOff());
        // Force a full repaint: the panel loses its framebuffer while off.
        if (on) this.#lastKey = "";
    }

    /** Render one frame without a panel attached, for the UI preview. */
    renderPreview(): string {
        this.#renderer.render(this.#frameInput());
        return this.#renderer.toDataUrl();
    }

    #frameInput() {
        const { display, panel } = this.#settings;
        return {
            events: this.#events,
            state: this.#state,
            collapseJoins: display.collapseJoinsPanel,
            collapseLikes: display.collapseLikesPanel,
            mergeSameUser: display.mergeSameUser,
            showClock: panel.showClock,
            speakingId: this.#speakingId,
            queued: this.#queued,
            locale: this.#settings.appearance.locale === "ro" ? "ro" : "en",
        };
    }

    #startLoop(): void {
        this.#stopLoop();
        const tick = (): void => {
            void this.#tick();
            const speaking = this.#speakingId !== undefined;
            this.#timer = setTimeout(tick, speaking ? ACTIVE_TICK_MS : IDLE_TICK_MS);
        };
        this.#timer = setTimeout(tick, 0);
    }

    #stopLoop(): void {
        if (this.#timer) clearTimeout(this.#timer);
        this.#timer = null;
    }

    async #tick(): Promise<void> {
        const panel = this.#panel;
        if (!panel?.connected || this.#pushing) return;

        // A cheap composite key of everything the frame depends on. Rendering is
        // skipped entirely when nothing visible changed.
        const minute = Math.floor(Date.now() / 60_000);
        const key = [
            this.#state,
            this.#events.map((e) => e.id).join(","),
            this.#speakingId ?? "",
            this.#queued,
            this.#settings.panel.showClock ? minute : 0,
        ].join("|");
        if (key === this.#lastKey) return;
        this.#lastKey = key;

        this.#pushing = true;
        try {
            const rgba = this.#renderer.render(this.#frameInput());
            const written = await panel.display(rgba);
            if (written > 0) this.#countFrame();
        } catch (error) {
            this.#error = error instanceof Error ? error.message : String(error);
            log.warn("frame push failed", this.#error);
            this.#emitStatus();
        } finally {
            this.#pushing = false;
        }
    }

    #countFrame(): void {
        this.#fpsFrames += 1;
        const now = Date.now();
        const elapsed = now - this.#fpsWindowStart;
        if (elapsed >= 1_000) {
            this.#fps = Math.round((this.#fpsFrames / elapsed) * 1000 * 10) / 10;
            this.#fpsFrames = 0;
            this.#fpsWindowStart = now;
            this.#emitStatus();
            this.#sinks.onPreview(this.#renderer.toDataUrl());
        }
    }

    #emitStatus(): void {
        this.#sinks.onStatus({
            connected: this.connected,
            portPath: this.#panel?.path,
            fps: this.#fps,
            frames: this.#panel?.frames ?? 0,
            error: this.#error,
        });
    }

    async dispose(): Promise<void> {
        await this.disconnect();
    }
}
