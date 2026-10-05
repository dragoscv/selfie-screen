const MODIFIERS = new Set([
    "commandorcontrol",
    "cmdorctrl",
    "cmdorcontrol",
    "commandorctrl",
    "command",
    "cmd",
    "control",
    "ctrl",
    "alt",
    "option",
    "altgr",
    "shift",
    "super",
    "meta",
]);

/**
 * Light validation of a Tauri accelerator ("CommandOrControl+Shift+M").
 * Empty is valid — it means "no shortcut". The shell remains the authority;
 * this only catches the obvious typos before they are registered.
 */
export function isValidAccelerator(value: string): boolean {
    const trimmed = value.trim();
    if (trimmed === "") return true;
    const parts = trimmed.split("+").map((p) => p.trim().toLowerCase());
    if (parts.some((p) => p === "")) return false;
    const key = parts.at(-1) ?? "";
    if (MODIFIERS.has(key)) return false;
    if (!parts.slice(0, -1).every((p) => MODIFIERS.has(p))) return false;
    return /^([a-z0-9]|f([1-9]|1[0-9]|2[0-4])|space|tab|enter|escape|esc|backspace|delete|insert|home|end|pageup|pagedown|up|down|left|right|arrowup|arrowdown|arrowleft|arrowright|plus|minus|comma|period|slash|backslash|semicolon|quote|backquote|bracketleft|bracketright|equal|numpad[0-9]|digit[0-9]|key[a-z]|mediaplaypause|mediastop|medianexttrack|mediaprevioustrack|audiovolumemute|audiovolumeup|audiovolumedown)$/.test(
        key,
    );
}

/** Normalised form for duplicate detection. */
export function acceleratorKey(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .split("+")
        .map((p) => p.trim())
        .sort()
        .join("+");
}
