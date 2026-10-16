import { NOTE_NAMES, type VocalChain } from "@tiksee/core";
import { cn } from "@tiksee/ui";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import type { VocalMeter } from "../../lib/vocal.js";

/**
 * 12-note key wheel in a single SVG: click a note = key, right-click (or
 * Shift+click) = switch the note off. Geometry leaves room for the hover
 * scale and the glow inside the viewBox, so nothing overflows or is clipped.
 */
export function KeyWheel({
    keyIndex,
    mask,
    bypass,
    current,
    onKey,
    onToggle,
    label,
}: {
    keyIndex: number;
    mask: number;
    bypass: number;
    current: number | null;
    onKey: (k: number) => void;
    onToggle: (pc: number) => void;
    label: string;
}) {
    const VIEW = 100; // viewBox half-size
    const DOT = 13; // dot radius
    const RING = VIEW - DOT - 12; // 12 = room for 1.15× scale + glow
    return (
        <svg
            role="group"
            aria-label={label}
            viewBox={`${-VIEW} ${-VIEW} ${VIEW * 2} ${VIEW * 2}`}
            className="mx-auto block aspect-square w-full max-w-[200px] select-none overflow-visible"
        >
            <defs>
                <filter id="kw-glow" x="-60%" y="-60%" width="220%" height="220%">
                    <feGaussianBlur stdDeviation="3.5" result="b" />
                    <feMerge>
                        <feMergeNode in="b" />
                        <feMergeNode in="SourceGraphic" />
                    </feMerge>
                </filter>
            </defs>
            <circle r={VIEW - 2} className="fill-panel-alt/30 stroke-fg/10" strokeWidth={1} />
            <circle r={RING - DOT - 8} className="fill-none stroke-fg/5" strokeWidth={1} />
            {NOTE_NAMES.map((name, pc) => {
                const a = (pc / 12) * Math.PI * 2 - Math.PI / 2;
                const x = Math.cos(a) * RING;
                const y = Math.sin(a) * RING;
                const inScale = ((mask >> pc) & 1) === 1;
                const off = ((bypass >> pc) & 1) === 1;
                const isKey = pc === keyIndex;
                const singing = current === pc;
                const fill = isKey ? "fill-accent" : inScale && !off ? "fill-accent-subtle" : "fill-fg/8";
                const text = isKey ? "fill-accent-fg" : inScale && !off ? "fill-accent" : "fill-fg-subtle";
                return (
                    <motion.g
                        key={name}
                        role="button"
                        tabIndex={0}
                        aria-pressed={isKey}
                        aria-label={`${name}${inScale ? "" : " (out)"}${off ? " (off)" : ""}`}
                        initial={false}
                        animate={{ scale: singing ? 1.15 : 1 }}
                        transition={{ type: "spring", stiffness: 520, damping: 28 }}
                        style={{ transformOrigin: `${x}px ${y}px`, transformBox: "view-box" }}
                        className="cursor-pointer outline-none [&:focus-visible>circle:first-child]:stroke-ring"
                        onClick={(e) => (e.shiftKey || e.altKey ? onToggle(pc) : onKey(pc))}
                        onContextMenu={(e) => {
                            e.preventDefault();
                            onToggle(pc);
                        }}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                if (e.shiftKey) onToggle(pc);
                                else onKey(pc);
                            }
                        }}
                    >
                        <circle
                            cx={x}
                            cy={y}
                            r={DOT}
                            className={cn(fill, "stroke-transparent transition-colors", singing && !isKey && "stroke-accent")}
                            strokeWidth={2}
                            filter={isKey || singing ? "url(#kw-glow)" : undefined}
                        />
                        <text x={x} y={y} dy="0.35em" textAnchor="middle" className={cn(text, "text-[9px] font-bold")} style={{ pointerEvents: "none" }}>
                            {name}
                        </text>
                        {off && <line x1={x - 7} y1={y} x2={x + 7} y2={y} className="stroke-fg-subtle" strokeWidth={1.5} />}
                    </motion.g>
                );
            })}
        </svg>
    );
}

