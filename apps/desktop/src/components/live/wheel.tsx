import { motion, useReducedMotion } from "motion/react";

import { wheelRotation } from "../../lib/games.js";

const COLORS = ["#62D6FF", "#FFB454", "#4ADE80", "#A78BFA", "#F87171", "#38BDF8", "#F472B6", "#FACC15"];
/** Must match the sidecar's WHEEL_SPIN_MS. */
const SPIN_MS = 6_000;

function arc(index: number, count: number, r: number): string {
    const step = (Math.PI * 2) / count;
    const a0 = -Math.PI / 2 + index * step;
    const a1 = a0 + step;
    const large = step > Math.PI ? 1 : 0;
    const p = (a: number) => `${(r + r * Math.cos(a)).toFixed(2)} ${(r + r * Math.sin(a)).toFixed(2)}`;
    return count === 1 ? `M ${r} 0 A ${r} ${r} 0 1 1 ${r - 0.01} 0 Z` : `M ${r} ${r} L ${p(a0)} A ${r} ${r} 0 ${large} 1 ${p(a1)} Z`;
}

export interface WheelProps {
    segments: readonly string[];
    winnerIndex?: number;
    spinAt?: number;
    spinning: boolean;
    label: string;
}

/** Giveaway wheel; the spin is decorative, the sidecar has already drawn the winner. */
export function Wheel({ segments, winnerIndex, spinAt, spinning, label }: WheelProps) {
    const reduced = useReducedMotion();
    const size = 200;
    const r = size / 2;
    const count = Math.max(1, segments.length);
    const target = winnerIndex !== undefined && spinAt !== undefined ? wheelRotation(winnerIndex, count) : 0;
    // Spin only while the sidecar says so; afterwards (or with reduced motion) snap to the result.
    const duration = spinning && spinAt !== undefined && !reduced ? SPIN_MS / 1000 : 0;

    return (
        <div className="relative mx-auto" style={{ width: size, height: size }} role="img" aria-label={label}>
            <motion.svg
                key={spinAt ?? 0}
                viewBox={`0 0 ${size} ${size}`}
                width={size}
                height={size}
                initial={{ rotate: duration > 0 ? 0 : target }}
                animate={{ rotate: target }}
                transition={{ duration, ease: [0.12, 0.8, 0.2, 1] }}
                aria-hidden
            >
                {segments.length === 0 ? (
                    <circle cx={r} cy={r} r={r} className="fill-panel-alt" />
                ) : (
                    segments.map((name, i) => {
                        const mid = ((i + 0.5) * 360) / count;
                        return (
                            <g key={`${name}-${i}`}>
                                <path d={arc(i, count, r)} fill={COLORS[i % COLORS.length]} stroke="var(--bg)" strokeWidth={1} />
                                <text
                                    x={r}
                                    y={r}
                                    transform={`rotate(${mid - 90} ${r} ${r}) translate(${r - 10} 0)`}
                                    textAnchor="end"
                                    dominantBaseline="middle"
                                    fontSize={count > 16 ? 8 : 10}
                                    fontWeight={700}
                                    fill="#0B0E14"
                                >
                                    {name.slice(0, 14)}
                                </text>
                            </g>
                        );
                    })
                )}
            </motion.svg>
            <span
                className="absolute left-1/2 top-[-6px] size-0 -translate-x-1/2 border-x-[9px] border-t-[16px] border-x-transparent border-t-fg drop-shadow"
                aria-hidden
            />
        </div>
    );
}
