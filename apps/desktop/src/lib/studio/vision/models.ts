import type { OptionalModel } from "./protocol.js";

/**
 * Optional ONNX models: downloaded once from the release bucket, verified by
 * SHA-256, kept in the Cache Storage API. Works on the main thread and in
 * workers (fetch, caches and crypto.subtle exist in both).
 */
export const MODEL_BASE = "https://storage.googleapis.com/tiksee-releases/models/";
const CACHE = "tiksee-models-v1";

export interface ModelFile {
    file: string;
    bytes: number;
    sha256: string;
}

export const MODELS: Record<OptionalModel, ModelFile> = {
    identity: {
        file: "face_recognition_sface_2021dec_int8.onnx",
        bytes: 9_896_933,
        sha256: "2b0e941e6f16cc048c20aee0c8e31f569118f65d702914540f7bfdc14048d78a",
    },
    dogIdentity: {
        file: "dinov2_small_q8.onnx",
        bytes: 24_446_700,
        sha256: "c179f8f7f592449c4c1bca4cd124a7538021428c5ffb89afde9503935b197efb",
    },
    depth: {
        file: "depth_anything_v2_small_fp16.onnx",
        bytes: 49_642_442,
        sha256: "2df6223f206b5164e21f664ace61dabeb9bb6a49b8b5a3e00510b4807d0f5b04",
    },
};

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
    return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stream a download, reporting received bytes. */
async function download(url: string, total: number, onBytes: (n: number) => void): Promise<ArrayBuffer> {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok || !res.body) throw new Error(`model download failed: ${url} -> HTTP ${res.status}`);
    const out = new Uint8Array(total);
    const reader = res.body.getReader();
    let got = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (got + value.length > total) {
            await reader.cancel();
            throw new Error(`model ${url}: larger than the expected ${total} bytes`);
        }
        out.set(value, got);
        got += value.length;
        onBytes(got);
    }
    if (got !== total) throw new Error(`model ${url}: got ${got} bytes, expected ${total}`);
    return out.buffer;
}

/** Load one model (cache first), verifying the hash every time it is read. */
export async function loadModel(which: OptionalModel, onBytes: (n: number) => void = () => {}): Promise<ArrayBuffer> {
    const m = MODELS[which];
    const url = MODEL_BASE + m.file;
    const cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) {
        const buf = await hit.arrayBuffer();
        if ((await sha256Hex(buf)) === m.sha256) {
            onBytes(m.bytes);
            return buf;
        }
        await cache.delete(url);
    }
    const buf = await download(url, m.bytes, onBytes);
    const hash = await sha256Hex(buf);
    if (hash !== m.sha256) {
        await cache.delete(url);
        throw new Error(`model ${m.file} failed verification (sha256 ${hash.slice(0, 12)}…, expected ${m.sha256.slice(0, 12)}…); deleted, try again`);
    }
    await cache.put(url, new Response(buf, { headers: { "content-type": "application/octet-stream", "content-length": String(m.bytes) } }));
    return buf;
}

/**
 * Make sure every requested model is cached and verified; progress is the
 * byte fraction over all of them (0..1). Returns the model bytes.
 */
export async function ensureModels(which: readonly OptionalModel[], onProgress?: (p: number) => void): Promise<Map<OptionalModel, ArrayBuffer>> {
    const unique = [...new Set(which)];
    const total = unique.reduce((s, w) => s + MODELS[w].bytes, 0) || 1;
    const got = new Map<OptionalModel, number>();
    const report = () => onProgress?.(Math.min(1, [...got.values()].reduce((s, v) => s + v, 0) / total));
    const out = new Map<OptionalModel, ArrayBuffer>();
    // Sequential: one stream at a time keeps progress honest and memory bounded.
    for (const w of unique) {
        out.set(
            w,
            await loadModel(w, (n) => {
                got.set(w, n);
                report();
            }),
        );
    }
    onProgress?.(1);
    return out;
}
