import type { ChatEvent, StudioSettings } from "@tiksee/core";
import {
    Backdrop,
    FrameStats,
    PetStage,
    ShoulderTracker,
    coverFraming,
    outputSize,
    rawToUpright,
    uprightSize,
    videoToOutput,
    type FrameStatsSnapshot,
    type Landmark,
    type PetClip,
    type PetId,
    type Rotation,
    type ShoulderAnchor,
    type Side,
    type VisemeEvent,
} from "@tiksee/pets";

import { PoseTracker } from "./pose.js";

export const PET_ASSET_BASE = "/pets";
const TRANSCODER = "/basis/";
/** Gift value at or above which the pets dance instead of a quick react. */
const BIG_GIFT_DIAMONDS = 100;
const CLIP_COMMANDS: Readonly<Record<string, PetClip>> = {
    dance: "dance",
    fly: "fly",
    sleep: "sleep",
    look: "look",
    jump: "react",
};

/** Prefer the capture card the owner streams with (Q33), else the first camera. */
export function pickCamera(devices: MediaDeviceInfo[], wanted: string): MediaDeviceInfo | undefined {
    const cams = devices.filter((d) => d.kind === "videoinput");
    return (
        cams.find((d) => d.deviceId === wanted && wanted !== "") ??
        cams.find((d) => /usb ?3\.0 video/i.test(d.label)) ??
        cams[0]
    );
}

/** Map a chat event to a pet reaction: gifts by tier, `!pet <clip>` commands, any chat wakes them. */
export function petEventFor(event: ChatEvent): Parameters<PetStage["send"]>[0] | null {
    if (event.kind === "gift") {
        const value = (event.giftDiamonds ?? 0) * Math.max(event.giftCount ?? 1, 1);
        return { type: "gift", tier: value >= BIG_GIFT_DIAMONDS ? "big" : "small" };
    }
    if (event.kind !== "chat") return null;
    const m = /^!pet\s+(\w+)/i.exec(event.text.trim());
    const clip = m?.[1] ? CLIP_COMMANDS[m[1].toLowerCase()] : undefined;
    return clip ? { type: "command", clip } : { type: "chat" };
}

/**
 * Shoulder anchors in output pixels from raw camera landmarks. `videoW/H` is the
 * raw camera size; `rotation` turns a sideways-mounted camera upright first.
 */
export function anchorsInOutput(
    tracker: ShoulderTracker,
    landmarks: readonly Landmark[] | null,
    videoW: number,
    videoH: number,
    outW: number,
    outH: number,
    mirror: boolean,
    tMs: number,
    rotation: Rotation = 0,
): Record<Side, ShoulderAnchor> | null {
    const [uw, uh] = uprightSize(rotation, videoW, videoH);
    const f = coverFraming(uw, uh, outW, outH, mirror);
    const mapped = landmarks?.map((p) => {
        const [ux, uy] = rawToUpright(rotation, p.x, p.y);
        const [x, y] = videoToOutput(f, ux, uy);
        return { x, y, ...(p.visibility !== undefined ? { visibility: p.visibility } : {}) };
    });
    return tracker.update(mapped ?? null, outW, outH, tMs);
}

export interface EngineCallbacks {
    onStats?(stats: FrameStatsSnapshot & { backend: string; tracking: boolean; video: VideoHealth }): void;
    onError?(message: string): void;
    onStep?(step: string): void;
}

/** What the camera actually delivers, independent of the render loop. */
export interface VideoHealth {
    /** Decoded camera frames per second (requestVideoFrameCallback). */
    fps: number;
    /** Mean luma 0..255 of a 16x16 downsample; ~0 means a black HDMI signal. */
    luma: number;
    state: "live" | "muted" | "ended" | "none";
}

export interface EngineOptions {
    /** Bench: animated 1080p canvas instead of a webcam, scripted shoulders instead of MediaPipe. */
    synthetic?: boolean;
}

