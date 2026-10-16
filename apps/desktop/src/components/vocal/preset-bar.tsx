import {
    BUILTIN_SECTION_PRESETS,
    applySection,
    sectionValues,
    type VocalParams,
    type VocalSection,
    type VocalUserPreset,
} from "@tiksee/core";
import { cn } from "@tiksee/ui";
import { Check, Download, Plus, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { downloadJson } from "../../lib/vocal-files.js";

/**
 * Preset strip for one tab: built-ins, then the user's own presets of this
 * section. Applying touches only this tab's slice of the parameters; "Save"
 * stores the current slice under a name; "Export" writes a preset file.
 */
export function PresetBar({
    section,
    params,
    presets,
    onApply,
    onPresets,
}: {
    section: VocalSection;
    params: VocalParams;
    presets: VocalUserPreset[];
    onApply: (next: VocalParams) => void;
    onPresets: (next: VocalUserPreset[]) => void;
}) {
    const { t } = useTranslation();
    const [naming, setNaming] = useState(false);
    const [name, setName] = useState("");
    const mine = presets.filter((p) => p.section === section);
    const current = JSON.stringify(sectionValues(params, section));
    const isActive = (values: Record<string, unknown>) => JSON.stringify(sectionValues(applySection(params, section, values), section)) === current;

    const save = () => {
        const trimmed = name.trim();
        if (trimmed === "") return;
        const existing = mine.find((p) => p.name.toLowerCase() === trimmed.toLowerCase());
        const preset: VocalUserPreset = {
            id: existing?.id ?? `${section}-${Date.now().toString(36)}`,
            name: trimmed,
            section,
            values: sectionValues(params, section),
            createdAt: Date.now(),
        };
        onPresets(existing ? presets.map((p) => (p.id === existing.id ? preset : p)) : [...presets, preset]);
        toast.success(t(existing ? "vocal.presetUpdated" : "vocal.presetSaved", { name: trimmed }));
        setNaming(false);
        setName("");
    };

    const chip = (key: string, label: string, values: Record<string, unknown>, onDelete?: () => void) => {
        const active = isActive(values);
        return (
            <motion.span key={key} layout initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} className="inline-flex">
                <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => onApply(applySection(params, section, values))}
                    className={cn(
                        "inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                        onDelete && "pr-1.5",
                        active ? "bg-accent text-accent-fg" : "bg-panel-alt text-fg hover:bg-accent-subtle hover:text-accent",
                    )}
                >
                    {label}
                    {onDelete && (
                        <span
                            role="button"
                            tabIndex={0}
                            aria-label={t("vocal.presetDelete", { name: label })}
                            onClick={(e) => {
                                e.stopPropagation();
                                onDelete();
                            }}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    onDelete();
                                }
                            }}
                            className="grid size-4 place-items-center rounded-full opacity-60 hover:bg-danger/20 hover:text-danger hover:opacity-100"
                        >
                            <X className="size-3" aria-hidden />
                        </span>
                    )}
                </button>
            </motion.span>
        );
    };

    return (
        <div className="space-y-2 rounded-chip border border-fg/10 bg-panel-alt/30 p-2.5" role="group" aria-label={t("vocal.presets.title")}>
            <div className="flex items-center gap-2">
                <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle">{t("vocal.presets.title")}</span>
                <div className="ml-auto flex items-center gap-1">
                    {mine.length > 0 && (
                        <button
                            type="button"
                            onClick={() => downloadJson(`tiksee-vocal-${section}-presets.json`, { kind: "tiksee-vocal-preset", version: 1, presets: mine })}
                            title={t("vocal.presetExport")}
                            aria-label={t("vocal.presetExport")}
                            className="grid size-7 place-items-center rounded-full text-fg-subtle outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            <Download className="size-3.5" aria-hidden />
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={() => setNaming((v) => !v)}
                        aria-expanded={naming}
                        className="inline-flex items-center gap-1 rounded-full bg-accent-subtle px-2.5 py-1 text-[0.6875rem] font-semibold text-accent outline-none hover:bg-accent hover:text-accent-fg focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <Plus className="size-3.5" aria-hidden />
                        {t("vocal.presetSave")}
                    </button>
                </div>
            </div>
            <AnimatePresence initial={false}>
                {naming && (
                    <motion.form
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="flex items-center gap-2 overflow-hidden"
                        onSubmit={(e) => {
                            e.preventDefault();
                            save();
                        }}
                    >
                        <input
                            autoFocus
                            value={name}
                            maxLength={60}
                            onChange={(e) => setName(e.target.value)}
                            onKeyDown={(e) => e.key === "Escape" && setNaming(false)}
                            placeholder={t("vocal.presetName")}
                            aria-label={t("vocal.presetName")}
                            className="min-w-0 flex-1 rounded-chip border border-border bg-panel px-2.5 py-1.5 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                        <button
                            type="submit"
                            disabled={name.trim() === ""}
                            aria-label={t("common.save")}
                            className="grid size-8 place-items-center rounded-full bg-accent text-accent-fg outline-none disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            <Check className="size-4" aria-hidden />
                        </button>
                    </motion.form>
                )}
            </AnimatePresence>
            <div className="flex flex-wrap gap-1.5">
                <AnimatePresence initial={false} mode="popLayout">
                    {Object.entries(BUILTIN_SECTION_PRESETS[section]).map(([id, values]) => chip(`b-${id}`, t(`vocal.builtin.${section}.${id}`), values))}
                    {mine.map((p) =>
                        chip(`u-${p.id}`, p.name, p.values, () => {
                            onPresets(presets.filter((x) => x.id !== p.id));
                            toast(t("vocal.presetDeleted", { name: p.name }));
                        }),
                    )}
                </AnimatePresence>
            </div>
        </div>
    );
}
