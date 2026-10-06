import {
    visionSchema,
    type ArObject,
    type ChatEvent,
    type IdentityProfile,
    type PetCommand,
    type PetObservation,
    type PetPersonality,
    type PetSay,
    type RuleAction,
    type SignalEvent,
    type StudioSettings,
    type VisionSettings,
    type VisionSnapshot,
} from "@tiksee/core";
import {
    Backdrop,
    BodyModel,
    FrameStats,
    PetStage,
    anchorPoints,
    unproject,
    coverFraming,
    evenSize,
    outputSize,
    rawToOutput,
    rawToUpright,
    uprightSize,
    videoToOutput,
    type Framing,
    type FrameStatsSnapshot,
    type Landmark,
    type OutputLandmark,
    type PetClip,
    type PetId,
    type PersonalityState,
    type Rotation,
    type ShoulderAnchor,
    type ShoulderTracker,
    type Side,
    type VisemeEvent,
} from "@tiksee/pets";
import * as THREE from "three/webgpu";
import { positionGeometry, screenUV, texture, vec4 } from "three/tsl";

import { ArLayer, type Anchors } from "./ar.js";
import { CameraRemote, type HoldAction } from "./camera-ble.js";
import { clipFileName } from "./clip-ring.js";
import { ClipRecorder, type ClipState, type SavedClip } from "./clips.js";
import type {
    CalibrationSample,
    Debug3dState,
    DebugHand,
    HandSample,
    LensProgress,
    LensResult,
    SceneResult,
    SpaceSample,
    DogBox,
    EnrolSample,
    FaceBox,
    GestureHint,
    StudioController,
    StudioFrameInfo,
    VisionFrame,
    VisionRuntime,
} from "./controller.js";
import { EffectLayer, effectOrigin } from "./effects.js";
import { cameraVfov, uprightVfov } from "./camera-fov.js";
import { HandSpace, palmPerches } from "./hand-space.js";
import { MetricDistance, type MetricConfig, type PoseForDistance } from "./metric-distance.js";
import { DigitalFraming } from "./framing.js";
import { PreviewPass } from "./monitor.js";
import { VcamPump } from "./output.js";
import { ScopeSampler } from "./scopes.js";
import { StudioVision } from "./vision/runtime.js";

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
/** UI info rate. */
const INFO_HZ = 15;
/** Owner signals the pets may comment on (chatty level). */
const OBSERVED_SIGNALS: ReadonlySet<string> = new Set([
    "wave",
    "heart",
    "laughing",
    "drinking",
    "eating",
    "phone",
    "standing",
    "away",
    "thumb_up",
    "thumb_down",
    "victory",
    "clap",
    "yawning",
    "dancing",
    "owner_present",
]);
const DEFAULT_OWNER_M = 1;
/** Gestures the pets answer, and how. */
const PET_GESTURES: Readonly<Partial<Record<SignalEvent["signal"], "wave" | "heart" | "point_left" | "point_right" | "point_up">>> = {
    wave: "wave",
    heart: "heart",
    point_left: "point_left",
    point_right: "point_right",
    point_up: "point_up",
};

/** Output-normalised landmarks from a raw pose through rotation + framing (MediaPipe z kept). */
export function poseToOutput(
    pose: readonly { x: number; y: number; z: number; visibility?: number }[],
    f: Framing,
    rotation: Rotation,
): OutputLandmark[] {
    return pose.map((p) => {
        const [u, v] = rawToOutput(f, rotation, p.x, p.y);
        return { u, v, z: p.z, visibility: p.visibility ?? 1 };
    });
}

/**
 * Vertical FOV of the OUTPUT image: the camera's vFOV over the output's
 * vertical extent, narrowed by the cover crop and the digital zoom
 * (framing.scaleY = fraction of the upright camera height shown).
 */
export function outputVfov(cameraVfovDeg: number, f: Framing): number {
    const half = Math.tan((cameraVfovDeg * Math.PI) / 360) * f.scaleY;
    return (Math.atan(half) * 360) / Math.PI;
}
const POSE = { nose: 0, leftShoulder: 11, rightShoulder: 12, leftWrist: 15, rightWrist: 16 } as const;

type Box = { x: number; y: number; w: number; h: number };

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
 * `framing` (digital crop) defaults to the plain cover crop.
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
    framing?: Framing,
): Record<Side, ShoulderAnchor> | null {
    const [uw, uh] = uprightSize(rotation, videoW, videoH);
    const f = framing ?? coverFraming(uw, uh, outW, outH, mirror);
    const mapped = landmarks?.map((p) => {
        const [ux, uy] = rawToUpright(rotation, p.x, p.y);
        const [x, y] = videoToOutput(f, ux, uy);
        return { x, y, ...(p.visibility !== undefined ? { visibility: p.visibility } : {}) };
    });
    return tracker.update(mapped ?? null, outW, outH, tMs);
}

