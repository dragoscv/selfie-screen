import { describe, expect, it } from "vitest";

import { isMediaPipeNoise } from "./quiet-console.js";

describe("MediaPipe console noise filter", () => {
    it("drops the known native info lines", () => {
        expect(isMediaPipeNoise(["W1008 06:55:49.944999 2196592 gl_context.cc:1119] OpenGL error checking is disabled"])).toBe(true);
        expect(isMediaPipeNoise(["INFO: Created TensorFlow Lite XNNPACK delegate for CPU."])).toBe(true);
        expect(isMediaPipeNoise(["W1008 landmark_projection_calculator.cc:81] Using NORM_RECT without IMAGE_DIMENSIONS is only supported for the square ROI."])).toBe(true);
        expect(isMediaPipeNoise(["W1008 07:04:05.046000 2196592 gesture_recognizer_graph.cc:134] Hand Gesture Recognizer contains CPU only ops. Sets HandGestureRecognizerGraph acceleration to Xnnpack."])).toBe(true);
    });

    it("keeps real warnings and errors", () => {
        expect(isMediaPipeNoise(["[vision] face failed", new Error("x")])).toBe(false);
        expect(isMediaPipeNoise([new Error("OpenGL error checking is disabled")])).toBe(false);
        expect(isMediaPipeNoise(["E1008 gl_context.cc:42] Failed to create context"])).toBe(false);
    });
});
