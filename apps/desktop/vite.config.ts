import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const host = process.env.TAURI_DEV_HOST;

/**
 * MediaPipe and onnxruntime `import()` their own loaders from /mediapipe and
 * /ort at runtime. In dev, Vite routes a module-worker `import()` (Sec-Fetch-Dest:
 * script) through its transform middleware, which refuses public files
 * ("This file is in /public ... should not be imported from source code").
 * Serve those two trees raw before Vite sees them; `vite build` copies them as-is.
 */
function rawRuntimeAssets(): Plugin {
    const pub = fileURLToPath(new URL("./public", import.meta.url));
    const types: Record<string, string> = { ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm" };
    return {
        name: "tiksee-raw-runtime-assets",
        apply: "serve",
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const path = (req.url ?? "").split("?")[0] ?? "";
                if (!/^\/(mediapipe|ort)\//.test(path)) return next();
                const file = normalize(join(pub, decodeURIComponent(path)));
                if (!file.startsWith(pub) || !existsSync(file) || !statSync(file).isFile()) return next();
                const ext = file.slice(file.lastIndexOf("."));
                res.setHeader("Content-Type", types[ext] ?? "application/octet-stream");
                res.setHeader("Cache-Control", "no-cache");
                createReadStream(file).pipe(res);
            });
        },
    };
}

export default defineConfig(({ command }) => ({
    plugins: [rawRuntimeAssets(), react(), tailwindcss()],
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
        },
        // Dev: resolve workspace packages from src (export condition "source"),
        // so edits in packages/core|pets hot-reload without a tsdown rebuild.
        // onnxruntime-web-use-extern-wasm: ORT loads its wasm from /ort/ (studio-assets.mjs)
        // instead of Vite emitting a second 28 MB copy into dist/assets.
        conditions: [
            ...(command === "serve" ? ["source"] : []),
            "onnxruntime-web-use-extern-wasm",
            "module",
            "browser",
            "development|production",
        ],
    },
    // Tauri serves the renderer from a fixed port and shows Rust errors itself,
    // so Vite must not clear the screen or silently pick another port.
    clearScreen: false,
    // Discovering these lazily makes Vite re-optimize mid-load on a cold cache,
    // which serves two React copies and throws "Invalid hook call" in <Group>.
    optimizeDeps: {
        include: [
            "react",
            "react-dom/client",
            "zod",
            "zustand",
            "react-resizable-panels",
            "@tanstack/react-virtual",
        ],
    },
    server: {
        // Hyper-V/WinNAT reserves shifting 100-port blocks below 10000 on this
        // machine (5094-5293 on 2026-10-05, 5358-5957 on 2026-10-06), which
        // surfaces as EACCES on listen. 15373 sits clear of the dynamic ranges.
        port: 15373,
        strictPort: true,
        host: host || "127.0.0.1",
        hmr: host ? { protocol: "ws", host, port: 15374 } : undefined,
        watch: { ignored: ["**/src-tauri/**"] },
    },
    envPrefix: ["VITE_", "TAURI_"],
    // The vision worker loads MediaPipe's ES-module wasm loader (pipeline.ts needsModuleLoader).
    worker: { format: "es" },
    build: {
        // WebView2 is evergreen Chromium; no legacy transpilation needed.
        target: "chrome120",
        minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
        sourcemap: !!process.env.TAURI_ENV_DEBUG,
        rollupOptions: {
            input: {
                main: fileURLToPath(new URL("./index.html", import.meta.url)),
                overlay: fileURLToPath(new URL("./overlay.html", import.meta.url)),
                studio: fileURLToPath(new URL("./studio.html", import.meta.url)),
            },
            output: {
                // Split the heavy vendor libraries out of the entry chunk so the
                // window paints before recharts (analytics-only) is parsed.
                manualChunks: (id: string) => {
                    if (id.includes("node_modules/recharts") || id.includes("node_modules/d3-")) {
                        return "charts";
                    }
                    if (id.includes("node_modules/motion") || id.includes("node_modules/framer-motion")) {
                        return "motion";
                    }
                    if (id.includes("node_modules/three") || id.includes("node_modules/@mediapipe")) {
                        return "studio-vendor";
                    }
                    return undefined;
                },
            },
        },
    },
}));
