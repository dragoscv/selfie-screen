import {
    compileWordList,
    eventDiamonds,
    type ChatEvent,
    type PetAiLevel,
    type PetCommand,
    type PetMemory,
    type PetMindState,
    type PetObservation,
    type PetPersonality,
    type PetSay,
    type Settings,
} from "@tiksee/core";

import type { CodaiClient } from "../codai/client.js";
import { defaultPersonality, type PetExperience, type PetStore, type PetTurn } from "../memory/pet-store.js";
import { AGENT_MAX_TOKENS, AGENT_TEMPERATURE, AGENT_TIMEOUT_MS, buildMessages, cueOf, HISTORY_TURNS, moodWord, parseAgentReply, type AgentTurn } from "./agent.js";
import { Floor, type Reason, type Salience } from "./floor.js";
import { MIN_TURNS_TO_REFLECT, parseReflection, REFLECT_MAX_TOKENS, REFLECT_TIMEOUT_MS, reflectionMessages } from "./reflection.js";
import { renderLog, StreamLog, type LogKind } from "./stream-log.js";
import { guessLanguage, mentionsPet, sanitiseUntrusted, similarity, ttlForText } from "./text.js";

/**
 * Pet agents (decision Q54): every pet in the studio is its own continuous LLM
 * agent with a persona, long-term memories and a resumable session, all reading
 * one shared stream log (chat, streamer speech, co-host lines, the other pets'
 * lines, owner actions). Deterministic floor control picks who speaks; only that
 * pet's agent is called (codai fast model, one streamed call). Lines become
 * bubbles (`petSay`) and, when enabled, speech in the pet's own voice through
 * the co-host queue (same gate: never over the streamer, the co-host, mute or
 * Shop mode). After a stream each pet reflects once and keeps <= 3 memories.
 *
 * Safety: viewer text is sanitised on entry and always quoted as data; model
 * output is validated (zod), cleaned, moderated with the blocked-word list and
 * de-duplicated against recent lines before it reaches the stream or memory.
 */

export const TICK_MS = 500;
export const STATE_MAX_AGE_MS = 15_000;
export const BIG_GIFT_DIAMONDS = 99;
/** A candidate line this similar to a recent pet line is dropped (anti-echo). */
export const ECHO_SIMILARITY = 0.6;
export const EXPERIENCE_EVERY_MS = 60_000;
const NICK_CHARS = 20;
const CHAT_CHARS = 90;
const SPEECH_CHARS = 160;
const LOG_LINES = 18;
const CHAT_WINDOW_MS = 60_000;
const PRAISE = /\b(cute|love|lovely|sweet|good|dragut\w*|frumo\w*|scump\w*|iubesc|super|bravo)\b|[\u2764\u{1F60D}]/iu;
const LAUGH = /\b(haha+|hihi+|lol|lmao|xd)\b|[\u{1F602}\u{1F923}]/iu;
const HANDLED: ReadonlySet<string> = new Set(["grabbed", "resized", "dropped"]);
const OWNER_PRESENT: ReadonlySet<string> = new Set(["owner_present", "owner"]);

export interface PetAgentsDeps {
    client: Pick<CodaiClient, "streamChat">;
    model: () => string;
    settings: () => Settings;
    /** Live Control: muted, replies paused, pets hidden. */
    quiet: () => boolean;
    shopMode: () => boolean;
    /** Something is being voiced now (co-host or a pet). */
    speaking: () => boolean;
    /** Epoch ms of the streamer's last transcript segment. */
    lastStreamerAt: () => number;
    emitSay: (say: PetSay) => void;
    emitCommand: (command: PetCommand) => void;
    /** Queue a line for TTS in `voice`; returns the queue entry id (utterances `<id>:<n>`). */
    speak?: (text: string, voice: string | undefined) => string | undefined;
    store?: Pick<PetStore, "ensure" | "seen" | "addMemory" | "applyExperience" | "addTurn" | "turns"> | null;
    /** Facts about a viewer (viewer memory). */
    viewerFacts?: (uniqueId: string) => string[];
    onPersonalityChanged?: () => void;
    log: { info: (...a: unknown[]) => void; debug: (...a: unknown[]) => void };
    now?: () => number;
}

