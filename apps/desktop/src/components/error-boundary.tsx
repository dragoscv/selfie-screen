import { Button } from "@tiksee/ui";
import { AlertTriangle } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
    children: ReactNode;
    /** Shown in the fallback so the user knows which area failed. */
    area?: string;
}

interface State {
    error: Error | null;
}

/**
 * Route- and panel-level error boundary.
 *
 * A crash in the analytics chart must never take down the chat feed, so each
 * major region is wrapped independently rather than the app having one
 * top-level boundary.
 */
export class ErrorBoundary extends Component<Props, State> {
    override state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    override componentDidCatch(error: Error, info: ErrorInfo): void {
        console.error(`[${this.props.area ?? "app"}] render error`, error, info.componentStack);
    }

    override render(): ReactNode {
        const { error } = this.state;
        if (!error) return this.props.children;

        return (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
                <div className="grid size-12 place-items-center rounded-2xl bg-danger/15 text-danger">
                    <AlertTriangle className="size-6" />
                </div>
                <div className="space-y-1">
                    <p className="text-sm font-semibold text-fg">Something went wrong</p>
                    <p className="measure text-pretty text-xs text-fg-muted">
                        {this.props.area
                            ? `The ${this.props.area} area stopped responding. The rest of the app keeps working.`
                            : "The rest of the app keeps working."}
                    </p>
                    <p className="mt-2 max-w-md truncate font-mono text-[0.6875rem] text-fg-subtle">
                        {error.message}
                    </p>
                </div>
                <Button size="sm" variant="soft" onClick={() => this.setState({ error: null })}>
                    Try again
                </Button>
            </div>
        );
    }
}
