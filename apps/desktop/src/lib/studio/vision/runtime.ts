import type { IdentityProfile, VisionSettings } from "@tiksee/core";

import type { CalibrationSample, EnrolSample, RawLandmark, VisionFrame, VisionRuntime } from "../controller.js";
import type { VisionPipeline } from "./pipeline.js";
import type { FromWorker, OptionalModel, PipelineConfig, Rotation, ToWorker } from "./protocol.js";

/**
 * Studio vision runtime.
 *
 * Default: every model runs in a dedicated Web Worker (`./worker.ts`), so the
 * render loop never waits on inference. Frames are driven by the camera, not
 * the render loop: `attach(video)` registers `requestVideoFrameCallback`, and
 * each NEW camera frame (presentedFrames changed) becomes a downscaled
 * ImageBitmap (≤ 640 px long edge, transferred, zero-copy) stamped with its
 * capture time on the performance clock. One frame in flight; while busy only
 * the newest frame is remembered and sent as soon as the in-flight one returns.
 * The worker posts the pose result early (`latestPose()`), before the rest.
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

export interface PoseResult {
    tMs: number;
    arrivalMs: number;
    seq: number;
    pose: RawLandmark[] | null;
}

export class StudioVision implements VisionRuntime {
    #backend: Backend | null = null;
    #latest: VisionFrame | null = null;
    #latestPose: PoseResult | null = null;
    #poseSeq = 0;
    #seq = 1;
    readonly #pending = new Map<number, Pending>();
    #inFlight = false;
    #config: PipelineConfig | null = null;
    #closed = false;
    #lastPush = -Infinity;
    #video: HTMLVideoElement | null = null;
    #rvfc: number | null = null;
    #lastPresented = -1;
    /** Capture time of the newest camera frame that arrived while one was in flight. */
    #pendingCapture: number | null = null;
    /** ms between pushes in the legacy (no requestVideoFrameCallback) path. */
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
        pipeline.onPose = (tMs, poses, ownerIndex) => this.#onPose(tMs, poses, ownerIndex);
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

    /** Drive vision from `video`'s own frames (requestVideoFrameCallback). Idempotent per element. */
    attach(video: HTMLVideoElement): void {
        if (this.#closed || this.#video === video) return;
        this.#detach();
        this.#video = video;
        this.#lastPresented = -1;
        this.#pendingCapture = null;
        if (typeof video.requestVideoFrameCallback === "function") this.#arm(video);
    }

    /** Legacy entry point: attaches on first call; only does work when rVFC is unavailable. */
    push(video: HTMLVideoElement, tMs: number): void {
        this.attach(video);
        if (typeof video.requestVideoFrameCallback === "function") return;
        if (this.#inFlight || tMs - this.#lastPush < this.#intervalMs) return;
        this.#lastPush = tMs;
        this.#send(video, performance.now());
    }

    #arm(video: HTMLVideoElement): void {
        this.#rvfc = video.requestVideoFrameCallback((now, meta) => {
            if (this.#closed || this.#video !== video) return;
            this.#arm(video);
            if (meta.presentedFrames === this.#lastPresented) return;
            this.#lastPresented = meta.presentedFrames;
            const captureMs = meta.captureTime ?? meta.expectedDisplayTime - (meta.processingDuration ?? 0) * 1000;
            const t = Number.isFinite(captureMs) && captureMs > 0 ? captureMs : now;
            if (this.#inFlight) this.#pendingCapture = t;
            else this.#send(video, t);
        });
    }

    #detach(): void {
        const v = this.#video;
        if (v && this.#rvfc !== null && typeof v.cancelVideoFrameCallback === "function") v.cancelVideoFrameCallback(this.#rvfc);
        this.#rvfc = null;
        this.#video = null;
    }

    #send(video: HTMLVideoElement, captureMs: number): void {
        const b = this.#backend;
        if (!b || this.#closed || this.#inFlight || !this.#config?.settings.enabled) return;
        if (video.readyState < 2 || video.videoWidth === 0) return;
        this.#inFlight = true;
        const tMs = captureMs;
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
                const arrivalMs = performance.now();
                frame.captureMs = tMs;
                frame.arrivalMs = arrivalMs;
                frame.timings["grab"] = grab;
                frame.timings["roundtrip"] = arrivalMs - t0;
                frame.timings["latency"] = arrivalMs - tMs;
                frame.timings["mode.worker"] = b.kind === "worker" ? 1 : 0;
                this.#latest = frame;
            })
            .catch((e: unknown) => console.warn("[vision] frame failed:", e))
            .finally(() => {
                this.#inFlight = false;
                const next = this.#pendingCapture;
                this.#pendingCapture = null;
                if (next !== null && this.#video) this.#send(this.#video, next);
            });
    }

    latest(): VisionFrame | null {
        return this.#latest;
    }

    /** Newest pose-only result (arrives before the full frame). */
    latestPose(): PoseResult | null {
        return this.#latestPose;
    }

    #onPose(tMs: number, poses: RawLandmark[][], ownerIndex: number): void {
        this.#latestPose = { tMs, arrivalMs: performance.now(), seq: ++this.#poseSeq, pose: poses[ownerIndex] ?? poses[0] ?? null };
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
        this.#detach();
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
        if (m.type === "pose") {
            // Extra message for an in-flight frame id; the "frame" reply still answers it.
            this.#onPose(m.tMs, m.poses, m.ownerIndex);
            return;
        }
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