interface Session {
    pet: string;
    history: AgentTurn[];
    /** Turns of the current stream (for the reflection). */
    streamTurns: AgentTurn[];
    busy: boolean;
}

const LLM_LEVELS: ReadonlySet<PetAiLevel> = new Set(["reactive", "chatty", "director"]);

export class PetAgents {
    #deps: PetAgentsDeps;
    #now: () => number;
    #log = new StreamLog();
    #floor = new Floor();
    #sessions = new Map<string, Session>();
    #minds: PetMindState[] = [];
    #mindsAt = 0;
    #chatTimes: number[] = [];
    #timer: NodeJS.Timeout | null = null;
    #ownerSeen = false;
    #blockedKey = "\u0001";
    #blocked: RegExp | null = null;
    #streamStartedAt = 0;
    #experienceAt: number;
    #tally = new Map<string, PetExperience & { kinds: Set<string> }>();
    #lastTranscript = new Map<string, string>();

    constructor(deps: PetAgentsDeps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
        this.#experienceAt = this.#now();
    }

    start(): void {
        if (this.#timer) return;
        this.#timer = setInterval(() => void this.tick(), TICK_MS);
        this.#timer.unref();
    }

    dispose(): void {
        if (this.#timer) clearInterval(this.#timer);
        this.#timer = null;
    }

    get callsLastHour(): number {
        return this.#floor.callsLastHour(this.#now());
    }

    /** The shared log (tests, diagnostics). */
    get streamLog(): StreamLog {
        return this.#log;
    }

    #level(): PetAiLevel {
        const s = this.#deps.settings();
        return s.studio.enabled ? s.studio.petAi.level : "off";
    }

    #llm(): boolean {
        return LLM_LEVELS.has(this.#level());
    }

    #pets(): string[] {
        return this.#minds.map((m) => m.pet);
    }

    /* ------------------------------ inputs ------------------------------ */

