/**
 * Build the TikSee Camera binaries for `tauri build`.
 *
 *   src-tauri/vcam/bin/tiksee_vcam.dll          ← Frame Server media source (resource)
 *   src-tauri/vcam/bin/tiksee-vcam-setup.exe    ← elevated install/uninstall helper (resource)
 *
 * Both land next to TikSee.exe in $INSTDIR through `bundle.resources`; the
 * NSIS hooks (src-tauri/windows/hooks.nsh) run `tiksee-vcam-setup.exe
 * install` after copying. The vcam crates are their own cargo workspace
 * (src-tauri/vcam/Cargo.toml) so the DLL keeps panic=unwind while the app
 * uses panic=abort. bin/ and target/ are gitignored.
 *
 * Run via `pnpm vcam:build`; `tauri build` runs it from `build.beforeBuildCommand`.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const vcamDir = join(desktop, "src-tauri", "vcam");
const manifest = join(vcamDir, "Cargo.toml");
const release = join(vcamDir, "target", "release");
const bin = join(vcamDir, "bin");

const ARTIFACTS = ["tiksee_vcam.dll", "tiksee-vcam-setup.exe"];

if (process.platform !== "win32") {
    console.log("vcam: TikSee Camera is Windows-only, skipping");
    process.exit(0);
}

const args = [
    "build",
    "--release",
    "--manifest-path",
    manifest,
    "-p",
    "tiksee-vcam-source",
    "-p",
    "tiksee-vcam-setup",
];
const result = spawnSync("cargo", args, { stdio: "inherit" });
if (result.status !== 0) {
    throw new Error(`cargo ${args.join(" ")} failed with exit code ${result.status}`);
}

mkdirSync(bin, { recursive: true });
for (const name of ARTIFACTS) {
    const from = join(release, name);
    if (!existsSync(from) || statSync(from).size === 0) {
        throw new Error(`vcam artifact missing at ${from}`);
    }
    const to = join(bin, name);
    copyFileSync(from, to);
    console.log(`vcam ${to} (${(statSync(to).size / 1024).toFixed(0)} KB)`);
}
