import type { AssistantSettings, AudioSettings, CodaiSettings } from "@tiksee/core";

import { getCodaiToken, invalidateCodaiToken } from "../codai-token.js";
import { bytesToBase64 } from "./pcm.js";
import workletUrl from "./pcm-worklet.ts?worker&url";
import { EnergyVad } from "./vad.js";

export interface MicConfig {
    assistant: AssistantSettings;
    audio: AudioSettings;
    codai: CodaiSettings;
}

export type MicPhase = "starting" | "connecting" | "live" | "reconnecting" | "error";

export interface MicCallbacks {
    onPhase(phase: MicPhase, error?: string): void;
    onSpeaking(speaking: boolean): void;
    onPartial(itemId: string, text: string): void;
    onFinal(itemId: string, text: string): void;
    /** A non-fatal server error (the session keeps running). */
    onWarning?(message: string): void;
}

/** One diagnostics event (studio mic HUD). */
export interface MicEvent {
    at: number;
    kind: "commit" | "skip" | "final" | "error" | "open" | "close" | "server-commit";
    text: string;
    /** STT item id of a "final" line (the sidecar's transcriptTranslation uses the same id). */
    itemId?: string;
}

/** Live diagnostics snapshot (studio mic HUD), ~10 Hz. */
export interface MicDiag {
    phase: MicPhase;
    device: string;
    sampleRate: number;
    ws: "closed" | "connecting" | "open";
    /** RMS of the last frame and its peak sample, 0..1. */
    level: number;
    peak: number;
    floor: number;
    threshold: number;
    speaking: boolean;
    streaming: boolean;
    /** Push-to-talk is on and the key is not held. */
    waitingForKey: boolean;
    /** Audio appended to the server since the last commit (ms). */
    turnMs: number;
    sentMs: number;
    commits: number;
    finals: number;
    framesPerSec: number;
    partial: string;
    /** ms from the last commit to its final transcript. */
    lastLatencyMs: number | null;
    /** Server event types received this session, with counts (what the gateway really sends). */
    serverEvents: Record<string, number>;
}

/** Commit the turn after this much silence. */
const COMMIT_AFTER_SILENCE_MS = 700;
/** The realtime API rejects a commit of less than 100 ms of audio ("buffer too small"). */
const MIN_COMMIT_MS = 120;
const FRAME_MS = 40;
/** Audio kept from before the VAD fired, so the first syllable is not clipped. */
const PREROLL_FRAMES = 8; // 8 × 40 ms
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

interface WorkletFrame {
    level: number;
    pcm: ArrayBuffer;
}

function peakOf(pcm: ArrayBuffer): number {
    const s = new Int16Array(pcm);
    let max = 0;
    for (let i = 0; i < s.length; i++) {
        const v = Math.abs(s[i] ?? 0);
        if (v > max) max = v;
    }
    return max / 32768;
}

function isWorkletFrame(value: unknown): value is WorkletFrame {
    return (
        typeof value === "object" &&
        value !== null &&
        "level" in value &&
        "pcm" in value &&
        (value as { pcm: unknown }).pcm instanceof ArrayBuffer
    );
}

/**
 * Continuous streamer transcription (WS20-01).
 *
 * Mic → AudioWorklet (24 kHz PCM16) → energy VAD → codai realtime
 * (`codai-transcribe-live`, ro). Audio is only streamed while the streamer
 * is talking (plus pre-roll), and committed after ~700 ms of silence, which
 * keeps the paid STT minutes close to actual speech time.
 */
export class Mic {
    #config: MicConfig;
    readonly #callbacks: MicCallbacks;
    #stream: MediaStream | null = null;
    #ctx: AudioContext | null = null;
    #node: AudioWorkletNode | null = null;
    #ws: WebSocket | null = null;
    #disposed = false;
    #backoff = BACKOFF_MIN_MS;
    #retryTimer: number | null = null;
    #vad = new EnergyVad();
    #preroll: ArrayBuffer[] = [];
    #streaming = false;
    #uncommitted = false;
    #pushToTalk = false;
    #partials = new Map<string, string>();
    readonly #sessionId = crypto.randomUUID();
    #phase: MicPhase = "starting";
    #turnMs = 0;
    #sentMs = 0;
    #commits = 0;
    #finals = 0;
    #committedAt: number[] = [];
    #lastLatencyMs: number | null = null;
    #level = 0;
    #peak = 0;
    #frameTimes: number[] = [];
    #lastPartial = "";
    #events: MicEvent[] = [];
    #serverEvents: Record<string, number> = {};

