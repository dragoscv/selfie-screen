import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import { ArrowLeft, ArrowRight, Check, Hand, RotateCcw, ScanSearch, Target, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { HandSample, LensProgress, LensResult, SceneResult, SpaceSample } from "../../lib/studio/controller.js";
import { FOCUS_RING, GLASS, INSTANT, SPRING, useStudio } from "./context.js";
import {
    CAMERA_PRESET_IDS,
    HAND_EMOJI,
    HAND_RECORD_MS,
    HAND_TARGETS,
    HAND_VERIFY_MS,
    HEIGHT_MAX_CM,
    HEIGHT_MIN_CM,
    LENS_MAX_MM,
    LENS_MIN_MM,
    acceptMeasuredFov,
    buildHandsCalibration,
    buildSpacePatch,
    cameraFromStudio,
    chooseLens,
    choosePreset,
    combineSamples,
    formatCm,
    formatDeg,
    formatMetres,
    formatMm,
    formatPct,
    judgeHandSample,
    parseHeightCm,
    presetNeedsLens,
    summariseHands,
    type CameraChoice,
    type CameraPresetId,
    type HandSamples,
    type HandTarget,
} from "./space-calibration-model.js";

const STEPS = ["camera", "you", "standing", "seated", "hands", "review"] as const;
type Step = (typeof STEPS)[number];

const COUNTDOWN_S = 3;
const SAMPLE_MS = 3000;

// The ChArUco board renderer is provided by the calibration module; resolved at build time,
// empty when the module is absent (the wizard then shows the text instructions only).
const CHARUCO = import.meta.glob<{ renderCharucoBoard?: (canvas: HTMLCanvasElement) => unknown }>("../../lib/studio/calibration/charuco.ts");

type Capture = { kind: "idle" } | { kind: "countdown"; n: number } | { kind: "sampling"; ms?: number };
type HandPhase = "intro" | "record" | "verify" | "summary";
type Lens = { kind: "idle" } | { kind: "running"; progress: LensProgress } | { kind: "done"; result: LensResult } | { kind: "error"; error: string };
type Scene = { kind: "idle" } | { kind: "running"; progress: number } | { kind: "done"; result: SceneResult } | { kind: "error"; error: string };

const BTN = `flex items-center gap-1 rounded-xl px-3 py-2 text-xs hover:bg-white/15 disabled:opacity-40 ${FOCUS_RING}`;
const PRIMARY = `flex items-center gap-1 rounded-xl bg-sky-400 px-4 py-2 text-xs font-semibold text-neutral-950 hover:bg-sky-300 disabled:opacity-50 ${FOCUS_RING}`;
const FIELD = "rounded-lg border border-white/15 bg-white/10 px-2.5 py-1.5 text-sm text-white outline-none focus:border-sky-300";

function Bar({ value, label }: { value: number; label: string }) {
    const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
    return (
        <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-1.5 overflow-hidden rounded-full bg-white/15">
            <div className="h-full bg-sky-300" style={{ width: `${pct}%` }} />
        </div>
    );
}

function Rows({ rows }: { rows: readonly (readonly [string, string])[] }) {
    return (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            {rows.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2 border-b border-white/10 pb-1">
                    <dt className="text-white/75">{k}</dt>
                    <dd className="font-semibold tabular-nums">{v}</dd>
                </div>
            ))}
        </dl>
    );
}

