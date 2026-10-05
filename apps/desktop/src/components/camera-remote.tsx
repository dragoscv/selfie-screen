import { Button, Card, StatusPill } from "@tiksee/ui";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Aperture, Bluetooth, Circle, Focus, Minus, Plus, ScanFace, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

type BleAction = "zoom" | "focus" | "af" | "photo" | "record" | "pair";

interface BleState {
    status: "searching" | "pairable" | "connected" | "error";
    address: string | null;
    recording: boolean;
    focused: boolean;
    error: string | null;
}

const send = (action: BleAction, value = 0) =>
    invoke("camera_ble", { action, value }).catch((error: unknown) => {
        toast.error(String(error));
    });

/** Held while the pointer/key is down; released (value 0) on up/leave/blur. */
function HoldButton({
    action,
    dir,
    label,
    icon,
    disabled,
}: {
    action: "zoom" | "focus";
    dir: 1 | -1;
    label: string;
    icon: ReactNode;
    disabled: boolean;
}) {
    const [held, setHeld] = useState(false);
    const start = () => {
        if (held) return;
        setHeld(true);
        void send(action, dir);
    };
    const stop = () => {
        if (!held) return;
        setHeld(false);
        void send(action, 0);
    };
    const onKey = (down: boolean) => (e: KeyboardEvent) => {
        if (e.key !== " " && e.key !== "Enter") return;
        e.preventDefault();
        if (down) start();
        else stop();
    };
    return (
        <Button
            variant={held ? "primary" : "outline"}
            size="md"
            icon={icon}
            disabled={disabled}
            aria-pressed={held}
            onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                start();
            }}
            onPointerUp={stop}
            onPointerCancel={stop}
            onLostPointerCapture={stop}
            onKeyDown={onKey(true)}
            onKeyUp={onKey(false)}
            onBlur={stop}
        >
            {label}
        </Button>
    );
}

export function CameraRemote() {
    const { t } = useTranslation();
    const [state, setState] = useState<BleState | null>(null);

    useEffect(() => {
        let disposed = false;
        let unlisten: (() => void) | undefined;
        void listen<BleState>("camera://ble", (e) => setState(e.payload)).then((fn) => {
            if (disposed) fn();
            else unlisten = fn;
        });
        return () => {
            disposed = true;
            unlisten?.();
        };
    }, []);

    const connected = state?.status === "connected";
    const tone = connected ? "success" : state?.status === "error" ? "danger" : state?.status === "pairable" ? "accent" : "neutral";
    const status = t(`settings.studio.remote.status.${state?.status ?? "searching"}`);

    return (
        <Card
            title={t("settings.studio.remote.title")}
            subtitle={t("settings.studio.remote.hint")}
            icon={<Bluetooth />}
            tint="var(--kind-share)"
        >
            <div className="flex flex-wrap items-center gap-2" aria-live="polite">
                <StatusPill tone={tone} pulse={state?.status === "searching" || state?.recording === true}>
                    {status}
                </StatusPill>
                {state?.address ? <span className="text-xs text-fg-muted">{state.address}</span> : null}
                {state?.recording ? <StatusPill tone="danger">{t("settings.studio.remote.recording")}</StatusPill> : null}
                {state?.error && !connected ? <span className="text-xs text-fg-muted">{state.error}</span> : null}
            </div>

            {!connected ? (
                <div className="flex flex-col gap-2 text-sm text-fg-muted">
                    <ol className="list-decimal space-y-1 pl-5">
                        <li>{t("settings.studio.remote.step1")}</li>
                        <li>{t("settings.studio.remote.step2")}</li>
                        <li>{t("settings.studio.remote.step3")}</li>
                        <li>{t("settings.studio.remote.step4")}</li>
                    </ol>
                    <div>
                        <Button variant="soft" icon={<Bluetooth />} onClick={() => void send("pair")}>
                            {t("settings.studio.remote.pair")}
                        </Button>
                    </div>
                </div>
            ) : null}

            <div className="grid grid-cols-2 gap-2">
                <HoldButton action="zoom" dir={-1} label={t("settings.studio.remote.zoomOut")} icon={<ZoomOut />} disabled={!connected} />
                <HoldButton action="zoom" dir={1} label={t("settings.studio.remote.zoomIn")} icon={<ZoomIn />} disabled={!connected} />
                <HoldButton action="focus" dir={-1} label={t("settings.studio.remote.focusNear")} icon={<Minus />} disabled={!connected} />
                <HoldButton action="focus" dir={1} label={t("settings.studio.remote.focusFar")} icon={<Plus />} disabled={!connected} />
            </div>
            <div className="flex flex-wrap gap-2">
                <Button variant="outline" icon={<ScanFace />} disabled={!connected} onClick={() => void send("af")}>
                    {t("settings.studio.remote.af")}
                    {state?.focused ? <Focus aria-label={t("settings.studio.remote.focused")} /> : null}
                </Button>
                <Button variant="outline" icon={<Aperture />} disabled={!connected} onClick={() => void send("photo")}>
                    {t("settings.studio.remote.photo")}
                </Button>
                <Button
                    variant={state?.recording ? "danger" : "outline"}
                    icon={<Circle />}
                    disabled={!connected}
                    aria-pressed={state?.recording ?? false}
                    onClick={() => void send("record")}
                >
                    {state?.recording ? t("settings.studio.remote.stop") : t("settings.studio.remote.record")}
                </Button>
            </div>
        </Card>
    );
}
