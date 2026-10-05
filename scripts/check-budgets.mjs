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
    ["sidecar bundle", /^index\.js$/, "apps/sidecar/dist", 80 * KB],
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