    /** Live diagnostics (cheap; read by the studio mic HUD). */
    diag(): MicDiag {
        const now = performance.now();
        this.#frameTimes = this.#frameTimes.filter((t) => now - t < 1000);
        const ws = this.#ws;
        return {
            phase: this.#phase,
            device: this.#stream?.getAudioTracks()[0]?.label ?? "",
            sampleRate: this.#ctx?.sampleRate ?? 0,
            ws: !ws ? "closed" : ws.readyState === WebSocket.OPEN ? "open" : ws.readyState === WebSocket.CONNECTING ? "connecting" : "closed",
            level: this.#level,
            peak: this.#peak,
            floor: this.#vad.floor,
            threshold: this.#vad.threshold,
            speaking: this.#vad.speaking,
            streaming: this.#streaming,
            waitingForKey: this.#config.assistant.pushToTalk && !this.#pushToTalk,
            turnMs: this.#turnMs,
            sentMs: this.#sentMs,
            commits: this.#commits,
            finals: this.#finals,
            framesPerSec: this.#frameTimes.length,
            partial: this.#lastPartial,
            lastLatencyMs: this.#lastLatencyMs,
            serverEvents: { ...this.#serverEvents },
        };
    }

    /** Events since the last call (drained). */
    drainEvents(): MicEvent[] {
        return this.#events.splice(0, this.#events.length);
    }

    #event(kind: MicEvent["kind"], text: string, itemId?: string): void {
        this.#events.push({ at: Date.now(), kind, text: text.slice(0, 200), ...(itemId ? { itemId } : {}) });
        if (this.#events.length > 50) this.#events.shift();
    }

    #setPhase(phase: MicPhase, error?: string): void {
        this.#phase = phase;
        this.#callbacks.onPhase(phase, error);
    }

    constructor(config: MicConfig, callbacks: MicCallbacks) {
        this.#config = config;
        this.#callbacks = callbacks;
    }

    async start(): Promise<void> {
        this.#setPhase("starting");
        try {
            await this.#openCapture();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.#event("error", `microphone: ${message}`);
            this.#setPhase("error", message);
            return;
        }
        this.#connect();
    }

