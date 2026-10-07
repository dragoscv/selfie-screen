import type { SignalEvent, StudioSettings, VisionSettings } from "@tiksee/core";
import { signalFamily } from "@tiksee/core";

import { LANDSCAPE_TITLE_SAFE, PORTRAIT_SAFE_ZONES, type SafeZoneId } from "../../components/studio/geometry.js";

/**
 * Hand gestures must not START while the hand is inside a TikTok safe zone (comments, top
 * bar, likes rail...): resting a hand on the desk under the comments must not fire a rule.
 * A gesture that started outside keeps going if the hand drifts in; the `end` of a start
 * that was blocked is dropped too, so the rule engine never sees an orphan end.
 */

export type GateZones = VisionSettings["gestureZones"];
export type HandZones = Partial<Record<"left" | "right", boolean>>;

const HAND_FAMILIES = new Set(["hand", "twoHands", "motion"]);

/** Is the output-normalised point (u, v) inside one of the enabled zones? */
export function inGateZone(u: number, v: number, orientation: StudioSettings["orientation"], zones: GateZones): boolean {
    if (!zones.enabled) return false;
    if (orientation !== "portrait") {
        if (!zones.zones.title) return false;
        const t = LANDSCAPE_TITLE_SAFE;
        return u < t.x || u > t.x + t.w || v < t.y || v > t.y + t.h;
    }
    return PORTRAIT_SAFE_ZONES.some((z) => zones.zones[z.id as Exclude<SafeZoneId, "title">] && u >= z.x && u <= z.x + z.w && v >= z.y && v <= z.y + z.h);
}

/** Centre of a hand (mean of its landmarks), or null without landmarks. */
export function handCentre(points: readonly { x: number; y: number }[]): { x: number; y: number } | null {
    if (points.length === 0) return null;
    let x = 0;
    let y = 0;
    for (const p of points) {
        x += p.x;
        y += p.y;
    }
    return { x: x / points.length, y: y / points.length };
}

export class ZoneGate {
    readonly #blocked = new Set<string>();

    static #key(e: SignalEvent): string {
        return `${e.signal}|${e.hand ?? "-"}|${e.subject.track}`;
    }

    /** True when this hand-gesture start would begin inside a zone. */
    static blocks(e: SignalEvent, hands: HandZones): boolean {
        if (!e.subject.owner || !HAND_FAMILIES.has(signalFamily(e.signal))) return false;
        // One-hand signals: that hand; two-hand / unattributed: either hand in a zone blocks.
        return e.hand ? hands[e.hand] === true : hands.left === true || hands.right === true;
    }

    /** Drop blocked starts/pulses and the ends that belong to them. */
    filter(events: readonly SignalEvent[], hands: HandZones, on: boolean): SignalEvent[] {
        if (!on && this.#blocked.size === 0) return events as SignalEvent[];
        const out: SignalEvent[] = [];
        for (const e of events) {
            const key = ZoneGate.#key(e);
            if (e.phase === "end") {
                if (this.#blocked.delete(key)) continue;
            } else if (on && ZoneGate.blocks(e, hands)) {
                if (e.phase === "start") this.#blocked.add(key);
                continue;
            }
            out.push(e);
        }
        return out;
    }
}
