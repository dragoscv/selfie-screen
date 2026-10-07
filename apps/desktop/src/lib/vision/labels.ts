import type { Condition, RuleAction, SignalId, Trigger } from "@tiksee/core";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ACTION_EMOJI, SIGNAL_EMOJI, varKey } from "./catalog.js";
import { formatMs } from "./log.js";

/** Human labels for signals, triggers, conditions and actions (store-free: usable in the studio window). */
const OP_SYMBOL = { eq: "=", ne: "≠", lt: "<", lte: "≤", gt: ">", gte: "≥" } as const;
const SET_SYMBOL = { set: "=", inc: "+=", dec: "−=" } as const;

export interface VisionLabels {
    signal: (id: SignalId) => string;
    signalWithEmoji: (id: SignalId) => string;
    trigger: (t: Trigger) => string;
    condition: (c: Condition | undefined) => string;
    action: (a: RuleAction) => string;
    actionType: (type: RuleAction["type"]) => string;
}

export function useVisionLabels(): VisionLabels {
    const { t } = useTranslation();
    return useMemo(() => {
        const signal = (id: SignalId) => t(`vision.signals.${id}`);
        const signalWithEmoji = (id: SignalId) => `${SIGNAL_EMOJI[id]} ${signal(id)}`;
        const value = (v: number | boolean) => (typeof v === "boolean" ? t(v ? "vision.editor.true" : "vision.editor.false") : String(v));

        const trigger = (tr: Trigger): string => {
            switch (tr.type) {
                case "signal": {
                    const parts = [signalWithEmoji(tr.signal)];
                    if (tr.on === "hold") parts.push(`${t("vision.triggerOn.hold")} ${formatMs(tr.holdMs)}`);
                    else if (tr.on === "end") parts.push(t("vision.triggerOn.end"));
                    if (tr.who !== "owner") parts.push(t(`vision.who.${tr.who}`));
                    return parts.join(" · ");
                }
                case "chat":
                    return t("vision.summary.chat", { text: tr.contains });
                case "gift":
                    return t("vision.summary.gift", { n: tr.minDiamonds });
                case "follow":
                    return t("vision.triggerTypes.follow");
                case "control":
                    return `${t("vision.triggerTypes.control")}: ${t(`vision.controlActions.${tr.action}`)}`;
                case "timer":
                    return t("vision.summary.timer", { time: formatMs(tr.everyMs) });
                case "manual":
                    return t("vision.triggerTypes.manual");
            }
        };

        const condition = (c: Condition | undefined): string => {
            if (!c) return t("vision.editor.gateAlways");
            switch (c.type) {
                case "compare":
                    return `${t(`vision.vars.${varKey(c.var)}`)} ${OP_SYMBOL[c.op]} ${value(c.value)}`;
                case "signalActive":
                    return `${signalWithEmoji(c.signal)} (${t(`vision.who.${c.who}`)})`;
                case "not":
                    return `${t("vision.condTypes.not")} (${condition(c.of)})`;
                case "all":
                case "any":
                    if (c.of.length === 0) return t("vision.editor.gateAlways");
                    return c.of.map(condition).join(c.type === "all" ? " ∧ " : " ∨ ");
            }
        };

        const actionType = (type: RuleAction["type"]) => t(`vision.actionTypes.${type}`);

        const action = (a: RuleAction): string => {
            const head = `${ACTION_EMOJI[a.type]} `;
            switch (a.type) {
                case "control":
                    return head + t(`vision.controlActions.${a.action}`);
                case "camera":
                    return head + t(`vision.cameraActions.${a.action}`);
                case "studio":
                    return head + t(`vision.studioActions.${a.action}`);
                case "effect":
                    return head + t(`vision.effects.${a.effect}`);
                case "arObject":
                    return `${head}${t(`vision.arOps.${a.op}`)} ${a.objectId}`;
                case "pet":
                    return head + t(`vision.petReactions.${a.reaction}`);
                case "speak":
                    return `${head}„${a.text}”`;
                case "vmuiFlash":
                    return `${head}${actionType(a.type)} ${a.color}`;
                case "vmuiScene":
                    return `${head}${actionType(a.type)} ${a.scene}`;
                case "highlight":
                    return head + (a.label ? `${actionType(a.type)}: ${a.label}` : actionType(a.type));
                case "notify":
                    return `${head}${a.text}`;
                case "set":
                    return `${head}${t(`vision.vars.${varKey(a.var)}`)} ${SET_SYMBOL[a.op]} ${a.value}`;
                case "if":
                    return `${head}${actionType(a.type)} ${condition(a.cond)}`;
                case "wait":
                    return `${head}${actionType(a.type)} ${formatMs(a.ms)}`;
                case "repeat":
                    return `${head}${actionType(a.type)} × ${a.count}`;
                case "parallel":
                    return `${head}${t("vision.editor.branches", { count: a.branches.length })}`;
                case "stop":
                    return head + actionType(a.type);
            }
        };

        return { signal, signalWithEmoji, trigger, condition, action, actionType };
    }, [t]);
}