/** Recording progress ring (fills over `ms`); purely a visual for the sr-only live text. */
function Ring({ ms, children }: { ms: number; children: ReactNode }) {
    return (
        <span className="relative grid size-20 shrink-0 place-items-center" aria-hidden>
            <svg viewBox="0 0 40 40" className="absolute inset-0 size-full -rotate-90">
                <circle cx="20" cy="20" r="17" fill="none" stroke="rgb(255 255 255 / 0.15)" strokeWidth="3" />
                <motion.circle
                    cx="20"
                    cy="20"
                    r="17"
                    fill="none"
                    stroke="rgb(125 211 252)"
                    strokeWidth="3"
                    strokeLinecap="round"
                    initial={{ pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                    transition={{ duration: ms / 1000, ease: "linear" }}
                />
            </svg>
            {children}
        </span>
    );
}

const VERDICT_TONE = { pass: "text-emerald-200", miss: "text-amber-200", outOfFrame: "text-amber-200", noHand: "text-amber-200" } as const;

/** 3D space wizard: camera FOV, owner height, standing + seated samples, review and save. */
export function SpaceCalibration({ onClose }: { onClose: () => void }) {
    const { controller, studio, vision, patchStudio, patchVision } = useStudio();
    const { t, i18n } = useTranslation();
    const lang = i18n.language;
    const reduced = useReducedMotion();
    const dialog = useRef<HTMLDivElement>(null);
    const cancelled = useRef(false);
    const lensAbort = useRef<AbortController | null>(null);
    const board = useRef<HTMLCanvasElement>(null);

    const [index, setIndex] = useState(0);
    const [camera, setCamera] = useState<CameraChoice>(() => cameraFromStudio(studio));
    const [heightText, setHeightText] = useState(studio.space.heightM > 0 ? String(Math.round(studio.space.heightM * 100)) : "");
    const [samples, setSamples] = useState<{ standing?: SpaceSample; seated?: SpaceSample }>({});
    const [capture, setCapture] = useState<Capture>({ kind: "idle" });
    const [useTilt, setUseTilt] = useState(true);
    const [lensOpen, setLensOpen] = useState(false);
    const [lens, setLens] = useState<Lens>({ kind: "idle" });
    const [boardState, setBoardState] = useState<"none" | "drawn" | "unavailable">("none");
    const [scene, setScene] = useState<Scene>({ kind: "idle" });
    const [handPhase, setHandPhase] = useState<HandPhase>("intro");
    const [handIdx, setHandIdx] = useState(0);
    const [handRecord, setHandRecord] = useState<HandSamples>({});
    const [handVerify, setHandVerify] = useState<HandSamples>({});
    const [verifying, setVerifying] = useState(false);

    const step: Step = STEPS[index] ?? "review";
    const busy = capture.kind !== "idle" || scene.kind === "running" || verifying;
    const heightCm = parseHeightCm(heightText);
    const heightInvalid = heightText.trim() !== "" && heightCm === null;

    useEffect(() => {
        dialog.current?.focus({ preventScroll: true });
        cancelled.current = false;
        return () => {
            cancelled.current = true;
            lensAbort.current?.abort();
        };
    }, []);

    const go = (delta: number) => {
        if (busy) return;
        setIndex((i) => Math.min(STEPS.length - 1, Math.max(0, i + delta)));
        dialog.current?.focus({ preventScroll: true });
    };

    const close = () => {
        lensAbort.current?.abort();
        onClose();
    };

    /* ----- camera step ----- */

    const drawBoard = async () => {
        const loader = Object.values(CHARUCO)[0];
        try {
            const mod = loader ? await loader() : undefined;
            if (!mod?.renderCharucoBoard || !board.current) throw new Error("unavailable");
            await mod.renderCharucoBoard(board.current);
            setBoardState("drawn");
        } catch {
            setBoardState("unavailable");
        }
    };

    const runLens = async () => {
        if (!controller.calibrateLens) return;
        lensAbort.current?.abort();
        const abort = new AbortController();
        lensAbort.current = abort;
        setLens({ kind: "running", progress: { views: 0, needed: 0, coverage: 0 } });
        try {
            const result = await controller.calibrateLens((progress) => {
                if (!cancelled.current) setLens({ kind: "running", progress });
            }, abort.signal);
            if (cancelled.current || abort.signal.aborted) return;
            setLens({ kind: "done", result });
            setCamera((c) => acceptMeasuredFov(c, result.vfovDeg, "charuco", result.k1, result.k2));
        } catch (e) {
            if (!cancelled.current) setLens(abort.signal.aborted ? { kind: "idle" } : { kind: "error", error: String(e) });
        }
    };

    const runScene = async () => {
        if (!controller.analyseScene) return;
        setScene({ kind: "running", progress: 0 });
        try {
            const result = await controller.analyseScene((progress) => {
                if (!cancelled.current) setScene({ kind: "running", progress });
            });
            if (!cancelled.current) setScene({ kind: "done", result });
        } catch (e) {
            if (!cancelled.current) setScene({ kind: "error", error: String(e) });
        }
    };

    /* ----- sampling steps ----- */

    /** 3-2-1 countdown; false when the wizard closed meanwhile. */
    const countdown = async (): Promise<boolean> => {
        for (let n = COUNTDOWN_S; n > 0; n--) {
            setCapture({ kind: "countdown", n });
            await new Promise((r) => window.setTimeout(r, 1000));
            if (cancelled.current) return false;
        }
        return true;
    };

    const sample = async (kind: "standing" | "seated") => {
        if (!(await countdown())) return;
        setCapture({ kind: "sampling" });
        try {
            const s = await controller.sampleSpace(kind, SAMPLE_MS);
            if (cancelled.current) return;
            setSamples((prev) => ({ ...prev, [kind]: s }));
        } catch (e) {
            if (!cancelled.current) toast.error(t("studio.space.failed", { error: String(e) }));
        } finally {
            if (!cancelled.current) setCapture({ kind: "idle" });
        }
    };

    /* ----- hands step ----- */

    const recordHand = async (target: HandTarget, ms: number): Promise<HandSample | null> => {
        if (!(await countdown())) return null;
        setCapture({ kind: "sampling", ms });
        try {
            const s = await controller.sampleHands(target, ms);
            return cancelled.current ? null : s;
        } catch (e) {
            if (!cancelled.current) toast.error(t("studio.space.failed", { error: String(e) }));
            return null;
        } finally {
            if (!cancelled.current) setCapture({ kind: "idle" });
        }
    };

    const recordCurrent = async () => {
        const target = HAND_TARGETS[handIdx];
        if (!target) return;
        const s = await recordHand(target, HAND_RECORD_MS);
        if (s) setHandRecord((prev) => ({ ...prev, [target]: s }));
    };

    const nextGesture = () => {
        if (handIdx + 1 < HAND_TARGETS.length) setHandIdx(handIdx + 1);
        else {
            setHandIdx(0);
            setHandPhase("verify");
        }
    };

    const runVerify = async () => {
        setHandVerify({});
        setVerifying(true);
        try {
            for (let i = 0; i < HAND_TARGETS.length; i++) {
                const target = HAND_TARGETS[i];
                if (!target) continue;
                setHandIdx(i);
                const s = await recordHand(target, HAND_VERIFY_MS);
                if (cancelled.current) return;
                if (s) setHandVerify((prev) => ({ ...prev, [target]: s }));
            }
            setHandPhase("summary");
        } finally {
            if (!cancelled.current) setVerifying(false);
        }
    };

    const restartHands = () => {
        setHandRecord({});
        setHandVerify({});
        setHandIdx(0);
        setHandPhase("record");
    };

    const handsSummary = summariseHands(handRecord, handVerify);
    const handsRecorded = Object.keys(handRecord).length > 0;

    const measure = combineSamples(samples.standing, samples.seated);

    const save = () => {
        const patch = buildSpacePatch({
            studio,
            camera,
            heightM: heightCm !== null ? heightCm / 100 : undefined,
            measure,
            useMeasuredTilt: useTilt,
        });
        patchStudio(patch);
        if (handsRecorded) {
            // Stamped with Date.now() inside the helper (default param) at save time.
            const hands = buildHandsCalibration(vision.calibration.hands, handRecord, handVerify);
            patchVision({ calibration: { ...vision.calibration, hands } });
        }
        toast.success(t("studio.space.saved"));
        close();
    };

    /* ----- rendering ----- */

    const presetLabel = (p: CameraPresetId) => t(`studio.space.presets.${p}`);

    const issues = (s: SpaceSample | undefined) =>
        s && (s.frames === 0 || s.issues.length > 0) ? (
            <ul className="space-y-1 rounded-xl bg-amber-400/15 p-2 text-[0.6875rem] text-amber-100">
                {s.frames === 0 && !s.issues.includes("noBody") && <li>{t("studio.space.issues.noBody")}</li>}
                {s.issues.map((i) => (
                    <li key={i}>{t(`studio.space.issues.${i}`)}</li>
                ))}
            </ul>
        ) : null;

    const captureBlock = (kind: "standing" | "seated", emoji: string, result: ReactNode) => {
        const s = samples[kind];
        return (
            <div className="space-y-3">
                <div className="flex items-center gap-4">
                    <div className="relative grid size-20 shrink-0 place-items-center rounded-2xl bg-white/10 text-5xl" aria-hidden>
                        {emoji}
                        <AnimatePresence>
                            {capture.kind !== "idle" && (
                                <motion.span
                                    key={capture.kind === "countdown" ? capture.n : "s"}
                                    initial={reduced ? false : { scale: 1.6, opacity: 0 }}
                                    animate={{ scale: 1, opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    transition={reduced ? INSTANT : SPRING}
                                    className="absolute inset-0 grid place-items-center rounded-2xl bg-sky-500/85 text-3xl font-bold text-white"
                                >
                                    {capture.kind === "countdown" ? capture.n : "●"}
                                </motion.span>
                            )}
                        </AnimatePresence>
                    </div>
                    <p className="min-w-0 flex-1 text-sm leading-snug text-white/85">{t(`studio.space.${kind}.body`)}</p>
                </div>
                {s && s.frames > 0 && result}
                {issues(s)}
                <div className="flex justify-end">
                    <button type="button" disabled={busy} onClick={() => void sample(kind)} className={PRIMARY}>
                        {s ? <RotateCcw className="size-3.5" aria-hidden /> : null}
                        {busy ? t("studio.space.capturing") : s ? t("studio.space.retry") : t("studio.space.start")}
                    </button>
                </div>
            </div>
        );
    };

    const gestureName = (g: HandTarget) => t(`studio.space.hands.gestures.${g}`);

    const gestureBox = (target: HandTarget) => (
        <div className="relative grid size-20 shrink-0 place-items-center rounded-2xl bg-white/10 text-5xl" aria-hidden>
            {capture.kind === "sampling" ? <Ring ms={capture.ms ?? HAND_RECORD_MS}>{HAND_EMOJI[target]}</Ring> : HAND_EMOJI[target]}
            <AnimatePresence>
                {capture.kind === "countdown" && (
                    <motion.span
                        key={capture.n}
                        initial={reduced ? false : { scale: 1.6, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={reduced ? INSTANT : SPRING}
                        className="absolute inset-0 grid place-items-center rounded-2xl bg-sky-500/85 text-3xl font-bold text-white"
                    >
                        {capture.n}
                    </motion.span>
                )}
            </AnimatePresence>
        </div>
    );

    /** One row per gesture; the same layoutId morphs recording rows into the summary table. */
    const handRows = (targets: readonly HandTarget[], summary: boolean) => (
        <ul className="space-y-1 text-xs" aria-label={t("studio.space.hands.results")}>
            <AnimatePresence initial={false}>
                {targets.map((target) => {
                    const rec = handRecord[target];
                    const row = handsSummary.rows.find((r) => r.target === target);
                    const verdict = rec ? judgeHandSample(rec).verdict : null;
                    return (
                        <motion.li
                            key={target}
                            layout={!reduced}
                            layoutId={reduced ? undefined : `hand-row-${target}`}
                            initial={reduced ? false : { opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0 }}
                            transition={reduced ? INSTANT : SPRING}
                            className={`grid items-center gap-2 rounded-lg bg-white/5 px-2 py-1.5 ${summary ? "grid-cols-[1.5rem_1fr_3rem_3rem_1.25rem]" : "grid-cols-[1.5rem_1fr_auto]"}`}
                        >
                            <span aria-hidden>{HAND_EMOJI[target]}</span>
                            <span className="truncate">{gestureName(target)}</span>
                            {summary ? (
                                <>
                                    <span className="text-right tabular-nums text-white/75">{formatPct(row?.record)}</span>
                                    <span className="text-right font-semibold tabular-nums">{formatPct(row?.verify)}</span>
                                    <span className={row?.pass ? "text-emerald-300" : "text-amber-300"}>
                                        {row?.pass ? <Check className="size-3.5" aria-label={t("studio.space.hands.pass")} /> : <X className="size-3.5" aria-label={t("studio.space.hands.fail")} />}
                                    </span>
                                </>
                            ) : (
                                <span className={`tabular-nums ${verdict ? VERDICT_TONE[verdict] : ""}`}>
                                    {verdict ? `${t(`studio.space.hands.verdict.${verdict}`)} · ${formatPct(rec ? judgeHandSample(rec).hitRate : undefined)}` : ""}
                                </span>
                            )}
                        </motion.li>
                    );
                })}
            </AnimatePresence>
        </ul>
    );

    function handsBody(): ReactNode {
        const target = HAND_TARGETS[handIdx] ?? "relaxed";
        if (handPhase === "intro") {
            return (
                <div className="space-y-3">
                    <div className="flex items-center gap-4">
                        <div className="grid size-20 shrink-0 place-items-center rounded-2xl bg-white/10" aria-hidden>
                            <motion.span
                                animate={reduced ? undefined : { rotate: [0, 18, -10, 18, 0], y: [0, -3, 0, -3, 0] }}
                                transition={reduced ? INSTANT : { duration: 1.8, repeat: Infinity, repeatDelay: 0.6, ease: "easeInOut" }}
                                style={{ originX: 0.5, originY: 0.9 }}
                                className="block"
                            >
                                <Hand className="size-10 text-sky-200" />
                            </motion.span>
                        </div>
                        <p className="min-w-0 flex-1 text-sm leading-snug text-white/85">{t("studio.space.hands.body")}</p>
                    </div>
                    <p className="text-[0.6875rem] text-white/70">{t("studio.space.hands.hint")}</p>
                    <div className="flex justify-end">
                        <button type="button" onClick={() => setHandPhase("record")} className={PRIMARY}>
                            {t("studio.space.start")}
                        </button>
                    </div>
                </div>
            );
        }
        if (handPhase === "summary") {
            return (
                <LayoutGroup id="hand-rows">
                    <div className="space-y-3">
                        <p className="text-sm text-white/85">{t("studio.space.hands.summary", { pct: formatPct(handsSummary.passRate), n: handsSummary.verified })}</p>
                        <div className="grid grid-cols-[1.5rem_1fr_3rem_3rem_1.25rem] gap-2 px-2 text-[0.625rem] uppercase tracking-wide text-white/60" aria-hidden>
                            <span />
                            <span>{t("studio.space.hands.gesture")}</span>
                            <span className="text-right">{t("studio.space.hands.recordCol")}</span>
                            <span className="text-right">{t("studio.space.hands.verifyCol")}</span>
                            <span />
                        </div>
                        {handRows(HAND_TARGETS, true)}
                        <div className="flex justify-end">
                            <button type="button" onClick={restartHands} className={BTN}>
                                <RotateCcw className="size-3.5" aria-hidden />
                                {t("studio.space.hands.redo")}
                            </button>
                        </div>
                    </div>
                </LayoutGroup>
            );
        }
        const verify = handPhase === "verify";
        const rec = handRecord[target];
        const judged = rec ? judgeHandSample(rec) : null;
        const done = HAND_TARGETS.filter((g) => handRecord[g]);
        return (
            <LayoutGroup id="hand-rows">
                <div className="space-y-3">
                    <div className="flex items-center gap-4">
                        {gestureBox(target)}
                        <div className="min-w-0 flex-1">
                            <p className="text-[0.6875rem] uppercase tracking-wide text-white/60">
                                {verify
                                    ? t("studio.space.hands.verifyStep", { n: handIdx + 1, total: HAND_TARGETS.length })
                                    : t("studio.space.hands.recordStep", { n: handIdx + 1, total: HAND_TARGETS.length })}
                            </p>
                            <AnimatePresence mode="popLayout" initial={false}>
                                <motion.p
                                    key={target}
                                    initial={reduced ? false : { opacity: 0, y: 8 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -8 }}
                                    transition={reduced ? INSTANT : SPRING}
                                    className="text-base font-semibold"
                                >
                                    {gestureName(target)}
                                </motion.p>
                            </AnimatePresence>
                            <p className="text-xs leading-snug text-white/75">{verify ? t("studio.space.hands.verifyBody") : t(`studio.space.hands.how.${target}`)}</p>
                        </div>
                    </div>
                    {!verify && judged && (
                        <p className={`rounded-xl bg-white/5 p-2 text-[0.6875rem] ${VERDICT_TONE[judged.verdict]}`} aria-live="polite">
                            {t(`studio.space.hands.message.${judged.verdict}`, { pct: formatPct(judged.hitRate) })}
                        </p>
                    )}
                    {done.length > 0 && handRows(done, false)}
                    <div className="flex flex-wrap justify-end gap-2">
                        {verify ? (
                            <button type="button" disabled={busy} onClick={() => void runVerify()} className={PRIMARY}>
                                {busy ? t("studio.space.capturing") : t("studio.space.hands.verifyStart")}
                            </button>
                        ) : (
                            <>
                                <button type="button" disabled={busy} onClick={() => void recordCurrent()} className={rec ? BTN : PRIMARY}>
                                    {rec ? <RotateCcw className="size-3.5" aria-hidden /> : null}
                                    {busy ? t("studio.space.capturing") : rec ? t("studio.space.hands.retryGesture") : t("studio.space.hands.record")}
                                </button>
                                {rec && (
                                    <button type="button" disabled={busy} onClick={nextGesture} className={PRIMARY}>
                                        {handIdx + 1 < HAND_TARGETS.length ? t("studio.space.hands.nextGesture") : t("studio.space.hands.toVerify")}
                                        <ArrowRight className="size-3.5" aria-hidden />
                                    </button>
                                )}
                            </>
                        )}
                    </div>
                </div>
            </LayoutGroup>
        );
    }

    const live =
        capture.kind === "countdown"
            ? t("studio.space.countdown", { n: capture.n })
            : capture.kind === "sampling"
                            ? step === "hands"
                                    ? t("studio.space.hands.recording", { gesture: t(`studio.space.hands.gestures.${HAND_TARGETS[handIdx] ?? "relaxed"}`) })
                                    : t("studio.space.hold")
              : step === "standing" && samples.standing
                ? t("studio.space.measured")
                : step === "seated" && samples.seated
                  ? t("studio.space.measured")
                                    : step === "hands" && handPhase === "summary"
                                        ? t("studio.space.hands.summaryLive", { pct: formatPct(handsSummary.passRate) })
                                        : "";

    let body: ReactNode;
    if (step === "camera") {
        const lp = lens.kind === "running" ? lens.progress : null;
        body = (
            <div className="space-y-3">
                <p className="text-sm leading-snug text-white/85">{t("studio.space.camera.body")}</p>
                <label className="block text-xs text-white/85">
                    {t("studio.space.camera.preset")}
                    <select
                        value={camera.preset}
                        onChange={(e) => setCamera((c) => choosePreset(c, e.target.value as CameraPresetId))}
                        className={`mt-1 block w-full ${FIELD} [&>option]:text-neutral-900`}
                    >
                        {CAMERA_PRESET_IDS.map((p) => (
                            <option key={p} value={p}>
                                {presetLabel(p)}
                            </option>
                        ))}
                    </select>
                </label>
                {presetNeedsLens(camera.preset) && (
                    <label className="block text-xs text-white/85">
                        {t("studio.space.camera.lens")}
                        <span className="mt-1 flex items-center gap-2">
                            <input
                                type="number"
                                inputMode="numeric"
                                min={LENS_MIN_MM}
                                max={LENS_MAX_MM}
                                step={1}
                                value={camera.lensMm}
                                onChange={(e) => {
                                    const v = Number(e.target.value);
                                    if (Number.isFinite(v) && v > 0) setCamera((c) => chooseLens(c, v));
                                }}
                                className={`w-24 ${FIELD}`}
                            />
                            mm
                        </span>
                    </label>
                )}
                {camera.preset === "custom" && (
                    <label className="block text-xs text-white/85">
                        {t("studio.space.camera.manual")}
                        <input
                            type="range"
                            min={15}
                            max={110}
                            step={0.5}
                            value={camera.vfovDeg}
                            onChange={(e) => setCamera((c) => acceptMeasuredFov(c, Number(e.target.value), "manual"))}
                            className="mt-1 block w-full accent-sky-300"
                        />
                    </label>
                )}
                <p className="text-xs text-sky-200" aria-live="polite">
                    {t("studio.space.camera.vfov", { value: formatDeg(camera.vfovDeg, lang), source: t(`studio.space.sources.${camera.fovSource}`) })}
                </p>

                {controller.calibrateLens && (
                    <div className="space-y-2 rounded-2xl bg-white/5 p-3">
                        <button type="button" aria-expanded={lensOpen} onClick={() => setLensOpen((v) => !v)} className={`${BTN} w-full justify-start font-semibold`}>
                            <Target className="size-3.5" aria-hidden />
                            {t("studio.space.lens.title")}
                        </button>
                        {lensOpen && (
                            <div className="space-y-2 text-xs text-white/85">
                                <p>{t("studio.space.lens.body")}</p>
                                <canvas ref={board} className={boardState === "drawn" ? "w-full rounded-lg bg-white" : "hidden"} aria-label={t("studio.space.lens.boardAlt")} />
                                {boardState === "unavailable" && <p className="text-white/70">{t("studio.space.lens.boardUnavailable")}</p>}
                                <div className="flex flex-wrap gap-2">
                                    <button type="button" onClick={() => void drawBoard()} className={BTN}>
                                        {t("studio.space.lens.board")}
                                    </button>
                                    {lens.kind === "running" ? (
                                        <button type="button" onClick={() => lensAbort.current?.abort()} className={BTN}>
                                            {t("studio.space.lens.stop")}
                                        </button>
                                    ) : (
                                        <button type="button" onClick={() => void runLens()} className={PRIMARY}>
                                            {t("studio.space.lens.start")}
                                        </button>
                                    )}
                                </div>
                                {lp && (
                                    <div className="space-y-1" aria-live="polite">
                                        <p>{t("studio.space.lens.views", { n: lp.views, needed: lp.needed })}</p>
                                        <Bar value={lp.coverage} label={t("studio.space.lens.coverage")} />
                                        {lp.lastError && <p className="text-amber-200">{lp.lastError}</p>}
                                    </div>
                                )}
                                {lens.kind === "done" && (
                                    <p className="text-emerald-200" aria-live="polite">
                                        {t("studio.space.lens.result", { vfov: formatDeg(lens.result.vfovDeg, lang), rms: lens.result.rmsPx.toFixed(2) })}
                                    </p>
                                )}
                                {lens.kind === "error" && <p className="text-amber-200">{t("studio.space.failed", { error: lens.error })}</p>}
                            </div>
                        )}
                    </div>
                )}

                {controller.analyseScene && (
                    <div className="space-y-2 rounded-2xl bg-white/5 p-3 text-xs text-white/85">
                        <button type="button" disabled={scene.kind === "running"} onClick={() => void runScene()} className={`${BTN} w-full justify-start font-semibold`}>
                            <ScanSearch className="size-3.5" aria-hidden />
                            {t("studio.space.scene.title")}
                        </button>
                        {scene.kind === "running" && (
                            <div aria-live="polite" className="space-y-1">
                                <p>{t("studio.space.scene.running", { pct: Math.round(scene.progress * 100) })}</p>
                                <Bar value={scene.progress} label={t("studio.space.scene.title")} />
                            </div>
                        )}
                        {scene.kind === "done" && (
                            <div className="space-y-2" aria-live="polite">
                                <Rows
                                    rows={[
                                        [t("studio.space.fields.vfov"), formatDeg(scene.result.vfovDeg, lang)],
                                        [t("studio.space.fields.desk"), formatMetres(scene.result.deskHeightM, lang)],
                                        [t("studio.space.fields.wall"), formatMetres(scene.result.wallDistanceM, lang)],
                                    ]}
                                />
                                <button type="button" onClick={() => setCamera((c) => acceptMeasuredFov(c, scene.result.vfovDeg, "moge"))} className={BTN}>
                                    <Check className="size-3.5" aria-hidden />
                                    {t("studio.space.scene.accept")}
                                </button>
                            </div>
                        )}
                        {scene.kind === "error" && <p className="text-amber-200">{t("studio.space.failed", { error: scene.error })}</p>}
                    </div>
                )}
            </div>
        );
    } else if (step === "you") {
        body = (
            <div className="space-y-3">
                <p className="text-sm leading-snug text-white/85">{t("studio.space.you.body")}</p>
                <label className="block text-xs text-white/85">
                    {t("studio.space.you.height")}
                    <span className="mt-1 flex items-center gap-2">
                        <input
                            type="number"
                            inputMode="numeric"
                            min={HEIGHT_MIN_CM}
                            max={HEIGHT_MAX_CM}
                            step={1}
                            value={heightText}
                            aria-invalid={heightInvalid}
                            aria-describedby="space-height-hint"
                            onChange={(e) => setHeightText(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && !heightInvalid) go(1);
                            }}
                            className={`w-24 ${FIELD}`}
                        />
                        cm
                    </span>
                </label>
                <p id="space-height-hint" className={`text-[0.6875rem] ${heightInvalid ? "text-amber-200" : "text-white/70"}`}>
                    {heightInvalid ? t("studio.space.you.invalid", { min: HEIGHT_MIN_CM, max: HEIGHT_MAX_CM }) : t("studio.space.you.hint")}
                </p>
            </div>
        );
    } else if (step === "standing") {
        const s = samples.standing;
        body = captureBlock(
            "standing",
            "🧍",
            <Rows
                rows={[
                    [t("studio.space.fields.tilt"), formatDeg(s?.tiltDeg, lang)],
                    [t("studio.space.fields.cameraHeight"), formatMetres(s?.heightM, lang)],
                    [t("studio.space.fields.distance"), formatMetres(s?.distanceM, lang)],
                ]}
            />,
        );
    } else if (step === "seated") {
        const s = samples.seated;
        body = captureBlock(
            "seated",
            "🪑",
            <Rows
                rows={[
                    [t("studio.space.fields.shoulder"), formatCm(s?.shoulderM, lang)],
                    [t("studio.space.fields.iris"), formatMm(s?.irisM, lang)],
                    [t("studio.space.fields.headHeight"), formatMetres(s?.headHeightM, lang)],
                    [t("studio.space.fields.distance"), formatMetres(s?.distanceM, lang)],
                ]}
            />,
        );
    } else if (step === "hands") {
        body = handsBody();
    } else {
        body = (
            <div className="space-y-3">
                <Rows
                    rows={[
                        [t("studio.space.fields.camera"), presetLabel(camera.preset)],
                        [t("studio.space.fields.vfov"), formatDeg(camera.vfovDeg, lang)],
                        [t("studio.space.fields.height"), heightCm !== null ? `${heightCm} cm` : "—"],
                        [t("studio.space.fields.tilt"), formatDeg(measure.tiltDeg, lang)],
                        [t("studio.space.fields.cameraHeight"), formatMetres(measure.cameraHeightM, lang)],
                        [t("studio.space.fields.shoulder"), formatCm(measure.shoulderM, lang)],
                        [t("studio.space.fields.iris"), formatMm(measure.irisM, lang)],
                        [t("studio.space.fields.headHeight"), formatMetres(measure.seatedHeadM, lang)],
                        [
                            t("studio.space.fields.hands"),
                            handsRecorded ? (handsSummary.verified > 0 ? formatPct(handsSummary.passRate) : t("studio.space.hands.notVerified")) : "—",
                        ],
                    ]}
                />
                <label className={`flex items-center gap-2 text-xs ${measure.tiltDeg === undefined ? "opacity-50" : ""}`}>
                    <input
                        type="checkbox"
                        checked={useTilt && measure.tiltDeg !== undefined}
                        disabled={measure.tiltDeg === undefined}
                        onChange={(e) => setUseTilt(e.target.checked)}
                        className="size-4 accent-sky-300"
                    />
                    {t("studio.space.review.useTilt")}
                </label>
                <p className="text-[0.6875rem] text-white/70">{t("studio.space.review.hint")}</p>
            </div>
        );
    }

    return (
        <div className="absolute inset-0 z-30 grid place-items-end justify-center bg-black/30 p-6 pb-28">
            <motion.div
                ref={dialog}
                tabIndex={-1}
                role="dialog"
                aria-modal="true"
                aria-labelledby="space-title"
                aria-describedby="space-step"
                onKeyDown={(e) => {
                    if (e.key === "Escape" && !busy) {
                        e.stopPropagation();
                        close();
                    }
                }}
                initial={reduced ? false : { opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                transition={reduced ? INSTANT : SPRING}
                className={`${GLASS} max-h-[calc(100cqh-3rem)] w-[30rem] max-w-full overflow-y-auto rounded-3xl p-5 outline-none`}
            >
                <div className="flex items-start justify-between">
                    <div>
                        <h2 id="space-title" className="text-base font-semibold">
                            {t("studio.space.title")}
                        </h2>
                        <p id="space-step" className="text-[0.6875rem] text-white/70">
                            {t("studio.space.progress", { n: index + 1, total: STEPS.length, step: t(`studio.space.${step}.title`) })}
                        </p>
                    </div>
                    <button type="button" onClick={close} disabled={busy} aria-label={t("studio.common.close")} className={`grid size-7 place-items-center rounded-full hover:bg-white/15 disabled:opacity-40 ${FOCUS_RING}`}>
                        <X className="size-4" aria-hidden />
                    </button>
                </div>

                <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/15" aria-hidden>
                    <motion.div className="h-full bg-sky-300" animate={{ width: `${((index + 1) / STEPS.length) * 100}%` }} transition={reduced ? INSTANT : SPRING} />
                </div>

                <h3 className="mt-4 text-sm font-semibold">{t(`studio.space.${step}.title`)}</h3>
                <div className="mt-2">{body}</div>
                <p className="sr-only" aria-live="assertive">
                    {live}
                </p>
                {capture.kind !== "idle" && (
                    <p className="mt-2 text-[0.6875rem] text-sky-200" aria-hidden>
                        {live}
                    </p>
                )}

                <div className="mt-4 flex items-center justify-between gap-2">
                    <button type="button" onClick={() => go(-1)} disabled={busy || index === 0} className={BTN}>
                        <ArrowLeft className="size-3.5" aria-hidden />
                        {t("studio.space.back")}
                    </button>
                    {step === "review" ? (
                        <button type="button" onClick={save} disabled={busy} className={`flex items-center gap-1 rounded-xl bg-emerald-400 px-4 py-2 text-xs font-semibold text-neutral-950 hover:bg-emerald-300 disabled:opacity-50 ${FOCUS_RING}`}>
                            <Check className="size-3.5" aria-hidden />
                            {t("studio.space.save")}
                        </button>
                    ) : (
                        <button type="button" onClick={() => go(1)} disabled={busy || (step === "you" && heightInvalid)} className={BTN}>
                            {(step === "standing" && !samples.standing) ||
                            (step === "seated" && !samples.seated) ||
                            (step === "you" && heightCm === null) ||
                            (step === "hands" && !handsRecorded)
                                ? t("studio.space.skip")
                                : t("studio.space.next")}
                            <ArrowRight className="size-3.5" aria-hidden />
                        </button>
                    )}
                </div>
            </motion.div>
        </div>
    );
}
