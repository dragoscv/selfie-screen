import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "@tiksee/ui";
import { Minus, Square, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

/**
 * Custom window chrome.
 *
 * The window is `decorations: false` so the UI can extend to the frame under
 * mica. The drag region is a real `-webkit-app-region: drag` element, which
 * keeps Windows Snap Layouts and double-click-to-maximise working.
 */
export function Titlebar({ children }: { children?: ReactNode }) {
    const { t } = useTranslation();
    const [maximised, setMaximised] = useState(false);

    useEffect(() => {
        const window = getCurrentWindow();
        let unlisten: (() => void) | undefined;

        void window.isMaximized().then(setMaximised);
        void window
            .onResized(() => {
                void window.isMaximized().then(setMaximised);
            })
            .then((fn) => {
                unlisten = fn;
            });

        return () => unlisten?.();
    }, []);

    const win = getCurrentWindow();

    return (
        <header
            className="drag-region flex h-10 shrink-0 items-center gap-3 border-b border-border/60 pl-3 pr-0"
            onDoubleClick={() => void win.toggleMaximize()}
        >
            <div className="flex min-w-0 flex-1 items-center gap-3">{children}</div>

            <div className="no-drag flex h-full shrink-0">
                <ChromeButton label={t("window.minimise")} onClick={() => void win.minimize()}>
                    <Minus />
                </ChromeButton>
                <ChromeButton
                    label={maximised ? t("window.restore") : t("window.maximise")}
                    onClick={() => void win.toggleMaximize()}
                >
                    <Square className={maximised ? "scale-90" : undefined} />
                </ChromeButton>
                <ChromeButton
                    label={t("window.close")}
                    danger
                    onClick={() => void win.close()}
                >
                    <X />
                </ChromeButton>
            </div>
        </header>
    );
}

function ChromeButton({
    children,
    label,
    onClick,
    danger = false,
}: {
    children: ReactNode;
    label: string;
    onClick: () => void;
    danger?: boolean;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            onClick={onClick}
            className={cn(
                // Windows-standard 46x32 hit target so it feels native.
                "grid h-full w-[46px] place-items-center text-fg-muted outline-none",
                "transition-colors duration-100",
                "[&_svg]:size-3.5",
                danger ? "hover:bg-danger hover:text-white" : "hover:bg-fg/10 hover:text-fg",
                "focus-visible:bg-fg/10",
            )}
        >
            {children}
        </button>
    );
}
