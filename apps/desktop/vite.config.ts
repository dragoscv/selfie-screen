import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(({ command }) => ({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
        },
        // Dev: resolve workspace packages from src (export condition "source"),
        // so edits in packages/core|pets hot-reload without a tsdown rebuild.
        ...(command === "serve" ? { conditions: ["source", "module", "browser", "development|production"] } : {}),
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
        // 5094-5293 falls inside a Hyper-V/WinNAT reserved exclusion range on
        // this machine, which surfaces as a confusing EACCES on ::1.
        port: 5373,
        strictPort: true,
        host: host || "127.0.0.1",
        hmr: host ? { protocol: "ws", host, port: 5374 } : undefined,
        watch: { ignored: ["**/src-tauri/**"] },
    },
    envPrefix: ["VITE_", "TAURI_"],
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
