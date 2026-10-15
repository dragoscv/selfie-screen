import { invoke, isTauri } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { load } from "@tauri-apps/plugin-store";
import {
    NOTE_NAMES,
    VOCAL_PRESETS,
    VOCAL_SCALES,
    applyVocalPreset,
    noteName,
    parseSettings,
    vocalParamsSchema,
    type Settings,
    type VocalParams,
    type VocalSettings,
} from "@tiksee/core";
import { ChipSelector, SliderRow, SwitchRow, applyAppearance, cn, transitions } from "@tiksee/ui";
import { AudioLines, GripHorizontal, Mic2, Pin, PinOff, Power, X } from "lucide-react";
import { AnimatePresence, LayoutGroup, MotionConfig, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Toaster, toast } from "sonner";

import { setLocale } from "../../i18n/index.js";
import { activeParams, type StripInfo, type VocalMeter, type VocalStatus } from "../../lib/vocal.js";
import { NoteLane } from "./note-lane.js";
import { EqCurve, KeyWheel, LevelBar, Tuner } from "./visuals.js";

const TABS = ["tune", "voice", "fx", "harmony", "setup"] as const;
type Tab = (typeof TABS)[number];

const SCALE_MASKS: Record<(typeof VOCAL_SCALES)[number], number[]> = {
    chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
    harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
    melodicMinor: [0, 2, 3, 5, 7, 9, 11],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    phrygian: [0, 1, 3, 5, 7, 8, 10],
    lydian: [0, 2, 4, 6, 7, 9, 11],
    mixolydian: [0, 2, 4, 5, 7, 9, 10],
    locrian: [0, 1, 3, 5, 6, 8, 10],
    majorPentatonic: [0, 2, 4, 7, 9],
    minorPentatonic: [0, 3, 5, 7, 10],
    blues: [0, 3, 5, 6, 7, 10],
};

function scaleMask(key: number, scale: (typeof VOCAL_SCALES)[number]): number {
    return SCALE_MASKS[scale].reduce((m, s) => m | (1 << ((s + key) % 12)), 0);
}

/** Polls the shell meter at display rate into a ref (no React render per frame). */
function useMeter(): React.RefObject<VocalMeter | null> {
    const ref = useRef<VocalMeter | null>(null);
    useEffect(() => {
        if (!isTauri()) return;
        let stop = false;
        let busy = false;
        const id = window.setInterval(() => {
            if (busy || stop) return;
            busy = true;
            void invoke<VocalMeter>("vocal_meter")
                .then((m) => {
                    ref.current = m;
                })
                .catch(() => undefined)
                .finally(() => {
                    busy = false;
                });
        }, 16);
        return () => {
            stop = true;
            window.clearInterval(id);
        };
    }, []);
    return ref;
}

/**
 * Detached vocal window (label `vocal`): controls and visuals only. The main
 * window owns `settings.vocal` and drives the engine in the shell, so closing
 * this window never stops the processing.
 */
