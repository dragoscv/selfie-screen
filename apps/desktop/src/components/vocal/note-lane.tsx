import { NOTE_NAMES } from "@tiksee/core";
import { useEffect, useRef } from "react";

import type { VocalMeter } from "../../lib/vocal.js";

const SECONDS = 6;
const RANGE = 14; // semitones visible

interface Point {
    t: number;
    detected: number;
    corrected: number;
    target: number;
    voiced: boolean;
}

/**
 * Scrolling pitch lane (detected = faint, corrected = accent, target = note
 * bar) drawn on a canvas from a ref — no React render per frame. In-scale
 * rows are lit; the view follows the singer smoothly.
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

        const draw = (now: number) => {
            raf = requestAnimationFrame(draw);
            const dpr = window.devicePixelRatio || 1;
            const w = el.clientWidth;
            const h = el.clientHeight;
            if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
                el.width = Math.round(w * dpr);
                el.height = Math.round(h * dpr);
            }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);

            const m = meterRef.current;
            const t = now / 1000;
            if (m?.running) {
                points.push({ t, detected: m.detectedMidi, corrected: m.correctedMidi, target: m.targetMidi, voiced: m.voiced });
                if (m.voiced) centre += (m.correctedMidi - centre) * (reduce ? 1 : 0.04);
            }
            while (points.length > 0 && (points[0]?.t ?? t) < t - SECONDS) points.shift();

            const row = h / RANGE;
            const yOf = (midi: number) => h / 2 - (midi - centre) * row;
            const xOf = (pt: number) => w - ((t - pt) / SECONDS) * w;

            // Note rows.
            ctx.font = "600 10px ui-sans-serif, system-ui";
            ctx.textBaseline = "middle";
            const lo = Math.floor(centre - RANGE / 2) - 1;
            for (let n = lo; n <= lo + RANGE + 2; n++) {
                const y = yOf(n);
                const pc = ((n % 12) + 12) % 12;
                const inScale = (maskRef.current >> pc) & 1;
                ctx.fillStyle = inScale ? "color-mix(in oklch, " + accent + " 9%, transparent)" : "transparent";
                ctx.fillRect(0, y - row / 2, w, row);
                ctx.fillStyle = inScale ? fg : "color-mix(in oklch, " + fg + " 30%, transparent)";
                ctx.globalAlpha = inScale ? 0.55 : 0.4;
                ctx.fillText(`${NOTE_NAMES[pc] ?? ""}${Math.floor(n / 12) - 1}`, 6, y);
                ctx.globalAlpha = 1;
            }

            // Target bars.
            ctx.fillStyle = "color-mix(in oklch, " + accent + " 22%, transparent)";
            for (let i = 1; i < points.length; i++) {
                const a = points[i - 1];
                const b = points[i];
                if (!a || !b || !b.voiced) continue;
                ctx.fillRect(xOf(a.t), yOf(b.target) - row * 0.32, xOf(b.t) - xOf(a.t) + 0.5, row * 0.64);
            }
            const line = (key: "detected" | "corrected", color: string, width: number) => {
                ctx.strokeStyle = color;
                ctx.lineWidth = width;
                ctx.lineJoin = "round";
                ctx.lineCap = "round";
                ctx.beginPath();
                let open = false;
                for (const p of points) {
                    if (!p.voiced) {
                        open = false;
                        continue;
                    }
                    const x = xOf(p.t);
                    const y = yOf(p[key]);
                    if (open) ctx.lineTo(x, y);
                    else ctx.moveTo(x, y);
                    open = true;
                }
                ctx.stroke();
            };
            line("detected", "color-mix(in oklch, " + fg + " 35%, transparent)", 1.5);
            ctx.shadowColor = accent;
            ctx.shadowBlur = 10;
            line("corrected", accent, 2.5);
            ctx.shadowBlur = 0;

            // Playhead dot.
            const last = points.at(-1);
            if (last?.voiced) {
                ctx.fillStyle = accent;
                ctx.beginPath();
                ctx.arc(w - 3, yOf(last.corrected), 4, 0, Math.PI * 2);
                ctx.fill();
            }
        };
        raf = requestAnimationFrame(draw);
        return () => cancelAnimationFrame(raf);
    }, [meterRef]);

    return <canvas ref={canvas} role="img" aria-label={label} className="size-full" />;
}
