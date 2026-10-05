import type { ReplyItem, ReplyStatus } from "@tiksee/core";
import { Button, EmptyState, SpeakingBars, StatusPill, cn } from "@tiksee/ui";
import { Check, MessagesSquare, X } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { sidecarClient } from "../../lib/sidecar-client.js";
import { useAppStore } from "../../store/app-store.js";
import { Avatar } from "./avatar.js";

/**
 * The sidecar caps the queue at `safety.maxQueue` (≤ 20), so a plain list is
 * enough; this bound only protects the UI from a runaway sidecar.
 */
const MAX_RENDERED = 50;

const STATUS_TONE: Record<ReplyStatus, "neutral" | "accent" | "success" | "warning" | "danger"> = {
    pending: "neutral",
    drafting: "accent",
    ready: "warning",
    speaking: "success",
    done: "neutral",
    skipped: "neutral",
    failed: "danger",
};

const ACTIONABLE = new Set<ReplyStatus>(["pending", "drafting", "ready"]);

export function ReplyQueue() {
    const { t } = useTranslation();
    const items = useAppStore((s) => s.replyQueue);
    const mode = useAppStore((s) => s.settings.assistant.replyMode);
    const enabled = useAppStore((s) => s.settings.assistant.aiReplies);
    const shown = items.slice(0, MAX_RENDERED);

    return (
        <section aria-labelledby="reply-queue-title" className="flex min-h-0 flex-col">
            <header className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-3">
                <h2 id="reply-queue-title" className="text-sm font-semibold text-fg">
                    {t("replies.title")}
                </h2>
                <StatusPill tone={mode === "auto" ? "accent" : "neutral"}>{t(`replies.mode.${mode}`)}</StatusPill>
                <span className="ml-auto text-[0.6875rem] text-fg-subtle">{t("replies.keys")}</span>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
                {shown.length === 0 ? (
                    <EmptyState
                        icon={<MessagesSquare />}
                        title={t("replies.empty")}
                        description={enabled ? t("replies.emptyHint") : t("replies.disabledHint")}
                    />
                ) : (
                    <ul className="flex flex-col gap-2" aria-live="polite" aria-relevant="additions">
                        {shown.map((item) => (
                            <ReplyCard key={item.id} item={item} />
                        ))}
                    </ul>
                )}
                {items.length > MAX_RENDERED && (
                    <p className="pt-2 text-center text-[0.6875rem] text-fg-subtle">
                        {t("replies.more", { count: items.length - MAX_RENDERED })}
                    </p>
                )}
            </div>
        </section>
    );
}

function ReplyCard({ item }: { item: ReplyItem }) {
    const { t } = useTranslation();
    // Local edit wins over the streamed draft once the streamer starts typing.
    const [edited, setEdited] = useState<string | null>(null);
    const draft = edited ?? item.draft ?? "";
    const actionable = ACTIONABLE.has(item.status);
    const canEdit = item.status === "ready";

    const approve = () => {
        const text = edited?.trim();
        sidecarClient.send({ type: "replyApprove", id: item.id, ...(text ? { text } : {}) });
    };
    const skip = () => sidecarClient.send({ type: "replySkip", id: item.id });

    const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
        if (!actionable) return;
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            approve();
        } else if (event.key === "Escape") {
            event.preventDefault();
            skip();
        }
    };

    return (
        <li
            tabIndex={actionable ? 0 : -1}
            onKeyDown={(event) => {
                if (event.target === event.currentTarget) onKeyDown(event);
            }}
            aria-label={t("replies.itemLabel", { name: item.nickname, message: item.message })}
            className={cn(
                "surface rounded-[--radius-card] p-3 outline-none",
                "focus-visible:ring-2 focus-visible:ring-ring",
                item.status === "speaking" && "[box-shadow:inset_0_0_0_1px_var(--success)]",
                !actionable && item.status !== "speaking" && "opacity-60",
            )}
        >
            <div className="flex items-start gap-2.5">
                <Avatar url={item.avatarUrl} name={item.nickname} />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <span className="truncate text-xs font-semibold text-fg">{item.nickname}</span>
                        <span className="truncate text-[0.625rem] text-fg-subtle">@{item.uniqueId}</span>
                        <span className="ml-auto flex shrink-0 items-center gap-1.5">
                            {item.status === "speaking" && <SpeakingBars />}
                            <StatusPill tone={STATUS_TONE[item.status]} pulse={item.status === "drafting"}>
                                {t(`replies.status.${item.status}`)}
                            </StatusPill>
                        </span>
                    </div>
                    <p className="mt-0.5 text-[0.8125rem] leading-snug text-fg">{item.message}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        <span className="rounded-full bg-accent-subtle px-2 py-0.5 text-[0.625rem] font-bold tabular-nums text-accent">
                            {t("replies.score", { score: Math.round(item.score) })}
                        </span>
                        {item.reasons.map((reason) => (
                            <span key={reason} className="rounded-full bg-panel-alt px-2 py-0.5 text-[0.625rem] text-fg-muted">
                                {t(`replies.reasons.${reason}`, { defaultValue: reason })}
                            </span>
                        ))}
                    </div>
                </div>
            </div>

            {(draft !== "" || canEdit) && (
                <div className="mt-2.5">
                    {canEdit ? (
                        <textarea
                            value={draft}
                            onChange={(event) => setEdited(event.target.value)}
                            onKeyDown={onKeyDown}
                            rows={2}
                            maxLength={500}
                            aria-label={t("replies.draft")}
                            className={cn(
                                "no-drag w-full resize-y rounded-[--radius-control] border border-border bg-panel-alt px-3 py-2",
                                "text-[0.8125rem] leading-snug text-fg outline-none",
                                "focus:border-accent focus:ring-2 focus:ring-ring/40",
                            )}
                        />
                    ) : (
                        <p className="rounded-[--radius-control] bg-panel-alt px-3 py-2 text-[0.8125rem] italic leading-snug text-fg-muted">
                            {draft}
                        </p>
                    )}
                </div>
            )}

            {actionable && (
                <div className="mt-2 flex justify-end gap-1.5">
                    <Button size="sm" variant="ghost" icon={<X />} onClick={skip}>
                        {t("replies.skip")}
                    </Button>
                    <Button size="sm" variant="success" icon={<Check />} onClick={approve} disabled={item.status !== "ready"}>
                        {t("replies.approve")}
                    </Button>
                </div>
            )}
        </li>
    );
}
