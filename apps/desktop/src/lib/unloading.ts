/**
 * True once the page is being torn down (window closed or full reload). Tauri IPC calls made
 * then (e.g. `unlisten`) fail with "IPC custom protocol failed" warnings; the listeners die
 * with the webview anyway, so callers skip them.
 */
let unloading = false;

if (typeof window !== "undefined") {
    const mark = () => {
        unloading = true;
    };
    window.addEventListener("pagehide", mark, { capture: true });
    window.addEventListener("beforeunload", mark, { capture: true });
}

export function isUnloading(): boolean {
    return unloading;
}

/** Call a Tauri unlisten unless the page is unloading. */
export function safeUnlisten(stop: (() => void) | null | undefined): void {
    if (!stop || unloading) return;
    try {
        stop();
    } catch {
        // The webview is going away; nothing to clean.
    }
}
