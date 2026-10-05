import {
    compileWordList,
    eventDiamonds,
    type ChatEvent,
    type ReplyItem,
    type ServerMessage,
    type Settings,
} from "@tiksee/core";

import type { CodaiClient } from "../codai/client.js";
import { splitSentences } from "../codai/sentences.js";
import type { LiveControl } from "../live-control.js";
import type { ScopedLogger } from "../logger.js";
import type { Observation, ViewerMemory } from "../memory/db.js";
import { TokenBucket } from "./bucket.js";
import { Coach } from "./coach.js";
import { FactCollector } from "./facts.js";
import { speakBlock } from "./gate.js";
import { ReplyQueue, type EntryKind, type QueueEntry } from "./queue.js";
import { draftReply } from "./responder.js";
import { S1Enricher, type S1Adjustment } from "./s1.js";
import { DuplicateTracker, isQuestion, scoreEvent } from "./scorer.js";
import { greetingLine, greetingSuggestion, passesReadFilters, readAloudLine, thanksLine } from "./templates.js";
import { TranscriptWindow } from "./transcript.js";

/** Below this a chat line is not worth an AI reply at all. */
export const MIN_AI_SCORE = 2;
/** Thanks and greetings: once per viewer per this window. */
export const TEMPLATE_DEDUPE_MS = 5 * 60_000;
const AI_TTL_MS = 90_000;
const APPROVE_TTL_MS = 180_000;
const READ_TTL_MS = 60_000;
const TEMPLATE_TTL_MS = 60_000;
/** If the renderer never answers `sayState`, assume the utterance ended. */
const SAY_WATCHDOG_BASE_MS = 15_000;
const SAY_WATCHDOG_PER_CHAR_MS = 90;

const AI_KINDS: ReadonlySet<EntryKind> = new Set(["ai"]);

export interface CoHostDeps {
    settings: () => Settings;
    send: (message: ServerMessage) => void;
    control: LiveControl;
    codai: Pick<CodaiClient, "streamChat" | "systemOne" | "complete">;
    memory: ViewerMemory | null;
    log: ScopedLogger;
    now?: () => number;
    /** A live session was closed in viewer memory (post-live summary trigger). */
    onSessionEnded?: (sessionId: number) => void;
}

interface CurrentSay {
    id: string;
    entryId: string;
    watchdog: NodeJS.Timeout;
}

/**
 * The co-host brain: scores live events, keeps the reply queue, drafts AI
 * replies, and decides — through one speaking gate — what the renderer may
 * say and when. It never talks over the streamer, over itself, while muted,
 * paused or in Shop LIVE.
 */
export class CoHost {
    #deps: CoHostDeps;
    #now: () => number;
    #queue: ReplyQueue;
    #bucket: TokenBucket;
    #transcript = new TranscriptWindow();
    #coach: Coach;
    #s1: S1Enricher;
    #facts: FactCollector;
    #duplicates = new DuplicateTracker();
    #blocked: RegExp | null = null;
    #templateSeen = new Map<string, number>();
    #drafts = new Map<string, AbortController>();
    #current: CurrentSay | null = null;
    #sayPart = new Map<string, number>();
    #recentChat: ChatEvent[] = [];
    #sessions = new Map<string, number>();
    #seenLocal = new Set<string>();
    #timer: NodeJS.Timeout | null = null;
    /** Last chat line or utterance; drives `aiInitiates` idle chatter. */
    #lastActivity = 0;

