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

    return (
        <div className="flex h-screen flex-col overflow-hidden">
            <Titlebar>
                <span className="select-none text-[0.8125rem] font-bold tracking-wide text-fg">
                    TikSee
                </span>
                <nav className="no-drag flex items-center gap-0.5" aria-label={t("nav.live")}>
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
                            <span className="hidden @2xl:inline">{t(`nav.${id}`)}</span>
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

            {!sidecarConnected && <SidecarBanner />}

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
