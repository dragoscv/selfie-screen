import { emitTo, listen } from "@tauri-apps/api/event";
import type { MicPanelMode } from "@tiksee/core";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { MicDiag, MicEvent } from "../../lib/audio/mic.js";

/**
 * Studio mic HUD (F4, preview only — never in the output video): what the transcription hears,
 * live. The mic runs in the main window; this asks it (`mic://watch`) and draws the 10 Hz
 * `mic://diag` stream: level meter against the speech threshold and noise floor, clipping, the
 * running partial transcript, final lines, connection events and a plain-language diagnosis.
 */

interface Payload {
    enabled: boolean;
    loading: boolean;
    error: string | null;
    diag: MicDiag | null;
    events: MicEvent[];
}

const HISTORY = 60;
const LOG = 8;
/** Final lines kept for the transcript-only view. */
const FINALS = 6;
const db = (v: number): number => (v > 0 ? 20 * Math.log10(v) : -90);
/** Meter scale -60..0 dBFS -> 0..100 %. */
const pct = (v: number): number => Math.max(0, Math.min(100, ((db(v) + 60) / 60) * 100));

type Advice = "off" | "starting" | "noSignal" | "tooQuiet" | "clipping" | "noisy" | "waitingKey" | "offline" | "noText" | "ok";

function advise(p: Payload | null, quietFrames: number, peaks: number): Advice {
    if (!p || !p.enabled) return "off";
    const d = p.diag;
    if (!d || p.loading) return "starting";
    if (d.framesPerSec < 5) return "noSignal";
    if (d.ws !== "open") return "offline";
    if (d.waitingForKey) return "waitingKey";
    if (peaks > 3) return "clipping";
    if (d.floor * 3 > 0.05) return "noisy";
    // Silence is normal between sentences: only after 15 s without speech suggest the mic is too quiet.
    if (quietFrames > 150 && !d.speaking) return "tooQuiet";
    if (d.commits > 0 && d.finals === 0) return "noText";
    return "ok";
}

