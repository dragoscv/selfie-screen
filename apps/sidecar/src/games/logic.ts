import type { GamePlayer } from "@tiksee/core";

/**
 * Pure chat-game rules (WS20-13): poll vote parsing, quiz answer matching and
 * the giveaway wheel draw. No timers, no I/O — the manager wires these to
 * live chat.
 */

/** Lower-case, strip diacritics and punctuation, collapse whitespace. */
export function normalizeAnswer(text: string): string {
    return text
        .normalize("NFD")
        .replace(/\p{M}+/gu, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}

/**
 * A poll vote is a message that is only an option number (1..optionCount),
 * optionally prefixed by `#` or `!` and followed by punctuation or emoji:
 * "2", "#2", "2!!", " 3 👍". Returns the zero-based option index or null.
 */
export function parseVote(text: string, optionCount: number): number | null {
    const match = /^\s*[#!]?\s*(\d{1,2})(?![\p{L}\p{N}])[^\p{L}\p{N}]*$/u.exec(text);
    if (!match?.[1]) return null;
    const n = Number.parseInt(match[1], 10);
    return n >= 1 && n <= optionCount ? n - 1 : null;
}

/**
 * True when the message answers the quiz. Exact match after normalisation, or
 * — for answers of 3+ characters — the answer appears as whole words inside a
 * longer message ("cred ca e Paris" answers "paris").
 */
export function matchesAnswer(text: string, answers: readonly string[]): boolean {
    const message = normalizeAnswer(text);
    if (message === "") return false;
    const padded = ` ${message} `;
    return answers.some((raw) => {
        const answer = normalizeAnswer(raw);
        if (answer === "") return false;
        if (message === answer) return true;
        return answer.length >= 3 && padded.includes(` ${answer} `);
    });
}

/** True when the chat line contains the wheel keyword as a whole word. */
export function hasKeyword(text: string, keyword: string): boolean {
    const word = normalizeAnswer(keyword);
    if (word === "") return false;
    return ` ${normalizeAnswer(text)} `.includes(` ${word} `);
}

export interface PollTally {
    votes: number[];
    /** uniqueId → option index of their current vote. */
    voters: Map<string, number>;
}

export function newTally(optionCount: number): PollTally {
    return { votes: Array.from({ length: optionCount }, () => 0), voters: new Map() };
}

/** Record a vote; returns true when the tally changed. */
export function castVote(tally: PollTally, uniqueId: string, option: number, allowChange: boolean): boolean {
    if (option < 0 || option >= tally.votes.length || uniqueId === "") return false;
    const previous = tally.voters.get(uniqueId);
    if (previous !== undefined) {
        if (!allowChange || previous === option) return false;
        tally.votes[previous] = Math.max(0, (tally.votes[previous] ?? 0) - 1);
    }
    tally.voters.set(uniqueId, option);
    tally.votes[option] = (tally.votes[option] ?? 0) + 1;
    return true;
}

export const MAX_WHEEL_SEGMENTS = 24;

export interface WheelDraw {
    winner: GamePlayer;
    /** Names drawn on the wheel, at most MAX_WHEEL_SEGMENTS, always including the winner. */
    segments: string[];
    winnerIndex: number;
}

/**
 * Pick a uniformly random winner among all entrants, then build the visible
 * wheel: every entrant when they fit, otherwise a random sample that always
 * includes the winner. `rng` returns [0, 1).
 */
export function drawWheel(entrants: readonly GamePlayer[], rng: () => number = Math.random): WheelDraw | null {
    if (entrants.length === 0) return null;
    const pick = (n: number) => Math.min(n - 1, Math.floor(rng() * n));
    const winnerAt = pick(entrants.length);
    const winner = entrants[winnerAt];
    if (!winner) return null;

    const others = entrants.filter((_, i) => i !== winnerAt);
    // Fisher–Yates on a copy, so the sample is unbiased.
    for (let i = others.length - 1; i > 0; i -= 1) {
        const j = pick(i + 1);
        const tmp = others[i];
        const swap = others[j];
        if (tmp && swap) {
            others[i] = swap;
            others[j] = tmp;
        }
    }
    const shown = others.slice(0, MAX_WHEEL_SEGMENTS - 1);
    const winnerIndex = pick(shown.length + 1);
    shown.splice(winnerIndex, 0, winner);
    return { winner, segments: shown.map((p) => p.nickname || p.uniqueId), winnerIndex };
}
