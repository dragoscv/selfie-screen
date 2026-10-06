import type { ArObject, IdentityProfile, RuleAction, SignalEvent, StudioSettings, VisionSettings, VisionSnapshot } from "@tiksee/core";
import type { AnchorId, BodySnapshot, PetDebug, Pinhole, Vec3 } from "@tiksee/pets";

/**
 * Contract between the studio engine (render + vision + vcam) and the studio
 * UI (controls over the preview, tutorial, calibration, enrolment).
 *
 * The engine owns two render targets: the OUTPUT frame (what the virtual
 * camera and window capture get) and the PREVIEW (output + monitoring aids).
 * Nothing the UI draws, and no monitor overlay, ever reaches the output.
 */

/** Face box and eye points in output-normalised coords (0..1, y down). */
export interface FaceBox {
    x: number;
    y: number;
    w: number;
    h: number;
    leftEye: [number, number];
    rightEye: [number, number];
    /** Roll in degrees, from the eye line. */
    rollDeg: number;
    track: number;
    name?: string;
    owner: boolean;
}

export interface DogBox {
    x: number;
    y: number;
    w: number;
    h: number;
    track: number;
    name?: string;
    confidence: number;
}

/** Live gesture feedback for the HUD: label + 0..1 hold progress. */
export interface GestureHint {
    signal: SignalEvent["signal"];
    progress: number;
    hand?: "left" | "right";
    /** Where to draw the ring, output-normalised. */
    at: [number, number];
}

export interface Scopes {
    /** 256 bins each, normalised 0..1. */
    histogram?: { r: Float32Array; g: Float32Array; b: Float32Array; y: Float32Array };
    /** width x 256 intensity grid, row-major, 0..1. */
    waveform?: { width: number; data: Float32Array };
    /** 128 x 128 Cb/Cr density, 0..1. */
    vectorscope?: { size: number; data: Float32Array };
    /** Share of pixels clipped high / low, 0..1. */
    clipHigh: number;
    clipLow: number;
    /** Mean face luma in IRE (0..100), for the exposure assistant. */
    faceIre?: number;
}

export interface StudioFrameInfo {
    faces: FaceBox[];
    dogs: DogBox[];
    hints: GestureHint[];
    scopes: Scopes;
    snapshot: VisionSnapshot;
    /** Horizon tilt from the shoulders/eyes, degrees. */
    horizonDeg: number;
    /** Owner distance in metres (calibrated body scale or depth model). */
    ownerDistanceM?: number;
    armed: boolean;
    /** Camera remote status from BLE notifications. */
    camera: { focused: boolean; recording: boolean; connected: boolean };
    vcam: { state: "off" | "waiting" | "streaming" | "unregistered" | "error"; fps: number; consumerSize?: [number, number] };
}

/** Raw samples the calibration wizard asks the engine for. */
export interface CalibrationSample {
    blinkLeft: number;
    blinkRight: number;
    smile: number;
    mouthOpen: number;
    browsUp: number;
    shoulderPx: number;
    ipdPx: number;
    neckRatio: number;
    faceVisible: boolean;
}

export interface EnrolSample {
    kind: "person" | "dog";
    /** Embedding of the subject nearest the frame centre (largest box). */
    embedding: number[];
    /** Small JPEG data URL of the crop for the UI. */
    thumbnail: string;
    quality: number;
}

/** Live 3D state for the preview-only debug overlay (F3). */
export interface Debug3dState {
    /** Output pinhole (width/height px of the output, vfovDeg after digital zoom). */
    pin: Pinhole;
    body: BodySnapshot | null;
    pets: readonly PetDebug[];
    /** Anchor points per side, world metres (null = unavailable). */
    anchors: Readonly<Record<"left" | "right", Readonly<Record<AnchorId, Vec3 | null>>>>;
    /** Render timings ms (EMA) and rates. */
    perf: { renderMs: number; fps: number; poseHz: number; poseAgeMs: number; petsActive: number };
}

