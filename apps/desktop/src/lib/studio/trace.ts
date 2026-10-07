import { HAND_GESTURES, type VisionSettings } from "@tiksee/core";
import { project, type BodySnapshot, type PetDebug, type Pinhole } from "@tiksee/pets";
import { gestureOverrides } from "@tiksee/vision";

import type { DebugHand } from "./controller.js";

/**
 * Dev telemetry for the pets + hands: one compact line every TRACE_MS on the dev log
 * (console.error is the only level tauri-plugin-log forwards). The engine imports this module
 * only in `vite dev` or with localStorage "tiksee.trace" = "1". Lines start with "[trace]" so
 * `node scripts/trace-report.mjs <log>` can parse them (fields `key=value`, parts " | ").
 */
export const TRACE_MS = 100;

const f2 = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "nan");
const f3 = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : "nan");

/** `[calib]` line: the hand calibration the vision pipeline applies (same `gestureOverrides` as the worker). */
export function calibLine(hands: VisionSettings["calibration"]["hands"]): string {
    const on = Object.entries(gestureOverrides(hands.gestures, HAND_GESTURES)).map(([k, v]) => `${k}=${f3(v.on ?? NaN)}`);
    return `[calib] hands at=${hands.calibratedAt} pinchOn=${hands.pinchOn} pinchOff=${hands.pinchOff} on=${on.join(",") || "-"}`;
}

export function traceLine(
    nowMs: number,
    pets: readonly PetDebug[],
    hands: readonly DebugHand[],
    pin: Pinhole,
    extra: { ownerM: number; poseHz: number; grab: string; body?: BodySnapshot | null },
): string {
    const p = pets.map((d) => {
        const pos = d.pose.p;
        return [
            `pet=${d.pet}`,
            `a=${d.pose.anchor}`,
            `act=${d.mind.decision?.action ?? "-"}`,
            `clip=${d.clip}`,
            `set=${d.pose.settled ? 1 : 0}`,
            `gait=${d.pose.gait ?? "-"}`,
            `p=${f3(pos[0])},${f3(pos[1])},${f3(pos[2])}`,
            `uv=${f3(d.screen.u)},${f3(d.screen.v)}`,
            `z=${f2(d.screen.depthM)}`,
            `sc=${f2(d.scale)}`,
            `held=${d.held ? 1 : 0}`,
            `push=${f3(d.pushed)}`,
        ].join(" ");
    });
    const h = hands
        .filter((x) => x.present)
        .map((x) => {
            const s = project(pin, x.point);
            return `hand=${x.side} pin=${x.pinching ? 1 : 0} shape=${x.shape ?? "-"} uv=${f3(s.u)},${f3(s.v)} z=${f2(s.depthM)} size=${Math.round(x.sizePx)} src=${x.source}`;
        });
    const b = extra.body;
    const head = b?.present
        ? [`head yaw=${b.head.euler.yaw.toFixed(1)} pitch=${b.head.euler.pitch.toFixed(1)} roll=${b.head.euler.roll.toFixed(1)} face=${f2(b.head.rotConf)} fwd=${f3(b.head.forward[0])},${f3(b.head.forward[1])},${f3(b.head.forward[2])} crown=${f3(b.crown[0])},${f3(b.crown[1])},${f3(b.crown[2])}`]
        : [];
    return `[trace] t=${Math.round(nowMs)} owner=${f2(extra.ownerM)} poseHz=${f2(extra.poseHz)} grab=${extra.grab} | ${[...p, ...h, ...head].join(" | ")}`;
}
