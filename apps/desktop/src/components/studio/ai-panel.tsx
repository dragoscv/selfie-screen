import { PET_AI_LEVELS, PET_CHAT_AWARENESS, type PetAiLevel, type PetPersonality, type StudioSettings } from "@tiksee/core";
import { ChipSelector, SwitchRow } from "@tiksee/ui";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import { RotateCcw } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ActionButton, Section } from "./controls-parts.js";
import { INSTANT, SPRING, useStudio } from "./context.js";
import { HoldButton } from "./hold-button.js";

/** Studio dock AI panel (lazy chunk): AI level, chat awareness, bubbles/voice, hand interaction, persistent personalities. */
/* ------------------------------------------------------------------ *
 * Pet AI
 * ------------------------------------------------------------------ */

const OCEAN = ["openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism"] as const;
const RESET_HOLD_MS = 1200;
const llmLevel = (level: PetAiLevel) => level !== "off" && level !== "local";

/** One-line description that cross-fades when `id` changes; the parent height follows (layout). */
function SwapText({ id, children }: { id: string; children: ReactNode }) {
    const reduced = useReducedMotion();
    return (
        <motion.div layout={!reduced} transition={reduced ? INSTANT : SPRING} className="relative overflow-hidden">
            <AnimatePresence mode="popLayout" initial={false}>
                <motion.p
                    key={id}
                    initial={reduced ? false : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduced ? { opacity: 0, transition: INSTANT } : { opacity: 0, y: -6 }}
                    transition={reduced ? INSTANT : SPRING}
                    aria-live="polite"
                    className="text-[0.6875rem] leading-snug text-white/75"
                >
                    {children}
                </motion.p>
            </AnimatePresence>
        </motion.div>
    );
}

function TraitBar({ label, value }: { label: string; value: number }) {
    const reduced = useReducedMotion();
    const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
    return (
        <div className="grid grid-cols-[1.25rem_1fr_2rem] items-center gap-1.5 text-[0.625rem]" title={label}>
            <span className="font-semibold text-white/70" aria-hidden>
                {label.slice(0, 1).toUpperCase()}
            </span>
            <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-1.5 overflow-hidden rounded-full bg-white/15">
                <motion.div className="h-full rounded-full bg-fuchsia-300" initial={false} animate={{ width: `${pct}%` }} transition={reduced ? INSTANT : SPRING} />
            </div>
            <span className="text-right tabular-nums text-white/70" aria-hidden>
                {pct}
            </span>
        </div>
    );
}

function ResetPersonality({ pet, name }: { pet: string; name: string }) {
    const { controller } = useStudio();
    const { t } = useTranslation();
    const reduced = useReducedMotion();
    const timer = useRef<number | null>(null);
    const [holding, setHolding] = useState(false);
    const clear = () => {
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = null;
    };
    useEffect(() => clear, []);
    return (
        <div className="space-y-1">
            <HoldButton
                label={t("studio.controls.ai.resetHold")}
                icon={<RotateCcw className="size-3.5" aria-hidden />}
                className="w-full"
                onStart={() => {
                    clear();
                    setHolding(true);
                    timer.current = window.setTimeout(() => {
                        timer.current = null;
                        setHolding(false);
                        controller.resetPetPersonality(pet);
                        toast.success(t("studio.controls.ai.resetDone", { name }));
                    }, RESET_HOLD_MS);
                }}
                onStop={() => {
                    clear();
                    setHolding(false);
                }}
            />
            <div className="h-0.5 overflow-hidden rounded-full bg-white/10" aria-hidden>
                <motion.div
                    className="h-full bg-rose-300"
                    initial={false}
                    animate={{ width: holding ? "100%" : "0%" }}
                    transition={holding && !reduced ? { duration: RESET_HOLD_MS / 1000, ease: "linear" } : INSTANT}
                />
            </div>
        </div>
    );
}

