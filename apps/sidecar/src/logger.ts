export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogSink = (level: LogLevel, message: string, at: number) => void;

/**
 * Minimal structured logger. The sidecar has two transports: stdout (captured
 * by the Tauri shell) and a sink that forwards to the UI's log panel.
 *
 * Never log secrets — `sessionid` and the Azure key pass through this process
 * and must be redacted at the call site.
 */
class Logger {
    #min: number = ORDER.info;
    #sinks = new Set<LogSink>();

    setLevel(level: LogLevel): void {
        this.#min = ORDER[level];
    }

    addSink(sink: LogSink): () => void {
        this.#sinks.add(sink);
        return () => this.#sinks.delete(sink);
    }

    #emit(level: LogLevel, scope: string, args: unknown[]): void {
        if (ORDER[level] < this.#min) return;
        const at = Date.now();
        const message = args
            .map((a) => (typeof a === "string" ? a : safeStringify(a)))
            .join(" ");
        const line = `[${new Date(at).toISOString()}] ${level.toUpperCase()} ${scope} ${message}`;
        if (level === "error" || level === "warn") console.error(line);
        else console.log(line);
        for (const sink of this.#sinks) {
            try {
                sink(level, `${scope} ${message}`, at);
            } catch {
                // A failing sink must never take down the service.
            }
        }
    }

    scoped(scope: string) {
        return {
            debug: (...a: unknown[]) => this.#emit("debug", scope, a),
            info: (...a: unknown[]) => this.#emit("info", scope, a),
            warn: (...a: unknown[]) => this.#emit("warn", scope, a),
            error: (...a: unknown[]) => this.#emit("error", scope, a),
        };
    }
}

function safeStringify(value: unknown): string {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

export const logger = new Logger();
export type ScopedLogger = ReturnType<Logger["scoped"]>;
