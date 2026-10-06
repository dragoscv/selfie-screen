import type { IdentityProfile, VisionSettings } from "@tiksee/core";

import type { CalibrationSample, EnrolSample, VisionFrame, VisionRuntime } from "../controller.js";
import type { VisionPipeline } from "./pipeline.js";
import type { FromWorker, OptionalModel, PipelineConfig, Rotation, ToWorker } from "./protocol.js";

/**
 * Studio vision runtime.
 *
 * Default: every model runs in a dedicated Web Worker (`./worker.ts`), so the
 * render loop never waits on inference. Each push() turns the <video> into a
 * downscaled ImageBitmap (≤ 640 px long edge, transferred, zero-copy); the
 * worker drops frames while busy, and so do we (one frame in flight).
 *
 * Worker loading: `new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`
 * — the only form Vite 8 bundles in both dev (module worker) and build (IIFE =
 * classic worker). The pipeline detects which kind it runs in and picks the
 * matching MediaPipe wasm loader, so both work under the CSP
 * (worker-src 'self' blob:, script-src 'self' 'wasm-unsafe-eval').
 *
 * Fallback: if the worker cannot start (no OffscreenCanvas/WebGL in workers,
 * init error), the same pipeline runs on the main thread with a staggered
 * schedule (pose + face on even frames, hands on odd, objects every 12th).
 * `timings` carries per-task EMA ms either way, plus `mode.worker` (1/0).
 */
const LONG_EDGE = 640;

interface Pending {
    resolve: (m: FromWorker) => void;
    reject: (e: Error) => void;
    onProgress?: (p: number) => void;
}

type Backend =
    | { kind: "worker"; worker: Worker }
    | { kind: "main"; pipeline: VisionPipeline };

export class StudioVision implements VisionRuntime {
    #backend: Backend | null = null;
    #latest: VisionFrame | null = null;
    #seq = 1;
    readonly #pending = new Map<number, Pending>();
    #inFlight = false;
    #config: PipelineConfig | null = null;
    #closed = false;
    #lastPush = -Infinity;
    /** ms between pushes; ~30 Hz is what the landmarkers track well. */
    readonly #intervalMs: number;

    constructor(intervalMs = 1000 / 30) {
        this.#intervalMs = intervalMs;
    }

