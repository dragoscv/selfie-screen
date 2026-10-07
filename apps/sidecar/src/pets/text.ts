import { normaliseForMatch } from "@tiksee/core";

import { speakable } from "../cohost/templates.js";

/**
 * Text safety helpers for the pet agents. Viewer text is untrusted DATA: it is
 * cleaned before it reaches a prompt, and everything a model writes is cleaned
 * again before it reaches the stream or a pet's memory.
 */

export const MAX_LINE_CHARS = 110;
export const MAX_MEMORY_CHARS = 160;

/**
 * Spoken name STEMS (EN + RO, no diacritics) that count as a mention of a pet. Matching is a
 * word-start prefix, so Romanian inflections and vocatives match too ("Vulpițo" -> vulpito,
 * "papagalule", "bufnițo", "pisicuțo"); live 2026-10-07: whole names missed the vocative.
 */
const PET_NAMES: Readonly<Record<string, readonly string[]>> = {
    parrot: ["parrot", "papagal"],
    cat: ["cat", "kitty", "pisic", "motan"],
    dragon: ["dragon"],
    drone: ["drone", "dron"],
    fox: ["fox", "vulp"],
    owl: ["owl", "bufnit"],
    redpanda: ["red panda", "redpanda", "panda"],
};

const fold = (text: string): string => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** The text names one of `pets` (species names, RO + EN). */
export function mentionsPet(text: string, pets: readonly string[]): boolean {
    const folded = ` ${fold(text).replace(/[^a-z0-9 ]+/g, " ")} `;
    // Stems of 4+ letters match a word start (inflections); short names must be whole words
    // ("cat" must not match the Romanian "catre").
    const hit = (name: string): boolean => folded.includes(name.length >= 4 ? ` ${name}` : ` ${name} `);
    return pets.some((pet) => (PET_NAMES[pet.split(/[-:#]/)[0] ?? pet] ?? [pet]).some(hit));
}

/** One untrusted string for a prompt: no control chars, URLs or @handles; truncated. */
export function sanitiseUntrusted(text: string, max: number): string {
    const cleaned = text
        .replace(/[\p{Cc}\p{Cf}]/gu, " ")
        .replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
        .replace(/\S+\.(?:com|ro|net|org|io|ly|gg|tv|me)(?:\/\S*)?\b/gi, " ")
        .replace(/@[\p{L}\p{N}_.]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
    return Array.from(cleaned).slice(0, max).join("");
}

/** Bubble time on screen for a line. */
export function ttlForText(text: string): number {
    return Math.min(7000, Math.max(2500, 1500 + 60 * Array.from(text).length));
}

/** Crude language hint from recent chat/speech: "en" only when English clearly dominates. */
export function guessLanguage(lines: readonly string[]): "ro" | "en" {
    let en = 0;
    let ro = 0;
    for (const line of lines) {
        const l = ` ${normaliseForMatch(line)} `;
        if (/[ăâîșşțţ]/i.test(line) || / (si|ce|esti|sunt|salut|buna|frumos|multumesc|e|nu|da|cum) /.test(l)) ro += 1;
        else if (/ (the|you|is|are|what|hello|hi|love|this|so|cute|thanks) /.test(l)) en += 1;
    }
    return en >= 3 && en > ro * 2 ? "en" : "ro";
}

/** A model-written line made safe to show/speak/store, or null when it must be dropped. */
export function cleanLine(raw: string, blocked: RegExp | null, max = MAX_LINE_CHARS): string | null {
    if (/https?|www\.|\bhttp\b/i.test(raw)) return null;
    let text = speakable(raw.replace(/@[\p{L}\p{N}_.]+/gu, " ").replace(/[#*_`"]/g, " "))
        .replace(/\s+/g, " ")
        .trim();
    if (text === "") return null;
    if (/\.(com|ro|net|org|io)\b/i.test(text)) return null;
    const chars = Array.from(text);
    if (chars.length > max) {
        const cut = chars.slice(0, max).join("");
        const space = cut.lastIndexOf(" ");
        text = (space > max / 2 ? cut.slice(0, space) : cut).replace(/[,;:\s]+$/, "");
    }
    if (blocked?.test(normaliseForMatch(text))) return null;
    return text;
}

const words = (text: string): Set<string> => new Set(fold(text).split(/[^a-z0-9]+/).filter((w) => w.length > 2));

/** Word-set Jaccard similarity 0..1 (anti-echo between pets). */
export function similarity(a: string, b: string): number {
    const wa = words(a);
    const wb = words(b);
    if (wa.size === 0 || wb.size === 0) return 0;
    let both = 0;
    for (const w of wa) if (wb.has(w)) both += 1;
    return both / (wa.size + wb.size - both);
}

/** First JSON object in a model reply, or null. */
export function extractJson(raw: string): unknown {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
        return JSON.parse(raw.slice(start, end + 1));
    } catch {
        return null;
    }
}
