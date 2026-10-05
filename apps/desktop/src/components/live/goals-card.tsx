import type { GoalProgress } from "@tiksee/core";
import { Button, Card, StatusPill } from "@tiksee/ui";
import { motion, useReducedMotion } from "motion/react";
import { RotateCcw, Target } from "lucide-react";
import { useTranslation } from "react-i18next";

import { sidecarClient } from "../../lib/sidecar-client.js";
import { useAppStore } from "../../store/app-store.js";

const GOAL_TINT: Record<GoalProgress["kind"], string> = {
    gifts: "var(--kind-gift)",
    likes: "var(--kind-like)",
};

function GoalBar({ goal }: { goal: GoalProgress }) {
    const { t, i18n } = useTranslation();
    const reduced = useReducedMotion();
    const label = goal.label.trim() || t(`goals.${goal.kind}`);
    const nf = new Intl.NumberFormat(i18n.language);
    const pct = Math.round(goal.ratio * 100);
    return (
        <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate font-semibold text-fg">{label}</span>
                {goal.reached && <StatusPill tone="success">{t("goals.reached")}</StatusPill>}
                <span className="shrink-0 tabular-nums text-fg-muted">
                    {t("goals.progress", { current: nf.format(goal.current), target: nf.format(goal.target) })}
                </span>
            </div>
            <div
                role="progressbar"
                aria-label={label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
                aria-valuetext={t("goals.progress", { current: nf.format(goal.current), target: nf.format(goal.target) })}
                className="h-2.5 w-full overflow-hidden rounded-full bg-panel-alt"
            >
                <motion.div
                    className="h-full rounded-full"
                    style={{ background: GOAL_TINT[goal.kind] }}
                    initial={false}
                    animate={{ width: `${pct}%` }}
                    transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 120, damping: 22 }}
                />
            </div>
        </div>
    );
}

/** Live gift and like goals (WS20-08); progress is computed by the sidecar. */
export function GoalsCard() {
    const { t } = useTranslation();
    const goals = useAppStore((s) => s.goals);

    return (
        <Card
            title={t("goals.title")}
            icon={<Target />}
            tint="var(--kind-gift)"
            actions={
                goals.enabled ? (
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t("goals.reset")}
                        title={t("goals.reset")}
                        onClick={() => sidecarClient.send({ type: "goalsReset" })}
                    >
                        <RotateCcw />
                    </Button>
                ) : undefined
            }
        >
            {!goals.enabled || goals.goals.length === 0 ? (
                <p className="text-xs text-fg-subtle">{t("goals.off")}</p>
            ) : (
                <div className="flex flex-col gap-3">
                    {goals.goals.map((goal) => (
                        <GoalBar key={goal.kind} goal={goal} />
                    ))}
                </div>
            )}
        </Card>
    );
}
