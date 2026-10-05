import { invoke } from "@tauri-apps/api/core";
import type { ConnectionStatus } from "@tiksee/core";
import { Button, StatusPill, cn } from "@tiksee/ui";
import { LogIn, LogOut, Play, Square, UserCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { sidecarClient } from "../lib/sidecar-client.js";
import { MAIN_STREAM, useAppStore } from "../store/app-store.js";
import { useSettingsUpdate } from "../hooks/use-settings.js";

const BUSY_STATES = new Set<ConnectionStatus["state"]>(["connecting", "reconnecting", "live"]);

export function ConnectionBar({ status }: { status: ConnectionStatus }) {
    const { t } = useTranslation();
    const update = useSettingsUpdate();
    const connection = useAppStore((s) => s.settings.connection);
    const waitUntilLive = useAppStore((s) => s.settings.behaviour.waitUntilLive);
    const hasSession = useAppStore((s) => s.hasTikTokSession);
    const sidecarConnected = useAppStore((s) => s.sidecarConnected);
    const clearEvents = useAppStore((s) => s.clearEvents);
    const setHasSession = useAppStore((s) => s.setHasTikTokSession);

    const [handle, setHandle] = useState(connection.username);
    const busy = BUSY_STATES.has(status.state);
    const live = status.state === "live";

    const onSubmit = (event: FormEvent) => {
        event.preventDefault();
        if (busy) {
            sidecarClient.send({ type: "disconnect", streamId: MAIN_STREAM });
            return;
        }
        const username = handle.trim().replace(/^@/, "");
        if (username === "") {
            toast.error(t("connection.usernameLabel"));
            return;
        }
        update("connection", { username });
        clearEvents(MAIN_STREAM);
        sidecarClient.send({
            type: "connect",
            streamId: MAIN_STREAM,
            username,
            driver: connection.driver,
            waitUntilLive,
        });
    };

    return (
        <form onSubmit={onSubmit} className="flex items-center gap-2">
            <div className="relative">
                <span
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-fg-subtle"
                    aria-hidden
                >
                    @
                </span>
                <input
                    value={handle}
                    onChange={(event) => setHandle(event.target.value)}
                    disabled={busy}
                    placeholder={t("connection.usernamePlaceholder").replace("@", "")}
                    aria-label={t("connection.usernameLabel")}
                    spellCheck={false}
                    autoCapitalize="none"
                    className={cn(
                        "no-drag h-9 w-44 rounded-[--radius-control] bg-panel-alt pl-7 pr-3 text-sm text-fg",
                        "border border-border outline-none placeholder:text-fg-subtle",
                        "transition-[border-color,box-shadow] duration-[--dur-fast]",
                        "focus:border-accent focus:ring-2 focus:ring-ring/40",
                        "disabled:opacity-60",
                    )}
                />
            </div>

            <Button
                type="submit"
                size="md"
                variant={live ? "danger" : "primary"}
                loading={status.state === "connecting"}
                disabled={!sidecarConnected}
                icon={live ? <Square /> : <Play />}
            >
                {busy ? t("connection.disconnect") : t("connection.connect")}
            </Button>

            <StatusPill
                tone={
                    live
                        ? "success"
                        : status.state === "error"
                            ? "danger"
                            : status.state === "connecting" || status.state === "reconnecting"
                                ? "warning"
                                : "neutral"
                }
                pulse={live}
            >
                {t(`connection.state.${status.state}`)}
            </StatusPill>

            {typeof status.viewerCount === "number" && live && (
                <span className="text-xs tabular-nums text-fg-muted">
                    {status.viewerCount.toLocaleString()} {t("stats.viewers").toLowerCase()}
                </span>
            )}

            <Button
                type="button"
                size="icon"
                variant="ghost"
                title={hasSession ? t("connection.signedIn") : t("connection.signIn")}
                aria-label={hasSession ? t("connection.signedIn") : t("connection.signIn")}
                onClick={() => {
                    void invoke("open_tiktok_login").catch(() => toast.error(t("common.error")));
                }}
            >
                {hasSession ? <UserCheck className="text-success" /> : <LogIn />}
            </Button>

            {hasSession && (
                <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    title={t("connection.signOutTikTok")}
                    aria-label={t("connection.signOutTikTok")}
                    onClick={() => {
                        sidecarClient.send({ type: "clearSession" });
                        // Older shells have no clear command; the sidecar copy is gone either way.
                        void invoke("tiktok_session_clear").catch(() => undefined);
                        setHasSession(false);
                        toast.success(t("connection.signedOut"));
                    }}
                >
                    <LogOut />
                </Button>
            )}
        </form>
    );
}
