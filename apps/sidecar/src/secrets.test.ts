import { describe, expect, it, vi } from "vitest";

import { SecretStore, credentialTarget } from "./secrets.js";

describe("SecretStore", () => {
    it("prefers the env var the shell passes at spawn time", async () => {
        const reader = vi.fn(async () => "from-vault");
        const store = new SecretStore({ env: { TIKSEE_CODAI_KEY: "  sk-env  " }, platform: "win32", reader });
        await expect(store.get("codai-api-key")).resolves.toBe("sk-env");
        expect(reader).not.toHaveBeenCalled();
    });

    it("maps each secret to its own env var", async () => {
        const store = new SecretStore({ env: { TIKSEE_VMUI_KEY: "vmui_x" }, platform: "linux" });
        await expect(store.get("vmui-api-key")).resolves.toBe("vmui_x");
        await expect(store.get("codai-api-key")).resolves.toBeNull();
    });

    it("ignores a blank env var and falls back to Credential Manager on Windows", async () => {
        const reader = vi.fn(async (target: string) => (target === "codai-api-key.ro.codai.tiksee" ? "sk-vault" : null));
        const store = new SecretStore({ env: { TIKSEE_CODAI_KEY: "   " }, platform: "win32", reader });
        await expect(store.get("codai-api-key")).resolves.toBe("sk-vault");
        expect(reader).toHaveBeenCalledWith(credentialTarget("codai-api-key"));
    });

    it("never spawns the reader off Windows", async () => {
        const reader = vi.fn(async () => "x");
        const store = new SecretStore({ env: {}, platform: "darwin", reader });
        await expect(store.get("codai-api-key")).resolves.toBeNull();
        expect(reader).not.toHaveBeenCalled();
    });

    it("caches hits, re-checks misses after the negative TTL, and honours invalidate", async () => {
        let now = 0;
        let value: string | null = null;
        const reader = vi.fn(async () => value);
        const store = new SecretStore({ env: {}, platform: "win32", reader, now: () => now });

        await expect(store.get("vmui-api-key")).resolves.toBeNull();
        value = "vmui_new";
        await expect(store.get("vmui-api-key")).resolves.toBeNull();
        now = 61_000;
        await expect(store.get("vmui-api-key")).resolves.toBe("vmui_new");
        await store.get("vmui-api-key");
        expect(reader).toHaveBeenCalledTimes(2);

        store.invalidate("vmui-api-key");
        await store.get("vmui-api-key");
        expect(reader).toHaveBeenCalledTimes(3);
    });

    it("treats a reader failure as a missing secret", async () => {
        const store = new SecretStore({ env: {}, platform: "win32", reader: async () => Promise.reject(new Error("boom")) });
        await expect(store.get("codai-api-key")).resolves.toBeNull();
    });
});
