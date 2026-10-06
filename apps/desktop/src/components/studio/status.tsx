import { invoke, isTauri } from "@tauri-apps/api/core";
import { motion, useReducedMotion } from "motion/react";
import { Bluetooth, BluetoothOff, Camera, Gauge, Video } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { FOCUS_RING, GLASS, useFrame, useStudio } from "./context.js";
import { visionLatency } from "./geometry.js";

function Tally() {
    const { frames } = useStudio();
    const { t } = useTranslation();
    const reduced = useReducedMotion();
    const recording = useFrame(frames, (i) => i?.camera.recording ?? false);
    return (
        <span className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[0.6875rem] font-bold tracking-wider ${recording ? "bg-red-600 text-white" : "bg-white/10 text-white/80"}`}>
            <motion.span
                className={`size-2 rounded-full ${recording ? "bg-white" : "bg-white/50"}`}
                animate={recording && !reduced ? { opacity: [1, 0.25, 1] } : { opacity: 1 }}
                transition={recording && !reduced ? { duration: 1.2, repeat: Infinity } : { duration: 0 }}
                aria-hidden
            />
            {recording ? t("studio.status.rec") : t("studio.status.standby")}
        </span>
    );
}

function VcamChip() {
    const { frames } = useStudio();
    const { t } = useTranslation();
    const [busy, setBusy] = useState(false);
    const vcam = useFrame(frames, (i) => {
        const v = i?.vcam;
        if (!v) return "off";
        const size = v.consumerSize ? ` ${v.consumerSize[0]}×${v.consumerSize[1]}` : "";
        return `${v.state}|${Math.round(v.fps)}|${size}`;
    });
    const [state = "off", fps = "0", size = ""] = vcam.split("|");

    if (state === "unregistered") {
        const register = async () => {
            if (!isTauri()) return;
            setBusy(true);
            try {
                await invoke<number>("vcam_register");
                toast.success(t("studio.status.vcamRegistered"));
            } catch (e) {
                toast.error(t("studio.status.vcamRegisterFailed", { error: String(e) }));
            } finally {
                setBusy(false);
            }
        };
        return (
            <button
                type="button"
                disabled={busy}
                onClick={() => void register()}
                title={t("studio.status.vcamRegister")}
                className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-amber-400/90 px-2.5 py-1 text-[0.6875rem] font-semibold text-neutral-950 hover:bg-amber-300 disabled:opacity-60 ${FOCUS_RING}`}
            >
                <Video className="size-3.5" aria-hidden />
                <span className="hidden @[26rem]/studio:inline">{t("studio.status.vcamRegister")}</span>
            </button>
        );
    }
    const tone =
        state === "streaming" ? "bg-emerald-500/25 text-emerald-100" : state === "error" ? "bg-rose-500/30 text-rose-100" : "bg-white/10 text-white/80";
    const label = t(`studio.status.vcam.${state}`, { fps, size });
    return (
        <span title={label} className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[0.6875rem] font-medium tabular-nums ${tone}`}>
            <Video className="size-3.5" aria-hidden />
            {/* Narrow windows: icon + colour only, full text in the tooltip and for screen readers. */}
            <span className="sr-only @[30rem]/studio:not-sr-only">{label}</span>
        </span>
    );
}

function BleChip() {
    const { frames } = useStudio();
    const { t } = useTranslation();
    const connected = useFrame(frames, (i) => i?.camera.connected ?? false);
    const Icon = connected ? Bluetooth : BluetoothOff;
    return (
        <span title={t(connected ? "studio.status.bleOn" : "studio.status.bleOff")} className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.6875rem] font-medium ${connected ? "bg-sky-500/25 text-sky-100" : "bg-white/10 text-white/75"}`}>
            <Icon className="size-3.5" aria-hidden />
            <Camera className="size-3.5" aria-hidden />
            <span className="sr-only">{t(connected ? "studio.status.bleOn" : "studio.status.bleOff")}</span>
        </span>
    );
}

function Perf() {
    const { frames } = useStudio();
    const { t } = useTranslation();
    const perf = useFrame(frames, (i) => {
        const p = i?.snapshot.perf;
        return p ? `${Math.round(p.renderFps)}|${Math.round(p.cameraFps)}|${visionLatency(p.visionMs).toFixed(0)}` : "0|0|0";
    });
    const [render = "0", cam = "0", ms = "0"] = perf.split("|");
    return (
        <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap px-1.5 text-[0.6875rem] tabular-nums text-white/85" title={t("studio.status.perfTitle")}>
            <Gauge className="size-3.5" aria-hidden />
            <span className="@[24rem]/studio:hidden">{render}</span>
            <span className="hidden @[24rem]/studio:inline">{t("studio.status.perf", { render, cam, ms })}</span>
        </span>
    );
}

/** Top status capsule. */
export function StatusBar() {
    const { t } = useTranslation();
    return (
        <div role="status" aria-label={t("studio.status.label")} className={`${GLASS} flex max-w-full items-center gap-1.5 overflow-hidden rounded-full p-1`}>
            <Tally />
            <VcamChip />
            <BleChip />
            <Perf />
        </div>
    );
}