    onPetState(pets: readonly PetMindState[], observations: readonly PetObservation[] = []): void {
        const now = this.#now();
        this.#minds = pets.slice(0, 8);
        this.#mindsAt = now;
        if (this.#level() === "off") return;
        this.#floor.setPets(this.#pets(), now);
        for (const p of this.#minds) this.#session(p.pet);
        for (const o of observations) this.#observe(o, now);
    }

    /** A pet's local mind chose to talk (renderer, immediate). */
    onPetTalk(pet: string): void {
        if (!this.#llm() || !this.#pets().includes(pet)) return;
        this.#floor.push("wantsToTalk", { at: this.#now(), text: "you feel like saying something" }, [pet]);
    }

    onEvent(event: ChatEvent): void {
        if (!this.#llm()) return;
        const at = this.#now();
        const pets = this.#pets();
        const awareness = this.#deps.settings().studio.petAi.chat;
        const who = sanitiseUntrusted(event.user.nickname || event.user.uniqueId, NICK_CHARS) || "someone";
        if (event.kind === "chat") {
            this.#chatTimes.push(at);
            this.#tallyAll("chats");
            if (LAUGH.test(event.text)) this.#tallyAll("laughs");
            const named = pets.filter((p) => mentionsPet(event.text, [p]));
            const text = sanitiseUntrusted(event.text, CHAT_CHARS);
            const readable = awareness === "full" || (awareness === "mentions" && named.length > 0);
            if (readable && text) this.#add("chat", text, at, who);
            for (const pet of named) {
                const t = this.#tallyOf(pet);
                t.mentions = (t.mentions ?? 0) + 1;
                if (PRAISE.test(event.text)) t.praise = (t.praise ?? 0) + 1;
            }
            if (awareness === "none") return;
            if (named.length > 0) {
                this.#floor.push("mention", { at, text: `${who} talked about you in the chat`, viewer: event.user.uniqueId }, named);
            } else if (awareness === "full" && text) {
                this.#floor.push("chat", { at, text: `${who} wrote in the chat`, viewer: event.user.uniqueId });
            }
        } else if (event.kind === "gift") {
            this.#tallyAll("gifts");
            const diamonds = eventDiamonds(event);
            const gift = `${sanitiseUntrusted(event.giftName ?? "gift", 24) || "gift"} x${event.giftCount ?? 1}`;
            this.#add("gift", `${who} sent ${gift} (${diamonds} diamonds)`, at);
            const big = diamonds >= BIG_GIFT_DIAMONDS;
            this.#floor.push(big ? "bigGift" : "gift", { at, text: `${who} sent ${big ? "a big gift" : "a gift"}: ${gift}`, viewer: event.user.uniqueId });
        } else if (event.kind === "follow") {
            this.#add("follow", `${who} followed the stream`, at);
            this.#floor.push("follow", { at, text: `${who} just followed the stream`, viewer: event.user.uniqueId });
        }
    }

    /** Streamer speech (renderer STT). Final segments only enter the log. */
    onTranscript(itemId: string, text: string, final: boolean, at: number): void {
        if (!this.#llm() || !final) return;
        const clean = sanitiseUntrusted(text, SPEECH_CHARS);
        if (!clean || this.#lastTranscript.get(itemId) === clean) return;
        this.#lastTranscript.set(itemId, clean);
        if (this.#lastTranscript.size > 50) this.#lastTranscript.delete(this.#lastTranscript.keys().next().value ?? "");
        const now = this.#now();
        this.#add("streamer", clean, Math.min(at, now));
        const named = this.#pets().filter((p) => mentionsPet(clean, [p]));
        this.#deps.log.info(`pets heard the streamer (${clean.length} chars${named.length > 0 ? `, named ${named.join(",")}` : ""})`);
        if (named.length > 0) this.#floor.push("streamerNamed", { at: now, text: "the streamer talked to you or about you" }, named);
        else this.#floor.push("streamerSpoke", { at: now, text: "the streamer said something" });
    }

    /** Every utterance the co-host queue starts (co-host replies and voiced pet lines). */
    onUtterance(entryId: string, text: string, kind: string): void {
        if (!this.#llm() || this.#petEntries.has(entryId)) return;
        const now = this.#now();
        this.#add("cohost", sanitiseUntrusted(text, SPEECH_CHARS), now);
        if (kind === "ai") this.#floor.push("cohostSpoke", { at: now, text: "the co-host answered someone" });
    }

    #petEntries = new Set<string>();

    /** A live stream started / ended (reflection runs at the end). */
    onStreamState(live: boolean): void {
        const now = this.#now();
        if (live) {
            if (this.#streamStartedAt === 0) this.#streamStartedAt = now;
            return;
        }
        if (this.#streamStartedAt === 0) return;
        const started = this.#streamStartedAt;
        this.#streamStartedAt = 0;
        void this.reflect(started);
    }

    #observe(o: PetObservation, now: number): void {
        const pets = o.pet ? [o.pet] : undefined;
        const tally = this.#tallyOf(o.pet ?? "*");
        tally.kinds.add(o.what);
        if (o.what === "petted") tally.petted = (tally.petted ?? 0) + 1;
        if (o.what === "dropped" || o.what === "startled") tally.startles = (tally.startles ?? 0) + 1;
        if (!this.#llm()) return;
        if (HANDLED.has(o.what)) {
            const verb = o.what === "resized" ? "resized" : o.what === "dropped" ? "dropped" : "picked up";
            this.#add("owner", `the streamer ${verb} ${o.pet ?? "a pet"} with their hands`, now);
            this.#floor.push("handled", { at: now, text: `the streamer just ${verb} you with their hands` }, pets);
        } else if (OWNER_PRESENT.has(o.what)) {
            if (this.#ownerSeen) return;
            this.#ownerSeen = true;
            this.#add("owner", "the streamer appeared on camera", now);
            this.#floor.push("ownerAppeared", { at: now, text: "the streamer just appeared on camera" });
        } else {
            this.#add("owner", `the streamer: ${o.what.replace(/_/g, " ")}`, now);
            this.#floor.push("ownerAction", { at: now, text: `the streamer is ${o.what.replace(/_/g, " ")}` });
        }
    }

    #add(kind: LogKind, text: string, at: number, who?: string): void {
        this.#log.add({ at, kind, text, ...(who ? { who } : {}) });
    }

    /* ----------------------------- scheduler ----------------------------- */

    /** One scheduler step (public for tests). Resolves to the pet that spoke, or null. */
    async tick(): Promise<string | null> {
        const now = this.#now();
        const level = this.#level();
        if (level !== "off") this.#applyExperience(now);
        if (!LLM_LEVELS.has(level)) return null;
        if (this.#minds.length === 0 || now - this.#mindsAt > STATE_MAX_AGE_MS) return null;
        if ([...this.#sessions.values()].some((s) => s.busy)) return null;
        this.#chatTimes = this.#chatTimes.filter((t) => now - t < CHAT_WINDOW_MS);
        const s = this.#deps.settings();
        const pick = this.#floor.pick(
            {
                level,
                maxCallsPerHour: s.studio.petAi.maxCallsPerHour,
                chatPerMinute: this.#chatTimes.length,
                lastStreamerAt: this.#deps.lastStreamerAt(),
                speaking: this.#deps.speaking(),
                quiet: this.#deps.quiet(),
            },
            now,
        );
        if (!pick) return null;
        this.#floor.granted(pick.pet, now);
        return (await this.#turn(pick.pet, pick.reasons, level)) ? pick.pet : null;
    }

    async #turn(pet: string, reasons: readonly Reason[], level: PetAiLevel): Promise<boolean> {
        const session = this.#session(pet);
        const mind = this.#minds.find((m) => m.pet === pet);
        if (!mind) return false;
        session.busy = true;
        const now = this.#now();
        try {
            const personality = this.#personality(pet);
            const entries = this.#log.recent(now, undefined, LOG_LINES);
            const viewer = [...reasons].reverse().find((r) => r.viewer)?.viewer;
            const facts = viewer ? (this.#deps.viewerFacts?.(viewer) ?? []).slice(0, 4).map((f) => sanitiseUntrusted(f, 100)) : [];
            const speech = entries.filter((e) => e.kind === "chat" || e.kind === "streamer").map((e) => e.text);
            const canMove = level === "director";
            const messages = buildMessages({
                pet: mind,
                personality,
                history: session.history,
                log: renderLog(entries, now, pet),
                digest: this.#log.digest(),
                reasons,
                others: this.#minds.filter((m) => m.pet !== pet).map((m) => ({ pet: m.pet, doing: m.action, mood: moodWord(m.mood) })),
                viewerFacts: facts,
                language: guessLanguage(speech),
                canMove,
                now,
            });
            const result = await this.#deps.client.streamChat({
                model: this.#deps.model(),
                messages,
                maxTokens: AGENT_MAX_TOKENS,
                temperature: AGENT_TEMPERATURE,
                timeoutMs: AGENT_TIMEOUT_MS,
            });
            if (!result.ok) {
                this.#deps.log.debug(`pet agent ${pet} skipped (${result.error.kind})`);
                return false;
            }
            const reply = parseAgentReply(result.value.text, pet, this.#blockedRe(), canMove);
            if (!reply) {
                this.#deps.log.debug(`pet agent ${pet}: unparsable reply`);
                return false;
            }
            let said = reply.say;
            if (said && this.#log.petLines(6).some((l) => similarity(l.text, said) >= ECHO_SIMILARITY)) {
                this.#deps.log.debug(`pet agent ${pet}: echo dropped`);
                said = "";
            }
            // The world may have changed during the call: never talk over someone who started meanwhile.
            if (said && (this.#deps.quiet() || this.#deps.speaking() || this.#now() - this.#deps.lastStreamerAt() < 1_000)) said = "";
            const turn: AgentTurn = { at: now, cue: cueOf(reasons), said };
            this.#remember(session, turn);
            if (said) this.#emit(pet, said, reply.emotion);
            this.#floor.spoke(pet, said !== "", this.#now());
            if (reply.remember) this.#storeMemory(pet, reply.remember);
            if (reply.move && said) {
                this.#deps.emitCommand(reply.move);
                this.#deps.log.info(`pet move ${pet} ${reply.move.anchor ?? "-"} ${reply.move.clip ?? "-"} ${reply.move.ttlSec}s`);
            }
            this.#deps.log.info(`pet agent ${pet}: ${said ? "spoke" : "silent"} (${reasons.map((r) => r.kind).join(",")}, ${result.value.totalMs} ms)`);
            return said !== "";
        } catch (error) {
            this.#deps.log.debug(`pet agent ${pet} failed: ${error instanceof Error ? error.name : "error"}`);
            return false;
        } finally {
            session.busy = false;
        }
    }

    #emit(pet: string, text: string, emotion: PetSay["emotion"]): void {
        const s = this.#deps.settings();
        const voiced = s.studio.petAi.voice && !this.#deps.shopMode();
        const sayId = voiced ? this.#deps.speak?.(text, s.studio.petAi.voices[pet]) : undefined;
        if (sayId) {
            this.#petEntries.add(sayId);
            if (this.#petEntries.size > 50) this.#petEntries.delete(this.#petEntries.values().next().value ?? "");
        }
        this.#deps.emitSay({ pet, text, emotion, ttlMs: ttlForText(text), ...(sayId ? { sayId } : {}) });
        const now = this.#now();
        this.#add("pet", text, now, pet);
        // The other pets heard it: they may answer (floor control stops endless ping-pong).
        const others = this.#pets().filter((p) => p !== pet);
        if (others.length > 0) this.#floor.push("petSpoke", { at: now, text: `${pet} just said something` }, others, mentionsPet(text, others) ? 2.5 : 1);
    }

    /* ------------------------------ sessions ----------------------------- */

    #session(pet: string): Session {
        let s = this.#sessions.get(pet);
        if (!s) {
            let history: AgentTurn[] = [];
            try {
                this.#deps.store?.seen(pet);
                history = (this.#deps.store?.turns(pet, HISTORY_TURNS) ?? []).map((t) => ({ ...t }));
            } catch (error) {
                this.#deps.log.debug(`pet store: ${error instanceof Error ? error.name : "error"}`);
            }
            s = { pet, history, streamTurns: [], busy: false };
            this.#sessions.set(pet, s);
        }
        return s;
    }

    /** The agent's session history (tests, diagnostics). */
    history(pet: string): readonly AgentTurn[] {
        return this.#sessions.get(pet)?.history ?? [];
    }

    #remember(session: Session, turn: AgentTurn): void {
        session.history.push(turn);
        if (session.history.length > HISTORY_TURNS * 2) session.history.splice(0, session.history.length - HISTORY_TURNS * 2);
        session.streamTurns.push(turn);
        if (session.streamTurns.length > 200) session.streamTurns.shift();
        try {
            this.#deps.store?.addTurn(session.pet, turn satisfies PetTurn);
        } catch (error) {
            this.#deps.log.debug(`pet turn store failed: ${error instanceof Error ? error.name : "error"}`);
        }
    }

    #personality(pet: string): PetPersonality {
        try {
            return this.#deps.store?.ensure(pet) ?? defaultPersonality(pet, this.#now());
        } catch {
            return defaultPersonality(pet, this.#now());
        }
    }

    #storeMemory(pet: string, m: { text: string; importance: number }): void {
        const store = this.#deps.store;
        if (!store) return;
        const existing = this.#personality(pet).memories;
        if (existing.some((e) => similarity(e.text, m.text) >= 0.7)) return;
        try {
            const item: PetMemory = { at: this.#now(), text: m.text, importance: Math.round(m.importance * 100) / 100 };
            store.addMemory(pet, item);
            this.#deps.onPersonalityChanged?.();
        } catch (error) {
            this.#deps.log.debug(`pet memory failed: ${error instanceof Error ? error.name : "error"}`);
        }
    }

    /** Post-stream reflection: one call per pet that took part, <= 3 memories each. */
    async reflect(since: number): Promise<number> {
        const s = this.#deps.settings();
        if (!s.studio.petAi.reflection || !this.#llm()) return 0;
        let added = 0;
        for (const session of this.#sessions.values()) {
            const turns = session.streamTurns.filter((t) => t.at >= since);
            session.streamTurns = [];
            if (turns.filter((t) => t.said).length < MIN_TURNS_TO_REFLECT) continue;
            const personality = this.#personality(session.pet);
            const result = await this.#deps.client.streamChat({
                model: this.#deps.model(),
                messages: reflectionMessages(personality, turns, this.#log.digest()),
                maxTokens: REFLECT_MAX_TOKENS,
                temperature: 0.5,
                timeoutMs: REFLECT_TIMEOUT_MS,
            });
            if (!result.ok) continue;
            for (const m of parseReflection(result.value.text, this.#blockedRe(), personality.memories.map((x) => x.text))) {
                this.#storeMemory(session.pet, m);
                added += 1;
            }
            this.#deps.log.info(`pet reflection ${session.pet}: ${added} memories`);
        }
        this.#log.clear();
        return added;
    }

    /* ----------------------------- experience ---------------------------- */

    #tallyOf(pet: string): PetExperience & { kinds: Set<string> } {
        let t = this.#tally.get(pet);
        if (!t) {
            t = { kinds: new Set() };
            this.#tally.set(pet, t);
        }
        return t;
    }

    #tallyAll(key: "chats" | "gifts" | "laughs"): void {
        const t = this.#tallyOf("*");
        t[key] = (t[key] ?? 0) + 1;
    }

    /** Bounded trait drift from what the pets lived through (PetStore enforces the cap). */
    #applyExperience(now: number): void {
        if (now - this.#experienceAt < EXPERIENCE_EVERY_MS) return;
        this.#experienceAt = now;
        const tally = this.#tally;
        this.#tally = new Map();
        const store = this.#deps.store;
        if (!store || this.#minds.length === 0) return;
        const all = tally.get("*") ?? { kinds: new Set<string>() };
        let changed = false;
        try {
            for (const p of this.#minds) {
                const own = tally.get(p.pet) ?? { kinds: new Set<string>() };
                const sum = (k: keyof PetExperience): number => (all[k] ?? 0) + (own[k] ?? 0);
                const exp: PetExperience = {
                    gifts: sum("gifts"),
                    petted: sum("petted"),
                    chats: sum("chats"),
                    mentions: sum("mentions"),
                    laughs: sum("laughs"),
                    startles: sum("startles"),
                    praise: sum("praise"),
                    novelty: new Set([...all.kinds, ...own.kinds]).size,
                };
                if (Object.values(exp).every((v) => v === 0)) continue;
                if (store.applyExperience(p.pet, exp)) changed = true;
            }
        } catch (error) {
            this.#deps.log.debug(`pet experience failed: ${error instanceof Error ? error.name : "error"}`);
        }
        if (changed) this.#deps.onPersonalityChanged?.();
    }

    #blockedRe(): RegExp | null {
        const words = this.#deps.settings().safety.blockedWords;
        const key = words.join("\u0000");
        if (key !== this.#blockedKey) {
            this.#blockedKey = key;
            this.#blocked = compileWordList(words);
        }
        return this.#blocked;
    }
}

export type { Salience };
