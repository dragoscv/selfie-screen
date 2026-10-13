import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { REMOTE_ACTIONS, type CameraRemoteSettings, type RemoteAction } from "@tiksee/core";
import { cn, SwitchRow } from "@tiksee/ui";
import { Gamepad2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

interface HidPress {
    device: string;
    key: string;
}

type Selfie = CameraRemoteSettings["selfie"];

/** Readable name for a learned key (`vk:26` -> "↑", `hid:...` -> "Shutter"). */
function keyLabel(key: string, t: (k: string) => string): string {
    const names: Record<string, string> = { "vk:26": "↑", "vk:28": "↓", "vk:25": "←", "vk:27": "→", "vk:0D": "OK", "vk:AF": "Vol +", "vk:AE": "Vol −" };
    if (names[key]) return names[key];
    return key.startsWith("hid:") ? t("cameraRemote.selfie.shutterKey") : key;
}

/**
 * Phone selfie-stick remote (Bluetooth HID: arrows, OK, shutter) as camera
 * buttons. Pair it with Windows, press Learn, press a button, pick what it does.
 * Only the learned device is listened to, so the real keyboard never zooms.
 */
export function SelfieRemote({ selfie, onChange }: { selfie: Selfie; onChange: (s: Selfie) => void }) {
    const { t } = useTranslation();
    const [learning, setLearning] = useState(false);
    const [pending, setPending] = useState<HidPress | null>(null);

    useEffect(() => {
        if (!learning) return;
        let disposed = false;
        let stop: (() => void) | undefined;
        void invoke("camera_hid_learn", { on: true }).catch(() => undefined);
        void listen<HidPress>("camera://hid-learn", (e) => setPending(e.payload))
            .then((fn) => {
                if (disposed) fn();
                else stop = fn;
            })
            .catch(() => undefined);
        return () => {
            disposed = true;
            stop?.();
            void invoke("camera_hid_learn", { on: false }).catch(() => undefined);
        };
    }, [learning]);

    const assign = (action: RemoteAction) => {
        if (!pending) return;
        // A different device replaces the old remote and its bindings.
        const base = pending.device === selfie.device ? selfie.bindings : [];
        const bindings = [...base.filter((b) => b.key !== pending.key), { key: pending.key, action }];
        onChange({ ...selfie, enabled: true, device: pending.device, bindings });
        setPending(null);
    };

    return (
        <section className="flex flex-col gap-2 rounded-control border border-border/60 px-2.5 py-2" aria-labelledby="selfie-title">
            <h2 id="selfie-title" className="flex items-center gap-1.5 text-xs font-semibold text-fg">
                <Gamepad2 className="size-3.5" aria-hidden />
                {t("cameraRemote.selfie.title")}
            </h2>
            <p className="text-[0.6875rem] text-fg-muted">{t("cameraRemote.selfie.hint")}</p>
            <SwitchRow
                label={t("cameraRemote.selfie.enabled")}
                checked={selfie.enabled}
                disabled={selfie.device === ""}
                onChange={(enabled) => onChange({ ...selfie, enabled })}
            />
            <button
                type="button"
                aria-pressed={learning}
                onClick={() => {
                    setPending(null);
                    setLearning((v) => !v);
                }}
                className={cn(
                    "no-drag min-h-10 rounded-control px-3 py-2 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    learning ? "bg-accent text-accent-fg" : "bg-panel-alt text-fg hover:bg-accent-subtle hover:text-accent",
                )}
            >
                {learning ? t("cameraRemote.selfie.learnStop") : t("cameraRemote.selfie.learn")}
            </button>
            {learning && (
                <div className="flex flex-col gap-1.5" aria-live="polite">
                    <p className="text-[0.6875rem] text-fg">
                        {pending ? t("cameraRemote.selfie.pick", { key: keyLabel(pending.key, t) }) : t("cameraRemote.selfie.press")}
                    </p>
                    {pending && (
                        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("cameraRemote.selfie.pickLabel")}>
                            {REMOTE_ACTIONS.map((a) => (
                                <button
                                    key={a}
                                    type="button"
                                    onClick={() => assign(a)}
                                    className="no-drag rounded-chip bg-panel-alt px-2.5 py-1.5 text-[0.6875rem] text-fg outline-none hover:bg-accent-subtle hover:text-accent focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                    {t(`cameraRemote.actions.${a}`)}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}
            {selfie.bindings.length > 0 ? (
                <ul className="flex flex-col gap-1">
                    {selfie.bindings.map((b) => (
                        <li key={b.key} className="flex items-center gap-2 text-[0.6875rem]">
                            <span className="w-14 rounded-chip bg-panel-alt px-2 py-1 text-center font-semibold text-fg">{keyLabel(b.key, t)}</span>
                            <span className="flex-1 text-fg-muted">{t(`cameraRemote.actions.${b.action}`)}</span>
                            <button
                                type="button"
                                aria-label={t("cameraRemote.selfie.remove", { key: keyLabel(b.key, t) })}
                                onClick={() => onChange({ ...selfie, bindings: selfie.bindings.filter((x) => x.key !== b.key) })}
                                className="no-drag grid size-8 place-items-center rounded-full text-fg-subtle outline-none hover:text-danger focus-visible:ring-2 focus-visible:ring-ring"
                            >
                                <Trash2 className="size-3.5" aria-hidden />
                            </button>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="text-[0.6875rem] text-fg-subtle">{t("cameraRemote.selfie.none")}</p>
            )}
            <p className="text-[0.6875rem] text-fg-subtle">{t("cameraRemote.selfie.cameraNote")}</p>
        </section>
    );
}
