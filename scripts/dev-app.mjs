// Hot-reload dev loop for the whole app, no package builds needed:
//   renderer  -> Vite HMR, workspace packages resolved from src ("source" condition)
//   sidecar   -> node --watch + tsx on apps/sidecar/src (restarts on save, windows reconnect)
//   Rust      -> tauri dev rebuilds and relaunches on src-tauri changes
// Usage: pnpm dev:app [--bench synthetic|camera] [--trace]
//   --trace: 10 Hz [trace]/[dial]/[sig]/[beauty] telemetry in the log (scripts/trace-report.mjs)
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const env = { ...process.env, TIKSEE_SIDECAR_WATCH: "1" };
const bench = args.indexOf("--bench");
if (bench >= 0) env.TIKSEE_STUDIO_BENCH = args[bench + 1] ?? "camera";
if (args.includes("--trace")) env.VITE_TIKSEE_TRACE = "1";

/** A TikSee WebView2 whose tiksee.exe parent died keeps the capture card locked. */
function killOrphans(when) {
    if (process.platform !== "win32") return;
    const r = spawnSync(
        "pwsh",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts", "kill-orphan-webview.ps1"), "-Kill"],
        { encoding: "utf8" },
    );
    const killed = (r.stdout ?? "").split("\n").filter((l) => l.startsWith("killed"));
    if (killed.length) console.log(`[dev-app] ${when}: ${killed.join(", ")}`);
}

killOrphans("before start");
const child = spawn("pnpm", ["--filter", "@tiksee/desktop", "tauri", "dev"], {
    cwd: root,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
});
child.on("exit", (code, signal) => {
    // code -1 / a signal = the process tree was killed from outside (closed terminal), not a crash.
    console.log(`[dev-app] tauri dev exited code=${code} signal=${signal ?? "-"} at ${new Date().toISOString()}`);
    // Give WebView2 a moment to exit with its parent, then reap leftovers.
    setTimeout(() => {
        killOrphans("after exit");
        process.exit(code ?? 0);
    }, 1500);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
