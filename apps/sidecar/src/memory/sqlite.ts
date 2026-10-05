import type * as NodeSqlite from "node:sqlite";
import type { DatabaseSync } from "node:sqlite";

let filterInstalled = false;

/**
 * Load `node:sqlite` lazily, swallowing only its own ExperimentalWarning.
 *
 * A static import would emit the warning at module evaluation, before any
 * filter could run, and the shell treats stderr noise as a smell. Every other
 * warning still reaches the default handler untouched.
 */
export function loadSqlite(): typeof NodeSqlite {
    if (!filterInstalled) {
        filterInstalled = true;
        const original = process.emitWarning.bind(process);
        process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
            const message = typeof warning === "string" ? warning : warning.message;
            const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
            const name = typeof warning === "string" ? type : warning.name;
            if (name === "ExperimentalWarning" && /sqlite/i.test(message)) return;
            (original as (...args: unknown[]) => void)(warning, ...rest);
        }) as typeof process.emitWarning;
    }
    return process.getBuiltinModule("node:sqlite");
}

export type Db = DatabaseSync;
