import type { AudioSettings, CodaiSettings, VoiceSettings } from "@tiksee/core";

import { getCodaiToken, invalidateCodaiToken } from "../codai-token.js";
import { applySink } from "./output.js";
import { createPcm16Decoder } from "./pcm.js";
import { createSseParser, type SseEvent } from "./sse.js";

export interface Utterance {
    id: string;
    text: string;
    voice: string;
    eventId?: string;
}

export interface Viseme {
    id: number;
    offsetMs: number;
}

export interface WordMark {
    text: string;
    offsetMs: number;
    durationMs: number;
}

export interface SpeakerConfig {
    voice: VoiceSettings;
    audio: AudioSettings;
    codai: CodaiSettings;
}

export interface SpeakerCallbacks {
    onState(id: string, state: "playing" | "done" | "error", error?: string): void;
    onTimeline(id: string, visemes: Viseme[], words: WordMark[]): void;
    onSpeaking(utterance: Utterance | null): void;
}

const DEFAULT_RATE = 24_000;
/** Lead time for the first chunk so the scheduler never starts in the past. */
const START_LEAD_S = 0.06;
const TIMELINE_THROTTLE_MS = 250;
const FETCH_TIMEOUT_MS = 15_000;

class SpeechAborted extends Error {
    constructor() {
        super("cancelled");
    }
}

/**
 * The co-host's voice.
 *
 * `codai`: streams codai-tts-ro over SSE and schedules each PCM16 chunk
 * gaplessly on an AudioContext routed to the chosen output device, so the
 * voice can sit on its own Voicemeeter strip. `system`: Windows voices via
 * speechSynthesis (no device routing — the OS picks the output).
 *
 * Utterances play one at a time in arrival order; `cancel` stops one
 * immediately whether it is playing or still queued.
 */
export class Speaker {
    #config: SpeakerConfig;
    readonly #callbacks: SpeakerCallbacks;
    #queue: Utterance[] = [];
    #current: { utterance: Utterance; abort: AbortController } | null = null;
    #ctx: AudioContext | null = null;
    #volume: GainNode | null = null;
    #duck: GainNode | null = null;
    #sinkId: string | null = null;
    #ducked = false;
    #sources = new Set<AudioBufferSourceNode>();

    constructor(config: SpeakerConfig, callbacks: SpeakerCallbacks) {
        this.#config = config;
        this.#callbacks = callbacks;
    }

