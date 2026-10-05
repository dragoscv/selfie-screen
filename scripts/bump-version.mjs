// Set one version everywhere a TikSee release is named.
// Usage: node scripts/bump-version.mjs 0.2.0
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
    console.error("usage: node scripts/bump-version.mjs <major.minor.patch>");
    process.exit(1);
}

const root = new URL("..", import.meta.url);
const jsonFiles = [
    "package.json",
    "apps/desktop/package.json",
    "apps/sidecar/package.json",
    "packages/core/package.json",
    "packages/ui/package.json",
    "packages/config/package.json",
    "apps/desktop/src-tauri/tauri.conf.json",
];
for (const rel of jsonFiles) {
    const url = new URL(rel, root);
    const text = readFileSync(url, "utf8");
    const next = text.replace(/("version":\s*")\d+\.\d+\.\d+(")/, `$1${version}$2`);
    if (next === text) throw new Error(`no version field in ${rel}`);
    writeFileSync(url, next);
}

const cargo = new URL("apps/desktop/src-tauri/Cargo.toml", root);
const toml = readFileSync(cargo, "utf8");
writeFileSync(cargo, toml.replace(/^version = "\d+\.\d+\.\d+"/m, `version = "${version}"`));

console.log(`version ${version} written to ${jsonFiles.length + 1} files`);