export function MicHud({ mode, onClose }: { mode: Exclude<MicPanelMode, "off">; onClose: () => void }) {
    const { t } = useTranslation();
    const [p, setP] = useState<Payload | null>(null);
    const [events, setEvents] = useState<MicEvent[]>([]);
    const [finalLines, setFinalLines] = useState<MicEvent[]>([]);
    const [view, setView] = useState<{ history: number[]; advice: Advice }>({ history: [], advice: "starting" });
    const history = useRef<number[]>([]);
    const peaks = useRef<number[]>([]);
    const quiet = useRef(0);

    useEffect(() => {
        const ask = () => void emitTo("main", "mic://watch", null).catch(() => undefined);
        ask();
        const timer = window.setInterval(ask, 2_000);
        let disposed = false;
        let stop: (() => void) | undefined;
        void listen<Payload>("mic://diag", (e) => {
            const payload = e.payload;
            const d = payload.diag;
            if (d) {
                history.current.push(d.level);
                if (history.current.length > HISTORY) history.current.shift();
                peaks.current.push(d.peak >= 0.98 ? 1 : 0);
                if (peaks.current.length > 30) peaks.current.shift();
                quiet.current = d.level < d.threshold * 0.6 ? quiet.current + 1 : 0;
            }
            if (payload.events.length > 0) {
                setEvents((prev) => [...prev, ...payload.events].slice(-LOG));
                const finals = payload.events.filter((ev) => ev.kind === "final");
                if (finals.length > 0) setFinalLines((prev) => [...prev, ...finals].slice(-FINALS));
            }
            setP(payload);
            setView({
                history: [...history.current],
                advice: advise(payload, quiet.current, peaks.current.reduce((a, b) => a + b, 0)),
            });
        }).then((u) => (disposed ? u() : (stop = u)));
        return () => {
            disposed = true;
            window.clearInterval(timer);
            stop?.();
        };
    }, []);

    const d = p?.diag ?? null;
    const advice = p ? view.advice : "off";
    const bad = advice !== "ok" && advice !== "starting";
    const finals = finalLines.slice(-3);
    const log = events.filter((e) => e.kind !== "final").slice(-4);

    if (mode === "transcript") {
        return (
            <section
                aria-label={t("studio.mic.transcriptTitle")}
                className="pointer-events-auto absolute left-3 top-14 z-40 w-[min(92%,420px)] rounded-xl border border-white/15 bg-neutral-950/75 p-3 text-white shadow-xl backdrop-blur-xl"
            >
                <header className="mb-1.5 flex items-center gap-2 text-[12px]">
                    <span aria-hidden className={`size-2 rounded-full ${d?.speaking ? "bg-emerald-400" : d?.ws === "open" ? "bg-sky-400" : "bg-neutral-500"}`} />
                    <h2 className="font-semibold">{t("studio.mic.transcriptTitle")}</h2>
                    {bad && <span className="truncate text-amber-200">{t(`studio.mic.advice.${advice}`)}</span>}
                    <button type="button" onClick={onClose} className="ml-auto rounded px-1.5 text-white/70 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400" aria-label={t("studio.common.close")}>
                        ×
                    </button>
                </header>
                {finalLines.length > 0 && (
                    <ul className="space-y-0.5 text-[13px] leading-snug text-white/75">
                        {finalLines.map((f, i) => (
                            <li key={`${f.at}-${i}`}>{f.text}</li>
                        ))}
                    </ul>
                )}
                <p className="mt-1 min-h-[1.4em] text-[15px] font-medium leading-snug" aria-live="polite">
                    {d?.partial ? d.partial : <span className="text-[13px] font-normal text-white/40">{d?.streaming ? t("studio.mic.listening") : t("studio.mic.speakNow")}</span>}
                </p>
            </section>
        );
    }

    return (
        <section
            aria-label={t("studio.mic.title")}
            className="pointer-events-auto absolute left-3 top-14 z-40 w-[min(92%,380px)] rounded-xl border border-white/15 bg-neutral-950/80 p-3 text-[12px] text-white shadow-xl backdrop-blur-xl"
        >
            <header className="mb-2 flex items-center gap-2">
                <span aria-hidden className={`size-2 rounded-full ${d?.speaking ? "bg-emerald-400" : d?.ws === "open" ? "bg-sky-400" : "bg-neutral-500"}`} />
                <h2 className="text-[13px] font-semibold">{t("studio.mic.title")}</h2>
                <span className="ml-auto text-white/60">{d ? t(`studio.mic.phase.${d.phase}`) : t("studio.mic.phase.off")}</span>
                <button type="button" onClick={onClose} className="rounded px-1.5 text-white/70 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400" aria-label={t("studio.common.close")}>
                    ×
                </button>
            </header>

            {/* Level meter: bar = RMS, line = speech threshold, shaded = noise floor (all dBFS). */}
            <div className="relative h-4 overflow-hidden rounded bg-white/10" role="meter" aria-label={t("studio.mic.level")} aria-valuemin={-60} aria-valuemax={0} aria-valuenow={Math.round(db(d?.level ?? 0))}>
                <div className="absolute inset-y-0 left-0 bg-white/15" style={{ width: `${pct(d?.floor ?? 0)}%` }} />
                <div
                    className={`absolute inset-y-0 left-0 transition-[width] duration-75 ${(d?.peak ?? 0) >= 0.98 ? "bg-rose-500" : d?.speaking ? "bg-emerald-400" : "bg-sky-400/80"}`}
                    style={{ width: `${pct(d?.level ?? 0)}%` }}
                />
                <div className="absolute inset-y-0 w-0.5 bg-amber-300" style={{ left: `${pct(d?.threshold ?? 0)}%` }} title={t("studio.mic.threshold")} />
            </div>
            <div className="mt-1 flex justify-between font-mono text-[11px] text-white/60">
                <span>{t("studio.mic.levelDb", { db: db(d?.level ?? 0).toFixed(0) })}</span>
                <span>{t("studio.mic.thresholdDb", { db: db(d?.threshold ?? 0).toFixed(0) })}</span>
                <span>{t("studio.mic.peakDb", { db: db(d?.peak ?? 0).toFixed(0) })}</span>
            </div>

            {/* Last 6 s of level as a sparkline. */}
            <svg viewBox={`0 0 ${HISTORY} 20`} preserveAspectRatio="none" className="mt-1 h-6 w-full" aria-hidden>
                <polyline fill="none" stroke="rgb(56 189 248)" strokeWidth="0.6" points={view.history.map((v, i) => `${i},${20 - pct(v) / 5}`).join(" ")} />
                <line x1="0" x2={HISTORY} y1={20 - pct(d?.threshold ?? 0) / 5} y2={20 - pct(d?.threshold ?? 0) / 5} stroke="rgb(252 211 77)" strokeWidth="0.3" />
            </svg>

            <p className={`mt-2 rounded-md px-2 py-1.5 ${bad ? "bg-amber-400/15 text-amber-100" : "bg-emerald-400/10 text-emerald-100"}`} role="status">
                {t(`studio.mic.advice.${advice}`)}
            </p>

            <div className="mt-2 min-h-[2.6em] rounded-md bg-white/5 px-2 py-1.5 text-[13px] leading-snug" aria-live="polite">
                {d?.partial ? <span className="text-white">{d.partial}</span> : <span className="text-white/40">{d?.streaming ? t("studio.mic.listening") : t("studio.mic.speakNow")}</span>}
            </div>
            {finals.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                    {finals.map((f, i) => (
                        <li key={`${f.at}-${i}`} className="truncate text-white/80">
                            <span className="mr-1 font-mono text-[10px] text-white/40">{new Date(f.at).toLocaleTimeString()}</span>
                            {f.text}
                        </li>
                    ))}
                </ul>
            )}

            <dl className="mt-2 grid grid-cols-3 gap-x-2 gap-y-0.5 font-mono text-[11px] text-white/70">
                <dt className="text-white/40">{t("studio.mic.ws")}</dt>
                <dd className="col-span-2">{d ? t(`studio.mic.wsState.${d.ws}`) : "–"}</dd>
                <dt className="text-white/40">{t("studio.mic.device")}</dt>
                <dd className="col-span-2 truncate">{d?.device || "–"} {d ? `· ${(d.sampleRate / 1000).toFixed(0)} kHz · ${d.framesPerSec}/s` : ""}</dd>
                <dt className="text-white/40">{t("studio.mic.turn")}</dt>
                <dd className="col-span-2">{t("studio.mic.turnValue", { turn: d?.turnMs ?? 0, sent: ((d?.sentMs ?? 0) / 1000).toFixed(1), commits: d?.commits ?? 0, finals: d?.finals ?? 0 })}</dd>
                <dt className="text-white/40">{t("studio.mic.latency")}</dt>
                <dd className="col-span-2">{d?.lastLatencyMs != null ? `${d.lastLatencyMs} ms` : "–"}</dd>
                <dt className="text-white/40">{t("studio.mic.server")}</dt>
                <dd className="col-span-2 break-all text-[10px]">
                    {d && Object.keys(d.serverEvents).length > 0
                        ? Object.entries(d.serverEvents)
                              .map(([k, n]) => `${k.replace(/^conversation\.item\.|^input_audio_/, "")} ×${n}`)
                              .join(" · ")
                        : "–"}
                </dd>
            </dl>

            {(log.length > 0 || p?.error) && (
                <ul className="mt-2 space-y-0.5 border-t border-white/10 pt-1.5 font-mono text-[10.5px]">
                    {p?.error && <li className="text-rose-300">{p.error}</li>}
                    {log.map((e, i) => (
                        <li key={`${e.at}-${i}`} className={e.kind === "error" || e.kind === "close" ? "text-rose-300" : e.kind === "skip" ? "text-amber-200" : "text-white/55"}>
                            {new Date(e.at).toLocaleTimeString()} {t(`studio.mic.event.${e.kind}`)}: {e.text}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
