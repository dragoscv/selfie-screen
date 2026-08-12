import { createServer, type Server } from "node:http";

import type { ChatEvent, Settings } from "@tiksee/core";
import { WebSocketServer, type WebSocket } from "ws";

import { logger } from "../logger.js";
import { OVERLAY_HTML } from "./page.js";

const log = logger.scoped("[overlay]");

/**
 * Serves the OBS browser source.
 *
 * A tiny HTTP server hands OBS a single self-contained HTML page, which then
 * subscribes over WebSocket for live events. Everything is served from
 * 127.0.0.1 only — this must never be reachable off the machine.
 */
export class OverlayServer {
    #http: Server | null = null;
    #wss: WebSocketServer | null = null;
    #clients = new Set<WebSocket>();
    #settings: Settings;
    /** Replayed to a newly attached source so OBS is never blank on scene load. */
    #recent: ChatEvent[] = [];
    #port = 0;

    constructor(settings: Settings) {
        this.#settings = settings;
    }

    get port(): number {
        return this.#port;
    }

    setSettings(settings: Settings): void {
        const wasEnabled = this.#settings.obs.browserSourceEnabled;
        const oldPort = this.#settings.obs.port;
        this.#settings = settings;

        if (settings.obs.browserSourceEnabled && !wasEnabled) void this.start();
        else if (!settings.obs.browserSourceEnabled && wasEnabled) void this.stop();
        else if (settings.obs.port !== oldPort && this.#http) {
            void this.stop().then(() => this.start());
        } else {
            // Layout and theme changes just need the page to re-read its config.
            this.#broadcast({ type: "config", config: this.#config() });
        }
    }

    async start(): Promise<number> {
        if (this.#http) return this.#port;

        const http = createServer((req, res) => {
            const url = new URL(req.url ?? "/", "http://127.0.0.1");
            if (url.pathname === "/overlay" || url.pathname === "/") {
                res.writeHead(200, {
                    "content-type": "text/html; charset=utf-8",
                    "cache-control": "no-store",
                });
                res.end(OVERLAY_HTML);
                return;
            }
            if (url.pathname === "/health") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, clients: this.#clients.size }));
                return;
            }
            res.writeHead(404, { "content-type": "text/plain" });
            res.end("Not found");
        });

        const wss = new WebSocketServer({ server: http, path: "/ws" });
        wss.on("connection", (socket) => {
            this.#clients.add(socket);
            log.info(`browser source attached (${this.#clients.size} total)`);
            send(socket, { type: "config", config: this.#config() });
            if (this.#recent.length > 0) send(socket, { type: "events", events: this.#recent });
            socket.on("close", () => this.#clients.delete(socket));
            socket.on("error", () => this.#clients.delete(socket));
        });

        await new Promise<void>((resolve, reject) => {
            http.once("error", reject);
            // Bind to loopback explicitly; this endpoint is unauthenticated.
            http.listen(this.#settings.obs.port, "127.0.0.1", () => {
                http.removeListener("error", reject);
                resolve();
            });
        });

        const address = http.address();
        this.#port = typeof address === "object" && address ? address.port : 0;
        this.#http = http;
        this.#wss = wss;
        log.info(`browser source at http://127.0.0.1:${this.#port}/overlay`);
        return this.#port;
    }

    async stop(): Promise<void> {
        for (const client of this.#clients) client.close();
        this.#clients.clear();
        this.#wss?.close();
        this.#wss = null;
        const http = this.#http;
        this.#http = null;
        this.#port = 0;
        if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
    }

    push(event: ChatEvent): void {
        this.#recent.push(event);
        const max = this.#settings.obs.maxRows;
        if (this.#recent.length > max) this.#recent.splice(0, this.#recent.length - max);
        this.#broadcast({ type: "events", events: [event] });
    }

    clear(): void {
        this.#recent = [];
        this.#broadcast({ type: "clear" });
    }

    #config() {
        const { obs, appearance, display } = this.#settings;
        return {
            layout: obs.layout,
            transparent: obs.transparent,
            maxRows: obs.maxRows,
            rowTtlMs: obs.rowTtlMs,
            accent: appearance.accent,
            customAccentHue: appearance.customAccentHue,
            customAccentChroma: appearance.customAccentChroma,
            mode: appearance.mode === "light" ? "light" : "dark",
            showAvatars: display.showAvatars,
            showTimestamps: display.showTimestamps,
            reducedMotion: appearance.reducedMotion,
        };
    }

    #broadcast(payload: unknown): void {
        const data = JSON.stringify(payload);
        for (const client of this.#clients) {
            if (client.readyState === client.OPEN) client.send(data);
        }
    }
}

function send(socket: WebSocket, payload: unknown): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}