    async init(settings: VisionSettings, rotation: Rotation, mirror: boolean): Promise<void> {
        this.#config = { settings, rotation, mirror, stagger: false };
        if (typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined") {
            const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "tiksee-vision" });
            worker.onmessage = (ev: MessageEvent<FromWorker>) => this.#onMessage(ev.data);
            worker.onerror = (ev) => {
                ev.preventDefault();
                this.#failAll(new Error(`vision worker error: ${ev.message}`));
            };
            this.#backend = { kind: "worker", worker };
            try {
                await this.#call({ id: 0, type: "init", config: this.#config });
                return;
            } catch (e) {
                // console.error: tauri-plugin-log only forwards errors to the log file.
                console.error("[vision] worker init failed, running on the main thread:", String(e));
                worker.terminate();
                this.#backend = null;
            }
        }
        const { VisionPipeline } = await import("./pipeline.js");
        const pipeline = new VisionPipeline();
        this.#config = { ...this.#config, stagger: true };
        await pipeline.init(this.#config);
        this.#backend = { kind: "main", pipeline };
    }

    async apply(settings: VisionSettings, rotation: Rotation, mirror: boolean): Promise<void> {
        const b = this.#backend;
        if (!b) return this.init(settings, rotation, mirror);
        this.#config = { settings, rotation, mirror, stagger: b.kind === "main" };
        if (b.kind === "worker") await this.#call({ id: 0, type: "apply", config: this.#config });
        else await b.pipeline.apply(this.#config);
    }

    push(video: HTMLVideoElement, tMs: number): void {
        const b = this.#backend;
        if (!b || this.#closed || this.#inFlight || !this.#config?.settings.enabled) return;
        if (video.readyState < 2 || video.videoWidth === 0 || tMs - this.#lastPush < this.#intervalMs) return;
        this.#lastPush = tMs;
        this.#inFlight = true;
        const rawW = video.videoWidth;
        const rawH = video.videoHeight;
        const s = Math.min(1, LONG_EDGE / Math.max(rawW, rawH));
        const t0 = performance.now();
        createImageBitmap(video, { resizeWidth: Math.round(rawW * s), resizeHeight: Math.round(rawH * s), resizeQuality: "low" })
            .then(async (bitmap) => {
                const grab = performance.now() - t0;
                let frame: VisionFrame;
                if (b.kind === "worker") {
                    const id = this.#seq++;
                    const msg: ToWorker = { id, type: "frame", bitmap, tMs, rawW, rawH };
                    const reply = this.#wait(id);
                    b.worker.postMessage(msg, [bitmap]);
                    const r = await reply;
                    if (r.type !== "frame") return;
                    frame = r.frame;
                } else frame = await b.pipeline.process(bitmap, tMs, rawW, rawH);
                frame.timings["grab"] = grab;
                frame.timings["roundtrip"] = performance.now() - t0;
                frame.timings["mode.worker"] = b.kind === "worker" ? 1 : 0;
                this.#latest = frame;
            })
            .catch((e: unknown) => console.warn("[vision] frame failed:", e))
            .finally(() => (this.#inFlight = false));
    }

    latest(): VisionFrame | null {
        return this.#latest;
    }

    async sampleCalibration(ms: number): Promise<CalibrationSample> {
        const b = this.#need();
        if (b.kind === "main") return b.pipeline.calibrate(ms);
        const r = await this.#call({ id: 0, type: "calibrate", ms });
        if (r.type !== "calibration") throw new Error("unexpected calibration reply");
        return r.sample;
    }

    async sampleEnrolment(kind: "person" | "dog"): Promise<EnrolSample | null> {
        const b = this.#need();
        if (b.kind === "main") return b.pipeline.enrol(kind);
        const r = await this.#call({ id: 0, type: "enrol", kind });
        if (r.type !== "enrolment") throw new Error("unexpected enrolment reply");
        return r.sample;
    }

    async ensureModels(which: OptionalModel[], onProgress?: (p: number) => void): Promise<void> {
        const b = this.#need();
        if (b.kind === "main") return b.pipeline.ensureModels(which, onProgress);
        await this.#call({ id: 0, type: "models", which }, onProgress);
    }

    setProfiles(profiles: IdentityProfile[]): void {
        const b = this.#backend;
        if (!b) return;
        if (b.kind === "main") b.pipeline.setProfiles(profiles);
        else void this.#call({ id: 0, type: "profiles", profiles }).catch(() => {});
    }

    close(): void {
        this.#closed = true;
        const b = this.#backend;
        this.#backend = null;
        if (b?.kind === "worker") {
            b.worker.postMessage({ id: 0, type: "close" } satisfies ToWorker);
            // Give the worker a moment to release GPU resources, then make sure it is gone.
            setTimeout(() => b.worker.terminate(), 500);
        } else b?.pipeline.close();
        this.#failAll(new Error("vision runtime closed"));
    }

    #need(): Backend {
        if (!this.#backend) throw new Error("vision runtime not initialised");
        return this.#backend;
    }

    #wait(id: number, onProgress?: (p: number) => void): Promise<FromWorker> {
        return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject, ...(onProgress ? { onProgress } : {}) }));
    }

    #call(msg: ToWorker, onProgress?: (p: number) => void): Promise<FromWorker> {
        const b = this.#backend;
        if (b?.kind !== "worker") return Promise.reject(new Error("no vision worker"));
        const id = this.#seq++;
        const p = this.#wait(id, onProgress);
        b.worker.postMessage({ ...msg, id });
        return p;
    }

    #onMessage(m: FromWorker): void {
        const p = this.#pending.get(m.id);
        if (!p) return;
        if (m.type === "progress") {
            p.onProgress?.(m.progress);
            return;
        }
        this.#pending.delete(m.id);
        if (m.type === "error") p.reject(new Error(m.message));
        else p.resolve(m);
    }

    #failAll(e: Error): void {
        for (const p of this.#pending.values()) p.reject(e);
        this.#pending.clear();
        this.#inFlight = false;
    }
}
