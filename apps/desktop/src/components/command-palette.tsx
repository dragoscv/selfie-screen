import { invoke } from "@tauri-apps/api/core";
import { cn } from "@tiksee/ui";
import { Command } from "cmdk";
import {
    BarChart3,
    Layers,
    Moon,
    Palette,
    Play,
    Radio,
    ScanEye,
    Settings as SettingsIcon,
    Square,
    Sun,
    Users,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useSettingsUpdate } from "../hooks/use-settings.js";
import { sidecarClient } from "../lib/sidecar-client.js";
import { MAIN_STREAM, selectStatus, useAppStore } from "../store/app-store.js";
import type { RouteId } from "./app-shell.js";

export function CommandPalette({
    onNavigate,
}: {
    onNavigate: (route: RouteId) => void;
}) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const update = useSettingsUpdate();
    const appearance = useAppStore((s) => s.settings.appearance);
    const overlay = useAppStore((s) => s.settings.overlay);
    const status = useAppStore(selectStatus(MAIN_STREAM));

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "k" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                setOpen((value) => !value);
            }
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, []);

    const run = (action: () => void) => {
        setOpen(false);
        // Defer so the dialog's exit animation isn't competing with a route swap.
        window.setTimeout(action, 0);
    };

    const live = status.state === "live" || status.state === "connecting";

    return (
        <Command.Dialog
            open={open}
            onOpenChange={setOpen}
            label={t("nav.commandPalette")}
            className={cn(
                "fixed left-1/2 top-[18%] z-50 w-[min(34rem,90vw)] -translate-x-1/2",
                "surface overflow-hidden rounded-card p-0 shadow-2xl",
                "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
            )}
            overlayClassName="fixed inset-0 z-40 bg-[var(--overlay-scrim)] backdrop-blur-sm"
        >
            <Command.Input
                placeholder={`${t("settings.search")}…`}
                className={cn(
                    "w-full border-b border-border bg-transparent px-4 py-3.5 text-sm text-fg",
                    "outline-none placeholder:text-fg-subtle",
                )}
            />
            <Command.List className="max-h-80 overflow-y-auto p-2">
                <Command.Empty className="px-3 py-6 text-center text-xs text-fg-muted">
                    {t("feed.noResults")}
                </Command.Empty>

                <Group heading={t("nav.live")}>
                    <Item icon={<Radio />} onSelect={() => run(() => onNavigate("live"))}>
                        {t("nav.live")}
                    </Item>
                    <Item icon={<Users />} onSelect={() => run(() => onNavigate("people"))}>
                        {t("nav.people")}
                    </Item>
                    <Item icon={<BarChart3 />} onSelect={() => run(() => onNavigate("analytics"))}>
                        {t("nav.analytics")}
                    </Item>
                    <Item icon={<ScanEye />} onSelect={() => run(() => onNavigate("vision"))}>
                        {t("nav.vision")}
                    </Item>
                    <Item icon={<SettingsIcon />} onSelect={() => run(() => onNavigate("settings"))}>
                        {t("nav.settings")}
                    </Item>
                </Group>

                <Group heading={t("connection.title")}>
                    {live ? (
                        <Item
                            icon={<Square />}
                            onSelect={() =>
                                run(() => sidecarClient.send({ type: "disconnect", streamId: MAIN_STREAM }))
                            }
                        >
                            {t("connection.disconnect")}
                        </Item>
                    ) : (
                        <Item
                            icon={<Play />}
                            onSelect={() =>
                                run(() => {
                                    const username = useAppStore.getState().settings.connection.username;
                                    if (username !== "") {
                                        sidecarClient.send({
                                            type: "connect",
                                            streamId: MAIN_STREAM,
                                            username,
                                            driver: "connector",
                                            waitUntilLive: false,
                                        });
                                    } else {
                                        onNavigate("live");
                                    }
                                })
                            }
                        >
                            {t("connection.connect")}
                        </Item>
                    )}
                    <Item
                        icon={<Layers />}
                        onSelect={() =>
                            run(() => {
                                const next = !overlay.enabled;
                                update("overlay", { enabled: next });
                                void invoke("toggle_overlay", { show: next }).catch(() => undefined);
                            })
                        }
                    >
                        {t("nav.toggleOverlay")}
                    </Item>
                </Group>

                <Group heading={t("settings.sections.appearance")}>
                    <Item
                        icon={appearance.mode === "dark" ? <Sun /> : <Moon />}
                        onSelect={() =>
                            run(() =>
                                update("appearance", { mode: appearance.mode === "dark" ? "light" : "dark" }),
                            )
                        }
                    >
                        {t(`settings.appearance.mode.${appearance.mode === "dark" ? "light" : "dark"}`)}
                    </Item>
                    <Item icon={<Palette />} onSelect={() => run(() => onNavigate("settings"))}>
                        {t("settings.appearance.accent")}
                    </Item>
                </Group>
            </Command.List>
        </Command.Dialog>
    );
}

function Group({ heading, children }: { heading: string; children: ReactNode }) {
    return (
        <Command.Group
            heading={heading}
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[0.625rem] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-fg-subtle"
        >
            {children}
        </Command.Group>
    );
}

function Item({
    icon,
    children,
    onSelect,
}: {
    icon: ReactNode;
    children: ReactNode;
    onSelect: () => void;
}) {
    return (
        <Command.Item
            onSelect={onSelect}
            className={cn(
                "flex cursor-pointer items-center gap-2.5 rounded-chip px-2.5 py-2 text-sm text-fg",
                "outline-none transition-colors duration-100",
                "data-[selected=true]:bg-accent-subtle data-[selected=true]:text-accent",
                "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-subtle",
                "data-[selected=true]:[&_svg]:text-accent",
            )}
        >
            {icon}
            {children}
        </Command.Item>
    );
}
