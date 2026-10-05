import { execFile } from "node:child_process";

import { APP_IDENTIFIER } from "./paths.js";

/**
 * Credentials live in Windows Credential Manager, written by the Tauri shell
 * through the `keyring` crate (v3): a GENERIC credential whose target is
 * `<user>.<service>` and whose blob is the UTF-16LE secret.
 *
 * Resolution order:
 *  1. the env var the shell sets when it spawns us (sidecar.rs);
 *  2. a CredRead P/Invoke run in a short-lived PowerShell (no native module).
 *
 * Secret values are never logged, cached on disk, or echoed.
 */

export const SECRET_ENV = {
    "codai-api-key": "TIKSEE_CODAI_KEY",
    "vmui-api-key": "TIKSEE_VMUI_KEY",
} as const;
export type SecretName = keyof typeof SECRET_ENV;

export function credentialTarget(name: SecretName): string {
    return `${name}.${APP_IDENTIFIER}`;
}

export type CredentialReader = (target: string) => Promise<string | null>;

/** A missing secret is re-checked after this long (the user may add it meanwhile). */
const NEGATIVE_TTL_MS = 60_000;
const READ_TIMEOUT_MS = 5_000;

const CRED_READ_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class TikseeCred {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CREDENTIAL {
        public int Flags; public int Type; public string TargetName; public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
        public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
    }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);
    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr credential);
    public static string Read(string target) {
        IntPtr p;
        if (!CredReadW(target, 1, 0, out p)) return null;
        try {
            CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
            if (c.CredentialBlobSize <= 0) return "";
            return Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2);
        } finally { CredFree(p); }
    }
}
"@
$value = [TikseeCred]::Read($env:TIKSEE_CRED_TARGET)
if ($null -eq $value) { exit 3 }
[Console]::Out.Write($value)
`;

/** Read a generic credential through PowerShell; `null` on any failure. */
export function readWindowsCredential(target: string, timeoutMs = READ_TIMEOUT_MS): Promise<string | null> {
    // -EncodedCommand sidesteps every quoting layer; the target travels in an
    // env var so it is never interpolated into script text.
    const encoded = Buffer.from(CRED_READ_SCRIPT, "utf16le").toString("base64");
    return new Promise((resolve) => {
        execFile(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
            {
                timeout: timeoutMs,
                windowsHide: true,
                encoding: "utf8",
                maxBuffer: 64 * 1024,
                env: { ...process.env, TIKSEE_CRED_TARGET: target },
            },
            (error, stdout) => {
                if (error) {
                    resolve(null);
                    return;
                }
                const value = stdout.trim();
                resolve(value === "" ? null : value);
            },
        );
    });
}

export interface SecretStoreOptions {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    reader?: CredentialReader;
    now?: () => number;
}

interface CacheEntry {
    value: string | null;
    at: number;
}

export class SecretStore {
    #env: NodeJS.ProcessEnv;
    #platform: NodeJS.Platform;
    #reader: CredentialReader;
    #now: () => number;
    #cache = new Map<SecretName, CacheEntry>();
    #inflight = new Map<SecretName, Promise<string | null>>();

    constructor(options: SecretStoreOptions = {}) {
        this.#env = options.env ?? process.env;
        this.#platform = options.platform ?? process.platform;
        this.#reader = options.reader ?? ((target) => readWindowsCredential(target));
        this.#now = options.now ?? Date.now;
    }

    async get(name: SecretName): Promise<string | null> {
        const fromEnv = this.#env[SECRET_ENV[name]]?.trim();
        if (fromEnv) return fromEnv;

        const cached = this.#cache.get(name);
        if (cached && (cached.value !== null || this.#now() - cached.at < NEGATIVE_TTL_MS)) {
            return cached.value;
        }

        const pending = this.#inflight.get(name);
        if (pending) return pending;

        const read = (this.#platform === "win32" ? this.#reader(credentialTarget(name)) : Promise.resolve(null))
            .catch(() => null)
            .then((value) => {
                this.#cache.set(name, { value, at: this.#now() });
                this.#inflight.delete(name);
                return value;
            });
        this.#inflight.set(name, read);
        return read;
    }

    /** Forget a cached value, e.g. after a 401 so a rotated key is re-read. */
    invalidate(name?: SecretName): void {
        if (name) this.#cache.delete(name);
        else this.#cache.clear();
    }
}
