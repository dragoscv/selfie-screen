import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

import {
    defaultSettings,
    parseClientMessage,
    type ChatEvent,
    type ServerMessage,
    type Settings,
} from "@tiksee/core";
import { WebSocketServer, type WebSocket } from "ws";

import { describeError } from "./ingest/connector.js";
import { ReplayStore } from "./ingest/replay.js";
import type { TikTokSession } from "./ingest/types.js";
import { logger } from "./logger.js";
import { ObsController } from "./obs.js";
import { OverlayServer } from "./overlay/server.js";
import { PanelService } from "./panel/service.js";
import { StreamManager } from "./streams.js";

const VERSION = "0.1.0";
const log = logger.scoped("[sidecar]");

const dataDir = join(homedir(), ".tiksee");
const replayDir = join(dataDir, "replays");

/**
 * The sidecar process.
 *
 * It owns everything that cannot live inside a WebView: the TikTok webcast
 * socket, the serial LCD panel, the OBS browser-source HTTP server, and the
 * obs-websocket client. The Tauri renderer talks to it over a loopback
 * WebSocket using the schemas in `@tiksee/core`.
 */
class Sidecar {
    #settings: Settings = defaultSettings();
    #session: TikTokSession | null = null;
    #clients = new Set<WebSocket>();

    #streams: StreamManager;
    #panel: PanelService;
    #overlay: OverlayServer;
    #obs = new ObsController();
    #replays = new ReplayStore(replayDir);

