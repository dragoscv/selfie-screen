// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Base flat config shared by every TypeScript package in the monorepo. */
export default tseslint.config(
    {
        ignores: [
            "**/dist/**",
            "**/build/**",
            "**/node_modules/**",
            "**/src-tauri/target/**",
            "**/routeTree.gen.ts",
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2023,
            globals: { ...globals.es2021 },
        },
        rules: {
            "@typescript-eslint/no-unused-vars": [
                "error",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
            ],
            "@typescript-eslint/consistent-type-imports": [
                "error",
                { prefer: "type-imports", fixStyle: "inline-type-imports" },
            ],
            "no-console": ["warn", { allow: ["warn", "error"] }],
            eqeqeq: ["error", "smart"],
        },
    },
);
