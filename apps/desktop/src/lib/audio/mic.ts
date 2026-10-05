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
}

/** Commit the turn after this much silence. */
const COMMIT_AFTER_SILENCE_MS = 700;
/** Audio kept from before the VAD fired, so the first syllable is not clipped. */
const PREROLL_FRAMES = 8; // 8 × 40 ms
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

interface WorkletFrame {
    level: number;
    pcm: ArrayBuffer;
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

    constructor(config: MicConfig, callbacks: MicCallbacks) {
        this.#config = config;
        this.#callbacks = callbacks;
    }

    async start(): Promise<void> {
        this.#callbacks.onPhase("starting");
        try {
            await this.#openCapture();
        } catch (error) {
            this.#callbacks.onPhase("error", error instanceof Error ? error.message : String(error));
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
            void this.#openCapture().catch((error: unknown) =>
                this.#callbacks.onPhase("error", error instanceof Error ? error.message : String(error)),
            );
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
            this.#sendJson({ type: "input_audio_buffer.commit" });
            this.#uncommitted = false;
        }
    }

    #append(pcm: ArrayBuffer): void {
        if (this.#sendJson({ type: "input_audio_buffer.append", audio: bytesToBase64(new Uint8Array(pcm)) })) {
            this.#uncommitted = true;
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
        this.#callbacks.onPhase(this.#backoff === BACKOFF_MIN_MS ? "connecting" : "reconnecting");
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
                    // 1008 / 4001-style closes mean the token was refused.
                    if (event.code === 1008 || (event.code >= 4000 && event.code < 4100)) invalidateCodaiToken();
                    this.#scheduleReconnect();
                };
                ws.onerror = () => ws.close();
            })
            .catch((error: unknown) => {
                this.#callbacks.onPhase("error", error instanceof Error ? error.message : String(error));
                this.#scheduleReconnect();
            });
    }

    #scheduleReconnect(): void {
        if (this.#disposed || this.#retryTimer !== null) return;
        const delay = this.#backoff;
        this.#backoff = Math.min(this.#backoff * 2, BACKOFF_MAX_MS);
        this.#callbacks.onPhase("reconnecting");
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
        switch (message.type) {
            case "session.created":
                this.#backoff = BACKOFF_MIN_MS;
                this.#callbacks.onPhase("live");
                break;
            case "conversation.item.input_audio_transcription.delta": {
                if (typeof message.delta !== "string" || itemId === "") break;
                const text = (this.#partials.get(itemId) ?? "") + message.delta;
                this.#partials.set(itemId, text);
                this.#callbacks.onPartial(itemId, text);
                break;
            }
            case "conversation.item.input_audio_transcription.completed": {
                if (itemId === "") break;
                const text = typeof message.transcript === "string" ? message.transcript : (this.#partials.get(itemId) ?? "");
                this.#partials.delete(itemId);
                if (text.trim() !== "") this.#callbacks.onFinal(itemId, text.trim());
                break;
            }
            case "error": {
                const err = message.error as { message?: unknown } | undefined;
                this.#callbacks.onPhase("error", typeof err?.message === "string" ? err.message : "transcription error");
                break;
            }
            default:
                break;
        }
    }
}
