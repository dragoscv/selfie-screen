import * as ort from "onnxruntime-web";

import { fromF16Array, toF16Array } from "@tiksee/vision";

/**
 * onnxruntime-web 1.30 (JSEP build: WebGPU EP + wasm fallback). The wasm
 * binaries are served locally from /ort/ (copied by scripts/studio-assets.mjs);
 * one wasm thread because the studio window is not cross-origin isolated.
 * Quantised ops the WebGPU EP lacks fall back to wasm per node.
 */
ort.env.wasm.wasmPaths = "/ort/";
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.logLevel = "error";

export type Session = ort.InferenceSession;

export async function createSession(model: ArrayBuffer): Promise<Session> {
    const bytes = new Uint8Array(model);
    try {
        return await ort.InferenceSession.create(bytes, { executionProviders: ["webgpu", "wasm"], graphOptimizationLevel: "all" });
    } catch (e) {
        console.warn("[vision] WebGPU session failed, using wasm:", e);
        return ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    }
}

export interface InputInfo {
    name: string;
    float16: boolean;
    shape: readonly (number | string)[];
}

export function inputInfo(s: Session): InputInfo {
    const meta = s.inputMetadata[0];
    const name = s.inputNames[0] ?? "input";
    if (meta && meta.isTensor) return { name, float16: meta.type === "float16", shape: meta.shape };
    return { name, float16: false, shape: [] };
}

/** Run a single-input model with a CHW float32 tensor (cast to float16 when the model wants it). */
export async function runChw(s: Session, info: InputInfo, chw: Float32Array, dims: readonly number[]): Promise<Record<string, { data: Float32Array; dims: readonly number[] }>> {
    const input = info.float16 ? new ort.Tensor("float16", toF16Array(chw), dims) : new ort.Tensor("float32", chw, dims);
    const out = await s.run({ [info.name]: input });
    const result: Record<string, { data: Float32Array; dims: readonly number[] }> = {};
    for (const [k, t] of Object.entries(out)) {
        const raw = t.data;
        let data: Float32Array;
        if (raw instanceof Float32Array) data = raw;
        else if (raw instanceof Uint16Array) data = fromF16Array(raw);
        else data = Float32Array.from(raw as ArrayLike<number>, Number);
        result[k] = { data, dims: t.dims };
        t.dispose();
    }
    input.dispose();
    return result;
}
