import type { ChatEvent, ChatKind } from "./events.js";

/**
 * A summary row standing in for many collapsed events of one kind, e.g.
 * `"Ana, Mihai +6 joined"`. Ported from the Android `ChatAggregator.Ticker`.
 */
export interface Ticker {
    kind: ChatKind;
    /** Up to three most recent distinct names, newest first. */
    names: string[];
    /** Number of DISTINCT users, not raw event count. */
    total: number;
}

export interface AggregateResult {
    events: ChatEvent[];
    joinTicker: Ticker | null;
    likeTicker: Ticker | null;
}

export interface AggregateOptions {
    collapseJoins: boolean;
    collapseLikes: boolean;
    mergeSameUser: boolean;
    /** Consecutive messages closer than this merge into one row. */
    mergeWindowMs?: number;
}

const DEFAULT_MERGE_WINDOW_MS = 30_000;
const MERGED_TEXT_LIMIT = 220;

/** `"Ana, Mihai +6 joined"`, or `"8 people joined"` when names are unknown. */
export function tickerLabel(ticker: Ticker, verb: string): string {
    // With no names at all the count IS the subject, so there is no overflow to
    // append — otherwise this reads "3 people +3 liked".
    if (ticker.names.length === 0) return `${ticker.total} people ${verb}`;
    const shown = ticker.names.slice(0, 2).join(", ");
    const extra = ticker.total - Math.min(ticker.names.length, 2);
    return extra > 0 ? `${shown} +${extra} ${verb}` : `${shown} ${verb}`;
}

/**
 * Collapse repetitive joins/likes into tickers and optionally fold a viewer's
 * rapid consecutive chat messages into a single row.
 *
 * Pure — no clock, no I/O — so it is trivially testable and identical on the
 * desktop feed, the overlay, the OBS source and the LCD panel.
 */
export function aggregate(input: ChatEvent[], options: AggregateOptions): AggregateResult {
    const { collapseJoins, collapseLikes, mergeSameUser } = options;
    const mergeWindowMs = options.mergeWindowMs ?? DEFAULT_MERGE_WINDOW_MS;

    const kept: ChatEvent[] = [];
    // Insertion-ordered distinct names, matching Kotlin's LinkedHashSet.
    const joinNames = new Set<string>();
    const likeNames = new Set<string>();
    let sawJoin = false;
    let sawLike = false;

    for (const event of input) {
        if (collapseJoins && event.kind === "join") {
            joinNames.add(event.user.nickname);
            sawJoin = true;
        } else if (collapseLikes && event.kind === "like") {
            likeNames.add(event.user.nickname);
            sawLike = true;
        } else {
            kept.push(event);
        }
    }

    const events = mergeSameUser ? mergeConsecutive(kept, mergeWindowMs) : kept;

    return {
        events,
        joinTicker: sawJoin ? buildTicker("join", joinNames) : null,
        likeTicker: sawLike ? buildTicker("like", likeNames) : null,
    };
}

function buildTicker(kind: ChatKind, names: Set<string>): Ticker {
    const all = [...names];
    return {
        kind,
        // Last three distinct users, newest first.
        names: all.slice(-3).reverse(),
        total: all.length,
    };
}

/**
 * Fold consecutive CHAT messages from the same user inside the merge window
 * into one row joined by `·`. Non-chat kinds never merge — a viewer sending
 * three gifts should read as three gifts.
 */
function mergeConsecutive(list: ChatEvent[], windowMs: number): ChatEvent[] {
    if (list.length < 2) return list;

    const out: ChatEvent[] = [];
    for (const event of list) {
        const prev = out[out.length - 1];
        const mergeable =
            prev !== undefined &&
            event.kind === "chat" &&
            prev.kind === "chat" &&
            prev.user.uniqueId === event.user.uniqueId &&
            event.at - prev.at < windowMs;

        if (mergeable) {
            out[out.length - 1] = {
                ...prev,
                text: `${prev.text} · ${event.text}`.slice(0, MERGED_TEXT_LIMIT),
                // Advance identity to the newest message so speech-highlight tracking
                // follows the row the viewer is actually looking at.
                at: event.at,
                id: event.id,
            };
        } else {
            out.push(event);
        }
    }
    return out;
}
