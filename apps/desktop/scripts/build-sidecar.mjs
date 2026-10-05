/**
 * Stage the Node sidecar for `tauri build` so the installed app needs no Node.
 *
 * Why not a Node SEA single executable: the sidecar loads two native addons
 * (@napi-rs/canvas ≈ 26 MB skia, @serialport/bindings-cpp) which cannot live
 * inside a SEA blob — they would still have to ship as loose files next to
 * the exe and be loaded through a custom `require` shim. Shipping the plain
 * Node runtime plus a pruned production `node_modules` is the same size and
 * keeps the normal module resolution, so that is what this does:
 *
 *   src-tauri/binaries/tiksee-sidecar-<triple>.exe   ← this Node runtime (externalBin)
 *   src-tauri/resources/sidecar/dist/index.js        ← tsdown bundle (resource)
 *   src-tauri/resources/sidecar/package.json         ← {"type":"module"}
 *   src-tauri/resources/sidecar/node_modules/…       ← `pnpm deploy --prod`, hoisted, pruned
 *
 * Both output folders are gitignored. Run via `pnpm sidecar:exe`; `tauri
 * build` runs it from `build.beforeBuildCommand`.
 */
import { spawnSync } from "node:child_process";
import {
    copyFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const root = resolve(desktop, "..", "..");
const tauriDir = join(desktop, "src-tauri");
const binaries = join(tauriDir, "binaries");
const staged = join(tauriDir, "resources", "sidecar");
const sidecarPkg = join(root, "apps", "sidecar");

function run(command, args, options = {}) {
    // pnpm is a .cmd shim on Windows, which spawn only runs through a shell;
    // hand the shell one quoted string rather than an args array (DEP0190).
    const line = [command, ...args].map((part) => (/[\s"]/.test(part) ? `"${part.replaceAll('"', '\\"')}"` : part)).join(" ");
    const result = spawnSync(line, { stdio: "inherit", shell: true, ...options });
    if (result.status !== 0) {
        throw new Error(`${line} failed with exit code ${result.status}`);
    }
}

function hostTriple() {
    const result = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
    const match = /^host:\s*(\S+)$/m.exec(result.stdout ?? "");
    if (!match?.[1]) throw new Error("could not determine the host target triple (is rustc on PATH?)");
    return match[1];
}

function dirSize(dir) {
    let bytes = 0;
    let files = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            const sub = dirSize(path);
            bytes += sub.bytes;
            files += sub.files;
        } else {
            bytes += statSync(path).size;
            files += 1;
        }
    }
    return { bytes, files };
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Files and folders no runtime code path loads. */
const PRUNE_DIRS = new Set([".bin", ".pnpm", "@types", "test", "tests", "__tests__", "docs", "example", "examples", ".github"]);
const PRUNE_FILE = /(\.d\.[cm]?ts|\.map|\.md|\.markdown|\.tsbuildinfo)$/i;

function prune(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (PRUNE_DIRS.has(entry.name)) rmSync(path, { recursive: true, force: true });
            else prune(path);
        } else if (PRUNE_FILE.test(entry.name) || entry.name === ".modules.yaml") {
            rmSync(path, { force: true });
        }
    }
}

/** serialport ships prebuilds for every OS; keep only the one we run on. */
function pruneSerialportPrebuilds(nodeModules) {
    const prebuilds = join(nodeModules, "@serialport", "bindings-cpp", "prebuilds");
    if (!existsSync(prebuilds)) return;
    const keep = `${process.platform}-${process.arch}`;
    for (const entry of readdirSync(prebuilds)) {
        if (entry !== keep) rmSync(join(prebuilds, entry), { recursive: true, force: true });
    }
}

// 1. Fresh sidecar bundle (turbo also builds @tiksee/core; cached runs are instant).
run("pnpm", ["exec", "turbo", "run", "build", "--filter=@tiksee/sidecar"], { cwd: root });
const bundle = join(sidecarPkg, "dist", "index.js");
if (!existsSync(bundle) || statSync(bundle).size === 0) {
    throw new Error(`sidecar bundle missing at ${bundle}`);
}

// 2. Flat production node_modules. `--legacy` because the workspace shares one
//    lockfile without inject-workspace-packages; hoisted = no symlinks, which
//    the NSIS bundler cannot follow.
const deployDir = join(tmpdir(), `tiksee-sidecar-deploy-${process.pid}`);
rmSync(deployDir, { recursive: true, force: true });
run(
    "pnpm",
    ["--filter", "@tiksee/sidecar", "deploy", "--prod", "--legacy", "--config.node-linker=hoisted", deployDir],
    { cwd: root },
);

// 3. Assemble the resource folder.
rmSync(staged, { recursive: true, force: true });
mkdirSync(join(staged, "dist"), { recursive: true });
copyFileSync(bundle, join(staged, "dist", "index.js"));
const version = JSON.parse(readFileSync(join(sidecarPkg, "package.json"), "utf8")).version;
writeFileSync(
    join(staged, "package.json"),
    `${JSON.stringify({ name: "tiksee-sidecar", version, private: true, type: "module", main: "dist/index.js" }, null, 4)}\n`,
);
const nodeModules = join(staged, "node_modules");
cpSync(join(deployDir, "node_modules"), nodeModules, { recursive: true, dereference: true });
rmSync(deployDir, { recursive: true, force: true });
// Workspace code is bundled into dist/index.js by tsdown (alwaysBundle).
rmSync(join(nodeModules, "@tiksee"), { recursive: true, force: true });
prune(nodeModules);
pruneSerialportPrebuilds(nodeModules);

// 4. Node runtime as the externalBin: the major pinned in .nvmrc (LTS).
//    Order: TIKSEE_SIDECAR_NODE, this Node if it matches, an fnm install of
//    the pinned major, else this Node with a warning (N-API is ABI-stable).
function pickRuntime() {
    const override = process.env.TIKSEE_SIDECAR_NODE?.trim();
    if (override) return override;
    const pinned = existsSync(join(root, ".nvmrc")) ? readFileSync(join(root, ".nvmrc"), "utf8").trim().replace(/^v/, "") : "";
    if (!pinned || process.versions.node.split(".")[0] === pinned.split(".")[0]) return process.execPath;
    const fnm = spawnSync("fnm", ["exec", `--using=${pinned}`, "node", "-p", "process.execPath"], { encoding: "utf8" });
    const found = fnm.status === 0 ? fnm.stdout.trim().split(/\r?\n/).pop() : "";
    if (found && existsSync(found)) return found;
    console.warn(`warning: bundling Node ${process.versions.node}; .nvmrc pins ${pinned} (set TIKSEE_SIDECAR_NODE)`);
    return process.execPath;
}
const nodeExe = pickRuntime();
const nodeVersion = spawnSync(nodeExe, ["-v"], { encoding: "utf8" }).stdout.trim();
const suffix = process.platform === "win32" ? ".exe" : "";
mkdirSync(binaries, { recursive: true });
const runtime = join(binaries, `tiksee-sidecar-${hostTriple()}${suffix}`);
copyFileSync(nodeExe, runtime);

// 5. Smoke-check: the staged tree must resolve every native addon on its own.
const probe = spawnSync(
    runtime,
    ["--input-type=module", "-e", "await import('@napi-rs/canvas'); await import('serialport'); console.log('ok');"],
    { cwd: staged, encoding: "utf8" },
);
if (probe.status !== 0 || !probe.stdout.includes("ok")) {
    throw new Error(`staged sidecar cannot load its native modules:\n${probe.stderr}`);
}

const res = dirSize(staged);
console.log(`sidecar runtime  ${runtime} (Node ${nodeVersion}, ${mb(statSync(runtime).size)})`);
console.log(`sidecar resource ${staged} (${res.files} files, ${mb(res.bytes)})`);