    configure(config: SpeakerConfig): void {
        this.#config = config;
        if (this.#volume && this.#ctx) {
            this.#volume.gain.setTargetAtTime(config.voice.volume, this.#ctx.currentTime, 0.05);
        }
        if (this.#ctx && this.#sinkId !== config.audio.outputDeviceId) void this.#routeOutput();
        this.setDucked(this.#ducked);
    }

    /** Lower the voice while the streamer talks (WS18-02). */
    setDucked(ducked: boolean): void {
        this.#ducked = ducked;
        if (!this.#duck || !this.#ctx) return;
        const target = ducked ? this.#config.audio.duckTo : 1;
        // Fast attack, slower release, so speech does not pump.
        this.#duck.gain.setTargetAtTime(target, this.#ctx.currentTime, ducked ? 0.04 : 0.25);
    }

    say(utterance: Utterance): void {
        this.#queue.push(utterance);
        if (!this.#current) void this.#drain();
    }

    cancel(id: string): void {
        const queued = this.#queue.findIndex((u) => u.id === id);
        if (queued !== -1) {
            this.#queue.splice(queued, 1);
            this.#callbacks.onState(id, "error", "cancelled");
            return;
        }
        if (this.#current?.utterance.id === id) this.#current.abort.abort();
    }

    /** Stop everything, e.g. when the voice is switched off. */
    cancelAll(): void {
        for (const u of this.#queue) this.#callbacks.onState(u.id, "error", "cancelled");
        this.#queue = [];
        this.#current?.abort.abort();
    }

    dispose(): void {
        this.cancelAll();
        void this.#ctx?.close().catch(() => undefined);
        this.#ctx = null;
    }

    async #drain(): Promise<void> {
        let next = this.#queue.shift();
        while (next) {
            const abort = new AbortController();
            this.#current = { utterance: next, abort };
            try {
                if (this.#config.voice.engine === "system") await this.#speakSystem(next, abort.signal);
                else await this.#speakCodai(next, abort.signal);
                this.#callbacks.onState(next.id, "done");
            } catch (error) {
                const message =
                    error instanceof SpeechAborted || abort.signal.aborted
                        ? "cancelled"
                        : error instanceof Error
                            ? error.message
                            : String(error);
                this.#stopSources();
                window.speechSynthesis?.cancel();
                this.#callbacks.onState(next.id, "error", message);
            } finally {
                this.#current = null;
                this.#callbacks.onSpeaking(null);
            }
            next = this.#queue.shift();
        }
    }

    /* --------------------------- codai engine --------------------------- */

    async #ensureContext(sampleRate: number): Promise<AudioContext> {
        if (this.#ctx && this.#ctx.sampleRate !== sampleRate) {
            await this.#ctx.close().catch(() => undefined);
            this.#ctx = null;
        }
        if (!this.#ctx) {
            const ctx = new AudioContext({ sampleRate, latencyHint: "interactive" });
            const volume = ctx.createGain();
            const duck = ctx.createGain();
            volume.gain.value = this.#config.voice.volume;
            duck.gain.value = this.#ducked ? this.#config.audio.duckTo : 1;
            volume.connect(duck).connect(ctx.destination);
            this.#ctx = ctx;
            this.#volume = volume;
            this.#duck = duck;
            this.#sinkId = null;
            await this.#routeOutput();
        }
        if (this.#ctx.state === "suspended") await this.#ctx.resume().catch(() => undefined);
        return this.#ctx;
    }

    async #routeOutput(): Promise<void> {
        const ctx = this.#ctx;
        if (!ctx) return;
        const wanted = this.#config.audio.outputDeviceId;
        const ok = await applySink(ctx, wanted);
        this.#sinkId = ok ? wanted : "";
    }

    async #openStream(utterance: Utterance, signal: AbortSignal, retried = false): Promise<Response> {
        const { token, baseUrl } = await getCodaiToken();
        if (signal.aborted) throw new SpeechAborted();
        const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
        const response = await fetch(`${baseUrl}/v1/audio/speech/stream`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                Accept: "text/event-stream",
            },
            body: JSON.stringify({
                model: this.#config.codai.ttsModel,
                input: utterance.text,
                voice: utterance.voice === "emil" || utterance.voice === "alina" ? utterance.voice : this.#config.voice.voice,
                response_format: "pcm",
                speed: this.#config.voice.speed,
            }),
            // Only the connect phase is time-boxed; a long utterance may stream for longer.
            signal: AbortSignal.any([signal, timeout]),
        });
        if (response.status === 401 && !retried) {
            invalidateCodaiToken();
            return this.#openStream(utterance, signal, true);
        }
        if (!response.ok || !response.body) {
            throw new Error(`codai TTS HTTP ${response.status}`);
        }
        return response;
    }

    async #speakCodai(utterance: Utterance, signal: AbortSignal): Promise<void> {
        const response = await this.#openStream(utterance, signal);
        const body = response.body;
        if (!body) throw new Error("codai TTS returned no body");

        let ctx: AudioContext | null = null;
        let nextTime = 0;
        let started = false;
        let finished = false;
        let failure: string | null = null;
        let sampleRate = DEFAULT_RATE;
        const decoder = createPcm16Decoder();
        const visemes: Viseme[] = [];
        const words: WordMark[] = [];
        let lastTimelineAt = 0;
        const pending: Promise<void>[] = [];

        const pushTimeline = (force: boolean) => {
            const now = performance.now();
            if (!force && now - lastTimelineAt < TIMELINE_THROTTLE_MS) return;
            lastTimelineAt = now;
            this.#callbacks.onTimeline(utterance.id, [...visemes], [...words]);
        };

        const playChunk = async (base64: string) => {
            ctx ??= await this.#ensureContext(sampleRate);
            if (signal.aborted) return;
            const samples = decoder.decode(base64);
            if (samples.length === 0) return;
            const buffer = ctx.createBuffer(1, samples.length, sampleRate);
            buffer.copyToChannel(samples, 0);
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(this.#volume ?? ctx.destination);
            const at = Math.max(nextTime, ctx.currentTime + START_LEAD_S);
            source.start(at);
            nextTime = at + buffer.duration;
            this.#sources.add(source);
            source.onended = () => this.#sources.delete(source);
            if (!started) {
                started = true;
                this.#callbacks.onState(utterance.id, "playing");
                this.#callbacks.onSpeaking(utterance);
            }
        };

        // Chunks must be scheduled strictly in order even though the first
        // one awaits context creation, hence the promise chain.
        let chain: Promise<void> = Promise.resolve();
        const onEvent = ({ event, data }: SseEvent) => {
            let payload: Record<string, unknown>;
            try {
                payload = JSON.parse(data) as Record<string, unknown>;
            } catch {
                return;
            }
            switch (event) {
                case "start":
                    if (typeof payload.sample_rate === "number" && payload.sample_rate > 0) {
                        sampleRate = payload.sample_rate;
                    }
                    break;
                case "audio":
                    if (typeof payload.delta === "string") {
                        const delta = payload.delta;
                        chain = chain.then(() => playChunk(delta));
                        pending.push(chain);
                    }
                    break;
                case "viseme":
                    if (typeof payload.id === "number" && typeof payload.offsetMs === "number") {
                        visemes.push({ id: payload.id, offsetMs: payload.offsetMs });
                        pushTimeline(false);
                    }
                    break;
                case "word":
                    if (
                        typeof payload.text === "string" &&
                        typeof payload.offsetMs === "number" &&
                        typeof payload.durationMs === "number"
                    ) {
                        words.push({ text: payload.text, offsetMs: payload.offsetMs, durationMs: payload.durationMs });
                        pushTimeline(false);
                    }
                    break;
                case "done":
                    finished = true;
                    break;
                case "error": {
                    const err = payload.error as { message?: unknown } | undefined;
                    failure = typeof err?.message === "string" ? err.message : "codai TTS error";
                    break;
                }
                default:
                    break;
            }
        };

        const parser = createSseParser(onEvent);
        const reader = body.pipeThrough(new TextDecoderStream()).getReader();
        const onAbort = () => void reader.cancel().catch(() => undefined);
        signal.addEventListener("abort", onAbort, { once: true });
        try {
            for (; ;) {
                const { value, done } = await reader.read();
                if (done) break;
                parser.feed(value);
                if (failure !== null || finished) break;
            }
            parser.flush();
        } finally {
            signal.removeEventListener("abort", onAbort);
        }
        await Promise.all(pending);
        if (signal.aborted) throw new SpeechAborted();
        if (failure !== null) throw new Error(failure);
        if (!started) throw new Error("codai TTS returned no audio");

        pushTimeline(true);
        await this.#waitUntilPlayed(nextTime, signal);
    }

    #waitUntilPlayed(endTime: number, signal: AbortSignal): Promise<void> {
        const ctx = this.#ctx;
        if (!ctx) return Promise.resolve();
        const remainingMs = Math.max(0, (endTime - ctx.currentTime) * 1000);
        return new Promise<void>((resolve, reject) => {
            const timer = window.setTimeout(() => {
                signal.removeEventListener("abort", onAbort);
                resolve();
            }, remainingMs + 30);
            const onAbort = () => {
                window.clearTimeout(timer);
                reject(new SpeechAborted());
            };
            signal.addEventListener("abort", onAbort, { once: true });
        });
    }

    #stopSources(): void {
        for (const source of this.#sources) {
            try {
                source.stop();
            } catch {
                // Already stopped.
            }
        }
        this.#sources.clear();
    }

