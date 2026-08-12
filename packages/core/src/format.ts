import type { ChatEvent, ChatKind } from "./events.js";

/** Canonical semantic colour token per event kind, shared by every surface. */
export const KIND_TOKENS: Readonly<Record<ChatKind, string>> = {
    chat: "kind-chat",
    gift: "kind-gift",
    follow: "kind-follow",
    join: "kind-join",
    like: "kind-like",
    share: "kind-share",
};

/**
 * Fallback hex per kind, matching the original Android palette. Used where CSS
 * variables are unavailable: the LCD panel renderer and canvas drawing.
 */
export const KIND_HEX: Readonly<Record<ChatKind, string>> = {
    chat: "#62D6FF",
    gift: "#FFB454",
    follow: "#4ADE80",
    join: "#A78BFA",
    like: "#F87171",
    share: "#38BDF8",
};

/** `HH:mm` in the viewer's locale. */
export function formatTime(at: number, locale = "en"): string {
    return new Intl.DateTimeFormat(locale, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).format(at);
}

/** Compact elapsed duration: `4s`, `12m 03s`, `2h 41m`. */
export function formatDuration(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
    if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
    return `${seconds}s`;
}

/** `1.2K`, `34.9M` — used for viewer and like counts. */
export function formatCount(value: number, locale = "en"): string {
    return new Intl.NumberFormat(locale, {
        notation: value >= 10_000 ? "compact" : "standard",
        maximumFractionDigits: 1,
    }).format(value);
}

/**
 * Text a screen reader (and the speech engine) should announce, including the
 * username when requested. Non-chat kinds already carry a rendered summary.
 */
export function spokenText(event: ChatEvent, readUsernames: boolean): string {
    const name = event.user.nickname.trim() || event.user.uniqueId;
    if (!readUsernames) return event.text;
    return event.kind === "chat" ? `${name} says: ${event.text}` : `${name} ${event.text}`;
}

/** First grapheme of a display name, uppercased, for avatar fallbacks. */
export function initialOf(name: string): string {
    const trimmed = name.trim();
    if (trimmed.length === 0) return "?";
    const [first] = Array.from(trimmed);
    return (first ?? "?").toUpperCase();
}