export function VocalWindow() {
    const { t } = useTranslation();
    const [settings, setSettings] = useState<VocalSettings | null>(null);
    const [tab, setTab] = useState<Tab>("tune");
    const [status, setStatus] = useState<VocalStatus | null>(null);
    const meterRef = useMeter();
    /** 10 Hz snapshot for text (the canvas/needles read the ref at 60 Hz). */
    const [view, setView] = useState<{ heard: number | null; target: number; latency: number; key: VocalMeter["key"] }>({
        heard: null,
        target: 0,
        latency: 0,
        key: null,
    });
    const heard = view.heard;
    const detectedKey = view.key;
    const settingsRef = useRef<VocalSettings | null>(null);

    useEffect(() => {
        let disposed = false;
        let stop: (() => void) | undefined;
        void (async () => {
            const store = isTauri() ? await load("settings.json", { autoSave: false }).catch(() => null) : null;
            const all: Settings = parseSettings(await store?.get("settings").catch(() => undefined));
            if (disposed) return;
            applyAppearance({ ...all.appearance, surface: "solid" });
            setLocale(all.appearance.locale);
            setSettings((s) => s ?? all.vocal);
        })();
        void listen<VocalSettings>("vocal://settings", (e) => setSettings(e.payload))
            .then((fn) => {
                if (disposed) fn();
                else stop = fn;
            })
            .catch(() => undefined);
        return () => {
            disposed = true;
            stop?.();
        };
    }, []);

    // Status at 2 Hz; the sung note, latency and detected key at 10 Hz (cheap renders).
    // Auto key: follow the music strip's key when it is confident.
    useEffect(() => {
        if (!isTauri()) return;
        const s = window.setInterval(() => void invoke<VocalStatus>("vocal_status").then(setStatus).catch(() => undefined), 500);
        const h = window.setInterval(() => {
            const m = meterRef.current;
            setView({
                heard: m?.voiced ? ((Math.round(m.targetMidi) % 12) + 12) % 12 : null,
                target: m?.targetMidi ?? 0,
                latency: m?.latencyMs ?? 0,
                key: m?.key ?? null,
            });
            const v = settingsRef.current;
            if (v?.autoKey && m?.key) {
                const [key, minor, conf] = m.key;
                const scale = minor ? "minor" : "major";
                const p = activeParams(v);
                if (conf > 0.6 && (p.tune.key !== key || p.tune.scale !== scale)) {
                    const next = { ...p, tune: { ...p.tune, key, scale } } as VocalParams;
                    const patchObj: Partial<VocalSettings> = v.slot === "b" ? { paramsB: next } : { params: next };
                    setSettings((cur) => (cur ? { ...cur, ...patchObj } : cur));
                    void emitTo("main", "vocal://patch", patchObj).catch(() => undefined);
                }
            }
        }, 100);
        return () => {
            window.clearInterval(s);
            window.clearInterval(h);
        };
    }, [meterRef]);

    useEffect(() => {
        settingsRef.current = settings;
    }, [settings]);

    const onTop = settings?.alwaysOnTop ?? true;
    useEffect(() => {
        void getCurrentWindow()
            .setAlwaysOnTop(onTop)
            .catch(() => undefined);
    }, [onTop]);

    const patch = (p: Partial<VocalSettings>) => {
        setSettings((s) => (s ? { ...s, ...p } : s));
        void emitTo("main", "vocal://patch", p).catch(() => undefined);
    };

    const params = settings ? activeParams(settings) : null;
    const setParams = (next: VocalParams) => {
        if (!settings) return;
        patch(settings.slot === "b" ? { paramsB: next } : { params: next });
    };
    const tune = (p: Partial<VocalParams["tune"]>) => params && setParams({ ...params, tune: { ...params.tune, ...p } });
    const chain = (p: Partial<VocalParams["chain"]>) => params && setParams({ ...params, chain: { ...params.chain, ...p } });

    const mask = useMemo(() => (params ? scaleMask(params.tune.key, params.tune.scale) & ~params.tune.bypass : 0xfff), [params]);
    const running = status?.running === true;

    return (
        <MotionConfig reducedMotion="user" transition={transitions.normal}>
            <div className="flex h-screen flex-col overflow-hidden bg-bg text-fg">
                <header className="drag-region flex h-10 shrink-0 items-center gap-2 border-b border-fg/10 px-3">
                    <GripHorizontal className="size-3.5 text-fg-subtle" aria-hidden />
                    <AudioLines className="size-4 text-accent" aria-hidden />
                    <h1 className="text-[0.6875rem] font-bold uppercase tracking-wider text-fg">{t("vocal.title")}</h1>
                    <motion.span
                        layout
                        className={cn(
                            "ml-2 rounded-full px-2 py-0.5 text-[0.625rem] font-semibold",
                            running ? "bg-success/15 text-success" : "bg-fg/10 text-fg-subtle",
                        )}
                        aria-live="polite"
                    >
                        {running
                            ? t("vocal.live", { ms: view.latency.toFixed(1), sr: (status.sampleRate / 1000).toFixed(0), block: status.block })
                            : status?.available === false
                              ? t("vocal.noVoicemeeter")
                              : t("vocal.off")}
                    </motion.span>
                    <div className="no-drag ml-auto flex items-center gap-0.5">
                        {settings && (
                            <button
                                type="button"
                                aria-pressed={settings.enabled}
                                onClick={() => patch({ enabled: !settings.enabled })}
                                title={t("vocal.power")}
                                aria-label={t("vocal.power")}
                                className={cn(
                                    "grid size-8 place-items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                                    settings.enabled ? "bg-accent text-accent-fg" : "text-fg-subtle hover:text-fg",
                                )}
                            >
                                <Power className="size-3.5" aria-hidden />
                            </button>
                        )}
                        <button
                            type="button"
                            aria-pressed={onTop}
                            onClick={() => patch({ alwaysOnTop: !onTop })}
                            aria-label={t("cameraRemote.onTop")}
                            title={t("cameraRemote.onTop")}
                            className={cn(
                                "grid size-8 place-items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                                onTop ? "text-accent" : "text-fg-subtle hover:text-fg",
                            )}
                        >
                            {onTop ? <Pin className="size-3.5" aria-hidden /> : <PinOff className="size-3.5" aria-hidden />}
                        </button>
                        <button
                            type="button"
                            onClick={() => void getCurrentWindow().close()}
                            aria-label={t("common.close")}
                            className="grid size-8 place-items-center rounded-full text-fg-subtle outline-none transition-colors hover:text-danger focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            <X className="size-3.5" aria-hidden />
                        </button>
                    </div>
                </header>

                {/* Stage: note lane + tuner + meters, always visible. */}
                <section className="relative flex h-44 shrink-0 gap-3 border-b border-fg/10 px-3 py-2">
                    <div className="relative min-w-0 flex-1 overflow-hidden rounded-chip bg-panel-alt/40">
                        <NoteLane meterRef={meterRef} allowedMask={mask} label={t("vocal.lane")} />
                        {!running && (
                            <div className="absolute inset-0 grid place-items-center text-xs text-fg-subtle">
                                <span className="flex items-center gap-2">
                                    <Mic2 className="size-4" aria-hidden />
                                    {t("vocal.laneIdle")}
                                </span>
                            </div>
                        )}
                    </div>
                    <div className="flex shrink-0 flex-col items-center justify-between">
                        <Tuner meterRef={meterRef} label={t("vocal.tuner")} />
                        <div className="flex gap-2">
                            <LevelBar meterRef={meterRef} pick={(m) => m.inputDb} label={t("vocal.in")} />
                            <LevelBar meterRef={meterRef} pick={(m) => m.outputDb} label={t("vocal.out")} />
                            <LevelBar meterRef={meterRef} pick={(m) => -m.compReductionDb - 0.0001} label={t("vocal.gr")} />
                        </div>
                    </div>
                </section>

                {/* Tabs with a morphing indicator. */}
                <LayoutGroup>
                    <nav role="tablist" aria-label={t("vocal.title")} className="flex shrink-0 gap-1 px-3 pt-2">
                        {TABS.map((id) => (
                            <button
                                key={id}
                                type="button"
                                role="tab"
                                aria-selected={tab === id}
                                onClick={() => setTab(id)}
                                className="relative rounded-full px-3 py-1.5 text-xs font-medium text-fg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring aria-selected:text-accent-fg"
                            >
                                {tab === id && <motion.span layoutId="vocal-tab" className="absolute inset-0 rounded-full bg-accent" transition={{ type: "spring", stiffness: 480, damping: 34 }} />}
                                <span className="relative">{t(`vocal.tabs.${id}`)}</span>
                            </button>
                        ))}
                        {settings && (
                            <div className="ml-auto flex items-center gap-1" role="group" aria-label={t("vocal.ab")}>
                                {(["a", "b"] as const).map((s) => (
                                    <button
                                        key={s}
                                        type="button"
                                        aria-pressed={settings.slot === s}
                                        onClick={() => patch(s === "b" && !settings.paramsB ? { slot: s, paramsB: settings.params } : { slot: s })}
                                        className={cn(
                                            "size-7 rounded-full text-[0.6875rem] font-bold uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                            settings.slot === s ? "bg-accent-subtle text-accent" : "text-fg-subtle hover:text-fg",
                                        )}
                                    >
                                        {s}
                                    </button>
                                ))}
                            </div>
                        )}
                    </nav>
                </LayoutGroup>

                <main className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
                    {settings && params ? (
                        <AnimatePresence mode="wait" initial={false}>
                            <motion.div
                                key={tab}
                                role="tabpanel"
                                initial={{ opacity: 0, y: 8, filter: "blur(4px)" }}
                                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                                exit={{ opacity: 0, y: -6, filter: "blur(4px)" }}
                                transition={transitions.fast}
                                className="space-y-4"
                            >
                                {tab === "tune" && (
                                    <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
                                        <div className="space-y-2">
                                            <KeyWheel
                                                keyIndex={params.tune.key}
                                                mask={scaleMask(params.tune.key, params.tune.scale)}
                                                bypass={params.tune.bypass}
                                                current={heard}
                                                onKey={(key) => tune({ key })}
                                                onToggle={(pc) => tune({ bypass: params.tune.bypass ^ (1 << pc) })}
                                                label={t("vocal.key")}
                                            />
                                            <p className="text-center text-[0.625rem] text-fg-subtle">{t("vocal.wheelHint")}</p>
                                            <SwitchRow
                                                label={t("vocal.autoKey")}
                                                description={
                                                    detectedKey
                                                        ? t("vocal.detected", {
                                                              key: NOTE_NAMES[detectedKey[0]],
                                                              scale: t(`vocal.scales.${detectedKey[1] ? "minor" : "major"}`),
                                                              conf: Math.round(detectedKey[2] * 100),
                                                          })
                                                        : t("vocal.autoKeyHint")
                                                }
                                                checked={settings.autoKey}
                                                onChange={(autoKey) => patch({ autoKey })}
                                            />
                                        </div>
                                        <div className="space-y-4">
                                            <label className="block space-y-1.5">
                                                <span className="block text-[0.8125rem] text-fg-muted">{t("vocal.scale")}</span>
                                                <select
                                                    value={params.tune.scale}
                                                    onChange={(e) => tune({ scale: e.target.value as (typeof VOCAL_SCALES)[number] })}
                                                    className="w-full rounded-chip border border-border bg-panel-alt px-2.5 py-1.5 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                                >
                                                    {VOCAL_SCALES.map((s) => (
                                                        <option key={s} value={s}>
                                                            {NOTE_NAMES[params.tune.key]} {t(`vocal.scales.${s}`)}
                                                        </option>
                                                    ))}
                                                </select>
                                            </label>
                                            <ChipSelector
                                                label={t("vocal.preset")}
                                                options={VOCAL_PRESETS}
                                                value={"" as (typeof VOCAL_PRESETS)[number]}
                                                onSelect={(p) => setParams(applyVocalPreset(params, p))}
                                                display={(p) => t(`vocal.presets.${p}`)}
                                            />
                                            <SliderRow label={t("vocal.retune")} value={params.tune.retuneMs} min={0} max={400} step={1} format={(v) => (v === 0 ? t("vocal.hard") : `${Math.round(v)} ms`)} onCommit={(retuneMs) => tune({ retuneMs })} />
                                            <SliderRow label={t("vocal.humanize")} value={params.tune.humanize} min={0} max={1} format={(v) => `${Math.round(v * 100)} %`} onCommit={(humanize) => tune({ humanize })} />
                                            <SliderRow label={t("vocal.flex")} value={params.tune.flexCents} min={0} max={100} step={1} format={(v) => `${Math.round(v)} ¢`} onCommit={(flexCents) => tune({ flexCents })} />
                                            <SliderRow label={t("vocal.vibrato")} value={params.tune.vibrato} min={0} max={2} format={(v) => `${Math.round(v * 100)} %`} onCommit={(vibrato) => tune({ vibrato })} />
                                            <SliderRow label={t("vocal.transpose")} value={params.tune.transpose} min={-12} max={12} step={1} format={(v) => `${v > 0 ? "+" : ""}${v} st`} onCommit={(transpose) => tune({ transpose })} />
                                            <ChipSelector label={t("vocal.mode")} options={["live", "natural"] as const} value={params.tune.mode} onSelect={(mode) => tune({ mode })} display={(m) => t(`vocal.modes.${m}`)} />
                                            {params.tune.mode === "natural" && (
                                                <SliderRow label={t("vocal.formant")} value={params.tune.formant} min={-6} max={6} step={0.5} format={(v) => `${v > 0 ? "+" : ""}${v} st`} onCommit={(formant) => tune({ formant })} />
                                            )}
                                            <SwitchRow label={t("vocal.tuneOn")} checked={params.tune.enabled} onChange={(enabled) => tune({ enabled })} />
                                        </div>
                                    </div>
                                )}

                                {tab === "voice" && (
                                    <div className="space-y-4">
                                        <EqCurve chain={params.chain} label={t("vocal.eq")} />
                                        <div className="grid gap-4 sm:grid-cols-2">
                                            <SliderRow label={t("vocal.inputGain")} value={params.chain.inputGainDb} min={-24} max={24} step={0.5} format={(v) => `${v.toFixed(1)} dB`} onCommit={(inputGainDb) => chain({ inputGainDb })} />
                                            <SliderRow label={t("vocal.hpf")} value={params.chain.hpfHz} min={20} max={400} step={1} format={(v) => `${Math.round(v)} Hz`} onCommit={(hpfHz) => chain({ hpfHz })} />
                                            {params.chain.eq.map((b, i) => (
                                                <SliderRow
                                                    key={i}
                                                    label={`${t(`vocal.bands.${i}`)} · ${b.hz >= 1000 ? `${(b.hz / 1000).toFixed(1)} kHz` : `${Math.round(b.hz)} Hz`}`}
                                                    value={b.gainDb}
                                                    min={-18}
                                                    max={18}
                                                    step={0.5}
                                                    format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`}
                                                    onCommit={(gainDb) => chain({ eq: params.chain.eq.map((x, j) => (j === i ? { ...x, gainDb } : x)) })}
                                                />
                                            ))}
                                            <SwitchRow label={t("vocal.gate")} checked={params.chain.gateOn} onChange={(gateOn) => chain({ gateOn })} />
                                            <SliderRow label={t("vocal.gateThreshold")} value={params.chain.gateThresholdDb} min={-90} max={0} step={1} format={(v) => `${v} dB`} onCommit={(gateThresholdDb) => chain({ gateThresholdDb })} disabled={!params.chain.gateOn} />
                                            <SwitchRow label={t("vocal.deess")} checked={params.chain.deessOn} onChange={(deessOn) => chain({ deessOn })} />
                                            <SliderRow label={t("vocal.deessThreshold")} value={params.chain.deessThresholdDb} min={-60} max={0} step={1} format={(v) => `${v} dB`} onCommit={(deessThresholdDb) => chain({ deessThresholdDb })} disabled={!params.chain.deessOn} />
                                            <SwitchRow label={t("vocal.comp")} checked={params.chain.compOn} onChange={(compOn) => chain({ compOn })} />
                                            <SliderRow label={t("vocal.compThreshold")} value={params.chain.compThresholdDb} min={-60} max={0} step={1} format={(v) => `${v} dB`} onCommit={(compThresholdDb) => chain({ compThresholdDb })} disabled={!params.chain.compOn} />
                                            <SliderRow label={t("vocal.compRatio")} value={params.chain.compRatio} min={1} max={20} step={0.5} format={(v) => `${v}:1`} onCommit={(compRatio) => chain({ compRatio })} disabled={!params.chain.compOn} />
                                            <SliderRow label={t("vocal.makeup")} value={params.chain.compMakeupDb} min={0} max={24} step={0.5} format={(v) => `${v} dB`} onCommit={(compMakeupDb) => chain({ compMakeupDb })} disabled={!params.chain.compOn} />
                                        </div>
                                    </div>
                                )}

                                {tab === "fx" && (
                                    <div className="grid gap-4 sm:grid-cols-2">
                                        <SwitchRow label={t("vocal.reverb")} checked={params.chain.reverbOn} onChange={(reverbOn) => chain({ reverbOn })} />
                                        <SliderRow label={t("vocal.mix")} value={params.chain.reverbMix} min={0} max={1} format={(v) => `${Math.round(v * 100)} %`} onCommit={(reverbMix) => chain({ reverbMix })} disabled={!params.chain.reverbOn} />
                                        <SliderRow label={t("vocal.size")} value={params.chain.reverbSize} min={0} max={1} format={(v) => `${Math.round(v * 100)} %`} onCommit={(reverbSize) => chain({ reverbSize })} disabled={!params.chain.reverbOn} />
                                        <SliderRow label={t("vocal.damp")} value={params.chain.reverbDamp} min={0} max={1} format={(v) => `${Math.round(v * 100)} %`} onCommit={(reverbDamp) => chain({ reverbDamp })} disabled={!params.chain.reverbOn} />
                                        <SwitchRow label={t("vocal.delay")} checked={params.chain.delayOn} onChange={(delayOn) => chain({ delayOn })} />
                                        <SliderRow label={t("vocal.mix")} value={params.chain.delayMix} min={0} max={1} format={(v) => `${Math.round(v * 100)} %`} onCommit={(delayMix) => chain({ delayMix })} disabled={!params.chain.delayOn} />
                                        <SliderRow label={t("vocal.time")} value={params.chain.delayMs} min={20} max={1500} step={5} format={(v) => `${Math.round(v)} ms`} onCommit={(delayMs) => chain({ delayMs })} disabled={!params.chain.delayOn} />
                                        <SliderRow label={t("vocal.feedback")} value={params.chain.delayFeedback} min={0} max={0.9} format={(v) => `${Math.round(v * 100)} %`} onCommit={(delayFeedback) => chain({ delayFeedback })} disabled={!params.chain.delayOn} />
                                        <SwitchRow label={t("vocal.limiter")} checked={params.chain.limiterOn} onChange={(limiterOn) => chain({ limiterOn })} />
                                        <SliderRow label={t("vocal.ceiling")} value={params.chain.limiterCeilingDb} min={-12} max={0} step={0.5} format={(v) => `${v} dB`} onCommit={(limiterCeilingDb) => chain({ limiterCeilingDb })} />
                                        <SliderRow label={t("vocal.outputGain")} value={params.chain.outputGainDb} min={-24} max={24} step={0.5} format={(v) => `${v.toFixed(1)} dB`} onCommit={(outputGainDb) => chain({ outputGainDb })} />
                                        <SliderRow label={t("vocal.wet")} value={params.tune.mix} min={0} max={1} format={(v) => `${Math.round(v * 100)} %`} onCommit={(mix) => tune({ mix })} />
                                    </div>
                                )}

                                {tab === "harmony" && (
                                    <div className="space-y-4">
                                        <p className="text-xs text-fg-muted">{t("vocal.harmonyHint")}</p>
                                        {params.harmony.voices.map((v, i) => {
                                            const setVoice = (p: Partial<typeof v>) =>
                                                setParams({ ...params, harmony: { ...params.harmony, voices: params.harmony.voices.map((x, j) => (j === i ? { ...x, ...p } : x)) } });
                                            return (
                                                <motion.div layout key={i} className={cn("grid gap-3 rounded-chip border border-fg/10 p-3 sm:grid-cols-4", v.on && "border-accent/40 bg-accent/5")}>
                                                    <SwitchRow label={t("vocal.voiceN", { n: i + 1 })} checked={v.on} onChange={(on) => setVoice({ on })} />
                                                    <SliderRow label={t("vocal.interval")} value={v.degrees} min={-7} max={7} step={1} format={(d) => t("vocal.degrees", { count: d })} onCommit={(degrees) => setVoice({ degrees })} disabled={!v.on} />
                                                    <SliderRow label={t("vocal.level")} value={v.gainDb} min={-30} max={6} step={0.5} format={(g) => `${g} dB`} onCommit={(gainDb) => setVoice({ gainDb })} disabled={!v.on} />
                                                    <SliderRow label={t("vocal.pan")} value={v.pan} min={-1} max={1} format={(p) => (p === 0 ? "C" : p < 0 ? `L${Math.round(-p * 100)}` : `R${Math.round(p * 100)}`)} onCommit={(pan) => setVoice({ pan })} disabled={!v.on} />
                                                </motion.div>
                                            );
                                        })}
                                        <SliderRow label={t("vocal.double")} value={params.harmony.double} min={0} max={1} format={(v) => `${Math.round(v * 100)} %`} onCommit={(double) => setParams({ ...params, harmony: { ...params.harmony, double } })} />
                                        <SwitchRow label={t("vocal.duck")} description={t("vocal.duckHint")} checked={params.duck.on} onChange={(on) => setParams({ ...params, duck: { ...params.duck, on } })} />
                                        <SliderRow label={t("vocal.duckDepth")} value={params.duck.depthDb} min={-30} max={0} step={1} format={(v) => `${v} dB`} onCommit={(depthDb) => setParams({ ...params, duck: { ...params.duck, depthDb } })} disabled={!params.duck.on} />
                                    </div>
                                )}

                                {tab === "setup" && <SetupPanel settings={settings} status={status} onPatch={patch} onReset={() => setParams(vocalParamsSchema.parse({}))} />}
                            </motion.div>
                        </AnimatePresence>
                    ) : (
                        <div className="h-40" aria-busy />
                    )}
                </main>
                <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-fg/10 px-3 text-[0.625rem] text-fg-subtle">
                    <span>{heard !== null ? `${t("vocal.singing")} ${noteName(view.target)}` : t("vocal.silent")}</span>
                    <span className="ml-auto">{params ? `${NOTE_NAMES[params.tune.key]} ${t(`vocal.scales.${params.tune.scale}`)}` : ""}</span>
                </footer>
                <Toaster position="bottom-center" toastOptions={{ classNames: { toast: "surface !rounded-panel !text-fg" } }} />
            </div>
        </MotionConfig>
    );
}

function SetupPanel({ settings, status, onPatch, onReset }: { settings: VocalSettings; status: VocalStatus | null; onPatch: (p: Partial<VocalSettings>) => void; onReset: () => void }) {
    const { t } = useTranslation();
    const [strips, setStrips] = useState<StripInfo[]>([]);
    useEffect(() => {
        if (!isTauri()) return;
        void invoke<StripInfo[]>("vocal_strips").then(setStrips).catch(() => setStrips([]));
    }, [status?.available]);
    const stripName = (s: StripInfo) => `${s.index + 1}. ${s.label || s.device || t("vocal.stripEmpty")}`;
    const run = (cmd: string, args: Record<string, unknown>, ok: string) =>
        void invoke<string>(cmd, args)
            .then((path) => toast.success(t(ok, { path })))
            .catch((e: unknown) => toast.error(String(e)));
    const peaks = status?.channelPeaksDb ?? [];
    return (
        <div className="space-y-4">
            {status?.conflict && <p className="rounded-chip bg-warning/12 px-3 py-2 text-xs text-warning">{t("vocal.conflict", { app: status.conflict })}</p>}
            {status?.error && !status.available && <p className="rounded-chip bg-danger/12 px-3 py-2 text-xs text-danger">{status.error}</p>}
            <div className="grid gap-4 sm:grid-cols-2">
                <label className="block space-y-1.5">
                    <span className="block text-[0.8125rem] text-fg-muted">{t("vocal.micStrip")}</span>
                    <select value={settings.micStrip} onChange={(e) => onPatch({ micStrip: Number(e.target.value) })} className="w-full rounded-chip border border-border bg-panel-alt px-2.5 py-1.5 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        {strips.map((s) => (
                            <option key={s.index} value={s.index}>
                                {stripName(s)}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="block space-y-1.5">
                    <span className="block text-[0.8125rem] text-fg-muted">{t("vocal.musicStrip")}</span>
                    <select value={settings.musicStrip} onChange={(e) => onPatch({ musicStrip: Number(e.target.value) })} className="w-full rounded-chip border border-border bg-panel-alt px-2.5 py-1.5 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <option value={-1}>{t("vocal.none")}</option>
                        {strips.map((s) => (
                            <option key={s.index} value={s.index}>
                                {stripName(s)}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            <ChipSelector
                label={t("vocal.phonesBus")}
                options={["1", "2", "3", "4", "5"] as const}
                value={String(settings.phonesBus) as "1" | "2" | "3" | "4" | "5"}
                onSelect={(v) => onPatch({ phonesBus: Number(v) })}
                display={(v) => `A${v}`}
            />
            {status?.running && (
                <p className="text-xs text-fg-muted" aria-live="polite">
                    {peaks.some((p) => p > -100) ? t("vocal.signalOk") : t("vocal.noSignal")}
                </p>
            )}
            <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => run("vm_apply_live", { micStrip: settings.micStrip, musicStrip: settings.musicStrip, phonesBus: settings.phonesBus }, "vocal.applied")} className="rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-accent-fg outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {t("vocal.applyLive")}
                </button>
                <button type="button" onClick={() => run("vm_backup", {}, "vocal.backedUp")} className="rounded-full bg-panel-alt px-3 py-1.5 text-xs text-fg outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-ring">
                    {t("vocal.backup")}
                </button>
                <button type="button" onClick={() => run("vm_restore", {}, "vocal.restored")} className="rounded-full bg-panel-alt px-3 py-1.5 text-xs text-fg outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-ring">
                    {t("vocal.restore")}
                </button>
                <button type="button" onClick={onReset} className="rounded-full bg-panel-alt px-3 py-1.5 text-xs text-fg-muted outline-none hover:text-danger focus-visible:ring-2 focus-visible:ring-ring">
                    {t("vocal.reset")}
                </button>
            </div>
            <ol className="list-decimal space-y-1 pl-5 text-xs text-fg-muted">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                    <li key={i}>{t(`vocal.guide.${i}`)}</li>
                ))}
            </ol>
        </div>
    );
}