    /* --------------------------- system engine -------------------------- */

    #speakSystem(utterance: Utterance, signal: AbortSignal): Promise<void> {
        const synth = window.speechSynthesis;
        if (!synth) return Promise.reject(new Error("speechSynthesis unavailable"));
        const { voice } = this.#config;
        const spoken = new SpeechSynthesisUtterance(utterance.text);
        spoken.rate = voice.speed;
        spoken.pitch = voice.pitch;
        // speechSynthesis cannot be ducked mid-utterance; apply the duck at start.
        spoken.volume = voice.volume * (this.#ducked ? this.#config.audio.duckTo : 1);
        const picked = pickSystemVoice(synth.getVoices(), voice);
        if (picked) {
            spoken.voice = picked;
            spoken.lang = picked.lang;
        } else {
            spoken.lang = voice.language === "en" ? "en-US" : "ro-RO";
        }

        return new Promise<void>((resolve, reject) => {
            const onAbort = () => {
                synth.cancel();
                reject(new SpeechAborted());
            };
            signal.addEventListener("abort", onAbort, { once: true });
            spoken.onstart = () => {
                this.#callbacks.onState(utterance.id, "playing");
                this.#callbacks.onSpeaking(utterance);
            };
            spoken.onend = () => {
                signal.removeEventListener("abort", onAbort);
                resolve();
            };
            spoken.onerror = (event) => {
                signal.removeEventListener("abort", onAbort);
                reject(new Error(`speechSynthesis: ${event.error}`));
            };
            synth.speak(spoken);
        });
    }
}

/** The configured voice, else a Romanian one, else whatever the OS defaults to. */
export function pickSystemVoice(
    voices: readonly SpeechSynthesisVoice[],
    voice: Pick<VoiceSettings, "systemVoiceUri" | "language">,
): SpeechSynthesisVoice | undefined {
    if (voice.systemVoiceUri !== "") {
        const exact = voices.find((v) => v.voiceURI === voice.systemVoiceUri);
        if (exact) return exact;
    }
    const lang = voice.language === "en" ? "en" : "ro";
    return voices.find((v) => v.lang.toLowerCase().startsWith(lang));
}
