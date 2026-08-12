import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { nextEventId, type ChatEvent, type ReplayInfo } from "@tiksee/core";

import { logger } from "../logger.js";

const log = logger.scoped("[replay]");

interface ReplayFile {
    version: 1;
    recordedAt: number;
    /** Event stream with timestamps rebased so the first offset is 0. */
    events: Array<{ offsetMs: number; event: ChatEvent }>;
}

/**
 * Records and replays live sessions.
 *
 * This is the single most useful development affordance in the project: the UI,
 * the overlay, the panel renderer and the speech queue can all be exercised at
 * any hour without a creator actually being live, and a captured gift storm can
 * be replayed at 10× to stress-test the feed.
 */
export class ReplayStore {
    #dir: string;
    #recording: { name: string; startedAt: number; events: ReplayFile["events"] } | null = null;
    #playback: { name: string; timer: NodeJS.Timeout | null; index: number; total: number } | null =
        null;

    constructor(dir: string) {
        this.#dir = dir;
    }

    get isRecording(): boolean {
        return this.#recording !== null;
    }

    get isPlaying(): boolean {
        return this.#playback !== null;
    }

    get playbackName(): string | undefined {
        return this.#playback?.name;
    }

    get progress(): number {
        const p = this.#playback;
        if (!p || p.total === 0) return 0;
        return Math.min(1, p.index / p.total);
    }

    async list(): Promise<ReplayInfo[]> {
        try {
            await mkdir(this.#dir, { recursive: true });
            const names = (await readdir(this.#dir)).filter((n) => n.endsWith(".json"));
            const infos: ReplayInfo[] = [];
            for (const file of names) {
                try {
                    const parsed = JSON.parse(await readFile(join(this.#dir, file), "utf8")) as ReplayFile;
                    const last = parsed.events.at(-1);
                    infos.push({
                        name: file.replace(/\.json$/, ""),
                        events: parsed.events.length,
                        durationMs: last?.offsetMs ?? 0,
                        recordedAt: parsed.recordedAt,
                    });
                } catch {
                    log.warn(`skipping unreadable replay ${file}`);
                }
            }
            return infos.sort((a, b) => b.recordedAt - a.recordedAt);
        } catch (error) {
            log.warn("list failed", error);
            return [];
        }
    }

    startRecording(name: string): void {
        this.#recording = { name: sanitise(name), startedAt: Date.now(), events: [] };
        log.info(`recording to "${this.#recording.name}"`);
    }

    /** Called for every ingested event; a no-op unless recording. */
    capture(event: ChatEvent): void {
        const rec = this.#recording;
        if (!rec) return;
        rec.events.push({ offsetMs: event.at - rec.startedAt, event });
    }

    async stopRecording(): Promise<ReplayInfo | null> {
        const rec = this.#recording;
        this.#recording = null;
        if (!rec) return null;

        await mkdir(this.#dir, { recursive: true });
        const payload: ReplayFile = {
            version: 1,
            recordedAt: rec.startedAt,
            events: rec.events,
        };
        await writeFile(join(this.#dir, `${rec.name}.json`), JSON.stringify(payload), "utf8");
        log.info(`saved "${rec.name}" (${rec.events.length} events)`);
        return {
            name: rec.name,
            events: rec.events.length,
            durationMs: rec.events.at(-1)?.offsetMs ?? 0,
            recordedAt: rec.startedAt,
        };
    }

    /**
     * Replay a recording. Events are re-stamped with the current time and given
     * fresh ids so downstream consumers treat them as live — the only tell is
     * `replay: true`, which the UI surfaces as a badge.
     */
    async play(
        name: string,
        streamId: string,
        speed: number,
        loop: boolean,
        emit: (event: ChatEvent) => void,
        onFinished: () => void,
    ): Promise<boolean> {
        this.stopPlayback();

        let file: ReplayFile;
        try {
            file = JSON.parse(await readFile(join(this.#dir, `${sanitise(name)}.json`), "utf8"));
        } catch (error) {
            log.warn(`cannot open replay "${name}"`, error);
            return false;
        }
        if (file.events.length === 0) return false;

        const rate = Math.max(0.1, speed);
        const state: NonNullable<typeof this.playbackState> = {
            name,
            timer: null,
            index: 0,
            total: file.events.length,
        };
        this.#playback = state;
        const startedAt = Date.now();

        const step = (): void => {
            if (this.#playback !== state) return;

            // Drain every entry whose scheduled moment has arrived. Batching here
            // means a burst recorded at 200 events/sec replays as a burst rather
            // than being smeared out by timer granularity.
            const elapsed = (Date.now() - startedAt) * rate;
            while (state.index < file.events.length) {
                const entry = file.events[state.index];
                if (!entry || entry.offsetMs > elapsed) break;
                state.index += 1;
                const at = Date.now();
                emit({ ...entry.event, id: nextEventId(at), at, streamId, replay: true });
            }

            if (state.index >= file.events.length) {
                if (loop) {
                    state.index = 0;
                    void this.play(name, streamId, speed, loop, emit, onFinished);
                    return;
                }
                this.stopPlayback();
                onFinished();
                return;
            }
            state.timer = setTimeout(step, 50);
        };

        log.info(`replaying "${name}" (${file.events.length} events at ${rate}×)`);
        state.timer = setTimeout(step, 0);
        return true;
    }

    private get playbackState() {
        return this.#playback;
    }

    stopPlayback(): void {
        const p = this.#playback;
        if (!p) return;
        if (p.timer) clearTimeout(p.timer);
        this.#playback = null;
    }
}

/** Keep replay names filesystem-safe — they come from user input. */
function sanitise(name: string): string {
    return (
        name
            .trim()
            .replace(/[^a-zA-Z0-9-_ ]/g, "")
            .slice(0, 64) || "session"
    );
}
