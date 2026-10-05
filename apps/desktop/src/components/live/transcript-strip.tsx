import { cn } from "@tiksee/ui";
import { Mic, MicOff, Radio } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useAppStore } from "../../store/app-store.js";

/** The streamer's own words as the co-host hears them (WS20-01). */
export function TranscriptStrip() {
    const { t } = useTranslation();
    const enabled = useAppStore((s) => s.settings.assistant.transcribe);
    const transcript = useAppStore((s) => s.transcript);
    const last = transcript.finals.at(-1);

    if (!enabled) return null;

    const live = transcript.mic === "live";
    const failed = transcript.mic === "error";

    return (
        <section
            aria-label={t("transcript.title")}
            className="flex shrink-0 items-center gap-2.5 border-b border-border/60 px-4 py-2"
        >
            <span
                className={cn(
                    "grid size-7 shrink-0 place-items-center rounded-full",
                    failed
                        ? "bg-danger/15 text-danger"
                        : transcript.speaking
                            ? "bg-success/15 text-success"
                            : live
                                ? "bg-accent-subtle text-accent"
                                : "bg-panel-alt text-fg-subtle",
                )}
                title={t(`transcript.mic.${transcript.mic}`)}
            >
                {failed ? <MicOff className="size-3.5" /> : transcript.speaking ? <Radio className="size-3.5" /> : <Mic className="size-3.5" />}
                <span className="sr-only">{t(`transcript.mic.${transcript.mic}`)}</span>
            </span>
            <p className="min-w-0 flex-1 truncate text-xs" aria-live="polite">
                {transcript.partial !== "" ? (
                    <span className="text-fg">{transcript.partial}</span>
                ) : last ? (
                    <span className="text-fg-muted">{last.text}</span>
                ) : (
                    <span className="text-fg-subtle">
                        {failed && transcript.error ? transcript.error : t("transcript.idle")}
                    </span>
                )}
            </p>
            {transcript.pushToTalk && (
                <span className="shrink-0 rounded-full bg-success/15 px-2 py-0.5 text-[0.625rem] font-bold text-success">
                    {t("transcript.ptt")}
                </span>
            )}
        </section>
    );
}
