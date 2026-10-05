import { eventDiamonds, type ChatEvent, type EffectFired, type EffectsSettings } from "@tiksee/core";

import type { Result } from "../result.js";
import type { FlashArgs, SceneArgs, VmuiCallOk } from "./vmui.js";

/** What the router decided to fire, before any network call. */
export type EffectPlan =
    | { kind: "flash"; label: string; by: string; args: FlashArgs }
    | { kind: "scene"; label: string; by: string; args: SceneArgs };

export interface EffectsBackend {
    sceneSet(args: SceneArgs): Promise<Result<VmuiCallOk, string>>;
    flashColor(args: FlashArgs): Promise<Result<VmuiCallOk, string>>;
}

const COMMAND = /^!\s*([a-z_]+)\b/i;

/** Highest tier whose threshold the gift's total value reaches. */
export function pickGiftTier(tiers: EffectsSettings["giftTiers"], diamonds: number): EffectsSettings["giftTiers"][number] | null {
    let best: EffectsSettings["giftTiers"][number] | null = null;
    for (const tier of tiers) {
        if (tier.minDiamonds <= diamonds && (!best || tier.minDiamonds > best.minDiamonds)) best = tier;
    }
    return best;
}

/**
 * Pure planning: turns a chat event into at most one effect, honouring the
 * allow-lists and both cooldowns. Gifts bypass the chat cooldowns (they are
 * paid) but are still idempotent on the event id.
 */
export class EffectPlanner {
    #settings: EffectsSettings;
    #lastByUser = new Map<string, number>();
    #lastGlobal = Number.NEGATIVE_INFINITY;

    constructor(settings: EffectsSettings) {
        this.#settings = settings;
    }

    setSettings(settings: EffectsSettings): void {
        this.#settings = settings;
    }

    plan(event: ChatEvent, now: number): EffectPlan | null {
        if (!this.#settings.enabled) return null;
        if (event.kind === "gift") return this.#gift(event);
        if (event.kind === "chat" && this.#settings.chatCommands) return this.#command(event, now);
        return null;
    }

    #gift(event: ChatEvent): EffectPlan | null {
        const tier = pickGiftTier(this.#settings.giftTiers, eventDiamonds(event));
        if (!tier) return null;
        return {
            kind: "scene",
            label: tier.scene,
            by: `gift:${event.giftName ?? "gift"}`,
            args: { scene: tier.scene, durationSec: tier.durationSec, idempotencyKey: event.id },
        };
    }

    #command(event: ChatEvent, now: number): EffectPlan | null {
        const match = COMMAND.exec(event.text.trim());
        const word = match?.[1]?.toLowerCase();
        if (!word) return null;
        const colors: readonly string[] = this.#settings.allowedColors;
        const scenes: readonly string[] = this.#settings.allowedChatScenes;
        const isColor = colors.includes(word);
        const isScene = !isColor && scenes.includes(word);
        if (!isColor && !isScene) return null;

        const user = event.user.uniqueId.toLowerCase();
        const lastUser = this.#lastByUser.get(user);
        if (lastUser !== undefined && now - lastUser < this.#settings.perUserCooldownSec * 1000) return null;
        if (now - this.#lastGlobal < this.#settings.globalCooldownSec * 1000) return null;
        this.#lastByUser.set(user, now);
        this.#lastGlobal = now;
        if (this.#lastByUser.size > 5000) {
            const horizon = now - this.#settings.perUserCooldownSec * 1000;
            for (const [k, at] of this.#lastByUser) if (at < horizon) this.#lastByUser.delete(k);
        }

        const by = `@${event.user.uniqueId}`;
        return isColor
            ? { kind: "flash", label: word, by, args: { color: word, count: 2, durationMs: 500, idempotencyKey: event.id } }
            : { kind: "scene", label: word, by, args: { scene: word, durationSec: 10, idempotencyKey: event.id } };
    }
}

/** Execute a plan against vmui and describe the outcome for the UI log. */
export async function fire(backend: EffectsBackend, plan: EffectPlan, at: number): Promise<EffectFired> {
    const result = plan.kind === "flash" ? await backend.flashColor(plan.args) : await backend.sceneSet(plan.args);
    const id = plan.args.idempotencyKey ?? `fx-${at.toString(36)}`;
    if (result.ok) return { id, kind: plan.kind, label: plan.label, by: plan.by, at, limited: result.value.limited };
    return { id, kind: plan.kind, label: plan.label, by: plan.by, at, limited: false, error: result.error };
}

/** A manual test from settings: `effectTest {kind, value}`. */
export function testPlan(kind: "flash" | "scene", value: string, at: number): EffectPlan {
    const idempotencyKey = `test-${at.toString(36)}`;
    return kind === "flash"
        ? { kind, label: value, by: "manual", args: { color: value, count: 2, durationMs: 500, idempotencyKey } }
        : { kind, label: value, by: "manual", args: { scene: value, durationSec: 10, idempotencyKey } };
}
