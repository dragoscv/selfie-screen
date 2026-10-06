import type { IdentityProfile, VisionSettings } from "@tiksee/core";

import type { CalibrationSample, EnrolSample, RawLandmark, VisionFrame } from "../controller.js";

/** Optional ONNX models, downloaded on demand (see models.ts). */
export type OptionalModel = "identity" | "dogIdentity" | "depth";

export type Rotation = 0 | 90 | 180 | 270;

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
    | { id: number; type: "pose"; tMs: number; poses: RawLandmark[][]; ownerIndex: number }
    | { id: number; type: "calibration"; sample: CalibrationSample }
    | { id: number; type: "enrolment"; sample: EnrolSample | null }
    | { id: number; type: "progress"; progress: number };
