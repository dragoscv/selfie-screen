import { fold, mentionsPet, similarity } from "./text.js";

/**
 * Who is the streamer talking to: the pets or the chat? Pure, deterministic
 * rules over one final transcript segment (no model call, it runs on every
 * sentence). Pet signals: a species name / nickname (vocatives included), or a
 * second-person / question follow-up while a pet is the conversation partner.
 * Chat signals: a recent viewer's name, words addressed to the audience, a chat
 * comment read aloud, "X zice / X întreabă". Tie-breaks: an explicit pet name
 * beats chat cues; a viewer's name beats a generic second person.
 */

export type AddressTarget = "pet" | "chat" | "unknown";

export interface AddressResult {
    target: AddressTarget;
    /** Addressed pets (target "pet" only). */
    pets: string[];
    /** 0..1 */
    confidence: number;
    /** Short code-written explanation, for logs. */
    why: string;
}

export interface AddressPartner {
    pet: string;
    at: number;
    /** The partner just said a line (vs. was only addressed). */
    spoke: boolean;
}

export interface AddressContext {
    /** Pet ids on stage. */
    pets: readonly string[];
    /** Extra names per pet id (settings.studio.petAi.nicknames). */
    nicknames?: Readonly<Record<string, readonly string[]>>;
    /** Viewer nicknames / uniqueIds seen in the chat recently (~2 min). */
    chatUsers: readonly string[];
    /** Chat messages from the last ~60 s. */
    chatMessages: readonly string[];
    /** The last pet that spoke or was addressed, when any. */
    partner?: AddressPartner | null;
    now: number;
}

/** A conversation partner stays "current" this long. */
export const PARTNER_TTL_MS = 20_000;
/** A transcript this similar to a recent chat message is a comment read aloud. */
export const READ_ALOUD_SIMILARITY = 0.5;

const CHAT_WORDS =
    /\b(chat(ul|ului)?|voi|voua|va (rog|multumesc|salut|iubesc|place|plac)|baieti(lor)?|fetelor|fete|lume|oameni(lor)?|cine|toti|tuturor|guys|everyone|everybody|folks|y ?all|you all|people)\b/;
const CHAT_PHRASES =
    /\b(multumesc|mersi|multumim|thanks|thank you)( mult| frumos)? (pentru|for( the)?) (follow|like|likes|cadou|cadoul|gift|gifts|trandafir|rose|share)\b|\bbine ati venit\b|\bwelcome( back)?\b/;
const READ_VERBS = /\b([a-z0-9_]{2,}) (zice|spune|intreaba|scrie|says|asks|writes|said|asked)\b/;
/** Words before "zice/spune" that are not a viewer's name ("hai spune", "îmi spune"). */
const NOT_A_NAME: ReadonlySet<string> = new Set(["hai", "tu", "imi", "iti", "mi", "ti", "ce", "nu", "si", "mai", "ne", "le", "ii", "ea", "el", "cine", "care", "he", "she", "it", "who", "what", "that", "this", "you"]);
const SECOND_PERSON =
    /\b(tu|te|ti|iti|esti|vrei|ai|poti|spune|spune mi|zi|hai|ce faci|cum esti|cum te simti|you|your|are you|do you|tell me|what do you)\b/;
const QUESTION_START = /^(ce|cum|cine|unde|cand|de ce|cat|care|oare|what|how|who|where|why|when|do|does|are|is|can)\b/;
const GREETING = /^(hey|hei|hi|hello|salut|buna|ce faci|yo|ia zi)\b/;
/** Romanian vocative endings on a name: papagalule, vulpito, mitico. */
const VOCATIVE = /(ule|ito|ico|o)$/;

const tokensOf = (folded: string): string[] => folded.split(" ").filter((t) => t !== "");

const normalise = (text: string): string =>
    fold(text)
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

