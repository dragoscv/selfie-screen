import type { IdentityProfile, VisionSettings } from "@tiksee/core";

import type { CalibrationSample, EnrolSample, HandSample, OwnerHand, RawLandmark, VisionFrame } from "../controller.js";

/** Optional ONNX models, downloaded on demand (see models.ts). */
export type OptionalModel = "identity" | "dogIdentity" | "depth";

export type Rotation = 0 | 90 | 180 | 270;

/**
 * MediaPipe pose WORLD landmark, kept exactly as `PoseLandmarkerResult.worldLandmarks` returns it:
 * metres, origin = centre between the hips, x/y in the RAW (unrotated, unmirrored) image orientation
 * (x grows towards image-right, y grows DOWN), z = depth with the same scale (smaller = nearer the camera).
 * https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker
 */
export interface WorldLandmark {
    x: number;
    y: number;
    z: number;
    visibility: number;
}

/** Early pose-only result (sent right after the pose landmarker, before hands/face/objects). */
export interface PoseEarly {
    tMs: number;
    /** Image landmarks per person, normalised to the full RAW frame (rawW x rawH). */
    poses: RawLandmark[][];
    /** World landmarks aligned index-for-index with `poses` (see WorldLandmark). */
    worldPoses: WorldLandmark[][];
    /** Index into `poses` of the owner tracked on the PREVIOUS frame, or -1. */
    ownerIndex: number;
    /** Raw camera frame size in px that the normalised landmarks refer to. */
    rawW: number;
    rawH: number;
    /** Owner's iris diameter in RAW px (mean of both eyes) from the most recent face result, or null. */
    irisPx: number | null;
    /** Age of that face result relative to `tMs`, ms (Infinity when irisPx is null). */
    irisAgeMs: number;
    /**
     * Owner's head rotation from the face model's transformation matrix, in DISPLAY terms
     * (degrees: yaw + towards display-right, pitch + up, roll + clockwise), with the capture
     * time of the face frame it came from (face runs every other frame). Null = no face.
     */
    head: { yaw: number; pitch: number; roll: number; tMs: number } | null;
}

/**
 * Early owner-hands result: sent right after the gesture recognizer and hand grouping, before
 * face/objects run. `hands` = at most one per side, same objects as VisionFrame.ownerHands
 * (empty when no owner is tracked yet or the owner shows no hands; stale ones flagged).
 */
export interface HandsEarly {
    tMs: number;
    hands: OwnerHand[];
    /** Raw camera frame size in px that the normalised `raw` landmarks refer to. */
    rawW: number;
    rawH: number;
}

export interface PipelineConfig {
    settings: VisionSettings;
    rotation: Rotation;
    mirror: boolean;
    /** Main-thread fallback: run the heavy tasks on alternating frames. */
    stagger: boolean;
}

/** Main thread -> vision worker. */
export type ToWorker =
    | { id: number; type: "init"; config: PipelineConfig }
    | { id: number; type: "apply"; config: PipelineConfig }
    | { id: number; type: "frame"; bitmap: ImageBitmap; tMs: number; rawW: number; rawH: number }
    | { id: number; type: "calibrate"; ms: number }
    | { id: number; type: "handSample"; target: string; ms: number }
    | { id: number; type: "enrol"; kind: "person" | "dog" }
    | { id: number; type: "models"; which: OptionalModel[] }
    | { id: number; type: "profiles"; profiles: IdentityProfile[] }
    | { id: number; type: "close" };

/** Vision worker -> main thread. `id` answers the request with the same id. */
export type FromWorker =
    | { id: number; type: "ok" }
    | { id: number; type: "error"; message: string }
    | { id: number; type: "frame"; frame: VisionFrame }
    /** Early pose-only result for frame `id`, sent before hands/face/objects run (does not answer the request). */
    | ({ id: number; type: "pose" } & PoseEarly)
    /** Early owner hands for frame `id`, sent after the gesture recognizer, before face/objects (does not answer the request). */
    | ({ id: number; type: "hands" } & HandsEarly)
    | { id: number; type: "calibration"; sample: CalibrationSample }
    | { id: number; type: "handSample"; sample: HandSample }
    | { id: number; type: "enrolment"; sample: EnrolSample | null }
    | { id: number; type: "progress"; progress: number };
