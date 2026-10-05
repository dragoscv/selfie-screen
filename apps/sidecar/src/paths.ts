import { homedir } from "node:os";
import { join } from "node:path";

/** Tauri identifier; the desktop shell stores its own data under the same name. */
export const APP_IDENTIFIER = "ro.codai.tiksee";

/**
 * Per-user data directory shared with the Tauri shell:
 * `%APPDATA%\ro.codai.tiksee` on Windows. `TIKSEE_DATA_DIR` overrides it so
 * tests never touch the real profile.
 */
export function appDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
    const override = env.TIKSEE_DATA_DIR?.trim();
    if (override) return override;
    if (platform === "win32") return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), APP_IDENTIFIER);
    if (platform === "darwin") return join(homedir(), "Library", "Application Support", APP_IDENTIFIER);
    return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), APP_IDENTIFIER);
}
