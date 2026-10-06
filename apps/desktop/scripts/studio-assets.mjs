// Copies the studio's runtime assets into apps/desktop/public (gitignored):
// MediaPipe wasm + models, onnxruntime-web wasm, the Basis/KTX2 transcoder and the built pets.
// Runs before `vite` / `vite build`; idempotent and offline after the first run.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const pub = join(app, "public");
/** pnpm links every direct dependency here; some packages do not export ./package.json. */
const pkgDir = (name) => {
    const dir = join(app, "node_modules", ...name.split("/"));
    if (!existsSync(dir)) throw new Error(`${name} is not installed in apps/desktop`);
    return dir;
};

function copyDir(from, to, filter = () => true) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) {
        const src = join(from, name);
        if (statSync(src).isFile() && filter(name)) copyFileSync(src, join(to, name));
    }
}

// MediaPipe wasm (SIMD builds only; WebView2 always has SIMD). The classic loader serves the
// main thread and the bundled (classic) vision worker; the `_module_` loader serves the module
// worker that `vite dev` creates.
const mp = pkgDir("@mediapipe/tasks-vision");
copyDir(join(mp, "wasm"), join(pub, "mediapipe", "wasm"), (n) => n.startsWith("vision_wasm_internal") || n.startsWith("vision_wasm_module_internal"));

// onnxruntime-web: the JSEP build (WebGPU EP + wasm) that the default `onnxruntime-web` entry
// loads, plus the plain wasm build. Served from /ort/ (ort.env.wasm.wasmPaths).
const ort = pkgDir("onnxruntime-web");
copyDir(join(ort, "dist"), join(pub, "ort"), (n) => /^ort-wasm-simd-threaded(\.jsep)?\.(mjs|wasm)$/.test(n));

// Basis transcoder for KTX2 textures.
const three = pkgDir("three");
copyDir(join(three, "examples", "jsm", "libs", "basis"), join(pub, "basis"), (n) => n.startsWith("basis_transcoder"));

// MediaPipe models, pinned by md5 (Google's x-goog-hash of each versioned object, checked
// 2026-10-05; /latest/ pointed at the same bytes).
const MP = "https://storage.googleapis.com/mediapipe-models";
const MODELS = [
    { url: `${MP}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`, md5: "BKdd33yBGsehpFIyZt19iA==", name: "pose_landmarker_lite.task" },
    { url: `${MP}/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task`, md5: "Tb9IXEcyB2URAKGJU0PzWg==", name: "gesture_recognizer.task" },
    { url: `${MP}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`, md5: "sOcnSQehZEQE/vZrKN1thQ==", name: "face_landmarker.task" },
    { url: `${MP}/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite`, md5: "zr9kr2w15avXNElGhQZIQg==", name: "efficientdet_lite0.tflite" },
];
const md5 = (buf) => createHash("md5").update(buf).digest("base64");
for (const m of MODELS) {
    const file = join(pub, "mediapipe", m.name);
    if (existsSync(file) && md5(readFileSync(file)) === m.md5) continue;
    const res = await fetch(m.url);
    if (!res.ok) throw new Error(`${m.name} download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (md5(buf) !== m.md5) throw new Error(`${m.name} checksum mismatch`);
    writeFileSync(file, buf);
}

// Built pets (assets/pets/dist/<pet>.glb from the Blender + gltf-transform pipeline).
const pets = join(app, "..", "..", "assets", "pets", "dist");
if (existsSync(pets)) copyDir(pets, join(pub, "pets"), (n) => n.endsWith(".glb"));

console.log("studio assets ready");
