import { randomUUID } from "node:crypto";

import { SEED_DOGS, type IdentityProfile, type ProfileKind } from "@tiksee/core";

import type { Db } from "../memory/sqlite.js";

/**
 * Enrolled identities (beta): only profiles the owner explicitly enrolled.
 * Embeddings are stored as Float32 BLOBs, one row per sample, and never leave
 * this process except to the local renderer. Never log them.
 */

type Row = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : Number(v ?? 0));
const SEED_KEY = "dogs_seeded";

export function encodeEmbedding(vector: readonly number[]): Uint8Array {
    const floats = Float32Array.from(vector);
    return new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
}

export function decodeEmbedding(blob: Uint8Array): number[] {
    // Copy into an aligned buffer: SQLite blobs carry no alignment guarantee.
    const copy = new Uint8Array(blob.byteLength);
    copy.set(blob);
    return Array.from(new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4)));
}

function kindOf(value: unknown): ProfileKind {
    return value === "owner" || value === "dog" ? value : "person";
}

export class IdentityStore {
    #db: Db;
    #now: () => number;

    constructor(db: Db, now: () => number = () => Date.now()) {
        this.#db = db;
        this.#now = now;
    }

    list(): IdentityProfile[] {
        const rows = this.#db.prepare("SELECT * FROM identity_profiles ORDER BY created_at, id").all() as Row[];
        const vectors = this.#db.prepare("SELECT idx, vec FROM identity_embeddings WHERE profile_id = ? ORDER BY idx");
        return rows.map((row) => {
            const id = String(row.id);
            const embeddings = (vectors.all(id) as Row[]).map((v) => decodeEmbedding(v.vec as Uint8Array));
            return {
                id,
                name: String(row.name),
                kind: kindOf(row.kind),
                embeddings,
                note: String(row.note ?? ""),
                createdAt: num(row.created_at),
                updatedAt: num(row.updated_at),
            };
        });
    }

    get(id: string): IdentityProfile | null {
        return this.list().find((p) => p.id === id) ?? null;
    }

    /** Insert or replace a profile and all its embeddings, atomically. */
    upsert(profile: IdentityProfile): void {
        const now = this.#now();
        this.#db.exec("BEGIN");
        try {
            this.#db
                .prepare(
                    `INSERT INTO identity_profiles (id, name, kind, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, note = excluded.note, updated_at = excluded.updated_at`,
                )
                .run(profile.id, profile.name, profile.kind, profile.note, profile.createdAt || now, Math.max(profile.updatedAt, now));
            this.#db.prepare("DELETE FROM identity_embeddings WHERE profile_id = ?").run(profile.id);
            const insert = this.#db.prepare("INSERT INTO identity_embeddings (profile_id, idx, vec) VALUES (?, ?, ?)");
            profile.embeddings.forEach((vector, idx) => insert.run(profile.id, idx, encodeEmbedding(vector)));
            this.#db.exec("COMMIT");
        } catch (error) {
            this.#db.exec("ROLLBACK");
            throw error;
        }
    }

    /** Hard delete (GDPR erasure): the profile and every embedding. */
    delete(id: string): boolean {
        this.#db.exec("BEGIN");
        try {
            // Explicit child delete: correct even if a connection lacks foreign_keys=ON.
            this.#db.prepare("DELETE FROM identity_embeddings WHERE profile_id = ?").run(id);
            const result = this.#db.prepare("DELETE FROM identity_profiles WHERE id = ?").run(id);
            this.#db.exec("COMMIT");
            return num(result.changes) > 0;
        } catch (error) {
            this.#db.exec("ROLLBACK");
            throw error;
        }
    }

    /**
     * Placeholder profiles for the owner's dogs, once per database: only when
     * no dog profile exists and the seed never ran (a deleted dog stays deleted).
     */
    seedDogs(): number {
        const done = this.#db.prepare("SELECT value FROM vision_meta WHERE key = ?").get(SEED_KEY) as Row | undefined;
        if (done) return 0;
        const dogs = num((this.#db.prepare("SELECT COUNT(*) AS n FROM identity_profiles WHERE kind = 'dog'").get() as Row | undefined)?.n);
        const now = this.#now();
        let created = 0;
        if (dogs === 0) {
            for (const [i, dog] of SEED_DOGS.entries()) {
                // Distinct created_at keeps list() in seed order (ties would sort by random id).
                this.upsert({ id: `dog-${randomUUID()}`, name: dog.name, kind: "dog", embeddings: [], note: dog.note, createdAt: now + i, updatedAt: now + i });
                created += 1;
            }
        }
        this.#db.prepare("INSERT OR REPLACE INTO vision_meta (key, value) VALUES (?, ?)").run(SEED_KEY, String(now));
        return created;
    }

    count(): number {
        return num((this.#db.prepare("SELECT COUNT(*) AS n FROM identity_profiles").get() as Row | undefined)?.n);
    }

    embeddingRows(): number {
        return num((this.#db.prepare("SELECT COUNT(*) AS n FROM identity_embeddings").get() as Row | undefined)?.n);
    }
}
