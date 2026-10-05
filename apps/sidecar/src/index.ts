import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

import {
    defaultSettings,
    parseClientMessage,
    type ChatEvent,
    type ClientMessage,
    type ControlAction,
    type ServerMessage,
    type Settings,
} from "@tiksee/core";
import { WebSocketServer, type WebSocket } from "ws";

import { CodaiClient } from "./codai/client.js";
import { CoHost } from "./cohost/engine.js";
import { EffectsController } from "./effects/controller.js";
import { VmuiClient } from "./effects/vmui.js";
import { GameManager } from "./games/manager.js";
import { GoalTracker } from "./goals/goals.js";
import { describeError } from "./ingest/connector.js";
import { ReplayStore } from "./ingest/replay.js";
import type { TikTokSession } from "./ingest/types.js";
import { LiveControl } from "./live-control.js";
import { logger } from "./logger.js";
import { ViewerMemory } from "./memory/db.js";
import { ObsController } from "./obs.js";
import { OverlayServer } from "./overlay/server.js";
import { PanelService } from "./panel/service.js";
import { appDataDir } from "./paths.js";
import { SecretStore } from "./secrets.js";
import { StreamManager } from "./streams.js";
import { SummaryService } from "./summary/service.js";
import { Translator } from "./translate/translator.js";

declare const __TIKSEE_VERSION__: string | undefined;
/** Injected by tsdown from package.json; `dev` (tsx) has no define. */
const VERSION = typeof __TIKSEE_VERSION__ === "string" ? __TIKSEE_VERSION__ : "dev";
const log = logger.scoped("[sidecar]");

const dataDir = join(homedir(), ".tiksee");
const replayDir = join(dataDir, "replays");
/** Shared with the Tauri shell: `%APPDATA%\ro.codai.tiksee`. */
const appDir = appDataDir();

type LiveClientMessage = Extract<
    ClientMessage,
    {
        type:
            | "control"
            | "replyApprove"
            | "replySkip"
            | "speak"
            | "transcript"
            | "sayState"
            | "speechTimeline"
            | "codaiToken"
            | "effectTest"
            | "goalsReset"
            | "gameStart"
            | "gameAction"
            | "summaryList"
            | "summaryRequest"
            | "summaryExport";
    }
