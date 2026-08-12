import {
    KIND_HEX,
    aggregate,
    formatTime,
    initialOf,
    tickerLabel,
    type ChatEvent,
    type ConnectionState,
    type Ticker,
} from "@tiksee/core";
import { createCanvas, loadImage, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";

import { PANEL_HEIGHT, PANEL_WIDTH } from "./turing.js";

const HEADER_H = 84;
const AVATAR = 28;
const PAD = 12;
const MAX_BODY_LINES = 3;

const BG_TOP = "#0B0E14";
const BG_MID = "#161122";
const TEXT_DIM = "#8B93A7";
const TEXT_BODY = "#E4E8F2";

export interface PanelRenderInput {
    events: ChatEvent[];
    state: ConnectionState;
    collapseJoins: boolean;
    collapseLikes: boolean;
    mergeSameUser: boolean;
    showClock: boolean;
    /** Message currently being spoken, highlighted with a pulsing rail. */
    speakingId?: string;
    queued?: number;
    locale?: string;
}

/**
 * Renders the 320×480 panel frame.
 *
 * Ported from the Android `ChatRenderer`, which drew with `android.graphics`.
 * Here it is Skia via `@napi-rs/canvas`, so the drawing primitives map almost
 * one to one and the visual output is intentionally identical.
 */
export class PanelRenderer {
    #canvas: Canvas;
    #ctx: SKRSContext2D;
    /** Decoded avatars keyed by URL; misses render an initial and fill in later. */
    #avatars = new Map<string, unknown>();
    #pending = new Set<string>();

    constructor() {
        this.#canvas = createCanvas(PANEL_WIDTH, PANEL_HEIGHT);
        this.#ctx = this.#canvas.getContext("2d");
    }

    /** RGBA bytes ready for `TuringPanel.display()`. */
    render(input: PanelRenderInput): Uint8ClampedArray {
        const ctx = this.#ctx;
        const locale = input.locale ?? "en";

        this.#background(ctx);
        this.#header(ctx, input, locale);

        const { events, joinTicker, likeTicker } = aggregate(input.events, {
            collapseJoins: input.collapseJoins,
            collapseLikes: input.collapseLikes,
            mergeSameUser: input.mergeSameUser,
        });

        // Tickers pin to the bottom and grow upward, so messages get the rest.
        let bottom = PANEL_HEIGHT - 8;
        if (likeTicker) bottom = this.#ticker(ctx, likeTicker, "liked ❤", bottom);
        if (joinTicker) bottom = this.#ticker(ctx, joinTicker, "joined", bottom);

        if (events.length === 0) {
            ctx.fillStyle = TEXT_DIM;
            ctx.font = "14px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText(emptyLabel(input.state), PANEL_WIDTH / 2, PANEL_HEIGHT / 2);
            ctx.textAlign = "left";
        } else {
            this.#messages(ctx, events, bottom, input, locale);
        }

        return ctx.getImageData(0, 0, PANEL_WIDTH, PANEL_HEIGHT).data;
    }

    /** PNG data URL of the current frame, for the settings-screen preview. */
    toDataUrl(): string {
        return this.#canvas.toDataURL("image/png");
    }

    #background(ctx: SKRSContext2D): void {
        const gradient = ctx.createLinearGradient(0, 0, 0, PANEL_HEIGHT);
        gradient.addColorStop(0, BG_TOP);
        gradient.addColorStop(0.5, BG_MID);
        gradient.addColorStop(1, BG_TOP);
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, PANEL_WIDTH, PANEL_HEIGHT);
    }

    #header(ctx: SKRSContext2D, input: PanelRenderInput, locale: string): void {
        ctx.fillStyle = "#FFFFFF";
        ctx.font = "bold 20px sans-serif";
        ctx.fillText("TIKTOK LIVE", PAD, 34);

        if (input.showClock) {
            ctx.textAlign = "right";
            ctx.font = "bold 17px monospace";
            // Minute resolution on purpose: a ticking seconds field repainted the
            // header every second and collapsed the panel's effective refresh rate.
            ctx.fillText(formatTime(Date.now(), locale), PANEL_WIDTH - PAD, 34);
            ctx.textAlign = "left";
        }

        const { color, label } = statusChrome(input.state);
        ctx.beginPath();
        ctx.arc(PAD + 5, 58, 5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();

        ctx.font = "bold 12px sans-serif";
        ctx.fillStyle = color;
        ctx.fillText(label, PAD + 18, 62);

        if (input.queued && input.queued > 0) {
            ctx.fillStyle = TEXT_DIM;
            ctx.fillText(`QUEUE ${input.queued}`, PAD + 100, 62);
        }

        ctx.fillStyle = "rgba(255,255,255,0.2)";
        ctx.fillRect(0, HEADER_H - 8, PANEL_WIDTH, 1);
    }

    /** Draws a ticker row bottom-anchored; returns the new bottom edge. */
    #ticker(ctx: SKRSContext2D, ticker: Ticker, verb: string, bottom: number): number {
        const height = 22;
        const top = bottom - height;
        const color = KIND_HEX[ticker.kind];

        ctx.fillStyle = withAlpha(color, 0.13);
        roundRect(ctx, PAD, top, PANEL_WIDTH - PAD * 2, height, 10);
        ctx.fill();

        ctx.beginPath();
        ctx.arc(PAD + 12, top + height / 2, 3, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();

        ctx.font = "600 11px sans-serif";
        ctx.fillStyle = color;
        ctx.fillText(
            ellipsise(ctx, tickerLabel(ticker, verb), PANEL_WIDTH - PAD * 2 - 30),
            PAD + 22,
            top + 15,
        );

        return top - 4;
    }

    #messages(
        ctx: SKRSContext2D,
        events: ChatEvent[],
        bottom: number,
        input: PanelRenderInput,
        locale: string,
    ): void {
        const textX = PAD + AVATAR + 12;
        const maxTextW = PANEL_WIDTH - textX - PAD;
        let y = bottom;

        // Newest first, drawn upward, stopping when we hit the header.
        for (let i = events.length - 1; i >= 0; i -= 1) {
            const event = events[i];
            if (!event) continue;

            ctx.font = "12px sans-serif";
            const lines = wrap(ctx, event.text, maxTextW, MAX_BODY_LINES);
            const rowH = Math.max(26 + lines.length * 18, AVATAR + 16);
            const top = y - rowH;
            if (top < HEADER_H) break;

            const color = KIND_HEX[event.kind];
            const speaking = input.speakingId !== undefined && input.speakingId === event.id;

            ctx.fillStyle = speaking ? "rgba(255,255,255,0.31)" : "rgba(255,255,255,0.15)";
            roundRect(ctx, PAD, top, PANEL_WIDTH - PAD * 2, rowH - 4, 10);
            ctx.fill();

            ctx.fillStyle = color;
            roundRect(ctx, PAD, top + 6, speaking ? 5 : 3, rowH - 16, 2);
            ctx.fill();

            this.#avatar(ctx, event, PAD + 8, top + 8, color);

            ctx.font = "bold 14px sans-serif";
            ctx.fillStyle = color;
            ctx.fillText(ellipsise(ctx, event.user.nickname, maxTextW - 44), textX, top + 20);

            ctx.font = "10px sans-serif";
            ctx.fillStyle = TEXT_DIM;
            ctx.textAlign = "right";
            ctx.fillText(formatTime(event.at, locale), PANEL_WIDTH - PAD - 4, top + 20);
            ctx.textAlign = "left";

            ctx.font = "12px sans-serif";
            ctx.fillStyle = TEXT_BODY;
            lines.forEach((line, index) => ctx.fillText(line, textX, top + 38 + index * 18));

            y = top - 6;
        }
    }

    #avatar(ctx: SKRSContext2D, event: ChatEvent, x: number, y: number, color: string): void {
        const url = event.user.avatarUrl;
        const image = url ? this.#avatars.get(url) : undefined;

        ctx.save();
        ctx.beginPath();
        ctx.arc(x + AVATAR / 2, y + AVATAR / 2, AVATAR / 2, 0, Math.PI * 2);
        ctx.clip();

        if (image) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ctx.drawImage(image as any, x, y, AVATAR, AVATAR);
        } else {
            ctx.fillStyle = withAlpha(color, 0.27);
            ctx.fillRect(x, y, AVATAR, AVATAR);
            ctx.fillStyle = color;
            ctx.font = "bold 13px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(initialOf(event.user.nickname), x + AVATAR / 2, y + AVATAR / 2 + 1);
            ctx.textAlign = "left";
            ctx.textBaseline = "alphabetic";
            if (url) void this.#fetchAvatar(url);
        }
        ctx.restore();
    }

    /**
     * Avatars load out-of-band: a miss draws the initial and the image appears on
     * a later frame. Blocking the render on the network would stall the panel.
     */
    async #fetchAvatar(url: string): Promise<void> {
        if (this.#pending.has(url) || this.#avatars.has(url)) return;
        this.#pending.add(url);
        try {
            const image = await loadImage(url);
            // Bounded cache; the panel only ever shows a handful at a time.
            if (this.#avatars.size > 128) {
                const oldest = this.#avatars.keys().next().value;
                if (oldest !== undefined) this.#avatars.delete(oldest);
            }
            this.#avatars.set(url, image);
        } catch {
            // Cache the failure as a null so we don't retry every frame.
            this.#avatars.set(url, null);
        } finally {
            this.#pending.delete(url);
        }
    }
}