/** A raw-camera box (x, y = top-left) mapped to output-normalised, as min/max of its corners. */
export function boxToOutput(f: Framing, r: Rotation, b: Box): Box {
    const [ax, ay] = rawToOutput(f, r, b.x, b.y);
    const [bx, by] = rawToOutput(f, r, b.x + b.w, b.y + b.h);
    return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

/** A raw-camera box mapped to upright camera coords. */
export function boxToUpright(r: Rotation, b: Box): Box {
    const [ax, ay] = rawToUpright(r, b.x, b.y);
    const [bx, by] = rawToUpright(r, b.x + b.w, b.y + b.h);
    return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

/** Face box + eyes from raw camera coords to output-normalised; roll re-derived on screen. */
export function faceToOutput(f: Framing, r: Rotation, face: FaceBox): FaceBox {
    const box = boxToOutput(f, r, face);
    const leftEye = rawToOutput(f, r, face.leftEye[0], face.leftEye[1]);
    const rightEye = rawToOutput(f, r, face.rightEye[0], face.rightEye[1]);
    const [a, b] = leftEye[0] <= rightEye[0] ? [leftEye, rightEye] : [rightEye, leftEye];
    const rollDeg = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    return { ...face, ...box, leftEye, rightEye, rollDeg };
}

/** Owner face (flagged), else the largest. */
export function ownerFace<T extends { w: number; h: number; owner?: boolean }>(faces: readonly T[]): T | undefined {
    const owner = faces.find((f) => f.owner);
    if (owner) return owner;
    let best: T | undefined;
    for (const f of faces) if (!best || f.w * f.h > best.w * best.h) best = f;
    return best;
}

export interface EngineStats extends FrameStatsSnapshot {
    backend: string;
    tracking: boolean;
    video: VideoHealth;
    /** ?bench timings, ms (EMA): render, visionPush, scopes, scopesReadback, vcamConvert, vcamReadback, vcamIpc, vcamFps + vision tasks. */
    timings: Record<string, number>;
}

export interface EngineCallbacks {
    onStats?(stats: EngineStats): void;
    onError?(message: string): void;
    onStep?(step: string): void;
    /** Studio-side toggles (zoom, reframe, peaking, AR visibility...) the caller must persist; already applied. */
    onSettingsPatch?(patch: Partial<StudioSettings>): void;
    /** The loupe (DOM, in the studio UI) was toggled by an action. */
    onLoupe?(on: boolean): void;
    /** A clip was muxed from the rolling buffer (`saveClip`); the caller writes it to disk. */
    onClip?(clip: SavedClip): Promise<void>;
    /** The owner moved / resized a pet with the hands (observation for chatty pets). */
    onPetObservation?(o: PetObservation): void;
}

/** Two saves closer than this (a rule and a hotkey on the same moment) are one save. */
const CLIP_COOLDOWN_MS = 2000;

/** What the camera actually delivers, independent of the render loop. */
export interface VideoHealth {
    /** Decoded camera frames per second (requestVideoFrameCallback). */
    fps: number;
    /** Mean luma 0..255 of a 16x16 downsample; ~0 means a black HDMI signal. */
    luma: number;
    state: "live" | "muted" | "ended" | "none";
}

export interface EngineOptions {
    /** Bench: animated 1080p canvas instead of a webcam, scripted subject instead of the vision runtime. */
    synthetic?: boolean;
    /** Initial vision settings (default: schema defaults until applyVision). */
    vision?: VisionSettings;
    /** Run the NV12 conversion without IPC to measure it (`?bench=vcam`). */
    benchVcam?: boolean;
    /** Force the readRenderTargetPixelsAsync + CPU NV12 path (`?vcam=cpu`), for A/B measurement. */
    vcamCpu?: boolean;
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

const EMPTY_SNAPSHOT: VisionSnapshot = { at: 0, subjects: [], perf: { renderFps: 0, cameraFps: 0, visionMs: {}, vcamFps: 0 } };

/** Scripted subject for the bench: swaying shoulders and a face, no mask. Raw camera coords. */
export function syntheticFrame(t: number): VisionFrame {
    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0 }));
    const sway = Math.sin(t / 900) * 0.02;
    lm[POSE.nose] = { x: 0.5 + sway, y: 0.4, z: 0, visibility: 0.99 };
    lm[POSE.leftShoulder] = { x: 0.62 + sway, y: 0.78, z: 0, visibility: 0.99 };
    lm[POSE.rightShoulder] = { x: 0.38 + sway, y: 0.78 + Math.sin(t / 700) * 0.01, z: 0, visibility: 0.99 };
    const face: FaceBox = {
        x: 0.42 + sway,
        y: 0.215,
        w: 0.156,
        h: 0.35,
        leftEye: [0.47 + sway, 0.36],
        rightEye: [0.53 + sway, 0.36],
        rollDeg: 0,
        track: 1,
        owner: true,
    };
    return {
        tMs: t,
        poses: [lm],
        mask: null,
        depth: null,
        faces: [face],
        dogs: [],
        hints: [],
        events: [],
        snapshot: { ...EMPTY_SNAPSHOT, at: 0 },
        ownerDistanceM: DEFAULT_OWNER_M,
        armed: false,
        timings: {},
    };
}

/** Inverse depth at a raw-normalised point (nearest sample). */
export function depthAt(d: NonNullable<VisionFrame["depth"]>, x: number, y: number): number {
    const px = Math.min(d.width - 1, Math.max(0, Math.round(x * (d.width - 1))));
    const py = Math.min(d.height - 1, Math.max(0, Math.round(y * (d.height - 1))));
    return d.data[py * d.width + px] ?? 0;
}

const ema = (prev: number, v: number): number => (prev === 0 ? v : prev * 0.9 + v * 0.1);

/**
 * Camera + vision + filters + AR + pets on one WebGPU device, three passes:
 *  1. CAMERA target: the graded camera (exposure, smoothing, blur, DoF,
 *     digital framing). Monitoring aids and scopes judge this image.
 *  2. OUTPUT target: camera + AR objects + pets + effects. The virtual camera
 *     gets exactly this (NV12 converted on the GPU).
 *  3. Canvas (preview): output + monitoring aids, unless clean feed.
 * The canvas is linear-output / no tone mapping; pets apply ACES in their own
 * materials, so the camera image is never tone mapped.
 */
export class StudioEngine implements StudioController {
    readonly #canvas: HTMLCanvasElement;
    readonly #video = document.createElement("video");
    readonly #body = new BodyModel({ width: 1080, height: 1920, vfovDeg: 60 });
    #bodySnap: ReturnType<BodyModel["sample"]> | null = null;
    #poseHz = 0;
    #lastPoseAt = 0;
    #poseSeq = -1;
    readonly #metric = new MetricDistance();
    readonly #hands = new HandSpace();
    #handsSeq = -1;
    #debugHands: readonly DebugHand[] = [];
    readonly #personalitySubs = new Set<(pets: readonly PetPersonality[]) => void>();
    #personalities: readonly PetPersonality[] = [];
    /** Sidecar transport for personality list/reset (set by the studio window). */
    sendToSidecar: ((m: { type: "petPersonalityList" } | { type: "petPersonalityReset"; pet: string }) => void) | null = null;
    readonly #observations: PetObservation[] = [];
    /** Space calibration capture in progress (raw early poses). */
    #spaceCapture: PoseForDistance[] | null = null;
    #lastRender = 0;
    readonly #stats = new FrameStats();
    readonly #cb: EngineCallbacks;
    readonly #synthetic: boolean;
    readonly #options: EngineOptions;
    readonly #framing = new DigitalFraming();
    readonly #remote: CameraRemote;
    readonly #frameSubs = new Set<(info: StudioFrameInfo) => void>();
    readonly #signalSubs = new Set<(events: SignalEvent[], armed: boolean) => void>();
    readonly #timings: Record<string, number> = { render: 0, visionPush: 0, scopes: 0, scopesReadback: 0 };
    readonly #arAnchors: Anchors = {};
    #vision: VisionRuntime | null = null;
    #visionSettings: VisionSettings;
    #stage: PetStage | null = null;
    #backdrop: Backdrop | null = null;
    #camScene = new THREE.Scene();
    #camRT: THREE.RenderTarget | null = null;
    #outRT: THREE.RenderTarget | null = null;
    #copy: THREE.Mesh | null = null;
    #preview: PreviewPass | null = null;
    #pump: VcamPump | null = null;
    #clips: ClipRecorder | null = null;
    #clipSaving: Promise<void> | null = null;
    #clipSavedAt = 0;
    #scopes: ScopeSampler | null = null;
    #ar: ArLayer | null = null;
    #effects: EffectLayer | null = null;
    #stream: MediaStream | null = null;
    #settings: StudioSettings;
    #raf = 0;
    #lastFrame = 0;
    #lastStats = 0;
    #lastInfo = 0;
    #pets: Record<Side, PetId | null> = { left: null, right: null };
    #stopped = false;
    #hidden = false;
    #loupe = false;
    #videoFrames = 0;
    #videoFps = 0;
    #videoState: VideoHealth["state"] = "none";
    #luma = -1;
    #lumaCanvas: HTMLCanvasElement | null = null;
    #lastHealth = 0;
    #lastFrameSeen = 0;
    #reopening = false;
    #wantScopes = false;
    #lastVision: VisionFrame | null = null;
    #armed = false;
    #ownerFace: FaceBox | undefined;
    #ownerM: number | undefined;

