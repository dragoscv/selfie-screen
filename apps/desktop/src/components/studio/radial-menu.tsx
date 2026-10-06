import { motion, useReducedMotion } from "motion/react";
import { Aperture, Box, EyeOff, Heart, PartyPopper, ScanFace, ZoomIn, ZoomOut, type LucideIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { RadialAction } from "./actions.js";
import { FOCUS_RING, INSTANT, SPRING } from "./context.js";

const ITEMS: readonly { id: RadialAction; icon: LucideIcon }[] = [
    { id: "af", icon: ScanFace },
    { id: "photo", icon: Aperture },
    { id: "hearts", icon: Heart },
    { id: "confetti", icon: PartyPopper },
    { id: "zoomIn", icon: ZoomIn },
    { id: "zoomOut", icon: ZoomOut },
    { id: "cleanFeed", icon: EyeOff },
    { id: "arAdd", icon: Box },
];

const RADIUS = 92;

/** 8-way radial quick menu; arrow keys rotate focus, Escape closes. */
export function RadialMenu({ x, y, onPick, onClose }: { x: number; y: number; onPick: (id: RadialAction) => void; onClose: () => void }) {
    const { t } = useTranslation();
    const reduced = useReducedMotion();
    const refs = useRef<(HTMLButtonElement | null)[]>([]);

    useEffect(() => {
        refs.current[0]?.focus({ preventScroll: true });
    }, []);

    const move = (from: number, delta: number) => refs.current[(from + delta + ITEMS.length) % ITEMS.length]?.focus();

    return (
        <div
            className="fixed inset-0 z-40"
            onPointerDown={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
            onContextMenu={(e) => {
                e.preventDefault();
                onClose();
            }}
        >
            <div role="menu" aria-label={t("studio.radial.label")} className="absolute" style={{ left: x, top: y }}>
                <motion.div
                    className="absolute -left-10 -top-10 size-20 rounded-full border border-white/20 bg-neutral-950/60 backdrop-blur-xl"
                    initial={reduced ? false : { scale: 0.3, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={reduced ? INSTANT : SPRING}
                    aria-hidden
                />
                {ITEMS.map((item, i) => {
                    const angle = (i / ITEMS.length) * Math.PI * 2 - Math.PI / 2;
                    const Icon = item.icon;
                    const label = t(`studio.radial.${item.id}`);
                    return (
                        <motion.button
                            key={item.id}
                            ref={(el) => {
                                refs.current[i] = el;
                            }}
                            type="button"
                            role="menuitem"
                            aria-label={label}
                            title={label}
                            onClick={() => onPick(item.id)}
                            onKeyDown={(e) => {
                                if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                                    e.preventDefault();
                                    move(i, 1);
                                } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                                    e.preventDefault();
                                    move(i, -1);
                                } else if (e.key === "Escape") {
                                    e.preventDefault();
                                    onClose();
                                }
                            }}
                            className={`absolute -ml-6 -mt-6 grid size-12 place-items-center rounded-full border border-white/20 bg-neutral-900/85 text-white shadow-lg backdrop-blur-xl hover:bg-sky-500 hover:text-neutral-950 focus-visible:bg-sky-500 focus-visible:text-neutral-950 ${FOCUS_RING}`}
                            initial={reduced ? false : { x: 0, y: 0, opacity: 0, scale: 0.4 }}
                            animate={{ x: Math.cos(angle) * RADIUS, y: Math.sin(angle) * RADIUS, opacity: 1, scale: 1 }}
                            transition={reduced ? INSTANT : { ...SPRING, delay: i * 0.015 }}
                        >
                            <Icon className="size-5" aria-hidden />
                        </motion.button>
                    );
                })}
            </div>
        </div>
    );
}