function statusChrome(state: ConnectionState): { color: string; label: string } {
    switch (state) {
        case "live":
            return { color: "#4ADE80", label: "LIVE" };
        case "connecting":
            return { color: "#FFB454", label: "CONNECTING…" };
        case "reconnecting":
            return { color: "#FFB454", label: "RECONNECTING…" };
        case "error":
            return { color: "#F87171", label: "ERROR" };
        case "ended":
            return { color: "#8B93A7", label: "ENDED" };
        default:
            return { color: "#78787F", label: "OFFLINE" };
    }
}

function emptyLabel(state: ConnectionState): string {
    if (state === "live") return "Waiting for messages…";
    if (state === "connecting" || state === "reconnecting") return "Connecting…";
    return "Not connected";
}

/** `#RRGGBB` plus an alpha, as `rgba()`. */
function withAlpha(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

function roundRect(
    ctx: SKRSContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
): void {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
}

/** Greedy word wrap, ellipsising the final line when content overflows. */
export function wrap(
    ctx: SKRSContext2D,
    text: string,
    maxWidth: number,
    maxLines: number,
): string[] {
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];

    const lines: string[] = [];
    let current = "";

    for (const word of words) {
        const candidate = current === "" ? word : `${current} ${word}`;
        if (ctx.measureText(candidate).width <= maxWidth) {
            current = candidate;
            continue;
        }
        if (current !== "") lines.push(current);
        current = word;
        if (lines.length === maxLines - 1) break;
    }

    if (lines.length < maxLines && current !== "") lines.push(current);

    const consumed = lines.join(" ").split(/\s+/).filter(Boolean).length;
    if (consumed < words.length) {
        const last = lines.length - 1;
        if (last >= 0) lines[last] = ellipsise(ctx, `${lines[last]}…`, maxWidth);
    }
    return lines;
}

/** Trim to width, appending `…` when the text does not fit. */
export function ellipsise(ctx: SKRSContext2D, text: string, maxWidth: number): string {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let low = 0;
    let high = text.length;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) low = mid;
        else high = mid - 1;
    }
    return `${text.slice(0, low)}…`;
}