    constructor(deps: CoHostDeps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
        const settings = deps.settings();
        this.#queue = new ReplyQueue(settings.safety.maxQueue, (items) => deps.send({ type: "replyQueue", items }));
        this.#bucket = new TokenBucket(settings.assistant.repliesPerMinute, 2, this.#now());
        this.#coach = new Coach((suggestion) => deps.send({ type: "suggestion", suggestion }));
        this.#s1 = new S1Enricher({
            client: deps.codai,
            onAdjust: (id, adjustment) => this.#applyS1(id, adjustment),
            onLog: (record) => deps.log.debug(`s1 ${JSON.stringify(record)}`),
        });
        this.#facts = new FactCollector({
            client: deps.codai,
            model: () => this.#deps.settings().codai.replyModel,
            store: (uniqueId, facts) => this.#deps.memory?.addFacts(uniqueId, facts),
        });
        this.setSettings(settings);
    }

    start(): void {
        if (this.#timer) return;
        this.#timer = setInterval(() => this.pump(), 250);
        this.#timer.unref();
    }

    setSettings(settings: Settings): void {
        this.#bucket.setRate(settings.assistant.repliesPerMinute, this.#now());
        this.#queue.setMaxActive(settings.safety.maxQueue);
        this.#blocked = compileWordList(settings.safety.blockedWords);
        this.#s1.enabled = settings.assistant.aiReplies && settings.assistant.useSystemOne;
        if (this.#deps.memory) this.#deps.memory.persistHistory = settings.data.persistHistory;
        this.pump();
    }

    snapshot(): ReplyItem[] {
        return this.#queue.snapshot();
    }

    /* ------------------------------ inputs ------------------------------ */

    /** Connection lifecycle → memory sessions and coach state. */
    onStatus(streamId: string, username: string, state: string, stats?: unknown): void {
        const memory = this.#deps.memory;
        if (state === "live" && !this.#sessions.has(streamId)) {
            if (memory) this.#sessions.set(streamId, memory.startSession(username, this.#now()));
            this.#coach.start(this.#now());
        } else if ((state === "offline" || state === "ended") && this.#sessions.has(streamId)) {
            const id = this.#sessions.get(streamId);
            this.#sessions.delete(streamId);
            if (memory && id !== undefined) {
                memory.endSession(id, stats ?? null, this.#now());
                this.#deps.onSessionEnded?.(id);
            }
            if (this.#sessions.size === 0) this.#coach.stop();
        }
    }

    onEvent(event: ChatEvent): void {
        const settings = this.#deps.settings();
        const now = this.#now();
        const observation = this.#observe(event);

        if (event.kind === "chat") {
            this.#lastActivity = now;
            this.#recentChat.push(event);
            if (this.#recentChat.length > 3) this.#recentChat.shift();
        }

        const duplicate = event.kind === "chat" && this.#duplicates.check(event.text, event.at);
        const question = event.kind === "chat" && isQuestion(event.text);
        this.#coach.onEvent(event, question && !duplicate);

        this.#maybeViewerCard(event, observation, settings);

        let readAloud = false;
        if (this.#readAloudOn(settings) && passesReadFilters(event, settings.voice) && !(duplicate && settings.safety.skipDuplicates)) {
            const line = readAloudLine(event, settings.voice);
            if (line !== "") readAloud = this.#addTemplate("read", event, line, 1, now);
        }

        if (event.kind === "gift" && settings.safety.thankGifts && !readAloud && this.#dedupe("thanks", event.user.uniqueId, now)) {
            this.#addTemplate("thanks", event, thanksLine(event), 5 + Math.log10(1 + eventDiamonds(event)), now);
        }

        if (settings.assistant.aiReplies && event.kind === "chat") {
            this.#considerAi(event, observation, duplicate, settings, now);
        }
        this.pump();
    }

    /** Streamer transcript from the renderer's STT session. */
    onTranscript(itemId: string, text: string, final: boolean, at: number): void {
        if (!this.#deps.settings().assistant.transcribe) return;
        this.#transcript.push(itemId, text, final, at);
        this.#coach.streamerSpoke(at);
    }

    onSayState(id: string, state: "playing" | "done" | "error", error?: string): void {
        if (state === "playing" || this.#current?.id !== id) return;
        const current = this.#current;
        clearTimeout(current.watchdog);
        this.#current = null;
        this.#deps.control.setSpeaking(undefined);
        const entry = this.#queue.get(current.entryId);
        if (entry) {
            if (state === "error") {
                this.#deps.log.warn(`say ${id} failed: ${error ?? "unknown"}`);
                this.#queue.update(entry.item.id, { status: "failed" });
                this.#abortDraft(entry.item.id);
            } else if (entry.parts.length === 0 && !entry.streaming) {
                this.#queue.update(entry.item.id, { status: "done" });
                this.#coach.answered(entry.item.uniqueId);
            }
        }
        this.pump();
    }

    approve(id: string, text?: string): boolean {
        const entry = this.#queue.get(id);
        if (!entry || (entry.item.status !== "ready" && entry.item.status !== "drafting" && entry.item.status !== "pending")) return false;
        entry.approved = true;
        const edited = text?.trim();
        if (edited) {
            this.#abortDraft(id);
            entry.parts = splitSentences(edited);
            entry.streaming = false;
            this.#queue.update(id, { status: "ready", draft: edited });
        } else {
            this.#queue.changed();
        }
        this.pump();
        return true;
    }

    skip(id: string): boolean {
        const entry = this.#queue.get(id);
        if (!entry) return false;
        // An AI draft that was never spoken should not cost a reply slot.
        if (entry.kind === "ai" && (entry.item.status === "drafting" || entry.item.status === "ready")) {
            this.#bucket.refund(this.#now());
        }
        this.#abortDraft(id);
        if (this.#current?.entryId === id) this.#cancelCurrent();
        this.#queue.update(id, { status: "skipped" });
        this.pump();
        return true;
    }

    /** `speak` from the UI: manual announcement, bypasses the reply bucket. */
    speak(text: string): void {
        const now = this.#now();
        const id = this.#queue.nextId();
        this.#queue.add(
            {
                item: { id, uniqueId: "", nickname: "manual", message: text, score: 100, reasons: ["manual"], draft: text, status: "ready", at: now },
                kind: "manual",
                approved: true,
                parts: splitSentences(text),
                streaming: false,
                expiresAt: now + TEMPLATE_TTL_MS,
            },
            now,
        );
        this.pump();
    }

    skipCurrent(): void {
        if (this.#current) {
            const entryId = this.#current.entryId;
            this.#abortDraft(entryId);
            this.#cancelCurrent();
            this.#queue.update(entryId, { status: "skipped" });
        }
        this.pump();
    }

    /** Mute / Shop LIVE: cut the voice now; queued items stay. */
    silence(): void {
        if (this.#current) {
            const entryId = this.#current.entryId;
            this.#cancelCurrent();
            const entry = this.#queue.get(entryId);
            if (entry) this.#queue.update(entryId, { status: entry.parts.length > 0 || entry.streaming ? "ready" : "done" });
        }
    }

    /** Highlight marker: time + the last three chat lines. */
    highlight(): string {
        const note = this.#recentChat.map((e) => `${e.user.nickname}: ${e.text}`).join(" | ") || "(fără mesaje)";
        this.#deps.memory?.addHighlight(note, this.#now());
        return note;
    }

    controlChanged(): void {
        this.pump();
    }

    /** Renderer gone: nobody will answer `sayState`. */
    rendererDetached(): void {
        if (this.#current) this.onSayState(this.#current.id, "done");
    }

    async dispose(): Promise<void> {
        if (this.#timer) clearInterval(this.#timer);
        this.#timer = null;
        for (const controller of this.#drafts.values()) controller.abort();
        this.#drafts.clear();
        if (this.#current) clearTimeout(this.#current.watchdog);
        this.#current = null;
        this.#queue.dispose();
        this.#s1.dispose();
        await this.#facts.flush().catch(() => 0);
        this.#facts.dispose();
        for (const [streamId] of this.#sessions) this.onStatus(streamId, "", "offline");
    }

    /* ------------------------------ pump ------------------------------ */

    /** Advance drafting and speaking; cheap and idempotent. */
    pump(): void {
        const now = this.#now();
        this.#queue.expire(now);
        this.#coach.tick(now);
        this.#maybeInitiate(now);
        this.#startDraft(now);
        this.#speakNext(now);
    }

    #startDraft(now: number): void {
        const settings = this.#deps.settings();
        const control = this.#deps.control.state;
        if (!settings.assistant.aiReplies || control.muted || control.shopMode || control.repliesPaused) return;
        if (this.#drafts.size > 0) return;
        const entry = this.#queue.topPending(now, AI_KINDS);
        if (!entry || !this.#bucket.tryTake(now)) return;
        void this.#draft(entry, settings);
    }

    /** `aiInitiates`: after `idleChatterSeconds` of silence the co-host says something itself. */
    #maybeInitiate(now: number): void {
        const { assistant } = this.#deps.settings();
        if (!assistant.aiReplies || !assistant.aiInitiates || this.#sessions.size === 0) return;
        if (this.#lastActivity === 0) {
            this.#lastActivity = now;
            return;
        }
        if (now - Math.max(this.#lastActivity, this.#transcript.lastAt) < assistant.idleChatterSeconds * 1000) return;
        if (this.#queue.activeCount() > 0) return;
        this.#lastActivity = now;
        this.#queue.add(
            {
                item: {
                    id: this.#queue.nextId(),
                    uniqueId: "",
                    nickname: "publicul",
                    message: "(Chatul e liniștit. Spune ceva scurt și antrenant publicului, legat de ce a spus streamerul, sau pune o întrebare.)",
                    score: MIN_AI_SCORE,
                    reasons: ["idle"],
                    status: "pending",
                    at: now,
                },
                kind: "ai",
                approved: false,
                parts: [],
                streaming: false,
                expiresAt: now + AI_TTL_MS,
            },
            now,
        );
    }

    async #draft(entry: QueueEntry, settings: Settings): Promise<void> {
        const id = entry.item.id;
        const controller = new AbortController();
        this.#drafts.set(id, controller);
        entry.streaming = true;
        // The streamer may have approved a pending item before its draft started.
        entry.approved = entry.approved || settings.assistant.replyMode === "auto";
        this.#queue.update(id, { status: "drafting" });

        const person = this.#deps.memory?.person(entry.item.uniqueId) ?? null;
        const now = this.#now();
        const result = await draftReply(this.#deps.codai, {
            model: settings.codai.replyModel,
            assistant: settings.assistant,
            blocked: this.#blocked,
            signal: controller.signal,
            context: {
                nickname: entry.item.nickname,
                uniqueId: entry.item.uniqueId,
                message: entry.item.message,
                reasons: entry.item.reasons,
                ...(person ? { visits: person.visits, facts: this.#deps.memory?.facts(person.uniqueId) ?? [] } : {}),
                ...(person && person.totalDiamonds > 0 ? { giftSummary: `${person.totalDiamonds} diamante în total` } : {}),
                transcript: this.#transcript.text(now),
            },
            callbacks: {
                onSentence: (sentence) => {
                    const live = this.#queue.get(id);
                    if (!live || live.item.status === "skipped") return;
                    live.parts.push(sentence);
                    if (live.item.status === "drafting") this.#queue.update(id, { status: "ready", draft: sentence });
                    else this.#queue.update(id, { draft: `${live.item.draft ?? ""} ${sentence}`.trim() });
                    this.pump();
                },
            },
        });
        this.#drafts.delete(id);

        const live = this.#queue.get(id);
        if (!live) return;
        live.streaming = false;
        if (live.item.status === "skipped") return;
        if (!result.ok) {
            this.#bucket.refund(this.#now());
            this.#deps.log.info(`reply draft failed (${result.error.kind}): ${result.error.message}`);
            if (live.item.status !== "speaking") this.#queue.update(id, { status: result.error.kind === "aborted" ? "skipped" : "failed" });
        } else {
            this.#queue.update(id, { draft: result.value });
            live.expiresAt = this.#now() + (live.approved ? AI_TTL_MS : APPROVE_TTL_MS);
            if (live.item.uniqueId !== "") {
                this.#facts.add({ uniqueId: live.item.uniqueId, nickname: live.item.nickname, text: live.item.message });
            }
            if (live.item.status === "speaking" && live.parts.length === 0 && this.#current?.entryId !== id) {
                this.#queue.update(id, { status: "done" });
            }
        }
        this.pump();
    }

    #speakNext(now: number): void {
        if (this.#current) return;
        const settings = this.#deps.settings();
        const control = this.#deps.control.state;
        const voiceEnabled = settings.voice.enabled && settings.voice.engine !== "off";

        // A reply mid-way through its sentences always finishes first, and
        // nothing else starts while its next sentence is still streaming.
        const continuing = this.#queue.entries().find((e) => e.item.status === "speaking");
        if (continuing && continuing.parts.length === 0) return;

        const block = speakBlock({
            control,
            lastTranscriptAt: this.#transcript.lastAt,
            quietAfterStreamerMs: settings.assistant.quietAfterStreamerMs,
            voiceEnabled,
            now,
        });
        const candidate =
            continuing ??
            this.#queue.nextSpeakable(now, (entry) => entry.approved || entry.kind !== "ai");
        if (!candidate) return;
        // Manual announcements ignore "replies paused"; nothing ignores mute or Shop LIVE.
        if (block !== null && !(candidate.kind === "manual" && block === "repliesPaused")) return;

        const text = candidate.parts.shift();
        if (text === undefined) return;
        const part = (this.#sayPart.get(candidate.item.id) ?? 0) + 1;
        this.#sayPart.set(candidate.item.id, part);
        if (this.#sayPart.size > 200) this.#sayPart.delete(this.#sayPart.keys().next().value ?? "");
        const sayId = `${candidate.item.id}:${part}`;
        const watchdog = setTimeout(() => this.onSayState(sayId, "done"), SAY_WATCHDOG_BASE_MS + text.length * SAY_WATCHDOG_PER_CHAR_MS);
        watchdog.unref();
        this.#current = { id: sayId, entryId: candidate.item.id, watchdog };
        this.#lastActivity = now;
        if (candidate.item.status !== "speaking") this.#queue.update(candidate.item.id, { status: "speaking" });
        this.#deps.control.setSpeaking(sayId);
        this.#deps.send({
            type: "say",
            id: sayId,
            text,
            voice: settings.voice.voice,
            ...(candidate.item.eventId ? { eventId: candidate.item.eventId } : {}),
        });
    }

    /* ------------------------------ helpers ------------------------------ */

    #observe(event: ChatEvent): Observation {
        const memory = this.#deps.memory;
        const sessionId = this.#sessions.get(event.streamId) ?? null;
        if (memory) {
            try {
                return memory.observe(event, sessionId);
            } catch (error) {
                this.#deps.log.warn("memory observe failed", error);
            }
        }
        const key = event.user.uniqueId;
        const first = key !== "" && !this.#seenLocal.has(key);
        if (first) this.#seenLocal.add(key);
        return { before: null, firstThisSession: first };
    }

    #maybeViewerCard(event: ChatEvent, observation: Observation, settings: Settings): void {
        if ((event.kind !== "join" && event.kind !== "chat") || !observation.firstThisSession) return;
        const before = observation.before;
        // Visits already recorded before this session: >= 1 means this is visit 2+.
        if (!before || before.visits < 1 || !this.#deps.memory) return;
        const visits = before.visits + 1;
        const facts = this.#deps.memory.facts(before.uniqueId);
        const card = this.#deps.memory.card(before.uniqueId, greetingSuggestion(before.nickname, visits, facts));
        if (card) this.#deps.send({ type: "viewerCard", card });

        const now = this.#now();
        if (settings.safety.greetReturningViewers && this.#dedupe("greet", before.uniqueId, now)) {
            this.#addTemplate("greeting", event, greetingLine(event.user.nickname || before.nickname, visits), 4, now);
        }
    }

    #readAloudOn(settings: Settings): boolean {
        return settings.voice.enabled && settings.voice.engine === "codai" && !settings.assistant.aiReplies;
    }

    #dedupe(kind: string, uniqueId: string, now: number): boolean {
        const key = `${kind}\u0000${uniqueId}`;
        const last = this.#templateSeen.get(key);
        if (last !== undefined && now - last < TEMPLATE_DEDUPE_MS) return false;
        this.#templateSeen.set(key, now);
        if (this.#templateSeen.size > 5000) {
            for (const [k, at] of this.#templateSeen) if (now - at > TEMPLATE_DEDUPE_MS) this.#templateSeen.delete(k);
        }
        return true;
    }

    #addTemplate(kind: EntryKind, event: ChatEvent, line: string, score: number, now: number): boolean {
        const settings = this.#deps.settings();
        if (!settings.voice.enabled || settings.voice.engine === "off") return false;
        return this.#queue.add(
            {
                item: {
                    id: this.#queue.nextId(),
                    eventId: event.id,
                    uniqueId: event.user.uniqueId,
                    nickname: event.user.nickname,
                    ...(event.user.avatarUrl ? { avatarUrl: event.user.avatarUrl } : {}),
                    message: event.text,
                    score,
                    reasons: [kind],
                    draft: line,
                    status: "ready",
                    at: now,
                },
                kind,
                event,
                approved: true,
                parts: [line],
                streaming: false,
                expiresAt: now + (kind === "read" ? READ_TTL_MS : TEMPLATE_TTL_MS),
            },
            now,
        );
    }

    #considerAi(event: ChatEvent, observation: Observation, duplicate: boolean, settings: Settings, now: number): void {
        const handle = (this.#streamerHandle(settings) ?? "").toLowerCase();
        const result = scoreEvent(event, {
            personaName: settings.assistant.personaName.trim().toLowerCase(),
            streamerHandle: handle,
            firstThisSession: observation.firstThisSession,
            firstEver: observation.before === null && this.#deps.memory !== null && event.user.uniqueId !== "",
            duplicate,
            blocked: this.#blocked,
        });
        if (result.excluded || result.score < MIN_AI_SCORE) return;
        const id = this.#queue.nextId();
        const added = this.#queue.add(
            {
                item: {
                    id,
                    eventId: event.id,
                    uniqueId: event.user.uniqueId,
                    nickname: event.user.nickname,
                    ...(event.user.avatarUrl ? { avatarUrl: event.user.avatarUrl } : {}),
                    message: event.text,
                    score: result.score,
                    reasons: result.reasons,
                    status: "pending",
                    at: now,
                },
                kind: "ai",
                event,
                approved: false,
                parts: [],
                streaming: false,
                expiresAt: now + AI_TTL_MS,
            },
            now,
        );
        if (added) {
            this.#s1.add({ id, text: event.text, nickname: event.user.nickname, alreadyQuestion: result.reasons.includes("question") });
        }
    }

    #streamerHandle(settings: Settings): string | null {
        return settings.connection.username.trim().replace(/^@/, "") || null;
    }

    #applyS1(id: string, adjustment: S1Adjustment): void {
        const entry = this.#queue.get(id);
        if (!entry || entry.item.status !== "pending") return;
        if (adjustment.skip) {
            this.#queue.update(id, { status: "skipped" });
            return;
        }
        if (adjustment.delta === 0 && adjustment.reasons.length === 0) return;
        const reasons = [...new Set([...entry.item.reasons, ...adjustment.reasons])];
        this.#queue.update(id, { score: Math.max(0, Math.round((entry.item.score + adjustment.delta) * 100) / 100), reasons });
    }

    #abortDraft(id: string): void {
        this.#drafts.get(id)?.abort();
        this.#drafts.delete(id);
    }

    #cancelCurrent(): void {
        const current = this.#current;
        if (!current) return;
        clearTimeout(current.watchdog);
        this.#current = null;
        this.#deps.send({ type: "sayCancel", id: current.id });
        this.#deps.control.setSpeaking(undefined);
    }
}
