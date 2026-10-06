import type { ReactNode } from "react";

import { FOCUS_RING } from "./context.js";

export function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <fieldset className="space-y-3 border-t border-white/10 pt-3 first:border-t-0 first:pt-0">
            <legend className="mb-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-white/70">{title}</legend>
            {children}
        </fieldset>
    );
}

export function ActionButton({ icon, label, onClick, active = false }: { icon: ReactNode; label: string; onClick: () => void; active?: boolean }) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className={`flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium transition-colors ${FOCUS_RING} ${
                active ? "bg-red-500 text-white" : "bg-white/10 text-white hover:bg-white/20"
            }`}
        >
            {icon}
            {label}
        </button>
    );
}
