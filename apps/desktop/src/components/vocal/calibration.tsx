import { invoke, isTauri } from "@tauri-apps/api/core";
import { noteName, sectionValues, vocalParamsSchema, type VocalSettings, type VocalUserPreset } from "@tiksee/core";
import { cn } from "@tiksee/ui";
import { Check, ChevronLeft, Mic2, RotateCcw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface Tone {
    hz: number;
    db: number;
    prominenceDb: number;
}
interface NoiseReport {
    rmsDb: number;
    floorDb: number;
    peakDb: number;
    tones: Tone[];
    humHz: number | null;
}
interface VoiceReport {
    rmsDb: number;
    peakDb: number;
    lowMidi: number;
    highMidi: number;
    voiced: number;
    sibilanceDb: number;
}

const STEPS = ["silence", "speak", "range", "sibilance", "review"] as const;
type Step = (typeof STEPS)[number];
const SECONDS: Record<Exclude<Step, "review">, number> = { silence: 5, speak: 8, range: 12, sibilance: 6 };

interface Results {
    silence?: NoiseReport;
    speak?: VoiceReport;
    range?: VoiceReport;
    sibilance?: VoiceReport;
}

/** What the measurements suggest, as a patch over the current params. */
function propose(base: VocalSettings, r: Results) {
    const p = base.params;
    const floor = r.silence?.floorDb ?? -60;
    const speech = r.speak?.rmsDb ?? -24;
    const peak = Math.max(r.speak?.peakDb ?? -6, r.range?.peakDb ?? -6);
    // Bring average speech to about -18 dBFS before the chain, never pushing peaks past -3.
    const inputGainDb = Math.max(-12, Math.min(18, Math.min(-18 - speech, -3 - peak)));
    const gateThresholdDb = Math.round(Math.min(speech - 18, Math.max(floor + 8, -80)));
    const notchHz = [...(r.silence?.tones ?? [])]
        .filter((t) => t.prominenceDb >= 15 && t.db > floor - 6)
        .slice(0, 4)
        .map((t) => Math.round(t.hz * 10) / 10);
    while (notchHz.length < 4) notchHz.push(0);
    const low = r.range?.lowMidi ?? 45;
    const high = r.range?.highMidi ?? 72;
    const minHz = Math.max(55, Math.round(440 * 2 ** ((low - 3 - 69) / 12)));
    const maxHz = Math.min(1400, Math.round(440 * 2 ** ((high + 3 - 69) / 12)));
    const hpfHz = Math.round(Math.max(60, Math.min(160, minHz * 0.7)));
    // Sibilance: the more 5-10 kHz energy vs the voice band, the earlier the de-esser bites.
    const sib = r.sibilance?.sibilanceDb ?? -20;
    const deessThresholdDb = Math.round(Math.max(-45, Math.min(-18, -28 - (sib + 18))));
    const compThresholdDb = Math.round(speech + 4 + inputGainDb);
    return vocalParamsSchema.parse({
        ...p,
        tune: { ...p.tune, minHz, maxHz },
        chain: {
            ...p.chain,
            inputGainDb: Math.round(inputGainDb * 2) / 2,
            gateOn: true,
            gateThresholdDb,
            hpfOn: true,
            hpfHz,
            notchOn: true,
            notchHz,
            deessOn: true,
            deessThresholdDb,
            compOn: true,
            compThresholdDb: Math.max(-40, Math.min(-8, compThresholdDb)),
        },
    });
}

/**
 * Guided calibration: records the real mic through the running engine
 * (pre-processing), analyses it in the shell, then proposes gain, gate,
 * notches against whine/hum, detection range, low cut, de-esser and
 * compressor — saved as the active settings plus a "Voice" preset.
 */
export function Calibration({
    settings,
    running,
    onDone,
    onCancel,
}: {
    settings: VocalSettings;
    running: boolean;
    onDone: (patch: Partial<VocalSettings>) => void;
    onCancel: () => void;
}) {
    const { t } = useTranslation();
    const [step, setStep] = useState<Step>("silence");
    const [results, setResults] = useState<Results>({});
    const [recording, setRecording] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [name, setName] = useState(() => t("vocal.cal.defaultName"));
    const timer = useRef<number | null>(null);

    useEffect(() => () => {
        if (timer.current !== null) window.clearInterval(timer.current);
    }, []);

    const index = STEPS.indexOf(step);
    const record = (s: Exclude<Step, "review">) => {
        if (!isTauri()) return;
        setError(null);
        void invoke("vocal_capture_start")
            .then(() => {
                const total = SECONDS[s];
                const started = performance.now();
                setRecording(total);
                timer.current = window.setInterval(() => {
                    const left = total - (performance.now() - started) / 1000;
                    if (left > 0) {
                        setRecording(left);
                        return;
                    }
                    if (timer.current !== null) window.clearInterval(timer.current);
                    timer.current = null;
                    setRecording(null);
                    void invoke<NoiseReport | VoiceReport>("vocal_analyze", { kind: s === "silence" ? "noise" : "voice" })
                        .then((r) => {
                            setResults((prev) => ({ ...prev, [s]: r }));
                            setStep(STEPS[STEPS.indexOf(s) + 1] ?? "review");
                        })
                        .catch((e: unknown) => setError(String(e)));
                }, 100);
            })
            .catch((e: unknown) => setError(String(e)));
    };

    const proposal = step === "review" ? propose(settings, results) : null;
    const save = (now: number) => {
        if (!proposal) return;
        const preset: VocalUserPreset = {
            id: `voice-cal-${now.toString(36)}`,
            name: name.trim() || t("vocal.cal.defaultName"),
            section: "voice",
            values: sectionValues(proposal, "voice"),
            createdAt: now,
        };
        const params = settings.slot === "b" ? { paramsB: proposal } : { params: proposal };
        onDone({ ...params, presets: [...settings.presets, preset], calibratedAt: now });
    };

    const s = results.silence;
    return (
        <div className="space-y-4">
            <div className="flex items-center gap-2">
                <button type="button" onClick={onCancel} aria-label={t("common.cancel")} className="grid size-8 place-items-center rounded-full text-fg-subtle outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring">
                    <ChevronLeft className="size-4" aria-hidden />
                </button>
                <h2 className="text-sm font-semibold text-fg">{t("vocal.cal.title")}</h2>
                <ol className="ml-auto flex items-center gap-1.5" aria-label={t("vocal.cal.progress")}>
                    {STEPS.map((id, i) => (
                        <li key={id} aria-current={id === step ? "step" : undefined} className={cn("h-1.5 rounded-full transition-all", i < index ? "w-4 bg-accent" : i === index ? "w-7 bg-accent" : "w-4 bg-fg/15")} />
                    ))}
                </ol>
            </div>
            {!running && <p className="rounded-chip bg-warning/12 px-3 py-2 text-xs text-warning">{t("vocal.cal.needsEngine")}</p>}
            {error && <p className="rounded-chip bg-danger/12 px-3 py-2 text-xs text-danger">{error}</p>}

            <AnimatePresence mode="wait" initial={false}>
                <motion.div key={step} initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} className="space-y-3">
                    {step !== "review" ? (
                        <>
                            <p className="text-base font-semibold text-fg">{t(`vocal.cal.${step}.title`)}</p>
                            <p className="text-sm text-fg-muted">{t(`vocal.cal.${step}.body`)}</p>
                            <div className="flex items-center gap-3">
                                <button
                                    type="button"
                                    disabled={!running || recording !== null}
                                    onClick={() => record(step)}
                                    className="inline-flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-accent-fg outline-none disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                    <Mic2 className="size-4" aria-hidden />
                                    {recording !== null ? t("vocal.cal.recording", { s: Math.ceil(recording) }) : t("vocal.cal.record", { s: SECONDS[step] })}
                                </button>
                                {recording !== null && (
                                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-fg/10" aria-hidden>
                                        <motion.div className="h-full bg-accent" initial={{ width: "0%" }} animate={{ width: "100%" }} transition={{ duration: SECONDS[step], ease: "linear" }} />
                                    </div>
                                )}
                            </div>
                        </>
                    ) : (
                        proposal && (
                            <>
                                <p className="text-base font-semibold text-fg">{t("vocal.cal.review.title")}</p>
                                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                                    <dt className="text-fg-muted">{t("vocal.cal.review.floor")}</dt>
                                    <dd className="font-mono tabular-nums text-fg">{s ? `${s.floorDb.toFixed(1)} dBFS` : "–"}</dd>
                                    <dt className="text-fg-muted">{t("vocal.cal.review.whine")}</dt>
                                    <dd className="font-mono tabular-nums text-fg">
                                        {proposal.chain.notchHz.filter((h) => h > 0).map((h) => (h >= 1000 ? `${(h / 1000).toFixed(2)} kHz` : `${h} Hz`)).join(" · ") || t("vocal.cal.review.none")}
                                        {s?.humHz ? ` (${t("vocal.cal.review.hum", { hz: s.humHz })})` : ""}
                                    </dd>
                                    <dt className="text-fg-muted">{t("vocal.cal.review.range")}</dt>
                                    <dd className="font-mono tabular-nums text-fg">{results.range ? `${noteName(results.range.lowMidi)} – ${noteName(results.range.highMidi)}` : "–"}</dd>
                                    <dt className="text-fg-muted">{t("vocal.inputGain")}</dt>
                                    <dd className="font-mono tabular-nums text-fg">{proposal.chain.inputGainDb} dB</dd>
                                    <dt className="text-fg-muted">{t("vocal.gateThreshold")}</dt>
                                    <dd className="font-mono tabular-nums text-fg">{proposal.chain.gateThresholdDb} dB</dd>
                                    <dt className="text-fg-muted">{t("vocal.hpf")}</dt>
                                    <dd className="font-mono tabular-nums text-fg">{proposal.chain.hpfHz} Hz</dd>
                                    <dt className="text-fg-muted">{t("vocal.deessThreshold")}</dt>
                                    <dd className="font-mono tabular-nums text-fg">{proposal.chain.deessThresholdDb} dB</dd>
                                    <dt className="text-fg-muted">{t("vocal.compThreshold")}</dt>
                                    <dd className="font-mono tabular-nums text-fg">{proposal.chain.compThresholdDb} dB</dd>
                                </dl>
                                {s && s.tones.length > 0 && <p className="rounded-chip bg-warning/12 px-3 py-2 text-xs text-warning">{t("vocal.cal.review.whineHint")}</p>}
                                <label className="block space-y-1.5">
                                    <span className="block text-[0.8125rem] text-fg-muted">{t("vocal.presetName")}</span>
                                    <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} className="w-full rounded-chip border border-border bg-panel-alt px-2.5 py-1.5 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring" />
                                </label>
                                <div className="flex gap-2">
                                    <button type="button" onClick={(e) => save(Math.round(performance.timeOrigin + e.timeStamp))} className="inline-flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-accent-fg outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                        <Check className="size-4" aria-hidden />
                                        {t("vocal.cal.save")}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setResults({});
                                            setStep("silence");
                                        }}
                                        className="inline-flex items-center gap-2 rounded-full bg-panel-alt px-4 py-2 text-sm text-fg outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-ring"
                                    >
                                        <RotateCcw className="size-4" aria-hidden />
                                        {t("vocal.cal.redo")}
                                    </button>
                                </div>
                            </>
                        )
                    )}
                </motion.div>
            </AnimatePresence>
        </div>
    );
}
