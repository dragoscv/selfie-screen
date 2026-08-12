import { describe, expect, it } from "vitest";

import { aggregate, tickerLabel } from "./aggregate.js";
import type { ChatEvent, ChatKind } from "./events.js";

let seq = 0;
function ev(kind: ChatKind, nickname: string, text: string, at: number): ChatEvent {
    seq += 1;
    return {
        id: `e${seq}`,
        kind,
        user: { id: nickname, uniqueId: nickname.toLowerCase(), nickname },
        text,
        at,
        streamId: "s1",
    };
}

const ALL_ON = { collapseJoins: true, collapseLikes: true, mergeSameUser: true };
const ALL_OFF = { collapseJoins: false, collapseLikes: false, mergeSameUser: false };

describe("aggregate", () => {
    it("passes events through untouched when everything is disabled", () => {
        const input = [ev("join", "Ana", "joined", 1), ev("chat", "Ana", "hi", 2)];
        const result = aggregate(input, ALL_OFF);
        expect(result.events).toHaveLength(2);
        expect(result.joinTicker).toBeNull();
        expect(result.likeTicker).toBeNull();
    });

    it("collapses joins into a ticker and removes them from the feed", () => {
        const input = [
            ev("join", "Ana", "joined", 1),
            ev("join", "Mihai", "joined", 2),
            ev("chat", "Ion", "hello", 3),
        ];
        const result = aggregate(input, ALL_ON);
        expect(result.events).toHaveLength(1);
        expect(result.events[0]?.kind).toBe("chat");
        expect(result.joinTicker).not.toBeNull();
        expect(result.joinTicker?.total).toBe(2);
    });

    it("counts distinct users, not raw events", () => {
        const input = [
            ev("join", "Ana", "joined", 1),
            ev("join", "Ana", "joined", 2),
            ev("join", "Ana", "joined", 3),
        ];
        const result = aggregate(input, ALL_ON);
        expect(result.joinTicker?.total).toBe(1);
    });

    it("shows the three most recent distinct names, newest first", () => {
        const input = ["A", "B", "C", "D", "E"].map((n, i) => ev("join", n, "joined", i));
        const result = aggregate(input, ALL_ON);
        expect(result.joinTicker?.names).toEqual(["E", "D", "C"]);
        expect(result.joinTicker?.total).toBe(5);
    });

    it("collapses likes independently of joins", () => {
        const input = [ev("like", "Ana", "liked", 1), ev("join", "Mihai", "joined", 2)];
        const result = aggregate(input, {
            collapseJoins: false,
            collapseLikes: true,
            mergeSameUser: false,
        });
        expect(result.likeTicker?.total).toBe(1);
        expect(result.joinTicker).toBeNull();
        expect(result.events).toHaveLength(1);
        expect(result.events[0]?.kind).toBe("join");
    });

    it("merges consecutive chat from the same user inside the window", () => {
        const input = [
            ev("chat", "Ana", "hello", 1000),
            ev("chat", "Ana", "there", 2000),
            ev("chat", "Ana", "friend", 3000),
        ];
        const result = aggregate(input, ALL_ON);
        expect(result.events).toHaveLength(1);
        expect(result.events[0]?.text).toBe("hello · there · friend");
    });

    it("advances the merged row identity to the newest message", () => {
        const first = ev("chat", "Ana", "hello", 1000);
        const second = ev("chat", "Ana", "there", 2000);
        const result = aggregate([first, second], ALL_ON);
        expect(result.events[0]?.at).toBe(2000);
        expect(result.events[0]?.id).toBe(second.id);
    });

    it("does not merge across the time window", () => {
        const input = [ev("chat", "Ana", "hello", 0), ev("chat", "Ana", "later", 40_000)];
        const result = aggregate(input, ALL_ON);
        expect(result.events).toHaveLength(2);
    });

    it("does not merge different users", () => {
        const input = [ev("chat", "Ana", "hello", 1000), ev("chat", "Mihai", "hi", 1500)];
        const result = aggregate(input, ALL_ON);
        expect(result.events).toHaveLength(2);
    });

    it("never merges non-chat kinds", () => {
        const input = [
            ev("gift", "Ana", "sent a Rose", 1000),
            ev("gift", "Ana", "sent a Rose", 1500),
        ];
        const result = aggregate(input, ALL_ON);
        expect(result.events).toHaveLength(2);
    });

    it("truncates merged text to the row limit", () => {
        const long = "x".repeat(200);
        const input = [ev("chat", "Ana", long, 1000), ev("chat", "Ana", long, 1100)];
        const result = aggregate(input, ALL_ON);
        expect(result.events[0]?.text.length).toBe(220);
    });

    it("handles an empty input", () => {
        const result = aggregate([], ALL_ON);
        expect(result.events).toEqual([]);
        expect(result.joinTicker).toBeNull();
    });
});

describe("tickerLabel", () => {
    it("renders two names plus an overflow count", () => {
        const label = tickerLabel({ kind: "join", names: ["Ana", "Mihai", "Ion"], total: 8 }, "joined");
        expect(label).toBe("Ana, Mihai +6 joined");
    });

    it("omits the overflow when everyone is shown", () => {
        const label = tickerLabel({ kind: "join", names: ["Ana", "Mihai"], total: 2 }, "joined");
        expect(label).toBe("Ana, Mihai joined");
    });

    it("falls back to a people count when no names are known", () => {
        const label = tickerLabel({ kind: "like", names: [], total: 3 }, "liked");
        expect(label).toBe("3 people liked");
    });
});
