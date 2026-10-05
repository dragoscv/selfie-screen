import { FilesetResolver, PoseLandmarker, type PoseLandmarkerResult } from "@mediapipe/tasks-vision";
import type { Landmark } from "@tiksee/pets";

/** Local assets only: the CSP blocks CDNs and the studio must work offline. */
const WASM_BASE = "/mediapipe/wasm";
const POSE_MODEL = "/mediapipe/pose_landmarker_lite.task";

export interface PoseSample {
    landmarks: Landmark[] | null;
    /** Person mask in camera space, row 0 = top, or null when masks are off. */
    mask: { data: Float32Array; width: number; height: number } | null;
    tMs: number;
}

/**
 * MediaPipe pose on the GPU delegate. Runs at most every `intervalMs` so the
 * render loop keeps its 60 fps; the One-Euro filter interpolates in between.
 */
export class PoseTracker {
    #landmarker: PoseLandmarker | null = null;
    #masks = false;
    #lastRun = -Infinity;
    #last: PoseSample = { landmarks: null, mask: null, tMs: 0 };
    readonly #intervalMs: number;

    constructor(intervalMs = 1000 / 30) {
        this.#intervalMs = intervalMs;
    }

    async init(withMasks: boolean): Promise<void> {
        const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
        this.#masks = withMasks;
        this.#landmarker = await PoseLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: POSE_MODEL, delegate: "GPU" },
            runningMode: "VIDEO",
            numPoses: 1,
            minPoseDetectionConfidence: 0.5,
            minPosePresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
            outputSegmentationMasks: withMasks,
        });
    }

    async setMasks(withMasks: boolean): Promise<void> {
        if (!this.#landmarker || withMasks === this.#masks) return;
        this.#masks = withMasks;
        await this.#landmarker.setOptions({ outputSegmentationMasks: withMasks });
    }

    /** Returns the newest sample; runs detection only when the interval has elapsed. */
    sample(video: HTMLVideoElement, nowMs: number): PoseSample {
        const lm = this.#landmarker;
        if (!lm || video.readyState < 2 || nowMs - this.#lastRun < this.#intervalMs) return this.#last;
        this.#lastRun = nowMs;
        let result: PoseLandmarkerResult;
        try {
            result = lm.detectForVideo(video, nowMs);
        } catch {
            return this.#last;
        }
        const first = result.landmarks[0];
        const maskImage = this.#masks ? result.segmentationMasks?.[0] : undefined;
        const mask = maskImage
            ? { data: maskImage.getAsFloat32Array().slice(), width: maskImage.width, height: maskImage.height }
            : null;
        maskImage?.close();
        this.#last = { landmarks: first ? first.map((p) => ({ x: p.x, y: p.y, visibility: p.visibility })) : null, mask, tMs: nowMs };
        return this.#last;
    }

    close(): void {
        this.#landmarker?.close();
        this.#landmarker = null;
    }
}
