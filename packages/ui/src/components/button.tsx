import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "../lib/cn.js";

const button = cva(
    [
        "no-drag relative inline-flex shrink-0 select-none items-center justify-center gap-2",
        "font-medium whitespace-nowrap outline-none",
        "transition-[background-color,color,border-color,box-shadow,transform]",
        "duration-[--dur-fast] ease-[--ease-out]",
        "active:scale-[0.98]",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        "disabled:pointer-events-none disabled:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0",
    ],
    {
        variants: {
            variant: {
                primary: "bg-accent text-accent-fg hover:bg-accent-hover active:bg-accent-active",
                soft: "bg-accent-subtle text-accent hover:bg-accent-muted",
                outline: "border border-border-strong bg-transparent text-fg hover:bg-panel-alt",
                ghost: "bg-transparent text-fg-muted hover:bg-panel-alt hover:text-fg",
                danger: "bg-danger/15 text-danger hover:bg-danger/25",
                success: "bg-success/15 text-success hover:bg-success/25",
            },
            size: {
                sm: "h-8 rounded-[--radius-chip] px-3 text-xs [&_svg]:size-3.5",
                md: "h-10 rounded-[--radius-control] px-4 text-sm [&_svg]:size-4",
                lg: "h-12 rounded-[--radius-control] px-6 text-[0.9375rem] [&_svg]:size-[1.125rem]",
                icon: "size-10 rounded-[--radius-control] [&_svg]:size-[1.125rem]",
                "icon-sm": "size-8 rounded-[--radius-chip] [&_svg]:size-4",
            },
        },
        defaultVariants: { variant: "primary", size: "md" },
    },
);

export interface ButtonProps
    extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
    asChild?: boolean;
    /** Shows a spinner and blocks interaction without changing layout width. */
    loading?: boolean;
    icon?: ReactNode;
}

export function Button({
    className,
    variant,
    size,
    asChild = false,
    loading = false,
    icon,
    children,
    disabled,
    ...props
}: ButtonProps) {
    const Comp = asChild ? Slot : "button";
    return (
        <Comp
            className={cn(button({ variant, size }), className)}
            disabled={disabled ?? loading}
            aria-busy={loading || undefined}
            {...props}
        >
            {loading ? <Loader2 className="animate-spin" aria-hidden /> : icon}
            {children}
        </Comp>
    );
}
