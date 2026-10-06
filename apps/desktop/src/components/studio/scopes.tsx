import type { StudioSettings } from "@tiksee/core";
import { motion, useReducedMotion } from "motion/react";
import { Sun } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { Scopes as ScopeData } from "../../lib/studio/controller.js";
import { FOCUS_RING, GLASS, INSTANT, SPRING, useFrame, useStudio } from "./context.js";
import { FACE_IRE_HIGH, FACE_IRE_LOW, exposureAdvice, exposureCorrection } from "./geometry.js";

type ScopeKind = Exclude<StudioSettings["monitor"]["scope"], "none">;
const KINDS: readonly ScopeKind[] = ["histogram", "waveform", "parade", "vectorscope"];
const W = 256;
const H = 128;
const REDRAW_MS = 100;

/** Draws one scope into a reused ImageData; no allocation per redraw. */
function paint(kind: ScopeKind, s: ScopeData, img: ImageData): void {
    const px = img.data;
    px.fill(0);
    for (let i = 3; i < px.length; i += 4) px[i] = 255;
    const put = (x: number, y: number, r: number, g: number, b: number, a: number) => {
        if (x < 0 || y < 0 || x >= W || y >= H) return;
        const p = (y * W + x) * 4;
        px[p] = Math.min(255, (px[p] ?? 0) + r * a);
        px[p + 1] = Math.min(255, (px[p + 1] ?? 0) + g * a);
        px[p + 2] = Math.min(255, (px[p + 2] ?? 0) + b * a);
    };
    if (kind === "histogram" && s.histogram) {
        const h = s.histogram;
        const bar = (arr: Float32Array, cr: number, cg: number, cb: number) => {
            for (let x = 0; x < W; x++) {
                const top = H - Math.round(Math.sqrt(arr[x] ?? 0) * (H - 2));
                for (let yy = top; yy < H; yy++) put(x, yy, cr, cg, cb, 0.35);
            }
        };
        bar(h.r, 255, 60, 60);
        bar(h.g, 60, 255, 60);
        bar(h.b, 70, 120, 255);
        bar(h.y, 200, 200, 200);
        return;
    }
    if ((kind === "waveform" || kind === "parade") && s.waveform) {
        const { width, data } = s.waveform;
        for (let row = 0; row < 256; row++) {
            const y = row >> 1;
            const base = row * width;
            for (let col = 0; col < width; col++) {
                const v = data[base + col] ?? 0;
                if (v <= 0) continue;
                put(Math.floor((col / width) * W), y, 120, 255, 140, Math.min(1, Math.sqrt(v) * 1.6));
            }
        }
        return;
    }
    if (kind === "vectorscope" && s.vectorscope) {
        const { size, data } = s.vectorscope;
        const ox = (W - H) / 2;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const v = data[y * size + x] ?? 0;
                if (v <= 0) continue;
                put(ox + Math.floor((x / size) * H), Math.floor((y / size) * H), 140, 255, 200, Math.min(1, Math.sqrt(v) * 2));
            }
        }
    }
}

function ScopeCanvas({ kind }: { kind: ScopeKind }) {
    const { frames } = useStudio();
    const { t } = useTranslation();
    const ref = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const g = ref.current?.getContext("2d");
        if (!g) return;
        const img = g.createImageData(W, H);
        let last = 0;
        const draw = () => {
            const now = performance.now();
            if (now - last < REDRAW_MS) return;
            last = now;
            const info = frames.get();
            if (!info) return;
            paint(kind, info.scopes, img);
            g.putImageData(img, 0, 0);
            if (kind === "waveform" || kind === "parade") {
                // 0/50/100 IRE graticule.
                g.strokeStyle = "rgb(255 255 255 / 0.25)";
                g.beginPath();
                for (const y of [0.5, H / 2, H - 0.5]) {
                    g.moveTo(0, y);
                    g.lineTo(W, y);
                }
                g.stroke();
            }
        };
        return frames.subscribe(draw);
    }, [frames, kind]);

    return <canvas ref={ref} width={W} height={H} role="img" aria-label={t(`studio.scopes.kind.${kind}`)} className="block h-32 w-64 rounded-lg bg-black" />;
}