    constructor() {
        this.#overlay = new OverlayServer(this.#settings);

        this.#panel = new PanelService(this.#settings, {
            onStatus: (status) => this.#broadcast({ type: "panelStatus", status }),
            onPreview: (dataUrl) => this.#broadcast({ type: "panelPreview", dataUrl }),
        });

        this.#streams = new StreamManager(this.#settings, {
            onEvents: (events) => this.#broadcast({ type: "events", events }),
            onStatus: (status) => {
                this.#panel.setState(status.state);
                this.#broadcast({ type: "status", status });
            },
            onStats: (stats) => this.#broadcast({ type: "stats", stats }),
            onAlert: (event) => this.#obs.handleAlert(event),
        });

        // Fan every moderated event out to the surfaces that consume it.
        this.#streams.addTap((event: ChatEvent) => {
            this.#panel.push(event);
            this.#overlay.push(event);
            this.#replays.capture(event);
            this.#obs.handleEvent(event);
        });

        logger.addSink((level, message, at) => this.#broadcast({ type: "log", level, message, at }));
    }

    async start(port: number): Promise<number> {
        await mkdir(replayDir, { recursive: true });

        if (this.#settings.obs.browserSourceEnabled) {
            await this.#overlay.start().catch((e) => log.warn("overlay start failed", e));
        }

        const http = createServer((_req, res) => {
            // A plain health endpoint so the shell can confirm readiness without
            // opening a WebSocket. Never `/healthz` — that name is reserved by some
            // frontends and never reaches the process.
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, version: VERSION }));
        });

        const wss = new WebSocketServer({ server: http, path: "/ws" });
        wss.on("connection", (socket) => this.#onClient(socket));

        await new Promise<void>((resolve, reject) => {
            http.once("error", reject);
            http.listen(port, "127.0.0.1", () => {
                http.removeListener("error", reject);
                resolve();
            });
        });

        const address = http.address();
        const bound = typeof address === "object" && address ? address.port : port;

        // The shell parses this line from stdout to learn where to connect.
        console.log(`TIKSEE_SIDECAR_READY ${JSON.stringify({ port: bound, version: VERSION })}`);
        log.info(`listening on ws://127.0.0.1:${bound}/ws`);
        return bound;
    }

    #onClient(socket: WebSocket): void {
        this.#clients.add(socket);
        log.info(`client attached (${this.#clients.size})`);

        this.#send(socket, {
            type: "hello",
            version: VERSION,
            overlayPort: this.#overlay.port,
            hasSession: this.#session !== null,
        });
        for (const status of this.#streams.statuses()) this.#send(socket, { type: "status", status });

        socket.on("message", (raw) => {
            void this.#handle(socket, String(raw));
        });
        socket.on("close", () => this.#clients.delete(socket));
        socket.on("error", () => this.#clients.delete(socket));
    }

    async #handle(socket: WebSocket, raw: string): Promise<void> {
        const message = parseClientMessage(raw);
        if (!message) {
            log.warn("dropped an unparseable client message");
            return;
        }

        try {
            switch (message.type) {
                case "ping":
                    this.#send(socket, { type: "pong", at: message.at });
                    break;

                case "connect":
                    await this.#streams.connect(message.streamId, message.username, message.waitUntilLive);
                    break;

                case "disconnect":
                    await this.#streams.disconnect(message.streamId);
                    this.#overlay.clear();
                    break;

                case "settings":
                    this.#applySettings(message.settings);
                    break;

                case "session":
                    this.#session = { sessionId: message.sessionId, ttTargetIdc: message.ttTargetIdc };
                    this.#streams.setSession(this.#session);
                    // Never log the value — this cookie is a full account credential.
                    log.info("TikTok session stored");
                    break;

                case "clearSession":
                    this.#session = null;
                    this.#streams.setSession(null);
                    log.info("TikTok session cleared");
                    break;

                case "panelConnect":
                    await this.#panel.connect(message.portPath);
                    break;
                case "panelDisconnect":
                    await this.#panel.disconnect();
                    break;
                case "panelListPorts":
                    this.#send(socket, { type: "panelPorts", ports: await this.#panel.listPorts() });
                    break;
                case "panelBrightness":
                    await this.#panel.setBrightness(message.level);
                    break;
                case "panelPower":
                    await this.#panel.setPower(message.on);
                    break;

                case "replayList":
                    this.#send(socket, { type: "replays", replays: await this.#replays.list() });
                    break;
                case "replayStart": {
                    const ok = await this.#replays.play(
                        message.name,
                        message.streamId,
                        message.speed,
                        message.loop,
                        (event) => this.#streams.ingest(event),
                        () => this.#emitReplayStatus(),
                    );
                    if (!ok) this.#send(socket, { type: "error", message: "Replay not found", fatal: false });
                    this.#emitReplayStatus();
                    break;
                }
                case "replayStop":
                    this.#replays.stopPlayback();
                    this.#emitReplayStatus();
                    break;
                case "recordStart":
                    this.#replays.startRecording(message.name);
                    this.#emitReplayStatus();
                    break;
                case "recordStop":
                    await this.#replays.stopRecording();
                    this.#send(socket, { type: "replays", replays: await this.#replays.list() });
                    this.#emitReplayStatus();
                    break;

                case "obsConnect":
                    await this.#obs.connect(message.url, message.password);
                    this.#send(socket, { type: "obsStatus", connected: this.#obs.connected });
                    break;
                case "obsDisconnect":
                    await this.#obs.disconnect();
                    this.#send(socket, { type: "obsStatus", connected: false });
                    break;
                case "obsSetScene":
                    await this.#obs.setScene(message.scene);
                    break;
                case "obsListScenes": {
                    const scenes = await this.#obs.listScenes();
                    this.#send(socket, { type: "obsScenes", ...scenes });
                    break;
                }

                case "simulate":
                    this.#streams.ingest(message.event);
                    break;
            }
        } catch (error) {
            const description = describeError(error);
            log.warn(`handler "${message.type}" failed: ${description}`);
            this.#send(socket, { type: "error", message: description, fatal: false });
        }
    }

    #applySettings(settings: Settings): void {
        this.#settings = settings;
        logger.setLevel(settings.behaviour.crashReporting ? "debug" : "info");
        this.#streams.setSettings(settings);
        this.#panel.setSettings(settings);
        this.#overlay.setSettings(settings);
        this.#obs.setSettings(settings);
    }

    #emitReplayStatus(): void {
        this.#broadcast({
            type: "replayStatus",
            playing: this.#replays.isPlaying,
            recording: this.#replays.isRecording,
            name: this.#replays.playbackName,
            progress: this.#replays.progress,
        });
    }

    #send(socket: WebSocket, message: ServerMessage): void {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    }

    #broadcast(message: ServerMessage): void {
        const data = JSON.stringify(message);
        for (const client of this.#clients) {
            if (client.readyState === client.OPEN) client.send(data);
        }
    }

    async dispose(): Promise<void> {
        log.info("shutting down");
        await Promise.allSettled([
            this.#streams.dispose(),
            this.#panel.dispose(),
            this.#overlay.stop(),
            this.#obs.disconnect(),
        ]);
    }
}

const requestedPort = Number(process.env.TIKSEE_SIDECAR_PORT ?? 0) || 0;
const sidecar = new Sidecar();

let shuttingDown = false;
async function shutdown(code = 0): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    await sidecar.dispose();
    process.exit(code);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
// The shell closes stdin when it exits; without this the sidecar would be
// orphaned and keep the serial port and sockets locked.
process.stdin.on("close", () => void shutdown(0));
process.stdin.resume();

process.on("uncaughtException", (error) => {
    log.error("uncaught exception", error);
});
process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection", reason);
});

sidecar.start(requestedPort).catch((error: unknown) => {
    log.error("failed to start", error);
    process.exit(1);
});
