import type { ArObject, IdentityProfile, PetPersonality, RuleAction, SignalEvent, StudioSettings, VisionSettings, VisionSnapshot } from "@tiksee/core";
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
    /** Two-hand pinch zoom in progress: total zoom asked for, lens moving, digital crop. */
    pinchZoom?: { target: number; optical: boolean; digital: number };
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

/** Aggregated owner measurement over a sampling window (space calibration). */
export interface SpaceSample {
    kind: "standing" | "seated";
    /** Frames used. 0 = nobody tracked (ask the user to step into view). */
    frames: number;
    /** Camera pitch (deg down) and lens height (m), only from a standing sample with a typed height. */
    tiltDeg?: number;
    heightM?: number;
    /** Body-solve distance of the torso (m), median. */
    distanceM?: number;
    /** Personal metrics in metres (median), from world landmarks scaled by `worldScale`. */
    shoulderM?: number;
    irisM?: number;
    /** Head (ear centre) height above the floor (m), needs a camera pose. */
    headHeightM?: number;
    /** MediaPipe world-landmark body height (heel/ankle to nose-top estimate), m — for worldScale. */
    modelHeightM?: number;
    /** Why a value is missing (i18n key suffix under studio.space.issues). */
    issues: ("noBody" | "notFullBody" | "headOut" | "smallIris" | "unstable")[];
}

