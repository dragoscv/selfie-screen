import { cn } from "@tiksee/ui";
import {
    EyeOff,
    MicOff,
    PauseCircle,
    ShoppingBag,
    SkipForward,
    Sparkles,
    Star,
    ZapOff,
    type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { TOGGLE_CONTROLS, sendControl, toggleControl, type ToggleControl } from "../../lib/live-control.js";
import { useAppStore } from "../../store/app-store.js";

const TOGGLES: readonly { id: ToggleControl; icon: LucideIcon; tone: string }[] = [
    { id: "mute", icon: MicOff, tone: "var(--danger)" },
    { id: "pause", icon: PauseCircle, tone: "var(--warning)" },
    { id: "effects", icon: ZapOff, tone: "var(--warning)" },
    { id: "shop", icon: ShoppingBag, tone: "var(--kind-gift)" },
    { id: "pets", icon: EyeOff, tone: "var(--kind-join)" },
];

/**
 * Emergency controls, always visible under the titlebar (WS22-01). Every
 * button reflects the sidecar's `liveControl` state, not a local guess, so a
 * hotkey or a second window can never leave it showing the wrong thing.
 */
export function LiveControlBar() {
    const { t } = useTranslation();
    const state = useAppStore((s) => s.liveControl);
    const speaking = useAppStore((s) => s.speaking);
    const connected = useAppStore((s) => s.sidecarConnected);

    return (
        <div
            role="toolbar"
            aria-label={t("liveControl.label")}
            className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/60 px-3 py-1.5"
        >
            {TOGGLES.map(({ id, icon: Icon, tone }) => {
                const active = state[TOGGLE_CONTROLS[id].flag] === true;
                return (
                    <button
                        key={id}
                        type="button"
                        aria-pressed={active}
                        disabled={!connected}
                        onClick={() => toggleControl(id)}
                        title={t(`liveControl.${id}Hint`)}
                        className={cn(
                            "no-drag inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.6875rem] font-medium",
                            "outline-none transition-colors duration-(--dur-fast)",
                            "focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                            active
                                ? "text-[var(--tone)] [background:color-mix(in_oklab,var(--tone)_18%,transparent)] [box-shadow:inset_0_0_0_1px_color-mix(in_oklab,var(--tone)_55%,transparent)]"
                                : "bg-panel-alt text-fg-muted hover:text-fg",
                        )}
                        style={{ "--tone": tone } as React.CSSProperties}
                    >
                        <Icon className="size-3.5" aria-hidden />
                        {t(`liveControl.${id}`)}
                    </button>
                );
            })}

            <span className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden />

            <button
                type="button"
                disabled={!connected || speaking === null}
                onClick={() => sendControl("skipCurrent")}
                title={t("liveControl.skipHint")}
                className={cn(
                    "no-drag inline-flex shrink-0 items-center gap-1.5 rounded-full bg-panel-alt px-2.5 py-1 text-[0.6875rem] font-medium text-fg-muted",
                    "outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                )}
            >
                <SkipForward className="size-3.5" aria-hidden />
                {t("liveControl.skip")}
            </button>
            <button
                type="button"
                disabled={!connected}
                onClick={() => sendControl("highlight")}
                title={t("liveControl.highlightHint")}
                className={cn(
                    "no-drag inline-flex shrink-0 items-center gap-1.5 rounded-full bg-panel-alt px-2.5 py-1 text-[0.6875rem] font-medium text-fg-muted",
                    "outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                )}
            >
                <Star className="size-3.5" aria-hidden />
                {t("liveControl.highlight")}
            </button>

            <p className="ml-auto flex min-w-0 shrink items-center gap-1.5 truncate pl-3 text-[0.6875rem] text-fg-muted" aria-live="polite">
                {state.shopMode ? (
                    <>
                        <ShoppingBag className="size-3.5 shrink-0 text-[var(--kind-gift)]" aria-hidden />
                        <span className="truncate">{t("liveControl.shopActive")}</span>
                    </>
                ) : speaking !== null ? (
                    <>
                        <Sparkles className="size-3.5 shrink-0 text-success" aria-hidden />
                        <span className="truncate" title={speaking.text}>
                            {t("liveControl.speaking", { text: speaking.text })}
                        </span>
                    </>
                ) : null}
            </p>
        </div>
    );
}
