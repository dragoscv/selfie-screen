import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { alertReason, playChime } from "../lib/alerts.js";
import { liveAudio } from "../lib/audio/live-audio.js";
import { runHotkey } from "../lib/live-control.js";
import { sidecarClient } from "../lib/sidecar-client.js";
import { MAIN_STREAM, useAppStore } from "../store/app-store.js";

const ERROR_DEDUPE_MS = 5_000;
/** A gift storm must not become a notification storm. */
const ALERT_MIN_GAP_MS = 4_000;

interface TikTokSession {
    sessionId: string;
    ttTargetIdc: string;
}

function isSession(value: unknown): value is TikTokSession {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { sessionId?: unknown }).sessionId === "string" &&
        typeof (value as { ttTargetIdc?: unknown }).ttTargetIdc === "string"
    );
}

/**
 * Subscribe to a Tauri event safely: `listen()` resolves asynchronously, so a
 * cleanup that runs first must not call an unlistener that does not exist yet.
 */
function listenSafely<T>(event: string, handler: (payload: T) => void): () => void {
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<T>(event, (e) => handler(e.payload))
        .then((unlisten) => {
            if (disposed) unlisten();
            else stop = unlisten;
        })
        .catch(() => undefined);
    return () => {
        disposed = true;
        stop?.();
    };
}

/** Hand the harvested TikTok session to the sidecar. Never logged. */
async function forwardTikTokSession(payload: unknown): Promise<void> {
    // The shell emits `null` when the session was cleared.
    if (payload === null) {
        useAppStore.getState().setHasTikTokSession(false);
        return;
    }
    let session: TikTokSession | null = isSession(payload) ? payload : null;
    try {
        const fromShell = await invoke<unknown>("tiktok_session");
        if (isSession(fromShell)) session = fromShell;
    } catch {
        // Older shells have no `tiktok_session`; the event payload is all we get.
    }
    if (!session) return;
    sidecarClient.send({ type: "session", sessionId: session.sessionId, ttTargetIdc: session.ttTargetIdc });
    useAppStore.getState().setHasTikTokSession(true);
}

/**
 * Main-window live-studio wiring: audio engines, global hotkeys (WS15-05),
 * sidecar error toasts (WS15-10) and the TikTok session hand-off (WS15-04).
 */
export function useLiveStudio(): void {
    const { t } = useTranslation();
    const settings = useAppStore((s) => s.settings);
    const control = useAppStore((s) => s.liveControl);
    const loaded = useAppStore((s) => s.settingsLoaded);
    const sidecarConnected = useAppStore((s) => s.sidecarConnected);

    useEffect(() => liveAudio.attach(), []);

    useEffect(() => {
        if (loaded) liveAudio.update({ settings, control });
    }, [settings, control, loaded]);

    useEffect(() => {
        if (loaded && sidecarConnected) reconnectOnLaunch();
    }, [loaded, sidecarConnected]);

    useEffect(() => {
        const stopHotkeys = listenSafely<string>("hotkey", (action) =>
            runHotkey(action, () => liveAudio.setPushToTalk(!useAppStore.getState().transcript.pushToTalk)),
        );
        const stopSession = listenSafely<unknown>("tiktok://session", (payload) => {
            void forwardTikTokSession(payload);
        });
        // The sidecar forgets the session on restart; the shell keeps it in
        // Credential Manager, so re-hand it over whenever the sidecar says hello without one.
        const offHello = sidecarClient.onMessage((message) => {
            if (message.type === "hello" && !message.hasSession) void forwardTikTokSession(undefined);
        });
        return () => {
            stopHotkeys();
            stopSession();
            offHello();
        };
    }, []);

    useEffect(() => {
        const recent = new Map<string, number>();
        return sidecarClient.onMessage((message) => {
            if (message.type !== "error") return;
            const now = Date.now();
            const last = recent.get(message.message);
            if (last !== undefined && now - last < ERROR_DEDUPE_MS) return;
            recent.set(message.message, now);
            for (const [text, at] of recent) if (now - at > ERROR_DEDUPE_MS) recent.delete(text);
            toast.error(message.message);
        });
    }, []);

    useEffect(() => {
        let lastAlertAt = 0;
        let permission: Promise<boolean> | null = null;
        const notify = (title: string, body: string) => {
            permission ??= isPermissionGranted()
                .then((granted) => granted || requestPermission().then((p) => p === "granted"))
                .catch(() => false);
            void permission.then((ok) => {
                if (ok) sendNotification({ title, body });
            });
        };
        return sidecarClient.onMessage((message) => {
            if (message.type !== "events") return;
            const current = useAppStore.getState().settings;
            for (const event of message.events) {
                const reason = alertReason(event, current);
                if (!reason) continue;
                const now = Date.now();
                if (now - lastAlertAt < ALERT_MIN_GAP_MS) return;
                lastAlertAt = now;
                if (current.alerts.soundEnabled) playChime(current.alerts.soundVolume);
                notify(t(`alertsNotify.${reason}`, { name: event.user.nickname }), event.text);
                return;
            }
        });
    }, [t]);
}

let launchReconnectDone = false;

/** `behaviour.autoReconnect`: reconnect to the last creator once per app launch. */
function reconnectOnLaunch(): void {
    if (launchReconnectDone) return;
    launchReconnectDone = true;
    const { settings, statuses } = useAppStore.getState();
    const username = settings.connection.username.trim();
    const state = statuses[MAIN_STREAM]?.state ?? "offline";
    if (!settings.behaviour.autoReconnect || username === "" || state !== "offline") return;
    sidecarClient.send({
        type: "connect",
        streamId: MAIN_STREAM,
        username,
        driver: settings.connection.driver,
        waitUntilLive: settings.behaviour.waitUntilLive,
    });
}