    configure(config: MicConfig): void {
        const deviceChanged = config.audio.inputDeviceId !== this.#config.audio.inputDeviceId;
        const modelChanged =
            config.codai.sttModel !== this.#config.codai.sttModel ||
            config.codai.baseUrl !== this.#config.codai.baseUrl;
        this.#config = config;
        if (deviceChanged) {
            this.#closeCapture();
            void this.#openCapture().catch((error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);
                this.#event("error", `microphone: ${message}`);
                this.#setPhase("error", message);
            });
        }
        if (modelChanged) this.#ws?.close();
    }

    setPushToTalk(active: boolean): void {
        this.#pushToTalk = active;
    }

    dispose(): void {
        this.#disposed = true;
        if (this.#retryTimer !== null) window.clearTimeout(this.#retryTimer);
        this.#closeCapture();
        const ws = this.#ws;
        this.#ws = null;
        if (ws) {
            ws.onclose = null;
            ws.close();
        }
    }

    /* ------------------------------ capture ----------------------------- */

    async #openCapture(): Promise<void> {
        const deviceId = this.#config.audio.inputDeviceId;
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                ...(deviceId !== "" ? { deviceId: { exact: deviceId } } : {}),
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
            },
        });
        if (this.#disposed) {
            for (const track of stream.getTracks()) track.stop();
            return;
        }
        const ctx = new AudioContext({ latencyHint: "interactive" });
        await ctx.audioWorklet.addModule(workletUrl);
        const source = ctx.createMediaStreamSource(stream);
        const node = new AudioWorkletNode(ctx, "tiksee-pcm-capture", {
            numberOfInputs: 1,
            numberOfOutputs: 0,
            channelCount: 1,
        });
        node.port.onmessage = (event: MessageEvent<unknown>) => {
            if (isWorkletFrame(event.data)) this.#onFrame(event.data);
        };
        source.connect(node);
        this.#stream = stream;
        this.#ctx = ctx;
        this.#node = node;
    }

    #closeCapture(): void {
        if (this.#node) this.#node.port.onmessage = null;
        this.#node?.disconnect();
        this.#node = null;
        for (const track of this.#stream?.getTracks() ?? []) track.stop();
        this.#stream = null;
        void this.#ctx?.close().catch(() => undefined);
        this.#ctx = null;
    }

    #onFrame(frame: WorkletFrame): void {
        const now = performance.now();
        this.#frameTimes.push(now);
        this.#level = frame.level;
        this.#peak = peakOf(frame.pcm);
        const wasSpeaking = this.#vad.speaking;
        const speaking = this.#vad.update(frame.level, now);
        if (speaking !== wasSpeaking) this.#callbacks.onSpeaking(speaking);

        const gated = !this.#config.assistant.pushToTalk || this.#pushToTalk;
        if (speaking && gated) {
            if (!this.#streaming) {
                this.#streaming = true;
                for (const buffered of this.#preroll) this.#append(buffered);
                this.#preroll = [];
            }
            this.#append(frame.pcm);
            return;
        }

        this.#streaming = false;
        this.#preroll.push(frame.pcm);
        if (this.#preroll.length > PREROLL_FRAMES) this.#preroll.shift();
        if (this.#uncommitted && now - this.#vad.lastVoiceAt > COMMIT_AFTER_SILENCE_MS) {
            // Too little audio (a click, a breath): keep it for the next turn instead of an API error.
            if (this.#turnMs < MIN_COMMIT_MS) {
                this.#event("skip", `${this.#turnMs} ms is too short to transcribe`);
            } else if (this.#sendJson({ type: "input_audio_buffer.commit" })) {
                this.#commits += 1;
                this.#committedAt.push(Date.now());
                if (this.#committedAt.length > 10) this.#committedAt.shift();
                this.#event("commit", `${this.#turnMs} ms of speech sent`);
                this.#turnMs = 0;
            }
            this.#uncommitted = false;
        }
    }

    #append(pcm: ArrayBuffer): void {
        if (this.#sendJson({ type: "input_audio_buffer.append", audio: bytesToBase64(new Uint8Array(pcm)) })) {
            this.#uncommitted = true;
            this.#turnMs += FRAME_MS;
            this.#sentMs += FRAME_MS;
        }
    }

    #sendJson(payload: Record<string, unknown>): boolean {
        const ws = this.#ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify(payload));
        return true;
    }

    /* ----------------------------- realtime ----------------------------- */

    #connect(): void {
        if (this.#disposed) return;
        this.#setPhase(this.#backoff === BACKOFF_MIN_MS ? "connecting" : "reconnecting");
        // A new session starts with an empty server buffer.
        this.#uncommitted = false;
        this.#turnMs = 0;
        void getCodaiToken()
            .then(({ token, baseUrl }) => {
                if (this.#disposed) return;
                const wsBase = baseUrl.replace(/^http/i, "ws");
                const params = new URLSearchParams({
                    model: this.#config.codai.sttModel,
                    language: "ro",
                    key: token,
                    session_id: this.#sessionId,
                });
                const ws = new WebSocket(`${wsBase}/v1/realtime?${params.toString()}`);
                this.#ws = ws;
                ws.onmessage = (event: MessageEvent<unknown>) => this.#onServer(event.data);
                ws.onclose = (event) => {
                    if (this.#ws === ws) this.#ws = null;
                    this.#event("close", `connection closed (${event.code}${event.reason ? ` ${event.reason}` : ""})`);
                    // 1008 / 4001-style closes mean the token was refused.
                    if (event.code === 1008 || (event.code >= 4000 && event.code < 4100)) invalidateCodaiToken();
                    this.#scheduleReconnect();
                };
                ws.onerror = () => ws.close();
            })
            .catch((error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);
                this.#event("error", message);
                this.#setPhase("error", message);
                this.#scheduleReconnect();
            });
    }

    #scheduleReconnect(): void {
        if (this.#disposed || this.#retryTimer !== null) return;
        const delay = this.#backoff;
        this.#backoff = Math.min(this.#backoff * 2, BACKOFF_MAX_MS);
        this.#setPhase("reconnecting");
        this.#retryTimer = window.setTimeout(() => {
            this.#retryTimer = null;
            this.#connect();
        }, delay);
    }

    #onServer(raw: unknown): void {
        if (typeof raw !== "string") return;
        let message: Record<string, unknown>;
        try {
            message = JSON.parse(raw) as Record<string, unknown>;
        } catch {
            return;
        }
        const itemId = typeof message.item_id === "string" ? message.item_id : "";
        const type = typeof message.type === "string" ? message.type.slice(0, 64) : "?";
        this.#serverEvents[type] = (this.#serverEvents[type] ?? 0) + 1;
        switch (message.type) {
            case "session.created":
                this.#backoff = BACKOFF_MIN_MS;
                // Name the transcription model in the session: without this the Azure lane runs its
                // VAD and commits every turn but never transcribes (live 2026-10-07: 17 commits,
                // 0 transcription events). The gateway maps the public model to its deployment.
                this.#sendJson({
                    type: "session.update",
                    session: {
                        type: "transcription",
                        audio: {
                            input: {
                                format: { type: "audio/pcm", rate: 24_000 },
                                transcription: { model: this.#config.codai.sttModel, language: "ro" },
                            },
                        },
                    },
                });
                this.#event("open", "transcription session started");
                this.#setPhase("live");
                break;
            case "session.updated":
                this.#event("open", "transcription configured");
                break;
            case "input_audio_buffer.committed":
                // The server (its own VAD) committed: our pending audio is gone, do not commit it again.
                if (this.#uncommitted || this.#turnMs > 0) {
                    this.#event("server-commit", `server took ${this.#turnMs} ms`);
                    this.#committedAt.push(Date.now());
                    if (this.#committedAt.length > 10) this.#committedAt.shift();
                }
                this.#uncommitted = false;
                this.#turnMs = 0;
                break;
            case "conversation.item.input_audio_transcription.delta": {
                if (typeof message.delta !== "string" || itemId === "") break;
                const text = (this.#partials.get(itemId) ?? "") + message.delta;
                this.#partials.set(itemId, text);
                this.#lastPartial = text;
                this.#callbacks.onPartial(itemId, text);
                break;
            }
            case "conversation.item.input_audio_transcription.completed": {
                if (itemId === "") break;
                const text = typeof message.transcript === "string" ? message.transcript : (this.#partials.get(itemId) ?? "");
                this.#partials.delete(itemId);
                this.#lastPartial = "";
                const committed = this.#committedAt.shift();
                if (committed !== undefined) this.#lastLatencyMs = Date.now() - committed;
                if (text.trim() !== "") {
                    this.#finals += 1;
                    this.#event("final", text.trim(), itemId);
                    this.#callbacks.onFinal(itemId, text.trim());
                } else {
                    // Diagnostic only: an empty result is not a transcript line.
                    this.#event("skip", "empty transcript from the server");
                }
                break;
            }
            case "error": {
                // Server errors in a live session are per-request (e.g. a too-short commit):
                // report them, keep the session and the "live" state.
                const err = message.error as { message?: unknown } | undefined;
                const text = typeof err?.message === "string" ? err.message : "transcription error";
                this.#event("error", text);
                if (this.#callbacks.onWarning) this.#callbacks.onWarning(text);
                else this.#setPhase("error", text);
                break;
            }
            default:
                break;
        }
    }
}