function syntheticStream(): MediaStream {
    const c = document.createElement("canvas");
    c.width = 1920;
    c.height = 1080;
    const g = c.getContext("2d");
    const draw = (t: number) => {
        if (!g) return;
        const grad = g.createLinearGradient(0, 0, 1920, 1080);
        grad.addColorStop(0, `hsl(${(t / 40) % 360} 40% 35%)`);
        grad.addColorStop(1, "hsl(210 30% 15%)");
        g.fillStyle = grad;
        g.fillRect(0, 0, 1920, 1080);
        g.fillStyle = "#c8a088";
        g.beginPath();
        g.ellipse(960, 420, 150, 190, 0, 0, Math.PI * 2);
        g.ellipse(960, 980, 420, 260, 0, 0, Math.PI * 2);
        g.fill();
        requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
    return c.captureStream(60);
}

/** Shoulders swaying slowly, in camera-normalised coords (y down). */
function syntheticPose(t: number): Landmark[] {
    const lm: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0 }));
    const sway = Math.sin(t / 900) * 0.02;
    lm[11] = { x: 0.62 + sway, y: 0.78, visibility: 0.99 };
    lm[12] = { x: 0.38 + sway, y: 0.78 + Math.sin(t / 700) * 0.01, visibility: 0.99 };
    return lm;
}

/**
 * Camera + pose + filters + pets in one WebGPU frame. The studio window shows
 * the canvas full-bleed so OBS window capture (and later the native virtual
 * camera) gets exactly this frame.
 */
export class StudioEngine {
    readonly #canvas: HTMLCanvasElement;
    readonly #video = document.createElement("video");
    readonly #pose = new PoseTracker();
    readonly #tracker = new ShoulderTracker();
    readonly #stats = new FrameStats();
    readonly #cb: EngineCallbacks;
    readonly #synthetic: boolean;
    #stage: PetStage | null = null;
    #backdrop: Backdrop | null = null;
    #stream: MediaStream | null = null;
    #settings: StudioSettings;
    #raf = 0;
    #lastFrame = 0;
    #lastStats = 0;
    #pets: Record<Side, PetId | null> = { left: null, right: null };
    #stopped = false;
    #videoFrames = 0;
    #videoFps = 0;
    #videoState: VideoHealth["state"] = "none";
    #luma = -1;
    #lumaCanvas: HTMLCanvasElement | null = null;
    #lastHealth = 0;
    #lastFrameSeen = 0;
    #reopening = false;

    constructor(canvas: HTMLCanvasElement, settings: StudioSettings, cb: EngineCallbacks = {}, options: EngineOptions = {}) {
        this.#canvas = canvas;
        this.#settings = settings;
        this.#cb = cb;
        this.#synthetic = options.synthetic ?? false;
        this.#video.muted = true;
        this.#video.playsInline = true;
    }

