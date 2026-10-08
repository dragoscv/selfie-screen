import { emitTo, listen } from "@tauri-apps/api/event";

import type { MicDiag, MicEvent } from "../audio/mic.js";
import { safeUnlisten } from "../unloading.js";

/** One `mic://diag` tick from the main window (10 Hz while watched). */
export interface MicPayload {
    enabled: boolean;
    loading: boolean;
    error: string | null;
    diag: MicDiag | null;
    events: MicEvent[];
}

const WATCH_MS = 2_000;

/**
 * The mic runs in the main window: ask it to stream diagnostics (`mic://watch`, renewed so a
 * reloaded main window resumes) and deliver each `mic://diag` payload. Returns the unsubscribe.
 */
export function subscribeMicFeed(onPayload: (payload: MicPayload) => void): () => void {
    const ask = () => void emitTo("main", "mic://watch", null).catch(() => undefined);
    ask();
    const timer = window.setInterval(ask, WATCH_MS);
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<MicPayload>("mic://diag", (e) => onPayload(e.payload))
        .then((u) => (disposed ? u() : (stop = u)))
        .catch(() => undefined);
    return () => {
        disposed = true;
        window.clearInterval(timer);
        safeUnlisten(stop);
    };
}
