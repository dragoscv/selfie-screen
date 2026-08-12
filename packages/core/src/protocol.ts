import { z } from "zod";

import { chatEventSchema, connectionStatusSchema, sessionStatsSchema } from "./events.js";
import { settingsSchema } from "./settings.js";

/**
 * The wire contract between the Tauri renderer and the Node sidecar.
 *
 * Both sides import these schemas, so a change that breaks one breaks the
 * other at compile time. Every inbound frame is validated at the boundary —
 * the sidecar owns network sockets and serial hardware, and must never trust
 * a malformed message.
 */

/* ----------------------------- UI → sidecar ----------------------------- */

export const clientMessageSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("ping"), at: z.number().int() }),

    z.object({
        type: z.literal("connect"),
        streamId: z.string(),
        username: z.string(),
        driver: z.enum(["connector", "sniffer"]).default("connector"),
        /** Poll until the creator goes live instead of failing immediately. */
        waitUntilLive: z.boolean().default(false),
    }),
    z.object({ type: z.literal("disconnect"), streamId: z.string() }),

    /** Push the full settings tree; the sidecar hot-applies what it owns. */
    z.object({ type: z.literal("settings"), settings: settingsSchema }),

    /** Store the TikTok session harvested from the login window. */
    z.object({
        type: z.literal("session"),
        sessionId: z.string(),
        ttTargetIdc: z.string(),
    }),
    z.object({ type: z.literal("clearSession") }),

    /* panel */
    z.object({ type: z.literal("panelConnect"), portPath: z.string().optional() }),
    z.object({ type: z.literal("panelDisconnect") }),
    z.object({ type: z.literal("panelListPorts") }),
    z.object({ type: z.literal("panelBrightness"), level: z.number().int().min(0).max(100) }),
    z.object({ type: z.literal("panelPower"), on: z.boolean() }),

    /* replay */
    z.object({ type: z.literal("replayList") }),
    z.object({
        type: z.literal("replayStart"),
        name: z.string(),
        streamId: z.string(),
        speed: z.number().min(0.1).max(20).default(1),
        loop: z.boolean().default(false),
    }),
    z.object({ type: z.literal("replayStop") }),
    z.object({ type: z.literal("recordStart"), name: z.string() }),
    z.object({ type: z.literal("recordStop") }),

    /* obs */
    z.object({ type: z.literal("obsConnect"), url: z.string(), password: z.string().optional() }),
    z.object({ type: z.literal("obsDisconnect") }),
    z.object({ type: z.literal("obsSetScene"), scene: z.string() }),
    z.object({ type: z.literal("obsListScenes") }),

    /** Inject a synthetic event, used by tests and the giveaway demo mode. */
    z.object({ type: z.literal("simulate"), event: chatEventSchema }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

/* ----------------------------- sidecar → UI ----------------------------- */

export const serialPortInfoSchema = z.object({
    path: z.string(),
    manufacturer: z.string().optional(),
    vendorId: z.string().optional(),
    productId: z.string().optional(),
    /** True when VID/PID match a known Turing panel. */
    isPanel: z.boolean(),
});
export type SerialPortInfo = z.infer<typeof serialPortInfoSchema>;

export const panelStatusSchema = z.object({
    connected: z.boolean(),
    portPath: z.string().optional(),
    fps: z.number().default(0),
    frames: z.number().int().default(0),
    error: z.string().optional(),
});
export type PanelStatus = z.infer<typeof panelStatusSchema>;

export const replayInfoSchema = z.object({
    name: z.string(),
    events: z.number().int(),
    durationMs: z.number().int(),
    recordedAt: z.number().int(),
});
export type ReplayInfo = z.infer<typeof replayInfoSchema>;

export const serverMessageSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("hello"),
        version: z.string(),
        /** Port of the OBS browser-source HTTP server, 0 when disabled. */
        overlayPort: z.number().int(),
        hasSession: z.boolean(),
    }),
    z.object({ type: z.literal("pong"), at: z.number().int() }),

    /** Batched for throughput — a gift storm must not cause one frame per event. */
    z.object({ type: z.literal("events"), events: z.array(chatEventSchema) }),
    z.object({ type: z.literal("status"), status: connectionStatusSchema }),
    z.object({ type: z.literal("stats"), stats: sessionStatsSchema }),

    z.object({ type: z.literal("panelStatus"), status: panelStatusSchema }),
    z.object({ type: z.literal("panelPorts"), ports: z.array(serialPortInfoSchema) }),
    /** Data-URL preview of the current panel frame, for the settings screen. */
    z.object({ type: z.literal("panelPreview"), dataUrl: z.string() }),

    z.object({ type: z.literal("replays"), replays: z.array(replayInfoSchema) }),
    z.object({
        type: z.literal("replayStatus"),
        playing: z.boolean(),
        recording: z.boolean(),
        name: z.string().optional(),
        progress: z.number().min(0).max(1).default(0),
    }),

    z.object({ type: z.literal("obsStatus"), connected: z.boolean(), error: z.string().optional() }),
    z.object({ type: z.literal("obsScenes"), scenes: z.array(z.string()), current: z.string() }),

    z.object({
        type: z.literal("log"),
        level: z.enum(["debug", "info", "warn", "error"]),
        message: z.string(),
        at: z.number().int(),
    }),
    z.object({ type: z.literal("error"), message: z.string(), fatal: z.boolean().default(false) }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

/** Parse an inbound frame, returning `null` rather than throwing on garbage. */
export function parseClientMessage(raw: string): ClientMessage | null {
    try {
        const result = clientMessageSchema.safeParse(JSON.parse(raw));
        return result.success ? result.data : null;
    } catch {
        return null;
    }
}

export function parseServerMessage(raw: string): ServerMessage | null {
    try {
        const result = serverMessageSchema.safeParse(JSON.parse(raw));
        return result.success ? result.data : null;
    } catch {
        return null;
    }
}
