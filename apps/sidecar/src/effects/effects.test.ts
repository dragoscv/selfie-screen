import { effectsSchema, nextEventId, type ChatEvent, type ChatKind } from "@tiksee/core";
import { describe, expect, it, vi } from "vitest";

import { EffectPlanner, fire, pickGiftTier } from "./router.js";
import { VmuiClient } from "./vmui.js";

function ev(kind: ChatKind, user: string, text: string, extra: Partial<ChatEvent> = {}): ChatEvent {
    return { id: nextEventId(), kind, user: { id: user, uniqueId: user, nickname: user }, text, at: 0, streamId: "main", ...extra };
}

const settings = effectsSchema.parse({ enabled: true, allowedColors: ["red", "blue"], allowedChatScenes: ["party"] });

describe("pickGiftTier", () => {
    it("picks the highest tier whose threshold is reached", () => {
        expect(pickGiftTier(settings.giftTiers, 0)).toBeNull();
        expect(pickGiftTier(settings.giftTiers, 1)?.scene).toBe("gift_gold");
        expect(pickGiftTier(settings.giftTiers, 99)?.scene).toBe("party");
        expect(pickGiftTier(settings.giftTiers, 5000)?.scene).toBe("rainbow");
    });
});

describe("EffectPlanner", () => {
    it("is off when effects are disabled", () => {
        const planner = new EffectPlanner(effectsSchema.parse({ enabled: false }));
        expect(planner.plan(ev("chat", "ana", "!red"), 0)).toBeNull();
    });

    it("only allows whitelisted colours and scenes", () => {
        const planner = new EffectPlanner(settings);
        expect(planner.plan(ev("chat", "a", "!green"), 0)).toBeNull();
        expect(planner.plan(ev("chat", "b", "!rainbow"), 10_000)).toBeNull();
        expect(planner.plan(ev("chat", "c", "!RED pls"), 20_000)).toMatchObject({ kind: "flash", label: "red", by: "@c" });
        expect(planner.plan(ev("chat", "d", "!party"), 30_000)).toMatchObject({ kind: "scene", label: "party" });
        expect(planner.plan(ev("chat", "e", "red"), 40_000)).toBeNull();
    });

    it("enforces the global and per-user cooldowns", () => {
        const planner = new EffectPlanner(settings);
        expect(planner.plan(ev("chat", "ana", "!red"), 0)).not.toBeNull();
        // Global 3 s.
        expect(planner.plan(ev("chat", "ion", "!blue"), 2_999)).toBeNull();
        expect(planner.plan(ev("chat", "ion", "!blue"), 3_000)).not.toBeNull();
        // Per-user 60 s.
        expect(planner.plan(ev("chat", "ana", "!red"), 30_000)).toBeNull();
        expect(planner.plan(ev("chat", "ana", "!red"), 60_000)).not.toBeNull();
    });

    it("maps gifts to tiers keyed on the event id, bypassing chat cooldowns", () => {
        const planner = new EffectPlanner(settings);
        planner.plan(ev("chat", "ana", "!red"), 0);
        const gift = ev("gift", "ana", "sent Rose", { giftName: "Rose", giftDiamonds: 50, giftCount: 2 });
        expect(planner.plan(gift, 1)).toEqual({
            kind: "scene",
            label: "party",
            by: "gift:Rose",
            args: { scene: "party", durationSec: 20, idempotencyKey: gift.id },
        });
    });
});

describe("VmuiClient + fire", () => {
    function rpc(text: unknown, isError = false): Response {
        return Response.json({ jsonrpc: "2.0", id: 1, result: { isError, content: [{ type: "text", text: JSON.stringify(text) }] } });
    }

    it("posts tools/call with the bearer key and treats limited as success", async () => {
        const fetchImpl = vi.fn(async () => rpc({ ok: true, limited: true, retryAfterMs: 900, queued: true }));
        const client = new VmuiClient({ baseUrl: () => "http://vmui:3737/", apiKey: async () => "vmui_k", fetch: fetchImpl });
        const fired = await fire(client, { kind: "flash", label: "red", by: "@a", args: { color: "red", count: 2, durationMs: 500, idempotencyKey: "e1" } }, 5);
        expect(fired).toEqual({ id: "e1", kind: "flash", label: "red", by: "@a", at: 5, limited: true });
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe("http://vmui:3737/api/mcp");
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer vmui_k");
        expect(JSON.parse(String(init.body))).toMatchObject({
            method: "tools/call",
            params: { name: "flash_color", arguments: { color: "red", idempotencyKey: "e1" } },
        });
    });

    it("reports tool errors, HTTP errors, network failures and a missing key", async () => {
        const make = (impl: typeof fetch, key: string | null = "k") => new VmuiClient({ baseUrl: () => "http://v", apiKey: async () => key, fetch: impl });
        expect(await make(async () => rpc({ ok: false, error: "HA down" }, true)).sceneSet({ scene: "party" })).toEqual({ ok: false, error: "HA down" });
        expect(await make(async () => new Response("", { status: 401 })).sceneSet({ scene: "party" })).toEqual({ ok: false, error: "vmui HTTP 401" });
        const net = await make(async () => Promise.reject(new TypeError("ECONNREFUSED"))).sceneSet({ scene: "party" });
        expect(net.ok).toBe(false);
        const fetchImpl = vi.fn(async () => rpc({ ok: true }));
        expect((await make(fetchImpl, null).sceneSet({ scene: "party" })).ok).toBe(false);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
