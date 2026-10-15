import { NOTE_NAMES, type VocalChain } from "@tiksee/core";
import { cn } from "@tiksee/ui";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import type { VocalMeter } from "../../lib/vocal.js";

/** 12-segment key wheel: tap a note to pick the key, in-scale notes glow, bypassed ones dim. */
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
    const R = 74;
    return (
        <div role="group" aria-label={label} className="relative mx-auto size-[184px] select-none">
            <svg viewBox="-92 -92 184 184" className="absolute inset-0 size-full" aria-hidden>
                <circle r={R + 14} className="fill-none stroke-fg/10" strokeWidth={1} />
                <circle r={R - 22} className="fill-none stroke-fg/5" strokeWidth={1} />
            </svg>
            {NOTE_NAMES.map((name, pc) => {
                const a = (pc / 12) * Math.PI * 2 - Math.PI / 2;
                const x = Math.cos(a) * R;
                const y = Math.sin(a) * R;
                const inScale = ((mask >> pc) & 1) === 1;
                const off = ((bypass >> pc) & 1) === 1;
                const isKey = pc === keyIndex;
                const singing = current === pc;
                return (
                    <motion.button
                        key={name}
                        type="button"
                        layout
                        onClick={(e) => (e.shiftKey || e.altKey ? onToggle(pc) : onKey(pc))}
                        onContextMenu={(e) => {
                            e.preventDefault();
                            onToggle(pc);
                        }}
                        aria-pressed={isKey}
                        aria-label={`${name}${inScale ? "" : " (out)"}${off ? " (bypassed)" : ""}`}
                        animate={{ scale: singing ? 1.18 : isKey ? 1.08 : 1 }}
                        transition={{ type: "spring", stiffness: 520, damping: 28 }}
                        style={{ left: `calc(50% + ${x}px - 18px)`, top: `calc(50% + ${y}px - 18px)` }}
                        className={cn(
                            "absolute grid size-9 place-items-center rounded-full text-[0.6875rem] font-bold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                            isKey && "bg-accent text-accent-fg shadow-[0_0_18px_var(--color-accent)]",
                            !isKey && inScale && !off && "bg-accent-subtle text-accent",
                            !isKey && (!inScale || off) && "bg-panel-alt/60 text-fg-subtle",
                            off && "line-through",
                            singing && !isKey && "ring-2 ring-accent",
                        )}
                    >
                        {name}
                    </motion.button>
                );
            })}
        </div>
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
            <svg viewBox="-60 -56 120 64" className="h-16 w-32" aria-hidden>
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

/** Vertical level meter (dBFS) updated from the meter ref. */
export function LevelBar({ meterRef, pick, label }: { meterRef: React.RefObject<VocalMeter | null>; pick: (m: VocalMeter) => number; label: string }) {
    const fill = useRef<HTMLDivElement>(null);
    const pickRef = useRef(pick);
    useEffect(() => {
        pickRef.current = pick;
    }, [pick]);
    useEffect(() => {
        let raf = 0;
        const tick = () => {
            raf = requestAnimationFrame(tick);
            const m = meterRef.current;
            const db = m ? pickRef.current(m) : -90;
            const pct = Math.max(0, Math.min(1, (db + 60) / 60));
            if (fill.current) {
                fill.current.style.transform = `scaleY(${pct})`;
                fill.current.dataset["hot"] = db > -3 ? "1" : "0";
            }
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [meterRef]);
    return (
        <div className="flex flex-col items-center gap-1" role="meter" aria-label={label}>
            <div className="relative h-24 w-2 overflow-hidden rounded-full bg-fg/10">
                <div
                    ref={fill}
                    className="absolute inset-0 origin-bottom bg-gradient-to-t from-success via-accent to-warning transition-transform duration-75 data-[hot=1]:to-danger"
                    style={{ transform: "scaleY(0)" }}
                />
            </div>
            <span className="text-[0.5625rem] uppercase tracking-wider text-fg-subtle">{label}</span>
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
