/**
 * MediaPipe's wasm prints native glog/TFLite chatter through console.warn / console.error /
 * console.info on every model load ("OpenGL error checking is disabled", "Created TensorFlow
 * Lite XNNPACK delegate for CPU", "Using NORM_RECT without IMAGE_DIMENSIONS ...", feedback
 * tensors, CPU-only ops). They are informational, yet `console.error` ones are forwarded to the
 * app log as errors. Drop exactly those known lines; everything else passes through unchanged.
 */
const NOISE: readonly RegExp[] = [
    /gl_context\.cc:\d+\] OpenGL error checking is disabled/,
    /Created TensorFlow Lite XNNPACK delegate for CPU/,
    /landmark_projection_calculator\.cc:\d+\] Using NORM_RECT without IMAGE_DIMENSIONS/,
    /inference_feedback_manager\.cc:\d+\] Feedback manager requires a model with a single signature/,
    /gesture_recognizer_graph\.cc:\d+\] Hand ?Gesture ?Recognizer contains CPU only ops/,
    /face_landmarker_graph\.cc:\d+\] Sets FaceBlendshapesGraph acceleration to xnnpack/,
];

export function isMediaPipeNoise(args: readonly unknown[]): boolean {
    const first = args[0];
    return typeof first === "string" && NOISE.some((re) => re.test(first));
}

let installed = false;

/** Wrap console.{warn,error,info,log} once (in the vision worker / main-thread fallback). */
export function quietMediaPipe(): void {
    if (installed) return;
    installed = true;
    // A record view of the console: the wrapper replaces methods, it does not log by itself.
    const target = console as unknown as Record<string, (...args: unknown[]) => void>;
    for (const level of ["warn", "error", "info", "log"] as const) {
        const orig = target[level];
        if (!orig) continue;
        const call = orig.bind(console);
        target[level] = (...args: unknown[]) => {
            if (!isMediaPipeNoise(args)) call(...args);
        };
    }
}