    async start(): Promise<void> {
        const size = outputSize(this.#settings.orientation);
        this.#canvas.width = size.width;
        this.#canvas.height = size.height;
        const stage = new PetStage({
            canvas: this.#canvas,
            width: size.width,
            height: size.height,
            assetBase: PET_ASSET_BASE,
            transcoderPath: TRANSCODER,
        });
        await stage.init();
        if (this.#stopped) return stage.dispose();
        this.#cb.onStep?.(`renderer ${stage.backend}`);
        this.#stage = stage;
        await this.#openCamera();
        if (this.#stopped) return this.#release();
        this.#cb.onStep?.(`camera ${this.#video.videoWidth}x${this.#video.videoHeight}`);
        this.#backdrop = new Backdrop(this.#video);
        stage.setBackdrop(this.#backdrop);
        if (!this.#synthetic) {
            await this.#pose.init(this.#settings.backgroundBlur > 0.01).catch((e: unknown) => {
                this.#cb.onError?.(`pose: ${String(e)}`);
            });
            this.#cb.onStep?.("pose ready");
        }
        if (this.#stopped) return this.#release();
        await this.apply(this.#settings);
        this.#cb.onStep?.("pets ready");
        this.#lastFrame = performance.now();
        this.#raf = requestAnimationFrame(this.#frame);
    }

    async #openCamera(): Promise<void> {
        this.#stream?.getTracks().forEach((t) => t.stop());
        if (this.#synthetic) {
            this.#stream = syntheticStream();
            this.#video.srcObject = this.#stream;
            await this.#video.play();
            return;
        }
        let devices = await navigator.mediaDevices.enumerateDevices();
        // Labels are empty until camera permission is granted once; only then probe.
        if (devices.some((d) => d.kind === "videoinput" && d.label === "")) {
            const probe = await navigator.mediaDevices.getUserMedia({ video: true });
            devices = await navigator.mediaDevices.enumerateDevices();
            probe.getTracks().forEach((t) => t.stop());
        }
        const cam = pickCamera(devices, this.#settings.cameraId);
        const constraints: MediaStreamConstraints = {
            video: {
                ...(cam ? { deviceId: { exact: cam.deviceId } } : {}),
                width: { ideal: 1920 },
                height: { ideal: 1080 },
                frameRate: { ideal: 60 },
            },
            audio: false,
        };
        // Windows releases a capture device asynchronously; a reopen right after
        // a stop fails with NotReadableError ("Device in use") for a few hundred ms.
        for (let attempt = 0; ; attempt++) {
            try {
                this.#stream = await navigator.mediaDevices.getUserMedia(constraints);
                break;
            } catch (e) {
                if (!(e instanceof DOMException) || e.name !== "NotReadableError" || attempt >= 12) throw e;
                this.#cb.onStep?.(`camera busy, retry ${attempt + 1}`);
                await new Promise((r) => setTimeout(r, Math.min(250 * (attempt + 1), 1500)));
            }
        }
        this.#video.srcObject = this.#stream;
        await this.#video.play();
        this.#watchTrack();
    }

    /** Count decoded frames and follow track state so a dead feed is visible and recoverable. */
    #watchTrack(): void {
        const track = this.#stream?.getVideoTracks()[0];
        if (!track) return;
        this.#videoState = track.muted ? "muted" : "live";
        track.onmute = () => {
            this.#videoState = "muted";
            this.#cb.onStep?.("camera track muted");
        };
        track.onunmute = () => {
            this.#videoState = "live";
            this.#cb.onStep?.("camera track unmuted");
        };
        track.onended = () => {
            this.#videoState = "ended";
            this.#cb.onStep?.("camera track ended");
            void this.#reopen("track ended");
        };
        this.#lastFrameSeen = performance.now();
        const onFrame = () => {
            this.#videoFrames++;
            this.#lastFrameSeen = performance.now();
            if (this.#stream?.getVideoTracks()[0] === track) this.#video.requestVideoFrameCallback(onFrame);
        };
        this.#video.requestVideoFrameCallback(onFrame);
    }

    async #reopen(reason: string): Promise<void> {
        if (this.#reopening || this.#stopped || this.#synthetic) return;
        this.#reopening = true;
        this.#cb.onStep?.(`camera reopen: ${reason}`);
        try {
            await this.#openCamera();
        } catch (e) {
            this.#cb.onError?.(`camera reopen failed: ${String(e)}`);
        } finally {
            this.#reopening = false;
        }
    }

    #sampleLuma(): number {
        const c = (this.#lumaCanvas ??= Object.assign(document.createElement("canvas"), { width: 16, height: 16 }));
        const g = c.getContext("2d", { willReadFrequently: true });
        if (!g || this.#video.readyState < 2) return -1;
        g.drawImage(this.#video, 0, 0, 16, 16);
        const px = g.getImageData(0, 0, 16, 16).data;
        let sum = 0;
        for (let i = 0; i < px.length; i += 4) sum += 0.2126 * (px[i] ?? 0) + 0.7152 * (px[i + 1] ?? 0) + 0.0722 * (px[i + 2] ?? 0);
        return sum / (px.length / 4);
    }

    async apply(settings: StudioSettings): Promise<void> {
        const prev = this.#settings;
        this.#settings = settings;
        const stage = this.#stage;
        if (!stage) return;
        const size = outputSize(settings.orientation);
        if (size.width !== stage.width || size.height !== stage.height) stage.resize(size.width, size.height);
        if (prev.cameraId !== settings.cameraId && this.#stream) await this.#openCamera();
        this.#backdrop?.setLook(settings);
        await this.#pose.setMasks(settings.backgroundBlur > 0.01).catch(() => undefined);
        for (const [side, choice] of [
            ["left", settings.leftPet],
            ["right", settings.rightPet],
        ] as const) {
            const pet = choice === "none" ? null : choice;
            if (this.#pets[side] !== pet) {
                this.#pets[side] = pet;
                await stage.setPet(side, pet).catch((e: unknown) => this.#cb.onError?.(`pet ${String(pet)}: ${String(e)}`));
            }
        }
    }

    setHidden(hidden: boolean): void {
        this.#stage?.setHidden(hidden);
    }

    onChat(event: ChatEvent): void {
        const e = petEventFor(event);
        if (e) this.#stage?.send(e);
    }

    speak(visemes: readonly VisemeEvent[]): void {
        this.#stage?.speak(visemes);
    }

    #frame = (now: number): void => {
        this.#raf = requestAnimationFrame(this.#frame);
        const stage = this.#stage;
        const backdrop = this.#backdrop;
        if (!stage || !backdrop) return;
        const t0 = performance.now();
        const vw = this.#video.videoWidth || 1920;
        const vh = this.#video.videoHeight || 1080;
        const { mirror } = this.#settings;
        // Synthetic frames are drawn upright already.
        const rotation: Rotation = this.#synthetic ? 0 : this.#settings.rotation;
        const [uw, uh] = uprightSize(rotation, vw, vh);
        const sample = this.#synthetic ? { landmarks: syntheticPose(now), mask: null } : this.#pose.sample(this.#video, now);
        backdrop.layout(stage.width, stage.height, coverFraming(uw, uh, stage.width, stage.height, mirror), uw, uh, rotation);
        if (sample.mask) backdrop.setMask(sample.mask.data, sample.mask.width, sample.mask.height);
        else backdrop.setMask(null, 0, 0);
        const anchors = anchorsInOutput(this.#tracker, sample.landmarks, vw, vh, stage.width, stage.height, mirror, now, rotation);
        const dt = Math.min((now - this.#lastFrame) / 1000, 0.1);
        this.#lastFrame = now;
        stage.render(anchors, dt);
        this.#stats.record(now, performance.now() - t0);
        if (now - this.#lastHealth > 1000) {
            this.#videoFps = (this.#videoFrames * 1000) / (now - this.#lastHealth || 1000);
            this.#videoFrames = 0;
            this.#lastHealth = now;
            this.#luma = this.#sampleLuma();
            // A live track that stops delivering frames for 3 s is wedged (capture card lost sync): reopen it.
            if (!this.#synthetic && this.#stream && now - this.#lastFrameSeen > 3000) void this.#reopen("no frames for 3 s");
        }
        if (now - this.#lastStats > 500) {
            this.#lastStats = now;
            this.#cb.onStats?.({
                ...this.#stats.snapshot(),
                backend: stage.backend,
                tracking: anchors !== null,
                video: { fps: this.#videoFps, luma: this.#luma, state: this.#videoState },
            });
        }
    };

    stop(): void {
        this.#stopped = true;
        this.#release();
    }

    #release(): void {
        cancelAnimationFrame(this.#raf);
        this.#stream?.getTracks().forEach((t) => t.stop());
        this.#stream = null;
        this.#video.srcObject = null;
        this.#pose.close();
        this.#backdrop?.dispose();
        this.#backdrop = null;
        this.#stage?.dispose();
        this.#stage = null;
    }
}
