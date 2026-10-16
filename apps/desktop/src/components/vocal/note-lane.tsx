import { NOTE_NAMES } from "@tiksee/core";
import { useEffect, useRef } from "react";

import type { VocalMeter } from "../../lib/vocal.js";

const SECONDS = 6;
/** Rows never get thinner than this, so labels never overlap. */
const MIN_ROW_PX = 13;
/** A gap longer than this, or a jump of more than 3 semitones, starts a new stroke. */
const BREAK_S = 0.08;
const BREAK_ST = 3;
const GUTTER = 34;

interface Point {
    t: number;
    detected: number;
    corrected: number;
    target: number;
    voiced: boolean;
}

/**
 * Scrolling pitch lane (detected = faint, corrected = accent, target = wide
 * soft stroke) drawn on a canvas from a ref — no React render per frame. The
 * visible range shows only as many semitones as fit at `MIN_ROW_PX`; only
 * in-scale notes are labelled (in a gutter). Strokes break on silence and on
 * jumps, so detector glitches never draw vertical spikes.
 */
export function NoteLane({ meterRef, allowedMask, label }: { meterRef: React.RefObject<VocalMeter | null>; allowedMask: number; label: string }) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const maskRef = useRef(allowedMask);
    useEffect(() => {
        maskRef.current = allowedMask;
    }, [allowedMask]);

    useEffect(() => {
        const el = canvas.current;
        if (!el) return;
        const ctx = el.getContext("2d");
        if (!ctx) return;
        const points: Point[] = [];
        let centre = 64;
        let raf = 0;
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const styles = getComputedStyle(el);
        const accent = styles.getPropertyValue("--color-accent").trim() || "oklch(0.8 0.14 200)";
        const fg = styles.getPropertyValue("--color-fg").trim() || "#fff";
        const mix = (c: string, pct: number) => `color-mix(in oklch, ${c} ${pct}%, transparent)`;

        const draw = (now: number) => {
            raf = requestAnimationFrame(draw);
            const dpr = window.devicePixelRatio || 1;
            const w = el.clientWidth;
            const h = el.clientHeight;
            if (w === 0 || h === 0) return;
            if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
                el.width = Math.round(w * dpr);
                el.height = Math.round(h * dpr);
            }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);

            const m = meterRef.current;
            const t = now / 1000;
            if (m?.running && m.voiced) {
                points.push({ t, detected: m.detectedMidi, corrected: m.correctedMidi, target: m.targetMidi, voiced: true });
                centre += (m.targetMidi - centre) * (reduce ? 1 : 0.05);
            } else if (points.at(-1)?.voiced) {
                points.push({ t, detected: 0, corrected: 0, target: 0, voiced: false });
            }
            while (points.length > 0 && (points[0]?.t ?? t) < t - SECONDS) points.shift();

            const range = Math.max(7, Math.floor(h / MIN_ROW_PX));
            const row = h / range;
            const yOf = (midi: number) => h / 2 - (midi - centre) * row;
            const xOf = (pt: number) => GUTTER + (w - GUTTER) * (1 - (t - pt) / SECONDS);

            // Rows: tint in-scale notes (tonic stronger) and label only those, in the gutter.
            ctx.font = `600 ${Math.min(10, Math.floor(row - 2))}px ui-sans-serif, system-ui`;
            ctx.textBaseline = "middle";
            const lo = Math.floor(centre - range / 2) - 1;
            for (let n = lo; n <= lo + range + 2; n++) {
                const y = yOf(n);
                const pc = ((n % 12) + 12) % 12;
                if (((maskRef.current >> pc) & 1) !== 1) continue;
                ctx.fillStyle = mix(accent, pc === 0 ? 12 : 7);
                ctx.fillRect(GUTTER, y - row / 2 + 0.5, w - GUTTER, row - 1);
                ctx.fillStyle = mix(fg, 60);
                ctx.fillText(`${NOTE_NAMES[pc] ?? ""}${Math.floor(n / 12) - 1}`, 4, y);
            }
            ctx.fillStyle = mix(fg, 8);
            ctx.fillRect(GUTTER - 1, 0, 1, h);

            const stroke = (key: "detected" | "corrected" | "target", color: string, width: number, glow = 0) => {
                ctx.strokeStyle = color;
                ctx.lineWidth = width;
                ctx.lineJoin = "round";
                ctx.lineCap = "round";
                ctx.shadowColor = color;
                ctx.shadowBlur = glow;
                ctx.beginPath();
                let prev: Point | undefined;
                for (const p of points) {
                    if (!p.voiced) {
                        prev = undefined;
                        continue;
                    }
                    const x = xOf(p.t);
                    const y = yOf(p[key]);
                    if (prev && p.t - prev.t < BREAK_S && Math.abs(p[key] - prev[key]) < BREAK_ST) ctx.lineTo(x, y);
                    else ctx.moveTo(x, y);
                    prev = p;
                }
                ctx.stroke();
                ctx.shadowBlur = 0;
            };
            stroke("target", mix(accent, 25), Math.max(3, row * 0.6));
            stroke("detected", mix(fg, 40), 1.5);
            stroke("corrected", accent, 2.5, 8);

            // Playhead dot.
            const last = points.at(-1);
            if (last?.voiced) {
                ctx.fillStyle = accent;
                ctx.beginPath();
                ctx.arc(w - 4, yOf(last.corrected), 3.5, 0, Math.PI * 2);
                ctx.fill();
            }
        };
        raf = requestAnimationFrame(draw);
        return () => cancelAnimationFrame(raf);
    }, [meterRef]);

    return <canvas ref={canvas} role="img" aria-label={label} className="block size-full" />;
}
