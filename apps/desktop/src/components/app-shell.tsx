import { invoke } from "@tauri-apps/api/core";
import { Button, cn, pageVariants } from "@tiksee/ui";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, BarChart3, Radio, Settings as SettingsIcon, Users } from "lucide-react";
import { Suspense, lazy, useState } from "react";
import { useTranslation } from "react-i18next";

import { MAIN_STREAM, selectStatus, useAppStore } from "../store/app-store.js";
import { CommandPalette } from "./command-palette.js";
import { ConnectionBar } from "./connection-bar.js";
import { ErrorBoundary } from "./error-boundary.js";
import { LiveControlBar } from "./live/live-control-bar.js";
import { SummaryDialog } from "./live/summary-dialog.js";
import { Titlebar } from "./titlebar.js";

const LiveRoute = lazy(() =>
    import("../routes/live.js").then((m) => ({ default: m.LiveRoute })),
);
const PeopleRoute = lazy(() =>
    import("../routes/people.js").then((m) => ({ default: m.PeopleRoute })),
);
const AnalyticsRoute = lazy(() =>
    import("../routes/analytics.js").then((m) => ({ default: m.AnalyticsRoute })),
);
const SettingsRoute = lazy(() =>
    import("../routes/settings.js").then((m) => ({ default: m.SettingsRoute })),
);

export type RouteId = "live" | "people" | "analytics" | "settings";

const ROUTES = [
    { id: "live", icon: Radio },
    { id: "people", icon: Users },
    { id: "analytics", icon: BarChart3 },
    { id: "settings", icon: SettingsIcon },
] as const;

export function AppShell() {
    const { t } = useTranslation();
    const [route, setRoute] = useState<RouteId>("live");
    const status = useAppStore(selectStatus(MAIN_STREAM));
    const sidecarConnected = useAppStore((s) => s.sidecarConnected);
    const sidecarError = useAppStore((s) => s.sidecarError);

    return (
        <div className="flex h-screen flex-col overflow-hidden">
            <Titlebar>
                <span className="select-none text-[0.8125rem] font-bold tracking-wide text-fg">
                    TikSee
                </span>
                <nav className="no-drag flex items-center gap-0.5" aria-label={t("nav.primary")}>
                    {ROUTES.map(({ id, icon: Icon }) => (
                        <button
                            key={id}
                            type="button"
                            onClick={() => setRoute(id)}
                            aria-current={route === id ? "page" : undefined}
                            title={t(`nav.${id}`)}
                            className={cn(
                                "relative flex items-center gap-1.5 rounded-[--radius-chip] px-2.5 py-1.5",
                                "text-xs outline-none transition-colors duration-[--dur-fast]",
                                "focus-visible:ring-2 focus-visible:ring-ring",
                                route === id ? "text-accent" : "text-fg-muted hover:text-fg",
                            )}
                        >
                            <Icon className="size-3.5" />
                            {/* The titlebar is not a @container, so a container
                                query here never matched. Use the viewport. */}
                            <span className="hidden lg:inline">{t(`nav.${id}`)}</span>
                            {route === id && (
                                <motion.span
                                    layoutId="nav-active"
                                    className="absolute inset-0 -z-10 rounded-[--radius-chip] bg-accent-subtle"
                                    transition={{ type: "spring", stiffness: 480, damping: 38 }}
                                />
                            )}
                        </button>
                    ))}
                </nav>

                <div className="no-drag ml-auto pr-2">
                    <ConnectionBar status={status} />
                </div>
            </Titlebar>

            <LiveControlBar />

            {!sidecarConnected && <SidecarBanner />}
            {sidecarConnected && sidecarError !== null && <ErrorBanner message={sidecarError} />}

            <main className="@container min-h-0 flex-1">
                <AnimatePresence mode="wait" initial={false}>
                    <motion.div
                        key={route}
                        variants={pageVariants}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className="h-full"
                    >
                        <ErrorBoundary area={route}>
                            <Suspense fallback={<RouteFallback />}>
                                {route === "live" && <LiveRoute />}
                                {route === "people" && <PeopleRoute />}
                                {route === "analytics" && <AnalyticsRoute />}
                                {route === "settings" && <SettingsRoute />}
                            </Suspense>
                        </ErrorBoundary>
                    </motion.div>
                </AnimatePresence>
            </main>

            <CommandPalette onNavigate={setRoute} />
            <ErrorBoundary area="summary">
                <SummaryDialog />
            </ErrorBoundary>
        </div>
    );
}

function SidecarBanner() {
    const { t } = useTranslation();
    return (
        <div className="flex shrink-0 items-center gap-2.5 border-b border-warning/30 bg-warning/10 px-4 py-2">
            <AlertTriangle className="size-4 shrink-0 text-warning" />
            <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-warning">{t("connection.sidecarDown")}</p>
                <p className="truncate text-[0.6875rem] text-fg-muted">{t("connection.sidecarDownHint")}</p>
            </div>
            <Button
                size="sm"
                variant="soft"
                onClick={() => void invoke("restart_sidecar").catch(() => undefined)}
            >
                {t("connection.restartService")}
            </Button>
        </div>
    );
}

function RouteFallback() {
    return (
        <div className="flex h-full flex-col gap-3 p-5" aria-busy="true">
            <div className="h-8 w-48 animate-pulse rounded-[--radius-chip] bg-panel-alt" />
            <div className="flex-1 animate-pulse rounded-[--radius-card] bg-panel-alt" />
        </div>
    );
}

/**
 * A sidecar-reported failure. Distinct from the "service is down" banner:
 * here the service is alive but something it attempted has failed, and the
 * message was previously stored in the app store and never shown.
 */
function ErrorBanner({ message }: { message: string }) {
    const { t } = useTranslation();
    const setError = useAppStore((s) => s.setSidecarError);

    return (
        <div
            role="alert"
            className="flex shrink-0 items-center gap-2.5 border-b border-danger/30 bg-danger/10 px-4 py-2"
        >
            <AlertTriangle className="size-4 shrink-0 text-danger" />
            <p className="min-w-0 flex-1 truncate text-xs text-fg" title={message}>
                {message}
            </p>
            <Button size="sm" variant="ghost" onClick={() => setError(null)}>
                {t("common.dismiss")}
            </Button>
        </div>
    );
}

