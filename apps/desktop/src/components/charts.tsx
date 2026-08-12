import { useTranslation } from "react-i18next";
import {
    Area,
    AreaChart,
    Bar,
    BarChart,
    Cell,
    Pie,
    PieChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";

import type { BreakdownSlice, GifterBar, TimelinePoint } from "../routes/analytics.js";

/**
 * Chart bundle, loaded lazily by the analytics route.
 *
 * Everything reads live CSS variables so charts follow the accent, mode and
 * surface settings without any JS theme plumbing.
 */

const AXIS = { stroke: "var(--fg-subtle)", fontSize: 10 } as const;

const tooltipStyle = {
    background: "var(--panel)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-chip)",
    fontSize: 12,
    color: "var(--fg)",
    boxShadow: "var(--surface-shadow)",
} as const;

export function ActivityChart({ data }: { data: TimelinePoint[] }) {
    return (
        <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -22 }}>
                <defs>
                    <linearGradient id="fillMessages" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--kind-chat)" stopOpacity={0.5} />
                        <stop offset="100%" stopColor="var(--kind-chat)" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="fillGifts" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--kind-gift)" stopOpacity={0.5} />
                        <stop offset="100%" stopColor="var(--kind-gift)" stopOpacity={0.02} />
                    </linearGradient>
                </defs>
                <XAxis dataKey="label" tickLine={false} axisLine={false} tick={AXIS} minTickGap={28} />
                <YAxis tickLine={false} axisLine={false} tick={AXIS} width={38} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ stroke: "var(--border-strong)" }} />
                <Area
                    type="monotone"
                    dataKey="messages"
                    stroke="var(--kind-chat)"
                    strokeWidth={2}
                    fill="url(#fillMessages)"
                    isAnimationActive={false}
                />
                <Area
                    type="monotone"
                    dataKey="gifts"
                    stroke="var(--kind-gift)"
                    strokeWidth={2}
                    fill="url(#fillGifts)"
                    isAnimationActive={false}
                />
            </AreaChart>
        </ResponsiveContainer>
    );
}

export function BreakdownChart({ data }: { data: BreakdownSlice[] }) {
    const { t } = useTranslation();
    const shaped = data.map((slice) => ({
        name: t(`feed.kinds.${slice.kind}`),
        value: slice.value,
        fill: `var(--kind-${slice.kind})`,
    }));

    return (
        <ResponsiveContainer width="100%" height={220}>
            <PieChart>
                <Pie
                    data={shaped}
                    dataKey="value"
                    nameKey="name"
                    innerRadius="52%"
                    outerRadius="82%"
                    paddingAngle={2}
                    stroke="none"
                    isAnimationActive={false}
                >
                    {shaped.map((slice) => (
                        <Cell key={slice.name} fill={slice.fill} />
                    ))}
                </Pie>
                <Tooltip contentStyle={tooltipStyle} />
            </PieChart>
        </ResponsiveContainer>
    );
}

export function GiftersChart({ data }: { data: GifterBar[] }) {
    return (
        <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 8 }}>
                <XAxis type="number" hide />
                <YAxis
                    type="category"
                    dataKey="name"
                    tickLine={false}
                    axisLine={false}
                    tick={AXIS}
                    width={92}
                />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--accent-subtle)" }} />
                <Bar dataKey="diamonds" fill="var(--kind-gift)" radius={[0, 6, 6, 0]} isAnimationActive={false} />
            </BarChart>
        </ResponsiveContainer>
    );
}
