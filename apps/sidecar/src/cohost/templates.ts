import { eventDiamonds, spokenText, type ChatEvent, type VoiceSettings } from "@tiksee/core";

/**
 * Low-cost spoken lines that never touch an LLM. Romanian is the default;
 * English only when the streamer explicitly set the speech language to `en`.
 */

/** Emoji and pictographs read terribly through TTS ("red heart red heart"). */
export function speakable(text: string): string {
    return text
        .replace(/https?:\/\/\S+/g, "")
        .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
        .replace(/[×]/g, "x")
        .replace(/\s+/g, " ")
        .trim();
}

function displayName(event: ChatEvent): string {
    return speakable(event.user.nickname.trim() || event.user.uniqueId) || "Cineva";
}

export function thanksLine(event: ChatEvent): string {
    const name = displayName(event);
    const gift = speakable(event.giftName ?? "") || "cadou";
    const count = event.giftCount ?? 1;
    return count > 1 ? `Mulțumim mult, ${name}, pentru cele ${count} ${gift}!` : `Mulțumim mult, ${name}, pentru ${gift}!`;
}

export function greetingLine(nickname: string, visits: number): string {
    const name = speakable(nickname) || "prietene";
    return visits >= 5 ? `Bine ai revenit, ${name}! Ne bucurăm mereu să te vedem.` : `Bine ai revenit, ${name}!`;
}

/** Suggestion text shown on the viewer card (not necessarily spoken). */
export function greetingSuggestion(nickname: string, visits: number, facts: readonly string[]): string {
    const base = `Salut din nou, ${nickname}! E a ${visits}-a vizită.`;
    const fact = facts[0];
    return fact ? `${base} Știi despre el/ea: ${fact}` : base;
}

/** Whether the read-aloud filters let this event through. */
export function passesReadFilters(event: ChatEvent, voice: VoiceSettings): boolean {
    const filters = voice.filters;
    switch (event.kind) {
        case "chat":
            return filters.chat;
        case "gift":
            return filters.gifts && eventDiamonds(event) >= voice.minGiftValueToRead;
        case "follow":
            return filters.follows;
        case "join":
            return filters.joins;
        case "like":
            return filters.likes;
        case "share":
            return filters.shares;
    }
}

/** Text to read aloud for an event (WS18-01). */
export function readAloudLine(event: ChatEvent, voice: VoiceSettings): string {
    if (voice.language === "en") return speakable(spokenText(event, voice.readUsernames));
    const name = displayName(event);
    const text = speakable(event.text);
    switch (event.kind) {
        case "chat":
            return voice.readUsernames ? `${name} zice: ${text}` : text;
        case "gift": {
            const count = event.giftCount ?? 1;
            const gift = speakable(event.giftName ?? "") || "un cadou";
            const who = voice.readUsernames ? name : "Cineva";
            return count > 1 ? `${who} a trimis ${count} ${gift}` : `${who} a trimis ${gift}`;
        }
        case "follow":
            return `${voice.readUsernames ? name : "Cineva"} te urmărește acum`;
        case "join":
            return `${voice.readUsernames ? name : "Cineva"} a intrat`;
        case "like":
            return `${voice.readUsernames ? name : "Cineva"} a dat like`;
        case "share":
            return `${voice.readUsernames ? name : "Cineva"} a distribuit liveul`;
    }
}
