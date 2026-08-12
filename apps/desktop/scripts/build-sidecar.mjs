/**
 * Package the Node sidecar as a Tauri `externalBin`.
 *
 * Tauri requires the binary to be named `<name>-<target-triple>`, so this
 * copies the current Node executable under that name and places the bundled
 * sidecar JS beside it. Using the system Node keeps the installer small; a
 * fully self-contained build would use Node SEA instead.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const binaries = join(desktop, "src-tauri", "binaries");

function hostTriple() {
    const output = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
    const match = /^host:\s*(\S+)$/m.exec(output);
    if (!match?.[1]) throw new Error("could not determine the host target triple");
    return match[1];
}

const triple = hostTriple();
mkdirSync(binaries, { recursive: true });

const suffix = process.platform === "win32" ? ".exe" : "";
const target = join(binaries, `tiksee-sidecar-${triple}${suffix}`);

copyFileSync(process.execPath, target);

const bundle = resolve(desktop, "..", "sidecar", "dist", "index.js");
if (!existsSync(bundle)) {
    throw new Error(`sidecar bundle missing at ${bundle} — run \`pnpm --filter @tiksee/sidecar build\` first`);
}
copyFileSync(bundle, join(binaries, "sidecar.js"));

console.log(`sidecar packaged: ${target}`);
