import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { INSTANT, SPRING, useStudio } from "./context.js";
import { ownerFaceOf } from "./geometry.js";

const SIZE = 220;

/**
 * Magnifier that follows the owner's eyes. Each rAF it copies the region of
 * the preview canvas around the eye midpoint (output pixels) into its own
 * canvas at `loupeZoom`. The canvas is WebGPU-backed; drawImage reads its
 * latest presented frame.
 */
export function Loupe() {
    const { canvas, frames, rectRef, studio } = useStudio();
    const { t } = useTranslation();
    const reduced = useReducedMotion();
    const ref = useRef<HTMLCanvasElement>(null);
    const wrap = useRef<HTMLDivElement>(null);
    const zoom = studio.monitor.loupeZoom;

    useEffect(() => {
        const out = ref.current;
        const g = out?.getContext("2d");
        if (!out || !g) return;
        g.imageSmoothingEnabled = false;
        let raf = 0;
        let cx = 0.5;
        let cy = 0.4;
        const draw = () => {
            raf = requestAnimationFrame(draw);
            const face = ownerFaceOf(frames.get()?.faces ?? []);
            if (face) {
                // Light smoothing so the loupe does not jitter with the detector.
                cx += ((face.leftEye[0] + face.rightEye[0]) / 2 - cx) * 0.35;
                cy += ((face.leftEye[1] + face.rightEye[1]) / 2 - cy) * 0.35;
            }
            const rect = rectRef.current;
            const el = wrap.current;
            if (el && rect.width > 0) {
                el.style.transform = `translate(${rect.left + cx * rect.width - SIZE / 2}px, ${rect.top + cy * rect.height - SIZE - 24}px)`;
            }
            const sw = SIZE / zoom;
            const sx = cx * canvas.width - sw / 2;
            const sy = cy * canvas.height - sw / 2;
            g.clearRect(0, 0, SIZE, SIZE);
            try {
                g.drawImage(canvas, sx, sy, sw, sw, 0, 0, SIZE, SIZE);
            } catch {
                // Canvas not ready (zero size) — skip this frame.
            }
        };
        raf = requestAnimationFrame(draw);
        return () => cancelAnimationFrame(raf);
    }, [canvas, frames, rectRef, zoom]);

    return (
        <div ref={wrap} className="pointer-events-none absolute left-0 top-0" style={{ width: SIZE, height: SIZE }}>
            <motion.div
                role="img"
                aria-label={t("studio.loupe.label", { zoom })}
                initial={reduced ? false : { opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: reduced ? 1 : 0.6 }}
                transition={reduced ? INSTANT : SPRING}
                className="relative size-full"
            >
                <canvas ref={ref} width={SIZE} height={SIZE} className="size-full rounded-full border-2 border-white/80 shadow-[0_8px_40px_rgb(0_0_0/0.6)]" />
                <span className="absolute -bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/75 px-2 py-0.5 text-[0.6875rem] font-bold text-white">
                    {zoom}×
                </span>
            </motion.div>
        </div>
    );
}