>;

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
    /** Retained so shutdown can release the port rather than leaking it. */
    #http: HttpServer | null = null;
    #wss: WebSocketServer | null = null;

    #streams: StreamManager;
    #panel: PanelService;
    #overlay: OverlayServer;
    #obs: ObsController;
    #replays = new ReplayStore(replayDir);

    #secrets = new SecretStore();
    #codai: CodaiClient;
    #control: LiveControl;
    #memory: ViewerMemory | null = null;
    #cohost: CoHost;
    #effects: EffectsController;
    #goals: GoalTracker;
    #games: GameManager;
    #translator: Translator;
    #summaries: SummaryService;
    /** Per-launch Stream Deck token; written to `trigger-token.txt`. */
    #triggerToken = randomBytes(24).toString("base64url");

    constructor() {
        this.#overlay = new OverlayServer(this.#settings);
        this.#obs = new ObsController((connected, error) => {
            this.#broadcast({ type: "obsStatus", connected, ...(error ? { error } : {}) });
            if (error) this.#broadcast({ type: "error", message: error, fatal: false });
        });

        this.#codai = new CodaiClient({
            baseUrl: () => this.#settings.codai.baseUrl,
            apiKey: () => this.#secrets.get("codai-api-key"),
            onUnauthorized: () => this.#secrets.invalidate("codai-api-key"),
        });
        const vmui = new VmuiClient({
            baseUrl: () => this.#settings.effects.vmuiUrl,
            apiKey: () => this.#secrets.get("vmui-api-key"),
        });

        this.#control = new LiveControl((state) => {
            this.#broadcast({ type: "liveControl", state });
            this.#overlay.pushPets(state.petsHidden);
        });

        try {
            this.#memory = ViewerMemory.open(appDir);
        } catch (error) {
            // Memory is an enhancement: the live feed must work without it.
            log.warn(`viewer memory unavailable: ${describeError(error)}`);
        }

        this.#cohost = new CoHost({
            settings: () => this.#settings,
            send: (message) => this.#broadcast(message),
            control: this.#control,
            codai: this.#codai,
            memory: this.#memory,
            log: logger.scoped("[cohost]"),
            onSessionEnded: (sessionId) => this.#pushSummary(sessionId, true),
        });

        this.#summaries = new SummaryService(this.#memory);

        this.#goals = new GoalTracker({
            settings: () => this.#settings,
            emit: (state) => {
                this.#broadcast({ type: "goals", state });
                this.#overlay.pushGoals(state);
            },
            onReached: (kind) => log.info(`goal reached: ${kind}`),
        });

        this.#games = new GameManager({
            settings: () => this.#settings,
            emit: (state) => {
                this.#broadcast({ type: "game", state });
                this.#overlay.pushGame(state);
            },
            announce: (text) => this.#cohost.speak(text),
        });

        this.#translator = new Translator({
            client: this.#codai,
            model: () => this.#settings.codai.replyModel,
            emit: (eventId, lang, text) => this.#broadcast({ type: "translation", eventId, lang, text }),
            onError: (message) => log.debug(`translation skipped (${message})`),
        });
        this.#applyTranslationSettings();

        this.#effects = new EffectsController({
            settings: () => this.#settings,
            effectsOff: () => this.#control.state.effectsOff,
            backend: vmui,
            emit: (effect) => this.#broadcast({ type: "effect", effect }),
            log: logger.scoped("[effects]"),
        });

        this.#panel = new PanelService(this.#settings, {
            onStatus: (status) => this.#broadcast({ type: "panelStatus", status }),
            onPreview: (dataUrl) => this.#broadcast({ type: "panelPreview", dataUrl }),
        });

        this.#streams = new StreamManager(this.#settings, {
            onEvents: (events) => this.#broadcast({ type: "events", events }),
            onStatus: (status, stats) => {
                this.#panel.setState(status.state);
                this.#broadcast({ type: "status", status });
                this.#cohost.onStatus(status.streamId, status.username, status.state, stats ?? this.#streams.stats(status.streamId));
                this.#autoRecord(status.username, status.state);
                if (status.state === "error" && status.error) {
                    this.#broadcast({ type: "error", message: status.error, fatal: false });
                }
            },
            onStats: (stats) => this.#broadcast({ type: "stats", stats }),
            onAlert: (event) => this.#obs.handleAlert(event),
            onError: (message) => this.#broadcast({ type: "error", message, fatal: false }),
        });

        // Fan every moderated event out to the surfaces that consume it.
        this.#streams.addTap((event: ChatEvent) => {
            this.#panel.push(event);
            this.#overlay.push(event);
            this.#replays.capture(event);
            this.#obs.handleEvent(event);
            this.#effects.onEvent(event);
            this.#cohost.onEvent(event);
            this.#goals.onEvent(event);
            this.#games.onEvent(event);
            if (event.kind === "chat") this.#translator.offer({ eventId: event.id, text: event.text });
        });

        logger.addSink((level, message, at) => this.#broadcast({ type: "log", level, message, at }));
    }

    async start(port: number): Promise<number> {
        await mkdir(replayDir, { recursive: true });
        this.#applyRetention();
        this.#cohost.start();
        await this.#configureTrigger();

        if (OverlayServer.wanted(this.#settings)) {
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
        this.#http = http;
        this.#wss = wss;

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
        this.#send(socket, { type: "liveControl", state: this.#control.state });
        this.#send(socket, { type: "replyQueue", items: this.#cohost.snapshot() });
        this.#send(socket, { type: "obsStatus", connected: this.#obs.connected });
        this.#send(socket, { type: "goals", state: this.#goals.state });
        this.#send(socket, { type: "game", state: this.#games.state });

        socket.on("message", (raw) => {
            void this.#handle(socket, String(raw));
        });
        const detach = (): void => {
            this.#clients.delete(socket);
            // The renderer owns the speaker; with none attached nobody will
            // ever answer `sayState`, so release the speaking slot.
            if (this.#clients.size === 0) this.#cohost.rendererDetached();
        };
        socket.on("close", detach);
        socket.on("error", detach);
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
                    if (message.driver === "sniffer") log.warn("the sniffer driver is not available yet; using tiktok-live-connector");
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

                default:
                    await this.#handleLive(socket, message);
                    break;
            }
        } catch (error) {
            const description = describeError(error);
            log.warn(`handler "${message.type}" failed: ${description}`);
            this.#send(socket, { type: "error", message: description, fatal: false });
        }
    }

    async #handleLive(socket: WebSocket, message: LiveClientMessage): Promise<void> {
        switch (message.type) {
            case "control":
                this.#applyControl(message.action);
                break;
            case "replyApprove":
                if (!this.#cohost.approve(message.id, message.text)) {
                    this.#send(socket, { type: "error", message: "Răspunsul nu mai este în coadă", fatal: false });
                }
                break;
            case "replySkip":
                this.#cohost.skip(message.id);
                break;
            case "speak":
                this.#cohost.speak(message.text);
                break;
            case "transcript":
                this.#cohost.onTranscript(message.itemId, message.text, message.final, message.at);
                break;
            case "sayState":
                this.#cohost.onSayState(message.id, message.state, message.error);
                break;
            case "speechTimeline":
                this.#overlay.pushSpeech({ id: message.id, visemes: message.visemes, words: message.words });
                break;
            case "codaiToken": {
                const baseUrl = this.#codai.baseUrl;
                const minted = await this.#codai.mintLiveToken();
                // The token is a credential: it goes to the requesting socket only, never to logs.
                if (minted.ok) {
                    this.#send(socket, { type: "codaiToken", token: minted.value.token, baseUrl, expiresAt: minted.value.expiresAt });
                } else {
                    log.warn(`codai token mint failed (${minted.error.kind})`);
                    this.#send(socket, { type: "codaiToken", baseUrl, error: minted.error.message });
                }
                break;
            }
            case "effectTest":
                await this.#effects.test(message.kind, message.value);
                break;
            case "goalsReset":
                this.#goals.reset();
                break;
            case "gameStart":
                this.#games.start(message.game);
                break;
            case "gameAction":
                this.#games.action(message.action);
                break;
            case "summaryList":
                this.#send(socket, { type: "summaries", sessions: this.#summaries.sessions() });
                break;
            case "summaryRequest": {
                const result = this.#summaries.summary(message.sessionId);
                this.#send(socket, result.ok ? { type: "summary", summary: result.value, auto: false } : { type: "summary", auto: false, error: result.error });
                break;
            }
            case "summaryExport": {
                const result = await this.#summaries.export(message.sessionId, message.format, message.path);
                // Never log the path: it can contain the Windows user name.
                this.#send(socket, result.ok ? { type: "summaryExported", path: result.value, ok: true } : { type: "summaryExported", path: message.path, ok: false, error: result.error });
                break;
            }
        }
    }

    #pushSummary(sessionId: number, auto: boolean): void {
        try {
            const result = this.#summaries.summary(sessionId);
            if (result.ok) this.#broadcast({ type: "summary", summary: result.value, auto });
            this.#broadcast({ type: "summaries", sessions: this.#summaries.sessions() });
        } catch (error) {
            log.warn(`summary failed: ${describeError(error)}`);
        }
    }

    #applyTranslationSettings(): void {
        this.#translator.enabled = this.#settings.translation.enabled;
        this.#translator.minLetters = this.#settings.translation.minLetters;
    }

    #applyControl(action: ControlAction): void {
        for (const effect of this.#control.apply(action)) {
            if (effect === "skipCurrent") this.#cohost.skipCurrent();
            else if (effect === "silence") this.#cohost.silence();
            else if (effect === "highlight") {
                const note = this.#cohost.highlight();
                log.info(`highlight marked (${note.length} chars)`);
            }
        }
        this.#cohost.controlChanged();
    }

    #applySettings(settings: Settings): void {
        const previous = this.#settings;
        this.#settings = settings;
        logger.setLevel(settings.behaviour.crashReporting ? "debug" : "info");
        if (settings.connection.driver === "sniffer" && previous.connection.driver !== "sniffer") {
            log.warn("the sniffer driver is not available yet; using tiktok-live-connector");
        }
        this.#streams.setSettings(settings);
        this.#panel.setSettings(settings);
        this.#overlay.setSettings(settings);
        this.#obs.setSettings(settings);
        this.#effects.setSettings(settings);
        this.#cohost.setSettings(settings);
        this.#goals.settingsChanged();
        this.#overlay.pushGame(this.#games.state);
        this.#applyTranslationSettings();
        if (settings.data.retentionDays !== previous.data.retentionDays) this.#applyRetention();
        if (settings.behaviour.triggerServerEnabled !== previous.behaviour.triggerServerEnabled) {
            void this.#configureTrigger();
        }
    }

    /** `data.recordSessions`: record every live session as a replay file. */
    #autoRecord(username: string, state: string): void {
        if (!this.#settings.data.recordSessions) return;
        if (state === "live" && !this.#replays.isRecording) {
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            this.#replays.startRecording(`${username}-${stamp}`);
            this.#emitReplayStatus();
        } else if ((state === "offline" || state === "ended") && this.#replays.isRecording && this.#streams.statuses().every((s) => s.state !== "live")) {
            void this.#replays.stopRecording().then(() => this.#emitReplayStatus());
        }
    }

    #applyRetention(): void {
        if (!this.#memory) return;
        try {
            const pruned = this.#memory.prune(this.#settings.data.retentionDays);
            if (pruned > 0) log.info(`retention pruned ${pruned} events`);
        } catch (error) {
            log.warn(`retention prune failed: ${describeError(error)}`);
        }
    }

    /**
     * Stream Deck trigger server (WS22-03). Routes live on the overlay HTTP
     * server (127.0.0.1 only): `POST /control/<action>` with header
     * `x-tiksee-token: <contents of %APPDATA%\ro.codai.tiksee\trigger-token.txt>`
     * → 204. The token is regenerated on every launch.
     */
    async #configureTrigger(): Promise<void> {
        if (!this.#settings.behaviour.triggerServerEnabled) {
            this.#overlay.setTrigger(null);
            return;
        }
        try {
            await mkdir(appDir, { recursive: true });
            await writeFile(join(appDir, "trigger-token.txt"), this.#triggerToken, { encoding: "utf8", mode: 0o600 });
        } catch (error) {
            log.warn(`cannot write trigger token: ${describeError(error)}`);
        }
        this.#overlay.setTrigger({ token: this.#triggerToken, handler: (action) => this.#applyControl(action) });
        log.info("trigger server enabled on the overlay port (POST /control/<action>)");
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

        // Close listeners before the subsystems: a client that reconnects
        // mid-teardown would otherwise be handed a half-disposed sidecar.
        for (const client of this.#clients) {
            try {
                client.close(1001, "sidecar shutting down");
            } catch {
                client.terminate();
            }
        }
        this.#clients.clear();

        const wss = this.#wss;
        this.#wss = null;
        if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()));

        const http = this.#http;
        this.#http = null;
        if (http?.listening) {
            // `close()` waits for keep-alive sockets, which can outlive the
            // grace period the shell allows; force them shut.
            http.closeAllConnections?.();
            await new Promise<void>((resolve) => http.close(() => resolve()));
        }

        await Promise.allSettled([
            this.#streams.dispose(),
            this.#panel.dispose(),
            this.#overlay.stop(),
            this.#obs.disconnect(),
        ]);
        // After streams: their final "offline" statuses close memory sessions.
        await this.#cohost.dispose().catch(() => undefined);
        this.#goals.dispose();
        this.#games.dispose();
        this.#translator.dispose();
        this.#memory?.close();
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
    // Carrying on in an undefined state is worse than dying for a process that
    // owns a serial port and two listening sockets: shut down cleanly so the
    // shell sees the exit and can respawn us.
    log.error("uncaught exception — shutting down", error);
    void shutdown(1);
});
process.on("unhandledRejection", (reason) => {
    // Rejections are far more often recoverable (a transient OBS or network
    // failure), so these are logged and survived.
    log.error("unhandled rejection", reason);
});

sidecar.start(requestedPort).catch((error: unknown) => {
    log.error("failed to start", error);
    process.exit(1);
});
