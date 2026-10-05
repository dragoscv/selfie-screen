// Copies the studio's runtime assets into apps/desktop/public (gitignored):
// MediaPipe wasm + pose model, the Basis/KTX2 transcoder and the built pets.
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

// MediaPipe wasm (SIMD build only; WebView2 always has SIMD).
const mp = pkgDir("@mediapipe/tasks-vision");
copyDir(join(mp, "wasm"), join(pub, "mediapipe", "wasm"), (n) => n.startsWith("vision_wasm_internal"));

// Basis transcoder for KTX2 textures.
const three = pkgDir("three");
copyDir(join(three, "examples", "jsm", "libs", "basis"), join(pub, "basis"), (n) => n.startsWith("basis_transcoder"));

// Pose model, pinned by md5 (Google's x-goog-hash for the float16 lite model).
const MODEL = {
    url: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
    md5: "BKdd33yBGsehpFIyZt19iA==",
    file: join(pub, "mediapipe", "pose_landmarker_lite.task"),
};
const md5 = (buf) => createHash("md5").update(buf).digest("base64");
if (!existsSync(MODEL.file) || md5(readFileSync(MODEL.file)) !== MODEL.md5) {
    const res = await fetch(MODEL.url);
    if (!res.ok) throw new Error(`pose model download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (md5(buf) !== MODEL.md5) throw new Error("pose model checksum mismatch");
    writeFileSync(MODEL.file, buf);
}

// Built pets (assets/pets/dist/<pet>.glb from the Blender + gltf-transform pipeline).
const pets = join(app, "..", "..", "assets", "pets", "dist");
if (existsSync(pets)) copyDir(pets, join(pub, "pets"), (n) => n.endsWith(".glb"));

console.log("studio assets ready");
