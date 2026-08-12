// @ts-check
import globals from "globals";
import tseslint from "typescript-eslint";

import base from "./index.js";

/**
 * Flat config for Node services. Consumers import this rather than depending
 * on `globals` themselves — pnpm's strict linking means a transitive dep of
 * this package is not resolvable from a sibling workspace.
 */
export default tseslint.config(...base, {
    files: ["**/*.ts"],
    languageOptions: { globals: { ...globals.node } },
    rules: {
        // A headless service logs to stdout by design.
        "no-console": "off",
    },
});