    constructor(canvas: HTMLCanvasElement, settings: StudioSettings, cb: EngineCallbacks = {}, options: EngineOptions = {}) {
        this.#canvas = canvas;
        this.#settings = settings;
        this.#cb = cb;
        this.#options = options;
        this.#synthetic = options.synthetic ?? false;
        this.#visionSettings = options.vision ?? visionSchema.parse({});
        this.#remote = new CameraRemote((m) => cb.onError?.(m));
        this.#video.muted = true;
        this.#video.playsInline = true;
    }

    get outputSize(): { width: number; height: number } {
        return this.#stage ? { width: this.#stage.width, height: this.#stage.height } : this.#wantedSize(this.#settings);
    }

    /** The virtual camera consumer's negotiated size wins; else the orientation preset. */
    #wantedSize(s: StudioSettings): { width: number; height: number } {
        const consumer = s.virtualCamera ? this.#pump?.status.consumerSize : undefined;
        return consumer ? evenSize(consumer[0], consumer[1]) : outputSize(s.orientation);
    }

    async start(): Promise<void> {
        const size = this.#wantedSize(this.#settings);
        this.#canvas.width = size.width;
        this.#canvas.height = size.height;
        this.#cb.onStep?.("probing webgpu");
        const webgpu = await PetStage.webgpuAvailable();
        if (!webgpu) this.#cb.onStep?.("webgpu adapter unavailable, using webgl2");
        const stage = new PetStage({
            canvas: this.#canvas,
            width: size.width,
            height: size.height,
            assetBase: PET_ASSET_BASE,
            transcoderPath: TRANSCODER,
            antialias: false,
            inlineToneMapping: true,
            forceWebGL: !webgpu,
        });
        await stage.init();
        if (this.#stopped) return stage.dispose();
        this.#cb.onStep?.(`renderer ${stage.backend}`);
        this.#stage = stage;
        stage.onInteraction = (e) => {
            this.#observe(e.kind, e.pet);
            if (e.kind === "resized" && e.scale !== undefined) {
                const scale = { ...this.#settings.petHands.scale, [e.pet]: Math.round(e.scale * 100) / 100 };
                void this.#patch({ petHands: { ...this.#settings.petHands, scale } });
            }
        };
        for (const p of this.#personalities) stage.setPersonality(p.pet, { traits: p.traits, likes: p.likes as PersonalityState["likes"], sessions: p.sessions });
        this.#setupTargets(size.width, size.height);
        await this.#openCamera();
        if (this.#stopped) return this.#release();
        this.#cb.onStep?.(`camera ${this.#video.videoWidth}x${this.#video.videoHeight}`);
        const backdrop = new Backdrop(this.#video);
        this.#backdrop = backdrop;
        this.#camScene.add(backdrop.mesh);
        stage.setBackdrop(backdrop);
        this.#ar = new ArLayer(stage.scene, backdrop, stage, (m) => this.#cb.onError?.(m));
        this.#effects = new EffectLayer(stage.scene);
        const query = typeof location === "undefined" ? null : new URLSearchParams(location.search);
        const benchVcam = this.#options.benchVcam ?? query?.get("bench") === "vcam";
        this.#pump = new VcamPump(stage.renderer, (m) => this.#cb.onError?.(m), { measureOnly: benchVcam });
        this.#pump.forceCpu = this.#options.vcamCpu ?? query?.get("vcam") === "cpu";
        // ?clips=off: A/B the render budget without the clip encoder.
        if (query?.get("clips") !== "off") this.#clips = new ClipRecorder(stage.renderer, (m) => this.#cb.onError?.(m));
        void this.#remote.listen().catch((e: unknown) => this.#cb.onError?.(`camera ble: ${String(e)}`));
        if (!this.#synthetic) {
            const vision = new StudioVision();
            try {
                await vision.init(this.#visionSettings, this.#settings.rotation, this.#settings.mirror);
                this.#vision = vision;
                this.#cb.onStep?.("vision ready");
            } catch (e) {
                vision.close();
                this.#cb.onError?.(`vision: ${String(e)}`);
            }
        }
        if (this.#stopped) return this.#release();
        await this.applyStudio(this.#settings);
        this.#cb.onStep?.("pets ready");
        this.#lastFrame = performance.now();
        this.#raf = requestAnimationFrame(this.#frame);
    }

    #setupTargets(width: number, height: number): void {
        const stage = this.#stage;
        if (!stage) return;
        this.#camRT = new THREE.RenderTarget(width, height, { colorSpace: THREE.SRGBColorSpace, depthBuffer: false, generateMipmaps: false });
        this.#outRT = new THREE.RenderTarget(width, height, { colorSpace: THREE.SRGBColorSpace, samples: 4, generateMipmaps: false });
        // The graded camera at the bottom of the output scene; pets and AR draw over it.
        // Clip-space quad at the far plane: fills the frame under the perspective camera.
        const m = new THREE.MeshBasicNodeMaterial();
        m.vertexNode = vec4(positionGeometry.xy.mul(2), 0.999, 1);
        m.colorNode = texture(this.#camRT.texture, screenUV);
        m.blending = THREE.NoBlending;
        m.depthTest = false;
        m.depthWrite = false;
        m.side = THREE.DoubleSide;
        this.#copy = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
        this.#copy.renderOrder = -1000;
        this.#copy.frustumCulled = false;
        stage.scene.add(this.#copy);
        this.#preview = new PreviewPass(this.#outRT.texture, this.#camRT.texture);
        this.#scopes = new ScopeSampler(this.#camRT.texture);
    }

    #resize(width: number, height: number): void {
        const stage = this.#stage;
        if (!stage || (stage.width === width && stage.height === height)) return;
        stage.resize(width, height);
        this.#camRT?.setSize(width, height);
        this.#outRT?.setSize(width, height);
        this.#cb.onStep?.(`output ${width}x${height}`);
    }

    async #openCamera(): Promise<void> {
        this.#stream?.getTracks().forEach((t) => t.stop());
        if (this.#synthetic) {
            this.#stream = syntheticStream();
            this.#video.srcObject = this.#stream;
            await this.#play();
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
        await this.#play();
        this.#watchTrack();
    }

    /**
     * `play()` on a detached MediaStream video may never settle in some
     * Chromium embeddings (measured: VS Code's Electron browser, 64x64 canvas
     * stream, still pending after 4 s). Rejections still surface; a pending
     * promise just stops blocking start-up, and the loop already skips
     * frames until `readyState >= 2`.
     */
    async #play(timeoutMs = 3000): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settled = await Promise.race([
            this.#video.play().then(() => true),
            new Promise<false>((resolve) => {
                timer = setTimeout(() => resolve(false), timeoutMs);
            }),
        ]).finally(() => clearTimeout(timer));
        if (!settled) this.#cb.onStep?.(`video play() pending after ${timeoutMs} ms, continuing`);
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

    /** Back-compat alias used by the studio window. */
    apply(settings: StudioSettings): Promise<void> {
        return this.applyStudio(settings);
    }

    #updateWantScopes(): void {
        const m = this.#settings.monitor;
        this.#wantScopes = m.scope !== "none" || m.clipping || this.#visionSettings.coach.exposure;
    }

    async applyStudio(settings: StudioSettings): Promise<void> {
        const prev = this.#settings;
        this.#settings = settings;
        const stage = this.#stage;
        if (!stage) return;
        this.#pump?.configure(settings.virtualCamera, settings.orientation === "portrait", settings.virtualCameraFps);
        this.#clips?.configure(settings.clips);
        const size = this.#wantedSize(settings);
        this.#resize(size.width, size.height);
        if (prev.cameraId !== settings.cameraId && this.#stream) await this.#openCamera();
        this.#backdrop?.setLook(settings);
        this.#preview?.set(settings.monitor);
        if (this.#framing.targetZoom !== settings.framing.zoom) this.#framing.setZoom(settings.framing.zoom);
        this.#ar?.set(settings.arObjects);
        this.#updateWantScopes();
        if (this.#vision && (prev.rotation !== settings.rotation || prev.mirror !== settings.mirror)) {
            await this.#vision
                .apply(this.#visionSettings, settings.rotation, settings.mirror)
                .catch((e: unknown) => this.#cb.onError?.(`vision: ${String(e)}`));
        }
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
        // Hand-resized sizes persist per pet (positions do not).
        stage.setAutonomous(settings.petAi.level !== "off");
        if (settings.petAi.level === "off" || settings.petAi.level === "local" || !settings.petAi.bubbles) stage.clearSpeech();
        for (const pet of [settings.leftPet, settings.rightPet]) {
            if (pet === "none") continue;
            const k = settings.petHands.scale[pet] ?? 1;
            if (Math.abs(stage.petScale(pet) - k) > 1e-3) stage.setPetScale(pet, k);
        }
    }

    async applyVision(settings: VisionSettings): Promise<void> {
        this.#visionSettings = settings;
        this.#updateWantScopes();
        await this.#vision?.apply(settings, this.#settings.rotation, this.#settings.mirror);
    }

    setProfiles(profiles: IdentityProfile[]): void {
        this.#vision?.setProfiles(profiles);
    }

    setHidden(hidden: boolean): void {
        this.#hidden = hidden;
        this.#stage?.setHidden(hidden);
    }

    /** Pet minds for the sidecar's optional LLM director (`petState`). */
    petSummary(): PetStage["mindSummary"] {
        return this.#stage?.mindSummary ?? [];
    }

    /** Director nudge (`petBias`): a utility multiplier with a TTL, never a command. */
    petBias(pet: string, action: Parameters<PetStage["bias"]>[1], k: number, ttlSec: number): void {
        if (this.#settings.petAi.level === "off") return;
        this.#stage?.bias(pet as PetId | "all", action, k, ttlSec * 1000);
    }

    /** A pet line from the sidecar: speech bubble in the output (if enabled). */
    petSay(m: PetSay): void {
        const ai = this.#settings.petAi;
        if (ai.level === "off" || ai.level === "local" || !ai.bubbles) return;
        this.#stage?.say(m.pet, m.text, { emotion: m.emotion, ttlMs: m.ttlMs });
    }

    /** Director-level 3D command (validated by the sidecar, re-checked here). */
    petCommand(m: PetCommand): void {
        if (this.#settings.petAi.level !== "director") return;
        this.#stage?.command(m.pet, { ...(m.anchor ? { anchor: m.anchor } : {}), ...(m.clip ? { clip: m.clip } : {}), ttlMs: m.ttlSec * 1000 });
    }

    /** Pets that chose "chatter" since the last call (the sidecar writes their line). */
    petsWantingToTalk(): string[] {
        return this.#stage?.wantsToTalk() ?? [];
    }

    /** Owner/interaction observations since the last call (sent with `petState`). */
    drainObservations(): PetObservation[] {
        return this.#observations.splice(0, this.#observations.length);
    }

    #observe(what: string, pet?: string): void {
        const o: PetObservation = { at: Date.now(), what: what.slice(0, 40), ...(pet ? { pet } : {}) };
        this.#observations.push(o);
        if (this.#observations.length > 20) this.#observations.shift();
        this.#cb.onPetObservation?.(o);
    }

    /** Stored personalities from the sidecar: apply to the minds, notify the UI. */
    setPetPersonalities(pets: readonly PetPersonality[]): void {
        this.#personalities = pets;
        for (const p of pets) {
            const state: PersonalityState = { traits: p.traits, likes: p.likes as PersonalityState["likes"], sessions: p.sessions };
            this.#stage?.setPersonality(p.pet, state);
        }
        for (const cb of this.#personalitySubs) cb(pets);
    }

    onPetPersonalities(cb: (pets: readonly PetPersonality[]) => void): () => void {
        this.#personalitySubs.add(cb);
        cb(this.#personalities);
        this.sendToSidecar?.({ type: "petPersonalityList" });
        return () => this.#personalitySubs.delete(cb);
    }

    resetPetPersonality(pet: string): void {
        this.sendToSidecar?.({ type: "petPersonalityReset", pet });
    }

    async sampleHands(target: string, ms: number): Promise<HandSample> {
        const vision = this.#needVision() as VisionRuntime & { sampleHands?: (t: string, ms: number) => Promise<HandSample> };
        if (!vision.sampleHands) throw new Error("hand sampling needs the vision worker");
        this.#hands.startPalmSampling();
        try {
            const sample = await vision.sampleHands(target, ms);
            return { ...sample, palmM: this.#hands.stopPalmSampling() };
        } catch (e) {
            this.#hands.stopPalmSampling();
            throw e;
        }
    }

    onChat(event: ChatEvent): void {
        if (event.kind === "chat") this.#noteChat();
        const e = petEventFor(event);
        if (e) this.#stage?.send(e);
    }

    speak(visemes: readonly VisemeEvent[]): void {
        this.#stage?.speak(visemes);
        // The co-host is speaking for the length of the utterance: pets turn to listen.
        const last = visemes.at(-1);
        const ms = (last?.offsetMs ?? 0) + 400;
        this.#stage?.setContext({ cohostSpeaking: true });
        window.clearTimeout(this.#cohostTimer);
        this.#cohostTimer = window.setTimeout(() => this.#stage?.setContext({ cohostSpeaking: false }), ms);
    }

    #cohostTimer = 0;
    readonly #chatTimes: number[] = [];

    /** Chat activity 0..1 (messages per minute / 30) for the pet minds. */
    #noteChat(): void {
        const now = performance.now();
        this.#chatTimes.push(now);
        while (this.#chatTimes.length && (this.#chatTimes[0] ?? 0) < now - 60_000) this.#chatTimes.shift();
        this.#stage?.setContext({ chatActivity: Math.min(1, this.#chatTimes.length / 30) });
    }

    onFrame(cb: (info: StudioFrameInfo) => void): () => void {
        this.#frameSubs.add(cb);
        return () => this.#frameSubs.delete(cb);
    }

    onSignals(cb: (events: SignalEvent[], armed: boolean) => void): () => void {
        this.#signalSubs.add(cb);
        return () => this.#signalSubs.delete(cb);
    }

    #patch(patch: Partial<StudioSettings>): Promise<void> {
        this.#cb.onSettingsPatch?.(patch);
        return this.applyStudio({ ...this.#settings, ...patch });
    }

    async run(action: RuleAction): Promise<void> {
        switch (action.type) {
            case "camera":
                return this.#remote.run(action.action, action.holdMs);
            case "pet":
                this.#stage?.send({ type: "command", clip: action.reaction });
                return;
            case "effect":
                this.#spawnEffect(action.effect, action.z);
                return;
            case "arObject": {
                const list = this.#settings.arObjects.map((o): ArObject => {
                    if (o.id !== action.objectId) return o;
                    const visible = action.op === "show" ? true : action.op === "hide" ? false : !o.visible;
                    return { ...o, visible };
                });
                return this.#patch({ arObjects: list });
            }
            case "studio":
                return this.#studioAction(action.action);
            default:
                // control/speak/vmui/... are sidecar-side; flow nodes are expanded by the sidecar.
                return;
        }
    }

    async #studioAction(a: Extract<RuleAction, { type: "studio" }>["action"]): Promise<void> {
        const s = this.#settings;
        const framing = (p: Partial<StudioSettings["framing"]>) => this.#patch({ framing: { ...s.framing, ...p } });
        const monitor = (p: Partial<StudioSettings["monitor"]>) => this.#patch({ monitor: { ...s.monitor, ...p } });
        switch (a) {
            case "digitalZoomIn":
                return framing({ zoom: this.#framing.stepZoom(1) });
            case "digitalZoomOut":
                return framing({ zoom: this.#framing.stepZoom(-1) });
            case "digitalZoomReset":
                this.#framing.setZoom(1);
                return framing({ zoom: 1 });
            case "reframeToggle":
                return framing({ autoReframe: !s.framing.autoReframe });
            case "dofToggle":
                return framing({ dof: !s.framing.dof });
            case "peakingToggle":
                return monitor({ peaking: !s.monitor.peaking });
            case "zebraToggle":
                return monitor({ zebra: !s.monitor.zebra });
            case "cleanFeedToggle":
                return monitor({ cleanFeed: !s.monitor.cleanFeed });
            case "loupeToggle":
                this.#loupe = !this.#loupe;
                this.#cb.onLoupe?.(this.#loupe);
                return;
            case "saveClip":
                return this.saveClip();
        }
    }

    /** Clip buffer state for the UI (`off` when disabled or not started). */
    get clipState(): ClipState {
        return this.#clips?.state ?? "off";
    }

    /**
     * Mux the rolling buffer and hand it to `onClip`. A save already running, or
     * one within CLIP_COOLDOWN_MS, is shared instead of writing a duplicate.
     */
    saveClip(): Promise<void> {
        if (this.#clipSaving) return this.#clipSaving;
        if (performance.now() - this.#clipSavedAt < CLIP_COOLDOWN_MS) return Promise.resolve();
        const clips = this.#clips;
        if (!clips) return Promise.reject(new Error("the clip buffer is off"));
        this.#clipSavedAt = performance.now();
        const run = (async () => {
            const clip = await clips.save(clipFileName(new Date()));
            await this.#cb.onClip?.(clip);
        })().finally(() => {
            this.#clipSaving = null;
        });
        this.#clipSaving = run;
        return run;
    }

    #spawnEffect(effect: Extract<RuleAction, { type: "effect" }>["effect"], zM?: number): void {
        const stage = this.#stage;
        if (!stage || !this.#effects) return;
        const pin = stage.pinhole;
        const f = this.#ownerFace;
        const p =
            zM !== undefined
                ? unproject(pin, f ? f.x + f.w / 2 : 0.5, f ? f.y + f.h * 0.15 : 0.3, Math.max(0.3, zM))
                : effectOrigin(pin, f, this.#ownerM ?? DEFAULT_OWNER_M);
        this.#effects.spawn(effect, p);
    }

    /** Raw-camera vFOV + owner calibration for the metric distance. */
    #metricConfig(): MetricConfig {
        const s = this.#settings;
        return { cameraVfovDeg: cameraVfov(s), worldScale: s.space.worldScale, irisM: s.space.irisM };
    }

    /**
     * Space calibration sample: collect `ms` of early pose results and aggregate
     * (medians) the owner's metric measures. Standing: camera pitch + height from the
     * upright torso and the typed height. Seated: personal shoulder width, iris, head height.
     */
    async sampleSpace(kind: "standing" | "seated", ms: number): Promise<SpaceSample> {
        this.#spaceCapture = [];
        await new Promise((r) => window.setTimeout(r, ms));
        const frames = this.#spaceCapture;
        this.#spaceCapture = null;
        const { aggregateSpace } = await import("./space-sample.js");
        return aggregateSpace(kind, frames, this.#metricConfig(), this.#settings.space.heightM, this.#metric, {
            tiltDeg: this.#settings.cameraTiltDeg,
            heightM: this.#settings.cameraHeightM,
        });
    }

    async calibrateLens(onProgress: (p: LensProgress) => void, signal: AbortSignal): Promise<LensResult> {
        const { calibrateLensFromVideo } = await import("./calibration/charuco.js");
        return calibrateLensFromVideo(this.#video, onProgress, signal);
    }

    async analyseScene(onProgress: (p: number) => void): Promise<SceneResult> {
        const { analyseSceneFromVideo } = await import("./calibration/scene.js");
        return analyseSceneFromVideo(this.#video, onProgress, { tiltDeg: this.#settings.cameraTiltDeg, cameraHeightM: this.#settings.cameraHeightM });
    }

    /** Live 3D state for the preview-only debug overlay (F3). */
    debug3d(): Debug3dState | null {
        const stage = this.#stage;
        if (!stage) return null;
        const pin = stage.pinhole;
        const t = performance.now() / 1000;
        const body = this.#bodySnap;
        const r = this.#metric.reading;
        return {
            pin,
            body,
            pets: stage.debug,
            anchors: { left: anchorPoints(body, pin, "left", t, null), right: anchorPoints(body, pin, "right", t, null) },
            perf: {
                renderMs: this.#timings["render"] ?? 0,
                fps: this.#stats.snapshot().fps,
                poseHz: this.#poseHz,
                poseAgeMs: body?.poseAgeMs ?? 0,
                petsActive: stage.activeCount,
                delayMs: this.#body.delayMs,
                distanceSource: r ? "metric" : "detector",
            },
            hands: this.#debugHands,
            grab: stage.grabState,
            ...(r
                ? {
                      metric: {
                          distanceM: r.distanceM,
                          relSigma: r.relSigma,
                          ...(r.body ? { body: r.body.distanceM } : {}),
                          ...(r.iris ? { iris: r.iris.distanceM } : {}),
                      },
                  }
                : {}),
        };
    }

    /** Owner gestures the pets react to: wave back, heart = happy hop + hearts, point = fly/walk there. */
    #petGestures(events: readonly SignalEvent[]): void {
        const stage = this.#stage;
        if (!stage) return;
        for (const e of events) {
            if (!e.subject.owner) continue;
            // Things worth a comment from chatty pets (rising edges only).
            if (e.phase === "start" && OBSERVED_SIGNALS.has(e.signal)) this.#observe(e.signal);
            // Mind context: an open palm invites a pet onto the hand; talking/laughing draws attention.
            // Real palm perches (setPalms) own palmUp when hands are tracked in 3D.
            if (e.signal === "open_palm" && this.#debugHands.length === 0) stage.setContext({ palmUp: e.phase !== "end" });
            else if (e.signal === "talking") stage.setContext({ ownerTalking: e.phase !== "end" });
            else if (e.signal === "laughing" && e.phase !== "end") stage.send({ type: "gesture", gesture: "heart" });
            if (e.phase === "end") continue;
            const g = PET_GESTURES[e.signal];
            if (!g) continue;
            if (g === "wave" || g === "heart") {
                stage.send({ type: "gesture", gesture: g });
                if (g === "heart") this.#spawnEffect("hearts");
                continue;
            }
            // Pointing: a spot 0.35 m beside the head (or above it), at the owner's depth.
            const b = this.#bodySnap;
            if (!b?.present) continue;
            const dx = g === "point_left" ? -0.35 : g === "point_right" ? 0.35 : 0;
            const dy = g === "point_up" ? 0.3 : 0.05;
            stage.goTo("point", [b.head.p[0] + dx, b.head.p[1] + dy, b.head.p[2] + 0.05]);
        }
    }

    cameraHold(action: HoldAction, speed: 1 | 2 | 3): void {
        this.#remote.hold(action, speed);
    }

    cameraRelease(): void {
        this.#remote.release();
    }

    #needVision(): VisionRuntime {
        if (!this.#vision) throw new Error("vision runtime is not running");
        return this.#vision;
    }

    sampleCalibration(ms: number): Promise<CalibrationSample> {
        return this.#needVision().sampleCalibration(ms);
    }

    sampleEnrolment(kind: "person" | "dog"): Promise<EnrolSample | null> {
        return this.#needVision().sampleEnrolment(kind);
    }

    ensureModels(which: ("identity" | "dogIdentity" | "depth")[], onProgress?: (p: number) => void): Promise<void> {
        return this.#needVision().ensureModels(which, onProgress);
    }

    pickArObject(x: number, y: number): ArObject["id"] | null {
        const { width, height } = this.outputSize;
        return this.#ar?.pick(x, y, width, height) ?? null;
    }

    /** A new vision result: mask/depth uploads and signal forwarding happen once per result, not per frame. */
    #ingest(frame: VisionFrame): void {
        const backdrop = this.#backdrop;
        if (!backdrop) return;
        if (frame.mask) backdrop.setMask(frame.mask.data, frame.mask.width, frame.mask.height);
        else backdrop.setMask(null, 0, 0);
        // Metric distance comes from MetricDistance (whole-body solve + iris + Kalman) when
        // the early pose carries world landmarks; the pipeline's body-scale value is the fallback.
        this.#ownerM = this.#metric.reading?.distanceM ?? frame.ownerDistanceM;
        const face = ownerFace(frame.faces);
        if (frame.depth && face) {
            // Scale relative inverse depth so the owner's face pixel reads ownerDistanceM: m = k / inv.
            const inv = Math.max(depthAt(frame.depth, face.x + face.w / 2, face.y + face.h / 2), 0.02);
            backdrop.setDepth(frame.depth.data, frame.depth.width, frame.depth.height, inv * (frame.ownerDistanceM ?? DEFAULT_OWNER_M), inv);
        } else backdrop.setDepth(null, 0, 0);
        if (frame.events.length > 0) this.#petGestures(frame.events);
        const armedChanged = frame.armed !== this.#armed;
        this.#armed = frame.armed;
        if (frame.events.length > 0 || armedChanged) for (const cb of this.#signalSubs) cb(frame.events, frame.armed);
    }

    #placeAnchors(pose: readonly { x: number; y: number; visibility?: number }[] | null, f: Framing, rotation: Rotation): void {
        const a = this.#arAnchors;
        const set = (key: keyof Anchors, i: number) => {
            const p = pose?.[i];
            if (p && (p.visibility ?? 1) >= 0.5) a[key] = rawToOutput(f, rotation, p.x, p.y);
            else delete a[key];
        };
        set("head", POSE.nose);
        set("leftShoulder", POSE.leftShoulder);
        set("rightShoulder", POSE.rightShoulder);
        set("leftHand", POSE.leftWrist);
        set("rightHand", POSE.rightWrist);
    }

    #frame = (now: number): void => {
        this.#raf = requestAnimationFrame(this.#frame);
        const stage = this.#stage;
        const backdrop = this.#backdrop;
        const camRT = this.#camRT;
        const outRT = this.#outRT;
        if (!stage || !backdrop || !camRT || !outRT) return;
        // Render cap (previewFps): beyond the camera rate every extra frame redraws the same image.
        const cap = this.#settings.previewFps;
        if (cap > 0 && now - this.#lastRender < 1000 / cap - 1.5) return;
        this.#lastRender = now;
        const t0 = performance.now();
        const W = stage.width;
        const H = stage.height;
        const vw = this.#video.videoWidth || 1920;
        const vh = this.#video.videoHeight || 1080;
        const { mirror } = this.#settings;
        // Synthetic frames are drawn upright already.
        const rotation: Rotation = this.#synthetic ? 0 : this.#settings.rotation;
        const [uw, uh] = uprightSize(rotation, vw, vh);
        const dt = Math.min((now - this.#lastFrame) / 1000, 0.1);
        this.#lastFrame = now;

        // Vision: push (never blocks), read the newest result.
        let frame: VisionFrame | null;
        if (this.#synthetic) frame = syntheticFrame(now);
        else {
            const tv = performance.now();
            this.#vision?.push(this.#video, now);
            this.#timings["visionPush"] = ema(this.#timings["visionPush"] ?? 0, performance.now() - tv);
            frame = this.#vision?.latest() ?? null;
        }
        const freshVision = !!frame && frame !== this.#lastVision;
        if (frame && freshVision) {
            this.#lastVision = frame;
            this.#ingest(frame);
        }

        // Digital framing on the upright camera frame.
        const rawFace = frame ? ownerFace(frame.faces) : undefined;
        const upFace = rawFace ? boxToUpright(rotation, rawFace) : null;
        const f = this.#framing.update(
            coverFraming(uw, uh, W, H, mirror),
            this.#settings.framing,
            {
                face: upFace ? { x: upFace.x + upFace.w / 2, y: upFace.y + upFace.h / 2, w: upFace.w, h: upFace.h } : null,
                people: frame ? Math.max(frame.faces.length, frame.poses.length) : 0,
                standing: frame?.snapshot.subjects.some((s) => s.owner && s.active.includes("standing")) ?? false,
            },
            dt,
        );
        backdrop.layout(W, H, f, uw, uh, rotation);
        this.#ownerFace = rawFace ? faceToOutput(f, rotation, rawFace) : undefined;
        const fo = this.#ownerFace;
        backdrop.setDof({
            strength: this.#settings.framing.dof ? this.#settings.framing.dofStrength : 0,
            focusX: fo ? fo.x + fo.w / 2 : 0.5,
            focusY: fo ? fo.y + fo.h / 2 : 0.35,
            radius: fo ? Math.max(fo.h * 0.75, 0.05) : 0.12,
        });

        // 3D: the output pinhole follows the crop + digital zoom; the body model is fed the
        // OWNER's pose as soon as it lands (early pose message, capture-timed) and is
        // interpolated a short fixed delay behind real time every render frame.
        stage.setFov(outputVfov(uprightVfov(cameraVfov(this.#settings), rotation, vw, vh), f));
        const tilt = this.#settings.cameraTiltAuto ? (this.#body.estimatedTiltDeg ?? this.#settings.cameraTiltDeg) : this.#settings.cameraTiltDeg;
        stage.setCameraPose(Math.round(tilt * 2) / 2, this.#settings.cameraHeightM);
        if (this.#effects) this.#effects.tiltDeg = stage.pinhole.tiltDeg ?? 0;
        const pin = stage.pinhole;
        this.#body.pinhole = pin;
        const early = this.#synthetic ? null : (this.#vision?.latestPose() ?? null);
        let pose = frame?.poses[0] ?? null;
        if (early && early.seq !== this.#poseSeq) {
            this.#poseSeq = early.seq;
            pose = early.pose;
            const m = this.#metric.update(early, this.#metricConfig());
            if (m) this.#ownerM = m.distanceM;
            this.#spaceCapture?.push(early);
            // Per-joint metric depth from this frame's body solve, re-anchored on the filtered torso distance.
            const solved = m?.body && m.body.jointDepthM ? m.body : null;
            const shift = m && solved ? m.distanceM - solved.distanceM : 0;
            const jointDepthM = solved?.jointDepthM?.map((d) => (d === undefined ? undefined : d + shift));
            this.#body.measure(
                { tMs: early.tMs, landmarks: pose ? poseToOutput(pose, f, rotation) : null, distanceM: this.#ownerM, ...(jointDepthM ? { jointDepthM } : {}) },
                early.arrivalMs,
            );
            if (pose) {
                const gap = early.tMs - this.#lastPoseAt;
                if (this.#lastPoseAt > 0 && gap > 0) this.#poseHz = this.#poseHz * 0.8 + (1000 / gap) * 0.2;
                this.#lastPoseAt = early.tMs;
            }
        } else if (!early && freshVision && frame) {
            // Synthetic bench / runtimes without the early pose message.
            this.#body.measure({ tMs: frame.tMs || now, landmarks: pose ? poseToOutput(pose, f, rotation) : null, distanceM: frame.ownerDistanceM });
        } else if (early) pose = early.pose;
        const body = this.#body.sample(now, dt);
        this.#bodySnap = body;
        this.#placeAnchors(pose, f, rotation);
        // Owner hands in the room (solve + wrist anchor) -> pets (pinch grab / two-hand resize).
        const handsResult = this.#synthetic ? null : (this.#vision?.latestHands?.() ?? null);
        const freshHands = handsResult && handsResult.seq !== this.#handsSeq ? handsResult : null;
        if (freshHands) this.#handsSeq = freshHands.seq;
        const cal = this.#visionSettings.calibration.hands;
        this.#debugHands = this.#hands.update(now, freshHands, body.present ? body : null, pin, (x, y) => rawToOutput(f, rotation, x, y), {
            cameraVfovDeg: cameraVfov(this.#settings),
            palmM: cal.palmM,
            pinchOn: cal.pinchOn,
            pinchOff: cal.pinchOff,
        });
        stage.setHands(
            this.#settings.petHands.enabled && this.#settings.petAi.level !== "off"
                ? this.#debugHands.map((h) => ({ side: h.side, present: h.present, pinching: h.pinching, point: h.point, strength: h.strength }))
                : [],
        );
        stage.setPalms(this.#settings.petHands.enabled ? palmPerches(this.#debugHands, [0, pin.heightM ?? 0, 0]) : []);
        this.#ar?.update(pin, this.#ownerM, this.#arAnchors, now / 1000, dt, this.#hidden);
        this.#effects?.update(dt);
        stage.update(body.present ? body : null, dt);

        // Pass 1: graded camera. Pass 2: output composite. Pass 3: preview to the canvas.
        const r = stage.renderer;
        r.setRenderTarget(camRT);
        r.render(this.#camScene, stage.camera);
        r.setRenderTarget(outRT);
        r.render(stage.scene, stage.camera);
        this.#preview?.render(r, W, H, now / 1000);
        this.#timings["render"] = ema(this.#timings["render"] ?? 0, performance.now() - t0);
        this.#pump?.frame(outRT, now);
        this.#clips?.frame(outRT, now);
        if (this.#wantScopes) {
            this.#scopes?.sample(r, W, H, now, fo);
            this.#timings["scopes"] = this.#scopes?.cpuMs ?? 0;
            this.#timings["scopesReadback"] = this.#scopes?.readbackMs ?? 0;
        }
        this.#stats.record(now, performance.now() - t0);

        if (now - this.#lastHealth > 1000) {
            this.#videoFps = (this.#videoFrames * 1000) / (now - this.#lastHealth || 1000);
            this.#videoFrames = 0;
            this.#lastHealth = now;
            this.#luma = this.#sampleLuma();
            // A live track that stops delivering frames for 3 s is wedged (capture card lost sync): reopen it.
            if (!this.#synthetic && this.#stream && now - this.#lastFrameSeen > 3000) void this.#reopen("no frames for 3 s");
            // The virtual camera consumer may have negotiated a different size.
            const want = this.#wantedSize(this.#settings);
            this.#resize(want.width, want.height);
        }
        if (now - this.#lastStats > 500) {
            this.#lastStats = now;
            this.#cb.onStats?.({
                ...this.#stats.snapshot(),
                backend: stage.backend,
                tracking: body.present,
                video: { fps: this.#videoFps, luma: this.#luma, state: this.#videoState },
                timings: { ...this.#timings, ...this.#pump?.timings, ...this.#clips?.timings, ...(frame?.timings ?? {}) },
            });
        }
        if (this.#frameSubs.size > 0 && now - this.#lastInfo > 1000 / INFO_HZ) {
            this.#lastInfo = now;
            const info = this.#info(frame, f, rotation);
            for (const cb of this.#frameSubs) cb(info);
        }
    };

    #info(frame: VisionFrame | null, f: Framing, rotation: Rotation): StudioFrameInfo {
        const snap = this.#stats.snapshot();
        const faces = (frame?.faces ?? []).map((face) => faceToOutput(f, rotation, face));
        const dogs: DogBox[] = (frame?.dogs ?? []).map((d) => ({ ...d, ...boxToOutput(f, rotation, d) }));
        const hints: GestureHint[] = (frame?.hints ?? []).map((h) => ({ ...h, at: rawToOutput(f, rotation, h.at[0], h.at[1]) }));
        const vcam = this.#pump?.status ?? { state: "off" as const, fps: 0 };
        const snapshot = frame?.snapshot ?? { ...EMPTY_SNAPSHOT, at: Date.now() };
        return {
            faces,
            dogs,
            hints,
            scopes: this.#wantScopes ? (this.#scopes?.latest ?? { clipHigh: 0, clipLow: 0 }) : { clipHigh: 0, clipLow: 0 },
            snapshot: {
                ...snapshot,
                perf: {
                    renderFps: snap.fps,
                    cameraFps: this.#videoFps,
                    visionMs: { ...(frame?.timings ?? {}), ...this.#timings },
                    vcamFps: this.#pump?.timings.vcamFps ?? 0,
                },
            },
            horizonDeg: ownerFace(faces)?.rollDeg ?? 0,
            ...(this.#ownerM !== undefined ? { ownerDistanceM: this.#ownerM } : {}),
            armed: this.#armed,
            camera: this.#remote.status,
            vcam: { ...vcam, fps: vcam.fps || (this.#pump?.timings.vcamFps ?? 0) },
        };
    }

    stop(): void {
        this.#stopped = true;
        this.#release();
    }

    #release(): void {
        cancelAnimationFrame(this.#raf);
        this.#stream?.getTracks().forEach((t) => t.stop());
        this.#stream = null;
        this.#video.srcObject = null;
        this.#vision?.close();
        this.#vision = null;
        this.#remote.dispose();
        this.#pump?.dispose();
        this.#pump = null;
        this.#clips?.dispose();
        this.#clips = null;
        this.#scopes?.dispose();
        this.#scopes = null;
        this.#preview?.dispose();
        this.#preview = null;
        this.#ar?.dispose();
        this.#ar = null;
        this.#effects?.dispose();
        this.#effects = null;
        if (this.#copy) {
            this.#copy.removeFromParent();
            this.#copy.geometry.dispose();
            (this.#copy.material as THREE.Material).dispose();
            this.#copy = null;
        }
        this.#camRT?.dispose();
        this.#outRT?.dispose();
        this.#camRT = null;
        this.#outRT = null;
        this.#backdrop?.dispose();
        this.#backdrop = null;
        this.#camScene = new THREE.Scene();
        this.#stage?.dispose();
        this.#stage = null;
    }
}
