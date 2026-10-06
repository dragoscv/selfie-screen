import { formatCount } from "@tiksee/core";
import { cn, transitions } from "@tiksee/ui";
import { AnimatePresence, motion } from "motion/react";
import { Gem, MessageCircle, Repeat, X } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { useAppStore, type QueuedViewerCard } from "../../store/app-store.js";
import { Avatar } from "./avatar.js";

const AUTO_DISMISS_MS = 12_000;
/** Cards on screen at once; the rest wait their turn. */
const VISIBLE = 2;

/**
 * Returning-viewer cards (WS20-06): float over the live page's bottom-left,
 * one or two at a time, each dismissing itself after 12 s.
 */
export function ViewerCards() {
    const cards = useAppStore((s) => s.viewerCards);
    const visible = cards.slice(0, VISIBLE);

    return (
        <div className="pointer-events-none absolute bottom-3 left-3 z-20 flex w-[min(22rem,calc(100%-1.5rem))] flex-col gap-2">
            <AnimatePresence initial={false}>
                {visible.map((entry) => (
                    <ViewerCardView key={entry.key} entry={entry} />
                ))}
            </AnimatePresence>
        </div>
    );
}

function ViewerCardView({ entry }: { entry: QueuedViewerCard }) {
    const { t, i18n } = useTranslation();
    const dismiss = useAppStore((s) => s.dismissViewerCard);
    const { card } = entry;

    useEffect(() => {
        const id = window.setTimeout(() => dismiss(entry.key), AUTO_DISMISS_MS);
        return () => window.clearTimeout(id);
    }, [dismiss, entry.key]);

    return (
        <motion.article
            layout
            initial={{ opacity: 0, x: -24, scale: 0.96 }}
            animate={{ opacity: 1, x: 0, scale: 1, transition: transitions.springSoft }}
            exit={{ opacity: 0, x: -16, transition: transitions.fast }}
            role="status"
            aria-label={t("viewerCard.label", { name: card.nickname })}
            className={cn(
                "surface pointer-events-auto relative overflow-hidden rounded-card p-3 shadow-xl",
                "[box-shadow:inset_0_0_0_1px_color-mix(in_oklab,var(--kind-follow)_45%,transparent)]",
            )}
        >
            <div className="flex items-start gap-3">
                <Avatar url={card.avatarUrl} name={card.nickname} className="size-11" />
                <div className="min-w-0 flex-1">
                    <p className="text-[0.625rem] font-bold uppercase tracking-wide text-[var(--kind-follow)]">
                        {t("viewerCard.returning")}
                    </p>
                    <p className="truncate text-sm font-semibold text-fg">{card.nickname}</p>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[0.6875rem] text-fg-muted">
                        <span className="inline-flex items-center gap-1">
                            <Repeat className="size-3" aria-hidden />
                            {t("viewerCard.visits", { count: card.visits })}
                        </span>
                        <span className="inline-flex items-center gap-1">
                            <Gem className="size-3" aria-hidden />
                            {t("viewerCard.diamonds", { count: card.totalDiamonds, formatted: formatCount(card.totalDiamonds, i18n.language) })}
                        </span>
                        <span className="inline-flex items-center gap-1">
                            <MessageCircle className="size-3" aria-hidden />
                            {t("viewerCard.messages", { count: card.messages })}
                        </span>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={() => dismiss(entry.key)}
                    aria-label={t("common.dismiss")}
                    className="grid size-6 shrink-0 place-items-center rounded-full text-fg-subtle outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
                >
                    <X className="size-3.5" />
                </button>
            </div>
            {card.facts.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-1">
                    {card.facts.slice(0, 4).map((fact) => (
                        <li key={fact} className="rounded-full bg-panel-alt px-2 py-0.5 text-[0.625rem] text-fg-muted">
                            {fact}
                        </li>
                    ))}
                </ul>
            )}
            {card.greeting !== undefined && card.greeting !== "" && (
                <p className="mt-2 rounded-chip bg-accent-subtle px-2.5 py-1.5 text-xs text-accent">
                    {t("viewerCard.greeting", { text: card.greeting })}
                </p>
            )}
            <motion.span
                className="absolute bottom-0 left-0 h-0.5 bg-[var(--kind-follow)]"
                initial={{ width: "100%" }}
                animate={{ width: "0%" }}
                transition={{ duration: AUTO_DISMISS_MS / 1000, ease: "linear" }}
                aria-hidden
            />
        </motion.article>
    );
}
