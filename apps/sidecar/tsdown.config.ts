import { readFileSync } from "node:fs";

import { defineConfig } from "tsdown";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    platform: "node",
    target: "node24",
    sourcemap: true,
    clean: true,
    // The Tauri launcher (src-tauri/src/sidecar.rs) spawns `dist/index.js`;
    // tsdown would otherwise emit `.mjs` for a node-platform build.
    fixedExtension: false,
    // An app, not a library: no declaration output.
    dts: false,
    // Single source of truth for the version reported in the READY line.
    define: { __TIKSEE_VERSION__: JSON.stringify(pkg.version) },
    deps: {
        // Bundle workspace code, but leave native/heavy deps external so their
        // prebuilt binaries resolve from node_modules at runtime. Regexes, not
        // strings: tsdown string patterns do not match subpath imports.
        alwaysBundle: [/^@tiksee\/core(\/|$)/],
        neverBundle: [/^serialport(\/|$)/, /^@serialport\//, /^@napi-rs\/canvas(\/|$)/],
    },
});