export type LensProgress = { views: number; needed: number; lastError?: string; coverage: number };
export interface LensResult {
    vfovDeg: number;
    fPx: number;
    k1: number;
    k2: number;
    rmsPx: number;
    views: number;
}
export interface SceneResult {
    vfovDeg: number;
    /** Planes in the ROOM frame (metres): desk top height and back-wall distance, when found. */
    deskHeightM?: number;
    wallDistanceM?: number;
    ms: number;
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
/** A grabbable object in the scene for the in-view editor (box: output-normalised, y down). */
export interface SceneObject {
    kind: "ar" | "pet";
    /** AR object id or pet id. */
    id: string;
    box: { x: number; y: number; w: number; h: number };
    /** Metres from the camera. */
    z: number;
    pinned?: boolean;
}

export interface Debug3dState {
    /** Output pinhole (width/height px of the output, vfovDeg after digital zoom). */
    pin: Pinhole;
    body: BodySnapshot | null;
    pets: readonly PetDebug[];
    /** Anchor points per side, world metres (null = unavailable). */
    anchors: Readonly<Record<"left" | "right", Readonly<Record<AnchorId, Vec3 | null>>>>;
    /** Render timings ms (EMA) and rates. */
    perf: {
        renderMs: number;
        fps: number;
        poseHz: number;
        poseAgeMs: number;
        petsActive: number;
        /** Body interpolation delay (ms): the skeleton is drawn this far in the past. */
        delayMs: number;
        /** Where the owner distance comes from: fused metric solve, or the raw detector estimate. */
        distanceSource: "metric" | "detector";
    };
    /** Fused metric owner distance (whole-body solve + iris + Kalman); absent before the first reading. */
    metric?: { distanceM: number; relSigma: number; body?: number; iris?: number };
    /** Owner hands in the room frame (metres), filtered, as the pets see them. */
    hands?: readonly DebugHand[];
    /** Current hand interaction with a pet, if any. */
    grab?: { pet: string; mode: "drag" | "resize"; scale: number } | null;
}

export interface DebugHand {
    side: "left" | "right";
    present: boolean;
    /** 21 landmarks, world metres (room frame). */
    landmarks: readonly Vec3[];
    pinching: boolean;
    /** 0..1 (1 = fingertips touching). */
    strength: number;
    /** Pinch point (thumb/index midpoint), world metres. */
    point: Vec3;
    depthM: number;
    /** How the depth was found: own 21-point solve, or the pose wrist fallback. */
    source: "solve" | "wrist";
    shape: string | null;
    /** Apparent hand size on the raw frame (px, smoothed): push/pull resize of a held pet. */
    sizePx: number;
}

/** Owner hand as the vision pipeline reports it (RAW camera space + MediaPipe hand world landmarks). */
export interface OwnerHand {
    side: "left" | "right";
    /** 21 image landmarks normalised to the RAW frame. */
    raw: RawLandmark[];
    /** 21 MediaPipe hand world landmarks: metres, origin = hand centre, raw image axes (y down). */
    world: { x: number; y: number; z: number }[];
    /** Handedness/presence score 0..1. */
    score: number;
    /** Classified one-hand shape (gesture id) or null. */
    shape: string | null;
    shapeConfidence: number;
    /** Thumb tip - index tip distance / palm width, from world landmarks (rotation/distance invariant). */
    pinch: number;
    /** False when the wrist or > 2 fingertips are outside the frame (landmarks partly invented). */
    inFrame: boolean;
    /** True when reused from an earlier run (main-thread stagger); not a new observation. */
    stale: boolean;
}

/** One gesture-calibration recording (wizard hands step). */
export interface HandSample {
    /** Gesture asked for ("relaxed" = hand open and still, "pinch" = thumb-index touch). */
    target: string;
    frames: number;
    /** Frames with an in-frame owner hand. */
    handFrames: number;
    /** Frames whose classified shape == target. */
    hits: number;
    /** Median classifier confidence over the hit frames. */
    confidence: number;
    /** Thumb-index / palm-width ratio percentiles over hand frames. */
    pinchP10: number;
    pinchP50: number;
    pinchP90: number;
    /** Owner palm width (m) from image size x wrist depth; 0 when the depth was unknown. */
    palmM: number;
}

export interface StudioController {
    /**
     * Space calibration (owner metric scale + camera pose). The wizard drives it step by
     * step; each call samples `ms` of the owner's pose and returns the aggregated measure.
     */
    sampleSpace(kind: "standing" | "seated", ms: number): Promise<SpaceSample>;
    /** Optional precise lens calibration from a ChArUco board (lazy-loaded opencv.js). */
    calibrateLens?(onProgress: (p: LensProgress) => void, signal: AbortSignal): Promise<LensResult>;
    /** Optional one-shot scene analysis (MoGe-2, lazy 141 MB): FOV estimate + desk/wall planes. */
    analyseScene?(onProgress: (p: number) => void): Promise<SceneResult>;
    /** Record `ms` of the owner's hands while they perform `target` (gesture calibration step). */
    sampleHands(target: string, ms: number): Promise<HandSample>;
    /** Stored pet personalities (sidecar `petPersonalities`), pushed on change. Returns an unsubscribe. */
    onPetPersonalities(cb: (pets: readonly PetPersonality[]) => void): () => void;
    /** Ask the sidecar to forget a pet's personality + memories ("all" = every pet). */
    resetPetPersonality(pet: string): void;
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
    /** AR objects and pets with their on-screen boxes (output-normalised) and depth, nearest first. */
    sceneObjects?(): SceneObject[];
    /** Live caption pill in the output (centre + size, output-normalised), or null when not on the live. */
    captionRect?(): { u: number; v: number; w: number; h: number } | null;
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
    /** Owner's hands (at most one per side), present when the hand models ran. */
    ownerHands?: OwnerHand[];
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
    /**
     * Newest pose-only result (arrives before the full frame). `pose` = owner image landmarks normalised
     * to the raw rawW x rawH frame; `world` = owner MediaPipe world landmarks (metres, origin between the
     * hips, raw image axes: x right, y DOWN, z depth, smaller = nearer camera); `irisPx` = owner iris
     * diameter in raw px from the most recent face result, `irisAgeMs` old.
     */
    latestPose(): {
        tMs: number;
        arrivalMs: number;
        seq: number;
        pose: RawLandmark[] | null;
        world: { x: number; y: number; z: number; visibility: number }[] | null;
        rawW: number;
        rawH: number;
        irisPx: number | null;
        irisAgeMs: number;
        /** Owner head rotation in display degrees (yaw + right, pitch + up, roll + clockwise) and its face frame's capture time. */
        head?: { yaw: number; pitch: number; roll: number; tMs: number } | null;
    } | null;
    sampleCalibration(ms: number): Promise<CalibrationSample>;
    sampleEnrolment(kind: "person" | "dog"): Promise<EnrolSample | null>;
    latestHands?(): { tMs: number; arrivalMs: number; seq: number; hands: OwnerHand[]; rawW: number; rawH: number } | null;
    ensureModels(which: ("identity" | "dogIdentity" | "depth")[], onProgress?: (p: number) => void): Promise<void>;
    /** Enrolled profiles to match against (from the sidecar `identities` message). */
    setProfiles(profiles: IdentityProfile[]): void;
    close(): void;
}
