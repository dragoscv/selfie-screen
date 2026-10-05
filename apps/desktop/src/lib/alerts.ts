import { compileWordList, eventDiamonds, normaliseForMatch, type ChatEvent, type Settings } from "@tiksee/core";

/**
 * Renderer-side alerts: a short chime and a Windows notification for big
 * gifts, follows and alert keywords. The sidecar handles the OBS side of the
 * same events; this is the streamer-facing half.
 */

export type AlertReason = "gift" | "follow" | "keyword";

let cachedWords: readonly string[] | null = null;
let cachedRe: RegExp | null = null;

function keywordRe(words: readonly string[]): RegExp | null {
    if (words !== cachedWords) {
        cachedWords = words;
        cachedRe = compileWordList(words);
    }
    return cachedRe;
}

export function alertReason(event: ChatEvent, settings: Settings): AlertReason | null {
    const a = settings.alerts;
    if (event.replay) return null;
    if (event.kind === "gift" && a.notifyOnGift && eventDiamonds(event) >= a.giftDiamondThreshold) return "gift";
    if (event.kind === "follow" && a.notifyOnFollow) return "follow";
    if (event.kind === "chat" && a.notifyOnKeyword) {
        const re = keywordRe(settings.safety.alertKeywords);
        if (re?.test(normaliseForMatch(event.text))) return "keyword";
    }
    return null;
}

let chimeCtx: AudioContext | null = null;

/** Two-note chime; no asset needed, honours the alert volume. */
export function playChime(volume: number): void {
    if (volume <= 0) return;
    chimeCtx ??= new AudioContext();
    const ctx = chimeCtx;
    void ctx.resume().catch(() => undefined);
    const now = ctx.currentTime;
    for (const [i, freq] of [880, 1318.5].entries()) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        const start = now + i * 0.11;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.25 * volume, start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.4);
    }
}
