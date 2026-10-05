import { gameSpecSchema, type GameSpec } from "@tiksee/core";

/** Turn the free-text option/answer box into a clean list (one per line or comma). */
export function splitList(raw: string, max: number): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const part of raw.split(/[\n,;]/)) {
        const item = part.trim();
        const key = item.toLowerCase();
        if (item === "" || seen.has(key)) continue;
        seen.add(key);
        out.push(item);
        if (out.length >= max) break;
    }
    return out;
}

export interface GameDraft {
    kind: GameSpec["kind"];
    question: string;
    list: string;
    keyword: string;
}

/** Validate a draft against the wire schema; null when it cannot start yet. */
export function draftToSpec(draft: GameDraft): GameSpec | null {
    const candidate =
        draft.kind === "poll"
            ? { kind: "poll", question: draft.question, options: splitList(draft.list, 6) }
            : draft.kind === "quiz"
              ? { kind: "quiz", question: draft.question, answers: splitList(draft.list, 10) }
              : { kind: "wheel", keyword: draft.keyword };
    const parsed = gameSpecSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
}

/**
 * Final wheel rotation (degrees, clockwise) that stops segment `winnerIndex`
 * of `count` under the top pointer after `turns` full turns. Segment 0 starts
 * at 12 o'clock and segments run clockwise.
 */
export function wheelRotation(winnerIndex: number, count: number, turns = 6): number {
    const n = Math.max(1, count);
    const seg = 360 / n;
    return turns * 360 - (Math.min(Math.max(0, winnerIndex), n - 1) + 0.5) * seg;
}
