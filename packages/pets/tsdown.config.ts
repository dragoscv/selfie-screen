import { defineConfig } from "tsdown";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    platform: "browser",
    target: "es2023",
    dts: true,
    sourcemap: true,
    clean: true,
    // three is a peer of the renderer bundle; never inline it here.
    deps: { neverBundle: [/^three/] },
    fixedExtension: false,
});
