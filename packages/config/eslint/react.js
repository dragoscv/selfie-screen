// @ts-check
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

import base from "./index.js";

/** Flat config for React 19 packages (renderer + shared UI). */
export default tseslint.config(
    ...base,
    {
        files: ["**/*.{ts,tsx}"],
        languageOptions: {
            globals: { ...globals.browser },
        },
        plugins: {
            "react-hooks": reactHooks,
            "react-refresh": reactRefresh,
        },
        rules: {
            ...reactHooks.configs.recommended.rules,
            "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
        },
    },
    {
        // Entry modules mount a React root and intentionally export nothing, so
        // the fast-refresh rule does not apply to them.
        files: ["**/main.tsx", "**/overlay.tsx", "**/studio.tsx", "**/index.tsx"],
        rules: { "react-refresh/only-export-components": "off" },
    },
);