/** A name (nickname/viewer) occurs as whole words in `padded` (" text "). */
function hasName(padded: string, name: string): boolean {
    const n = normalise(name);
    return n.length >= 3 && padded.includes(` ${n} `);
}

/** A vocative token built on a name: "Mițo" for nickname "Miți", "Bubule" for "Bubu". */
function vocativeOf(tokens: readonly string[], name: string): boolean {
    const n = normalise(name);
    if (n.length < 3 || n.includes(" ")) return false;
    const stem = n.slice(0, Math.max(3, n.length - 1));
    return tokens.some((t) => t !== n && t.length >= 4 && t.startsWith(stem) && VOCATIVE.test(t));
}

/** Classify one streamer sentence. */
export function classifyAddress(text: string, ctx: AddressContext): AddressResult {
    const folded = normalise(text);
    const padded = ` ${folded} `;
    const tokens = tokensOf(folded);
    const none: AddressResult = { target: "unknown", pets: [], confidence: 0, why: "no cue" };
    if (tokens.length === 0) return none;

    // Pet names (species stems incl. inflections and vocatives) and the streamer's nicknames.
    const named: string[] = [];
    let vocative = false;
    for (const pet of ctx.pets) {
        const nicks = ctx.nicknames?.[pet] ?? [];
        const byNick = nicks.some((n) => hasName(padded, n));
        const byVocative = nicks.some((n) => vocativeOf(tokens, n));
        const bySpecies = mentionsPet(text, [pet]);
        if (byNick || byVocative || bySpecies) named.push(pet);
        if (byVocative || (bySpecies && tokens.some((t) => t.length >= 5 && VOCATIVE.test(t) && mentionsPet(t, [pet])))) vocative = true;
    }
    const petNames = new Set(
        ctx.pets.flatMap((p) => [p, ...(ctx.nicknames?.[p] ?? [])]).map((n) => normalise(n)),
    );

    // Chat cues.
    const viewer = ctx.chatUsers.find((u) => !petNames.has(normalise(u)) && hasName(padded, u));
    const readAloud = ctx.chatMessages.some((m) => similarity(m, text) >= READ_ALOUD_SIMILARITY);
    const quoted = READ_VERBS.exec(folded)?.[1];
    const readVerb = quoted !== undefined && !NOT_A_NAME.has(quoted);
    const chatWords = CHAT_WORDS.test(folded) || CHAT_PHRASES.test(folded);
    const chatCue = viewer !== undefined || readAloud || readVerb || chatWords;

    if (named.length > 0) {
        const greeted = GREETING.test(folded) || folded.startsWith(normalise(named[0] ?? ""));
        const confidence = vocative ? 0.95 : chatCue ? 0.75 : greeted ? 0.92 : 0.85;
        return { target: "pet", pets: named, confidence, why: vocative ? "vocative" : chatCue ? "name+chat cue" : "name" };
    }
    if (viewer !== undefined) return { target: "chat", pets: [], confidence: 0.85, why: "viewer name" };
    if (readAloud) return { target: "chat", pets: [], confidence: 0.8, why: "comment read aloud" };
    if (readVerb) return { target: "chat", pets: [], confidence: 0.75, why: "quoting a viewer" };
    if (chatWords) return { target: "chat", pets: [], confidence: 0.75, why: "audience words" };

    const partner = ctx.partner;
    if (partner && ctx.pets.includes(partner.pet) && ctx.now - partner.at <= PARTNER_TTL_MS) {
        const second = SECOND_PERSON.test(folded);
        const question = text.trim().endsWith("?") || QUESTION_START.test(folded);
        if (second && question) return { target: "pet", pets: [partner.pet], confidence: 0.82, why: "follow-up question" };
        if (second) return { target: "pet", pets: [partner.pet], confidence: 0.75, why: "follow-up" };
        if (question && partner.spoke) return { target: "pet", pets: [partner.pet], confidence: 0.7, why: "question after pet line" };
    }
    return none;
}