function PersonalityCard({ pet, data }: { pet: string; data: PetPersonality | undefined }) {
    const { t } = useTranslation();
    const reduced = useReducedMotion();
    const name = t(`studio.pets.${pet}`);
    const latest = data ? [...data.memories].sort((a, b) => b.at - a.at)[0] : undefined;
    return (
        <motion.li
            layout={!reduced}
            layoutId={reduced ? undefined : `pet-card-${pet}`}
            initial={reduced ? false : { opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduced ? { opacity: 0, transition: INSTANT } : { opacity: 0, scale: 0.96 }}
            transition={reduced ? INSTANT : SPRING}
            className="space-y-2 rounded-2xl bg-white/5 p-3"
            aria-label={name}
        >
            <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold">{name}</h3>
                <span className="text-[0.625rem] tabular-nums text-white/70">{t("studio.controls.ai.sessions", { count: data?.sessions ?? 0 })}</span>
            </div>
            {data ? (
                <>
                    <div className="space-y-1">
                        {OCEAN.map((k) => (
                            <TraitBar key={k} label={t(`studio.controls.ai.traits.${k}`)} value={data.traits[k]} />
                        ))}
                    </div>
                    <p className="truncate text-[0.6875rem] text-white/75" title={latest?.text}>
                        {latest ? `“${latest.text}”` : t("studio.controls.ai.noMemory")}
                    </p>
                    <ResetPersonality pet={pet} name={name} />
                </>
            ) : (
                <p className="text-[0.6875rem] text-white/70">{t("studio.controls.ai.newPet")}</p>
            )}
        </motion.li>
    );
}

export function AiPanel() {
    const { studio, controller, patchStudio } = useStudio();
    const { t } = useTranslation();
    const [personalities, setPersonalities] = useState<readonly PetPersonality[]>([]);
    useEffect(() => controller.onPetPersonalities(setPersonalities), [controller]);

    const ai = studio.petAi;
    const hands = studio.petHands;
    const setAi = (p: Partial<StudioSettings["petAi"]>) => patchStudio({ petAi: { ...ai, ...p } });
    const llm = llmLevel(ai.level);
    const resized = Object.values(hands.scale).some((v) => v !== 1);
    const pets = [studio.leftPet, studio.rightPet].filter((p, i, all) => p !== "none" && all.indexOf(p) === i);

    return (
        <>
            <Section title={t("studio.controls.ai.title")}>
                <ChipSelector label={t("studio.controls.ai.level")} options={PET_AI_LEVELS} value={ai.level} onSelect={(level) => setAi({ level })} display={(v) => t(`studio.controls.ai.levels.${v}`)} />
                <SwapText id={ai.level}>
                    {t(`studio.controls.ai.levelHint.${ai.level}`)}
                    <span className="mt-0.5 block font-semibold text-sky-200">
                        {llm ? t("studio.controls.ai.cost", { n: ai.maxCallsPerHour }) : t("studio.controls.ai.noCost")}
                    </span>
                </SwapText>
            </Section>
            <Section title={t("studio.controls.ai.chat")}>
                <div aria-disabled={!llm} className={llm ? "" : "opacity-55"}>
                    <ChipSelector
                        label={t("studio.controls.ai.chatLabel")}
                        options={PET_CHAT_AWARENESS}
                        value={ai.chat}
                        onSelect={(chat) => setAi({ chat })}
                        display={(v) => t(`studio.controls.ai.chats.${v}`)}
                        disabled={!llm}
                    />
                </div>
                <SwapText id={llm ? ai.chat : "off"}>{llm ? t(`studio.controls.ai.chatHint.${ai.chat}`) : t("studio.controls.ai.needsLlm")}</SwapText>
                <SwitchRow label={t("studio.controls.ai.bubbles")} checked={ai.bubbles} onChange={(bubbles) => setAi({ bubbles })} />
                <SwitchRow
                    label={t("studio.controls.ai.voice")}
                    description={llm ? t("studio.controls.ai.voiceHint") : t("studio.controls.ai.needsLlm")}
                    checked={ai.voice && llm}
                    disabled={!llm}
                    onChange={(voice) => setAi({ voice })}
                />
            </Section>
            <Section title={t("studio.controls.ai.handsTitle")}>
                <SwitchRow
                    label={t("studio.controls.ai.hands")}
                    description={t("studio.controls.ai.handsHint")}
                    checked={hands.enabled}
                    onChange={(enabled) => patchStudio({ petHands: { ...hands, enabled } })}
                />
                {resized && (
                    <ActionButton
                        icon={<RotateCcw className="size-4" aria-hidden />}
                        label={t("studio.controls.ai.resetSizes")}
                        onClick={() => patchStudio({ petHands: { ...hands, scale: {} } })}
                    />
                )}
            </Section>
            <Section title={t("studio.controls.ai.personalities")}>
                <LayoutGroup id="pet-cards">
                    <ul className="space-y-2">
                        <AnimatePresence mode="popLayout" initial={false}>
                            {pets.map((pet) => (
                                <PersonalityCard key={pet} pet={pet} data={personalities.find((p) => p.pet === pet)} />
                            ))}
                        </AnimatePresence>
                    </ul>
                </LayoutGroup>
                {pets.length === 0 && <p className="text-[0.6875rem] text-white/70">{t("studio.controls.ai.empty")}</p>}
            </Section>
        </>
    );
}