function ExposureAssistant() {
    const { frames } = useStudio();
    const { t } = useTranslation();
    const ire = useFrame(frames, (i) => (i?.scopes.faceIre === undefined ? null : Math.round(i.scopes.faceIre)));
    if (ire === null) return <p className="text-[0.6875rem] text-white/70">{t("studio.scopes.noFace")}</p>;
    const advice = exposureAdvice(ire);
    const pos = (v: number) => `${v}%`;
    return (
        <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[0.6875rem]">
                <span className="flex items-center gap-1 text-white/80">
                    <Sun className="size-3" aria-hidden />
                    {t("studio.scopes.faceIre", { ire })}
                </span>
                <span className={advice === "good" ? "text-emerald-300" : "text-amber-200"}>
                    {t(`studio.scopes.advice.${advice}`, { stops: Math.abs(exposureCorrection(ire)).toFixed(1) })}
                </span>
            </div>
            <div className="relative h-1.5 rounded-full bg-white/15" aria-hidden>
                <div className="absolute inset-y-0 rounded-full bg-emerald-400/50" style={{ left: pos(FACE_IRE_LOW), width: pos(FACE_IRE_HIGH - FACE_IRE_LOW) }} />
                <div className="absolute -top-0.5 h-2.5 w-1 -translate-x-1/2 rounded-full bg-white" style={{ left: pos(Math.min(100, Math.max(0, ire))) }} />
            </div>
        </div>
    );
}

/** Scope dock: tabs with a morphing underline, clipping readout, exposure assistant. */
export function ScopesDock() {
    const { studio, vision, frames, patchStudio } = useStudio();
    const { t } = useTranslation();
    const reduced = useReducedMotion();
    const m = studio.monitor;
    const clip = useFrame(frames, (i) => (i ? `${(i.scopes.clipHigh * 100).toFixed(1)}|${(i.scopes.clipLow * 100).toFixed(1)}` : "0.0|0.0"));
    const [hi, lo] = clip.split("|");
    const showScope = m.scope !== "none";
    if (!showScope && !m.clipping && !vision.coach.exposure) return null;

    return (
        <section
            aria-label={t("studio.scopes.title")}
            // ~45% of a narrow window, 17.5rem max: never wider than the window, never covering the face.
            className={`${GLASS} w-[min(17.5rem,45cqw)] min-w-40 space-y-2 rounded-2xl p-2.5`}
        >
            {showScope && (
                <>
                    <div role="tablist" aria-label={t("studio.scopes.title")} className="flex gap-1">
                        {KINDS.map((k) => (
                            <button
                                key={k}
                                type="button"
                                role="tab"
                                aria-selected={m.scope === k}
                                onClick={() => patchStudio({ monitor: { ...m, scope: k } })}
                                className={`relative flex-1 rounded-md px-1 py-1 text-[0.6875rem] font-medium ${FOCUS_RING} ${m.scope === k ? "text-white" : "text-white/70 hover:text-white"}`}
                            >
                                {t(`studio.scopes.short.${k}`)}
                                {m.scope === k && (
                                    <motion.span layoutId="scope-tab" transition={reduced ? INSTANT : SPRING} className="absolute inset-x-1 -bottom-0.5 h-0.5 rounded-full bg-sky-300" />
                                )}
                            </button>
                        ))}
                    </div>
                    <ScopeCanvas kind={m.scope as ScopeKind} />
                </>
            )}
            {(m.clipping || showScope) && (
                <p className="flex justify-between text-[0.6875rem] tabular-nums text-white/85">
                    <span>{t("studio.scopes.clipHigh", { pct: hi })}</span>
                    <span>{t("studio.scopes.clipLow", { pct: lo })}</span>
                </p>
            )}
            {vision.coach.exposure && <ExposureAssistant />}
        </section>
    );
}
