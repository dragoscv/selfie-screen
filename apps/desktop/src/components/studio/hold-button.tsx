import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { FOCUS_RING } from "./context.js";

/**
 * Press-and-hold control: pointer capture keeps it held while the pointer
 * leaves the button; Space/Enter hold it from the keyboard; blur releases.
 */
export function HoldButton({
    label,
    icon,
    onStart,
    onStop,
    disabled,
    className = "",
}: {
    label: string;
    icon?: ReactNode;
    onStart: () => void;
    onStop: () => void;
    disabled?: boolean;
    className?: string;
}) {
    const [held, setHeld] = useState(false);
    const heldRef = useRef(false);
    const start = () => {
        if (heldRef.current || disabled) return;
        heldRef.current = true;
        setHeld(true);
        onStart();
    };
    const stop = () => {
        if (!heldRef.current) return;
        heldRef.current = false;
        setHeld(false);
        onStop();
    };
    const isHoldKey = (e: KeyboardEvent) => {
        if (e.key !== " " && e.key !== "Enter") return false;
        e.preventDefault();
        e.stopPropagation();
        return true;
    };
    return (
        <button
            type="button"
            aria-pressed={held}
            disabled={disabled}
            onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                start();
            }}
            onPointerUp={stop}
            onPointerCancel={stop}
            onLostPointerCapture={stop}
            onKeyDown={(e) => {
                if (isHoldKey(e)) start();
            }}
            onKeyUp={(e) => {
                if (isHoldKey(e)) stop();
            }}
            onBlur={stop}
            className={`flex select-none items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium transition-colors disabled:opacity-45 ${FOCUS_RING} ${
                held ? "bg-sky-400 text-neutral-950" : "bg-white/10 text-white hover:bg-white/20"
            } ${className}`}
        >
            {icon}
            {label}
        </button>
    );
}
