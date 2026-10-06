// Size budgets: fail when a build artefact grows past its limit.
// Run after `pnpm verify` (needs apps/desktop/dist and apps/sidecar/dist).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const KB = 1024;

/** [label, file matcher, dir, max gzip bytes] */
const budgets = [
    ["desktop entry", /^main-.*\.js$/, "apps/desktop/dist/assets", 45 * KB],
    ["desktop overlay", /^overlay-.*\.js$/, "apps/desktop/dist/assets", 6 * KB],
    ["desktop live route", /^live-.*\.js$/, "apps/desktop/dist/assets", 35 * KB],
    ["desktop speaker (lazy)", /^speaker-.*\.js$/, "apps/desktop/dist/assets", 5 * KB],
    ["desktop mic (lazy)", /^mic-.*\.js$/, "apps/desktop/dist/assets", 4 * KB],
    // Separate window; three/webgpu + MediaPipe never load in the main window.
    // 0.3.0: engine (output RT, AR, monitor, scopes, vcam pump) + control surface = 38.5 KB measured;
    // tutorial / calibration / enrol / AR editor are lazy chunks.
    // 0.4.0: + clip buffer (42.4) + 3D pets runtime (BodyModel, PetRoamer, PetActor, metre space) = 48.3 KB;
    // the 3D debug overlay (8.5 KB raw) and the MP4 muxer stay lazy.
    // + metric owner distance (body solve, iris, Kalman) and the fluid-skeleton interpolation: 51.6 KB;
    // + per-frame pet runtime (utility AI minds, body capsules + constraint pass, procedural
    //   animation: saccades, springs, squash) and the director wiring: 58.3 KB measured.
    // Space calibration, ChArUco, MoGe-2, the F3 overlay and the MP4 muxer are lazy chunks.
    ["desktop studio", /^studio-[^v].*\.js$/, "apps/desktop/dist/assets", 62 * KB],
    ["desktop studio vendor", /^studio-vendor-.*\.js$/, "apps/desktop/dist/assets", 380 * KB],
    // Vision worker (MediaPipe + ONNX glue) and its main-thread fallback pipeline; measured 211 / 113 KB.
    ["studio vision worker", /^worker-.*\.js$/, "apps/desktop/dist/assets", 230 * KB],
    ["studio vision pipeline (fallback)", /^pipeline-.*\.js$/, "apps/desktop/dist/assets", 125 * KB],
    // Main window: vision route (lazy) and the xyflow rule graph (lazy inside it); measured 17.8 / 61.2 KB.
    ["desktop vision route", /^vision-.*\.js$/, "apps/desktop/dist/assets", 25 * KB],
    ["desktop rule graph (lazy)", /^rule-graph-editor-.*\.js$/, "apps/desktop/dist/assets", 70 * KB],
    // 0.4.0: MP4 muxer for studio clips (mediabunny, tree-shaken), loaded on the first save.
    ["studio clip muxer (lazy)", /^clip-mux-.*\.js$/, "apps/desktop/dist/assets", 60 * KB],
    // 0.4.0: lens calibration (ChArUco + Zhang, 7.4 KB) and the js-aruco2 detector (10.3 KB) load on demand.
    ["studio lens calibration (lazy)", /^charuco-.*\.js$/, "apps/desktop/dist/assets", 10 * KB],
    ["studio aruco detector (lazy)", /^aruco-.*\.js$/, "apps/desktop/dist/assets", 13 * KB],
    // 0.3.0 adds the rules engine, vision log and identities: 85.1 KB measured.
    ["sidecar bundle", /^index\.js$/, "apps/sidecar/dist", 95 * KB],
];

let failed = 0;
for (const [label, match, dir, max] of budgets) {
    const abs = join(root, dir);
    let files;
    try {
        files = readdirSync(abs).filter((f) => match.test(f));
    } catch {
        console.error(`MISSING  ${label}: ${dir} not built`);
        failed++;
        continue;
    }
    if (files.length === 0) {
        console.error(`MISSING  ${label}: no file matches ${match}`);
        failed++;
        continue;
    }
    for (const f of files) {
        const path = join(abs, f);
        const gz = gzipSync(readFileSync(path)).length;
        const raw = statSync(path).size;
        const ok = gz <= max;
        if (!ok) failed++;
        console.log(
            `${ok ? "ok      " : "OVER    "} ${label.padEnd(24)} ${(gz / KB).toFixed(1).padStart(7)} KB gz` +
                ` (raw ${(raw / KB).toFixed(1)} KB, budget ${(max / KB).toFixed(0)} KB)`,
        );
    }
}
if (failed) {
    console.error(`\n${failed} budget problem(s)`);
    process.exit(1);
}