/** Cents needle: how far the raw voice is from the target, with a spring. */
export function Tuner({ meterRef, label }: { meterRef: React.RefObject<VocalMeter | null>; label: string }) {
    const needle = useRef<SVGLineElement>(null);
    const text = useRef<HTMLSpanElement>(null);
    useEffect(() => {
        let raf = 0;
        let shown = 0;
        const tick = () => {
            raf = requestAnimationFrame(tick);
            const m = meterRef.current;
            const cents = m?.voiced ? Math.max(-50, Math.min(50, (m.detectedMidi - m.targetMidi) * 100)) : 0;
            shown += (cents - shown) * 0.25;
            needle.current?.setAttribute("transform", `rotate(${shown * 1.4})`);
            if (text.current) text.current.textContent = m?.voiced ? `${cents > 0 ? "+" : ""}${Math.round(cents)}¢` : "–";
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [meterRef]);
    return (
        <div className="flex flex-col items-center" role="meter" aria-label={label} aria-valuemin={-50} aria-valuemax={50}>
            <svg viewBox="-60 -56 120 64" className="h-14 w-full max-w-32" aria-hidden>
                <path d="M -50 0 A 50 50 0 0 1 50 0" className="fill-none stroke-fg/15" strokeWidth={6} strokeLinecap="round" />
                <path d="M -12 -48.5 A 50 50 0 0 1 12 -48.5" className="fill-none stroke-success" strokeWidth={6} strokeLinecap="round" />
                <line ref={needle} x1={0} y1={4} x2={0} y2={-46} className="stroke-accent" strokeWidth={2.5} strokeLinecap="round" />
                <circle r={4} className="fill-accent" />
            </svg>
            <span ref={text} className="-mt-1 font-mono text-xs tabular-nums text-fg-muted">
                –
            </span>
        </div>
    );
}

/**
 * Compact horizontal meter with a numeric readout. `reduction` meters (comp
 * gain reduction) grow from the right, 0..24 dB; level meters show -60..0 dBFS.
 */
export function LevelBar({
    meterRef,
    pick,
    label,
    reduction = false,
}: {
    meterRef: React.RefObject<VocalMeter | null>;
    pick: (m: VocalMeter) => number;
    label: string;
    reduction?: boolean;
}) {
    const fill = useRef<HTMLDivElement>(null);
    const value = useRef<HTMLSpanElement>(null);
    const pickRef = useRef(pick);
    useEffect(() => {
        pickRef.current = pick;
    }, [pick]);
    useEffect(() => {
        let raf = 0;
        let shown = reduction ? 0 : -90;
        const tick = () => {
            raf = requestAnimationFrame(tick);
            const m = meterRef.current;
            const db = m?.running ? pickRef.current(m) : reduction ? 0 : -90;
            // Fast attack, slower fall, like a hardware meter.
            shown = db > shown ? db : shown + (db - shown) * 0.12;
            const pct = reduction ? Math.max(0, Math.min(1, shown / 24)) : Math.max(0, Math.min(1, (shown + 60) / 60));
            if (fill.current) {
                fill.current.style.transform = `scaleX(${pct})`;
                fill.current.dataset["hot"] = !reduction && shown > -3 ? "1" : "0";
            }
            if (value.current) value.current.textContent = reduction ? (shown > 0.05 ? `-${shown.toFixed(1)}` : "0.0") : shown <= -89 ? "-∞" : shown.toFixed(0);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [meterRef, reduction]);
    return (
        <div className="grid grid-cols-[2.25rem_1fr_2rem] items-center gap-2" role="meter" aria-label={label}>
            <span className="text-[0.5625rem] font-semibold uppercase tracking-wider text-fg-subtle">{label}</span>
            <div className="relative h-1.5 overflow-hidden rounded-full bg-fg/10">
                <div
                    ref={fill}
                    className={cn(
                        "absolute inset-0",
                        reduction ? "origin-right bg-warning" : "origin-left bg-gradient-to-r from-success via-accent to-warning data-[hot=1]:to-danger",
                    )}
                    style={{ transform: "scaleX(0)" }}
                />
            </div>
            <span ref={value} className="text-right font-mono text-[0.625rem] tabular-nums text-fg-muted">
                –
            </span>
        </div>
    );
}

const FREQS = Array.from({ length: 96 }, (_, i) => 20 * 1000 ** (i / 95));

/** EQ response curve from the shell (same biquads as the audio thread). */
export function EqCurve({ chain, label }: { chain: VocalChain; label: string }) {
    const [curve, setCurve] = useState<number[]>(() => FREQS.map(() => 0));
    const key = JSON.stringify([chain.hpfOn, chain.hpfHz, chain.eqOn, chain.eq]);
    useEffect(() => {
        if (!isTauri()) return;
        let stale = false;
        const id = window.setTimeout(() => {
            void invoke<number[]>("vocal_eq_curve", { chain }).then((c) => {
                if (!stale) setCurve(c);
            });
        }, 30);
        return () => {
            stale = true;
            window.clearTimeout(id);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the EQ fields only
    }, [key]);
    const W = 320;
    const H = 96;
    const y = (db: number) => H / 2 - (Math.max(-18, Math.min(18, db)) / 18) * (H / 2 - 4);
    const d = curve.map((db, i) => `${i === 0 ? "M" : "L"}${((i / (curve.length - 1)) * W).toFixed(1)},${y(db).toFixed(1)}`).join(" ");
    return (
        <svg viewBox={`0 0 ${W} ${H}`} className="h-24 w-full" role="img" aria-label={label} preserveAspectRatio="none">
            {[100, 1000, 10_000].map((f) => {
                const x = (Math.log(f / 20) / Math.log(1000)) * W;
                return <line key={f} x1={x} x2={x} y1={0} y2={H} className="stroke-fg/10" strokeWidth={1} />;
            })}
            <line x1={0} x2={W} y1={H / 2} y2={H / 2} className="stroke-fg/15" strokeWidth={1} />
            <motion.path d={`${d} L${W},${H} L0,${H} Z`} className="fill-accent/15" animate={{ d: `${d} L${W},${H} L0,${H} Z` }} transition={{ duration: 0.18 }} />
            <motion.path d={d} className="fill-none stroke-accent" strokeWidth={2} animate={{ d }} transition={{ duration: 0.18 }} />
            {chain.eq.map((b, i) => {
                const x = (Math.log(b.hz / 20) / Math.log(1000)) * W;
                return <circle key={i} cx={x} cy={y(b.gainDb)} r={4} className={cn(b.on ? "fill-accent" : "fill-fg/30")} />;
            })}
        </svg>
    );
}
