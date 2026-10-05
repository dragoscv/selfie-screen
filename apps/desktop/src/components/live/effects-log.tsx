import { formatTime } from "@tiksee/core";
import { Card, StatusPill } from "@tiksee/ui";
import { Lightbulb } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useAppStore } from "../../store/app-store.js";

/** The last smart-home effects fired by gifts, chat commands or voice. */
export function EffectsLog() {
    const { t, i18n } = useTranslation();
    const effects = useAppStore((s) => s.effects);
    const enabled = useAppStore((s) => s.settings.effects.enabled);
    const off = useAppStore((s) => s.liveControl.effectsOff);

    return (
        <Card
            title={t("effectsLog.title")}
            icon={<Lightbulb />}
            tint="var(--kind-gift)"
            actions={
                <StatusPill tone={!enabled || off ? "neutral" : "success"}>
                    {!enabled ? t("common.off") : off ? t("effectsLog.paused") : t("common.on")}
                </StatusPill>
            }
        >
            {effects.length === 0 ? (
                <p className="text-xs text-fg-subtle">{t("effectsLog.empty")}</p>
            ) : (
                <ul className="flex flex-col gap-1" aria-live="polite">
                    {effects.map((effect) => (
                        <li key={effect.id} className="flex items-center gap-2 text-xs">
                            <span className="w-11 shrink-0 tabular-nums text-fg-subtle">{formatTime(effect.at, i18n.language)}</span>
                            <span className="min-w-0 flex-1 truncate text-fg">
                                {t(`effectsLog.kinds.${effect.kind}`)}: {effect.label}
                                <span className="text-fg-subtle"> · {effect.by}</span>
                            </span>
                            {effect.error !== undefined ? (
                                <StatusPill tone="danger">{t("effectsLog.failed")}</StatusPill>
                            ) : effect.limited ? (
                                <StatusPill tone="warning">{t("effectsLog.limited")}</StatusPill>
                            ) : null}
                        </li>
                    ))}
                </ul>
            )}
        </Card>
    );
}