export interface StudioController {
    /** Subscribe to per-frame UI info (throttled to ~15 Hz). Returns an unsubscribe. */
    onFrame(cb: (info: StudioFrameInfo) => void): () => void;
    /** Debounced signal edges + arming changes, to forward to the sidecar (`visionSignals`, `visionArm`). */
    onSignals(cb: (events: SignalEvent[], armed: boolean) => void): () => void;
    /** Enrolled profiles from the sidecar `identities` message. */
    setProfiles(profiles: IdentityProfile[]): void;
    applyStudio(settings: StudioSettings): Promise<void>;
    applyVision(settings: VisionSettings): Promise<void>;
    /** Execute an action locally (UI buttons and relayed `ruleAction`s share this path). */
    run(action: RuleAction): Promise<void>;
    /** Hold-to-act camera controls (BLE): start on press, stop on release. */
    cameraHold(action: "zoomIn" | "zoomOut" | "focusNear" | "focusFar", speed: 1 | 2 | 3): void;
    cameraRelease(): void;
    /** Average `ms` of raw detector values for the calibration wizard. */
    sampleCalibration(ms: number): Promise<CalibrationSample>;
    /** Collect one enrolment sample of the main subject of `kind`. Requires identity models. */
    sampleEnrolment(kind: "person" | "dog"): Promise<EnrolSample | null>;
    /** Download (sha256-verified) and load the optional models; progress 0..1. */
    ensureModels(which: ("identity" | "dogIdentity" | "depth")[], onProgress?: (p: number) => void): Promise<void>;
    /** AR editing: move/scale objects; changes persist through the settings store by the caller. */
    pickArObject(x: number, y: number): ArObject["id"] | null;
    /** Output-normalised -> preview element coords helper data. */
    readonly outputSize: { width: number; height: number };
    /** Live 3D state for the debug overlay; null before start. Read inside rAF, do not hold. */
    debug3d(): Debug3dState | null;
}

/* ------------------------------------------------------------------ *
 * Vision runtime (lib/studio/vision/**) <-> render engine (engine.ts).
 * ------------------------------------------------------------------ */

/** One normalised landmark in RAW camera coords (0..1, y down), like MediaPipe. */
export interface RawLandmark {
    x: number;
    y: number;
    z: number;
    visibility?: number;
}

/** Everything the render engine needs from one vision tick, in raw camera space. */
export interface VisionFrame {
    /** = captureMs (performance clock). */
    tMs: number;
    /** Camera capture time of the analysed frame (performance clock). */
    captureMs?: number;
    /** performance.now() when the result reached the main thread. */
    arrivalMs?: number;
    /** Pose landmarks per person (33 each), raw camera coords. */
    poses: RawLandmark[][];
    /** Person segmentation mask (raw camera space, row 0 = top), or null. */
    mask: { data: Float32Array; width: number; height: number } | null;
    /** Optional relative inverse-depth map 0..1 (1 = near), raw camera space. */
    depth: { data: Float32Array; width: number; height: number } | null;
    /** Face boxes/eyes in RAW camera coords (the engine maps them to output). */
    faces: FaceBox[];
    dogs: DogBox[];
    hints: GestureHint[];
    /** Signal edges since the previous tick (already debounced). */
    events: SignalEvent[];
    snapshot: VisionSnapshot;
    ownerDistanceM?: number;
    armed: boolean;
    /** Per-task latency, ms (EMA). */
    timings: Record<string, number>;
}

export interface VisionRuntime {
    init(settings: VisionSettings, rotation: 0 | 90 | 180 | 270, mirror: boolean): Promise<void>;
    apply(settings: VisionSettings, rotation: 0 | 90 | 180 | 270, mirror: boolean): Promise<void>;
    /** Attach the camera <video>; frames are then pulled per NEW camera frame (requestVideoFrameCallback). */
    attach?(video: HTMLVideoElement): void;
    /** Legacy: attaches `video` on first call, otherwise a no-op. */
    push(video: HTMLVideoElement, tMs: number): void;
    /** Newest completed result (the same object until a new one lands). */
    latest(): VisionFrame | null;
    /** Newest pose-only result (arrives before the full frame). */
    latestPose(): { tMs: number; arrivalMs: number; seq: number; pose: RawLandmark[] | null } | null;
    sampleCalibration(ms: number): Promise<CalibrationSample>;
    sampleEnrolment(kind: "person" | "dog"): Promise<EnrolSample | null>;
    ensureModels(which: ("identity" | "dogIdentity" | "depth")[], onProgress?: (p: number) => void): Promise<void>;
    /** Enrolled profiles to match against (from the sidecar `identities` message). */
    setProfiles(profiles: IdentityProfile[]): void;
    close(): void;
}
