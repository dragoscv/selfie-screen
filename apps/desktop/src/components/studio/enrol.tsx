import { Progress } from "@tiksee/ui";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Lock, ScanFace, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { EnrolSample } from "../../lib/studio/controller.js";
import { sidecarClient } from "../../lib/sidecar-client.js";
import { mergeEmbeddings, type EnrolRequest } from "./actions.js";
import { FOCUS_RING, GLASS, INSTANT, SPRING, useStudio } from "./context.js";

const TARGET = 8;
const INTERVAL_MS = 700;
const MIN_QUALITY = 0.3;
const PERSON_POSES = ["straight", "left", "right", "up", "down", "smile", "straight", "tilt"] as const;
const DOG_POSES = ["front", "left", "right", "front", "side", "up", "down", "front"] as const;

/** Enrolment: enable identity (download models), capture 8 good samples, upsert to the sidecar. */
export function Enrol({ request, onClose }: { request: EnrolRequest; onClose: () => void }) {
    const { controller, vision, profiles, patchVision } = useStudio();
    const { t } = useTranslation();
    const reduced = useReducedMotion();
    const subject = request.kind === "dog" ? "dog" : "person";
    const profile = profiles.find((p) => p.id === request.profileId);
    const [progress, setProgress] = useState<number | null>(null);
    const [samples, setSamples] = useState<EnrolSample[]>([]);
    const [skipped, setSkipped] = useState(0);
    const [capturing, setCapturing] = useState(false);
    const stop = useRef(false);
    const dialog = useRef<HTMLDivElement>(null);
    const poses = subject === "dog" ? DOG_POSES : PERSON_POSES;

    useEffect(() => {
        dialog.current?.focus({ preventScroll: true });
        stop.current = false;
        return () => {
            stop.current = true;
        };
    }, []);

    const enable = async () => {
        setProgress(0);
        try {
            patchVision({ identity: true });
            await controller.ensureModels([subject === "dog" ? "dogIdentity" : "identity"], setProgress);
            setProgress(1);
        } catch (e) {
            setProgress(null);
            toast.error(t("studio.enrol.modelsFailed", { error: String(e) }));
        }
    };

    const capture = async () => {
        setCapturing(true);
        setSamples([]);
        setSkipped(0);
        let got = 0;
        let tries = 0;
        try {
            await controller.ensureModels([subject === "dog" ? "dogIdentity" : "identity"]);
            while (got < TARGET && tries < TARGET * 4 && !stop.current) {
                tries++;
                const s = await controller.sampleEnrolment(subject);
                if (stop.current) return;
                if (!s || s.quality < MIN_QUALITY) setSkipped((n) => n + 1);
                else {
                    got++;
                    setSamples((prev) => [...prev, s]);
                }
                await new Promise((r) => window.setTimeout(r, INTERVAL_MS));
            }
            if (got < TARGET) toast.warning(t("studio.enrol.partial", { count: got }));
        } catch (e) {
            toast.error(t("studio.enrol.failed", { error: String(e) }));
        } finally {
            setCapturing(false);
        }
    };

    const save = () => {
        if (!profile || samples.length === 0) return;
        sidecarClient.send({ type: "identityUpsert", profile: mergeEmbeddings(profile, samples) });
        toast.success(t("studio.enrol.saved", { name: profile.name }));
        onClose();
    };

    const needsIdentity = !vision.identity || (progress !== null && progress < 1);
    const pose = poses[Math.min(samples.length, poses.length - 1)] ?? poses[0];

    return (
        <div className="absolute inset-0 z-30 grid place-items-end justify-center bg-black/30 p-6 pb-28">
            <motion.div
                ref={dialog}
                tabIndex={-1}
                role="dialog"
                aria-modal="true"
                aria-labelledby="enrol-title"
                onKeyDown={(e) => {
                    if (e.key === "Escape" && !capturing) onClose();
                }}
                initial={reduced ? false : { opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                transition={reduced ? INSTANT : SPRING}
                className={`${GLASS} w-[30rem] max-w-full rounded-3xl p-5 outline-none`}
            >
                <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2">
                        <ScanFace className="size-5 text-sky-300" aria-hidden />
                        <h2 id="enrol-title" className="text-base font-semibold">
                            {t("studio.enrol.title", { name: profile?.name ?? "?" })}
                        </h2>
                    </div>
                    <button type="button" onClick={onClose} disabled={capturing} aria-label={t("studio.common.close")} className={`grid size-7 place-items-center rounded-full hover:bg-white/15 disabled:opacity-40 ${FOCUS_RING}`}>
                        <X className="size-4" aria-hidden />
                    </button>
                </div>

                {!profile ? (
                    <p className="mt-3 text-sm text-white/85">{t("studio.enrol.missing")}</p>
                ) : needsIdentity ? (
                    <div className="mt-3 space-y-3">
                        <p className="text-sm leading-snug text-white/85">{t("studio.enrol.identityOff")}</p>
                        {progress !== null ? (
                            <Progress value={Math.round(progress * 100)} label={t("studio.enrol.downloading", { pct: Math.round(progress * 100) })} />
                        ) : (
                            <button type="button" onClick={() => void enable()} className={`rounded-xl bg-sky-400 px-4 py-2 text-xs font-semibold text-neutral-950 hover:bg-sky-300 ${FOCUS_RING}`}>
                                {t("studio.enrol.enable")}
                            </button>
                        )}
                    </div>
                ) : (
                    <div className="mt-3 space-y-3">
                        <p className="text-sm text-white/85" aria-live="polite">
                            {capturing ? t(`studio.enrol.poses.${subject}.${pose ?? "straight"}`) : t(`studio.enrol.intro.${subject}`)}
                        </p>
                        <ul className="grid grid-cols-8 gap-1.5" aria-label={t("studio.enrol.samples", { count: samples.length })}>
                            {Array.from({ length: TARGET }, (_, i) => {
                                const s = samples[i];
                                return (
                                    <li key={i} className="relative aspect-square overflow-hidden rounded-lg bg-white/10">
                                        <AnimatePresence>
                                            {s && (
                                                <motion.img
                                                    src={s.thumbnail}
                                                    alt={t("studio.enrol.sampleAlt", { n: i + 1, q: Math.round(s.quality * 100) })}
                                                    initial={reduced ? false : { scale: 0.5, opacity: 0 }}
                                                    animate={{ scale: 1, opacity: 1 }}
                                                    transition={reduced ? INSTANT : SPRING}
                                                    className="size-full object-cover"
                                                />
                                            )}
                                        </AnimatePresence>
                                        {s && (
                                            <span className="absolute inset-x-0 bottom-0 bg-black/70 text-center text-[0.5625rem] font-semibold tabular-nums text-white">
                                                {Math.round(s.quality * 100)}
                                            </span>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                        <p className="text-[0.6875rem] text-white/70">
                            {t("studio.enrol.counts", { got: samples.length, total: TARGET, skipped })}
                        </p>
                        <div className="flex justify-end gap-2">
                            <button type="button" disabled={capturing} onClick={() => void capture()} className={`rounded-xl bg-white/10 px-4 py-2 text-xs font-semibold hover:bg-white/20 disabled:opacity-50 ${FOCUS_RING}`}>
                                {capturing ? t("studio.enrol.capturing") : samples.length > 0 ? t("studio.enrol.again") : t("studio.enrol.start")}
                            </button>
                            <button type="button" disabled={capturing || samples.length === 0} onClick={save} className={`rounded-xl bg-emerald-400 px-4 py-2 text-xs font-semibold text-neutral-950 hover:bg-emerald-300 disabled:opacity-50 ${FOCUS_RING}`}>
                                {t("studio.enrol.save")}
                            </button>
                        </div>
                    </div>
                )}
                <p className="mt-4 flex items-center gap-1.5 text-[0.6875rem] text-white/70">
                    <Lock className="size-3" aria-hidden />
                    {t("studio.enrol.privacy")}
                </p>
            </motion.div>
        </div>
    );
}
