import type { IdentityProfile, RuleAction } from "@tiksee/core";

import type { EnrolSample } from "../../lib/studio/controller.js";

export type RadialAction = "af" | "photo" | "hearts" | "confetti" | "zoomIn" | "zoomOut" | "cleanFeed" | "arAdd";

export interface EnrolRequest {
    profileId: string;
    kind: "owner" | "person" | "dog";
}

const MAX_EMBEDDINGS = 40;

/** Merge new embeddings into the profile, keeping the newest 40. */
export function mergeEmbeddings(profile: IdentityProfile, samples: readonly EnrolSample[], now = Date.now()): IdentityProfile {
    return { ...profile, embeddings: [...profile.embeddings, ...samples.map((s) => s.embedding)].slice(-MAX_EMBEDDINGS), updatedAt: now };
}

/** The engine action for a radial item (photo and AR add are handled by the caller). */
export function radialToAction(id: RadialAction): RuleAction | null {
    switch (id) {
        case "af":
            return { type: "camera", action: "af" };
        case "hearts":
            return { type: "effect", effect: "hearts" };
        case "confetti":
            return { type: "effect", effect: "confetti" };
        case "zoomIn":
            return { type: "studio", action: "digitalZoomIn" };
        case "zoomOut":
            return { type: "studio", action: "digitalZoomOut" };
        case "cleanFeed":
            return { type: "studio", action: "cleanFeedToggle" };
        default:
            return null;
    }
}

/**
 * Batches signal edges for the sidecar (≤ 10 Hz) and reports arming changes once.
 * Pure: the caller owns the timer and the transport.
 */
export class SignalBatcher<E> {
    #pending: E[] = [];
    #armed: boolean | null = null;

    push(events: readonly E[], armed: boolean): { armChanged: boolean } {
        for (const e of events) this.#pending.push(e);
        if (this.#pending.length > 200) this.#pending.splice(0, this.#pending.length - 200);
        const armChanged = armed !== this.#armed;
        this.#armed = armed;
        return { armChanged };
    }

    drain(): E[] {
        const out = this.#pending;
        this.#pending = [];
        return out;
    }
}
