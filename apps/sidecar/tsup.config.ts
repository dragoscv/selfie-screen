import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    platform: "node",
    target: "node22",
    sourcemap: true,
    clean: true,
    // Bundle workspace code, but leave native/heavy deps external so their
    // prebuilt binaries resolve from node_modules at runtime.
    noExternal: ["@tiksee/core"],
    external: ["serialport", "@serialport/bindings-cpp", "@napi-rs/canvas"],
    banner: {
        js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
    },
});
