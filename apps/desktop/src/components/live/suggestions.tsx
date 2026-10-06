import { Card, cn, rowVariants } from "@tiksee/ui";
import { AnimatePresence, motion } from "motion/react";
import { Lightbulb, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useAppStore } from "../../store/app-store.js";

/** Teleprompter: the studio assistant's latest coaching hints (WS20-07). */
export function Suggestions() {
    const { t } = useTranslation();
    const suggestions = useAppStore((s) => s.suggestions);
    const dismiss = useAppStore((s) => s.dismissSuggestion);

    return (
        <Card title={t("suggestions.title")} icon={<Lightbulb />} tint="var(--kind-join)">
            {suggestions.length === 0 ? (
                <p className="text-xs text-fg-subtle">{t("suggestions.empty")}</p>
            ) : (
                <ul className="flex flex-col gap-1.5" aria-live="polite">
                    <AnimatePresence initial={false}>
                        {suggestions.map((s) => (
                            <motion.li
                                key={s.id}
                                layout
                                variants={rowVariants}
                                initial="initial"
                                animate="animate"
                                exit="exit"
                                className="flex items-start gap-2 rounded-chip bg-panel-alt px-3 py-2"
                            >
                                <span
                                    className={cn(
                                        "mt-0.5 shrink-0 rounded-full px-1.5 py-0.5 text-[0.5625rem] font-bold uppercase tracking-wide",
                                        "bg-accent-subtle text-accent",
                                    )}
                                >
                                    {t(`suggestions.kinds.${s.kind}`)}
                                </span>
                                <p className="min-w-0 flex-1 text-xs leading-snug text-fg">{s.text}</p>
                                <button
                                    type="button"
                                    onClick={() => dismiss(s.id)}
                                    aria-label={t("common.dismiss")}
                                    className="grid size-5 shrink-0 place-items-center rounded text-fg-subtle outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                    <X className="size-3" />
                                </button>
                            </motion.li>
                        ))}
                    </AnimatePresence>
                </ul>
            )}
        </Card>
    );
}
