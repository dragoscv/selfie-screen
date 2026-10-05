import type { ChatEvent, GameAction, GamePlayer, GameSpec, GameState, Settings } from "@tiksee/core";

import { MAX_WHEEL_SEGMENTS, castVote, drawWheel, hasKeyword, matchesAnswer, newTally, parseVote, type PollTally } from "./logic.js";

/** How long the overlay wheel animates before the winner is revealed. */
export const WHEEL_SPIN_MS = 6_000;
const EMIT_THROTTLE_MS = 200;
const MAX_ENTRANTS = 50_000;

export interface GameManagerDeps {
    settings: () => Settings;
    emit: (state: GameState) => void;
    /** Spoken announcement (winner, results); the co-host gate decides when. */
    announce: (text: string) => void;
    now?: () => number;
    rng?: () => number;
}

type Running =
    | { kind: "poll"; id: string; question: string; options: string[]; tally: PollTally; open: boolean; startedAt: number }
    | {
          kind: "quiz";
          id: string;
          question: string;
          answers: string[];
          open: boolean;
          attempts: number;
          winner?: GamePlayer & { answer: string; at: number };
          startedAt: number;
      }
    | {
          kind: "wheel";
          id: string;
          keyword: string;
          open: boolean;
          entrants: Map<string, GamePlayer>;
          segments: string[];
          spinning: boolean;
          winnerIndex?: number;
          winner?: GamePlayer;
          spinAt?: number;
          startedAt: number;
      };

let gameSeq = 0;

/**
 * One chat game at a time: poll, quiz or giveaway wheel. Driven by live chat,
 * controlled by the desktop app, rendered by the app and the OBS overlay.
 */
export class GameManager {
    #deps: GameManagerDeps;
    #now: () => number;
    #game: Running | null = null;
    #emitTimer: NodeJS.Timeout | null = null;
    #spinTimer: NodeJS.Timeout | null = null;

    constructor(deps: GameManagerDeps) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
    }

    get state(): GameState {
        const game = this.#game;
        if (!game) return { kind: "none" };
        switch (game.kind) {
            case "poll":
                return {
                    kind: "poll",
                    id: game.id,
                    question: game.question,
                    options: game.options.map((label, i) => ({ label, votes: game.tally.votes[i] ?? 0 })),
                    totalVotes: game.tally.voters.size,
                    open: game.open,
                    startedAt: game.startedAt,
                };
            case "quiz":
                return {
                    kind: "quiz",
                    id: game.id,
                    question: game.question,
                    open: game.open,
                    attempts: game.attempts,
                    ...(game.winner ? { winner: game.winner } : {}),
                    ...(!game.open ? { answer: game.answers[0] ?? "" } : {}),
                    startedAt: game.startedAt,
                };
            case "wheel":
                return {
                    kind: "wheel",
                    id: game.id,
                    keyword: game.keyword,
                    open: game.open,
                    entrantCount: game.entrants.size,
                    segments: game.segments,
                    spinning: game.spinning,
                    ...(game.winnerIndex !== undefined ? { winnerIndex: game.winnerIndex } : {}),
                    ...(game.winner && !game.spinning ? { winner: game.winner } : {}),
                    ...(game.spinAt !== undefined ? { spinAt: game.spinAt } : {}),
                    startedAt: game.startedAt,
                };
        }
    }

    start(spec: GameSpec): void {
        this.#clearTimers();
        const id = `g${(++gameSeq).toString(36)}-${this.#now().toString(36)}`;
        const startedAt = this.#now();
        if (spec.kind === "poll") {
            this.#game = { kind: "poll", id, question: spec.question, options: spec.options, tally: newTally(spec.options.length), open: true, startedAt };
        } else if (spec.kind === "quiz") {
            this.#game = { kind: "quiz", id, question: spec.question, answers: spec.answers, open: true, attempts: 0, startedAt };
        } else {
            this.#game = { kind: "wheel", id, keyword: spec.keyword, open: true, entrants: new Map(), segments: [], spinning: false, startedAt };
        }
        this.#emitNow();
    }

    action(action: GameAction): void {
        const game = this.#game;
        if (action === "clear" || !game) {
            this.#clearTimers();
            this.#game = null;
            this.#emitNow();
            return;
        }
        if (action === "close") {
            if (!game.open) return;
            game.open = false;
            this.#emitNow();
            if (game.kind === "poll") this.#announcePoll(game);
            else if (game.kind === "quiz" && !game.winner) this.#announce(`Nimeni n-a ghicit. Răspunsul era: ${game.answers[0] ?? ""}.`);
            return;
        }
        if (action === "spin" && game.kind === "wheel") this.#spin(game);
    }

    onEvent(event: ChatEvent): void {
        const game = this.#game;
        if (!game || !game.open || event.kind !== "chat" || event.user.uniqueId === "") return;
        const player: GamePlayer = { uniqueId: event.user.uniqueId, nickname: event.user.nickname || event.user.uniqueId };

        if (game.kind === "poll") {
            const option = parseVote(event.text, game.options.length);
            if (option === null) return;
            if (castVote(game.tally, player.uniqueId, option, this.#deps.settings().games.allowVoteChange)) this.#scheduleEmit();
        } else if (game.kind === "quiz") {
            game.attempts += 1;
            if (matchesAnswer(event.text, game.answers)) {
                game.winner = { ...player, answer: event.text.slice(0, 120), at: event.at };
                game.open = false;
                this.#emitNow();
                this.#announce(`Bravo ${player.nickname}! Răspunsul corect era: ${game.answers[0] ?? ""}.`);
            } else {
                this.#scheduleEmit();
            }
        } else if (game.kind === "wheel") {
            if (!hasKeyword(event.text, game.keyword) || game.entrants.has(player.uniqueId)) return;
            if (this.#deps.settings().games.wheelFollowersOnly && event.user.isFollower !== true) return;
            if (game.entrants.size >= MAX_ENTRANTS) return;
            game.entrants.set(player.uniqueId, player);
            if (game.segments.length < MAX_WHEEL_SEGMENTS) game.segments = [...game.segments, player.nickname];
            this.#scheduleEmit();
        }
    }

    dispose(): void {
        this.#clearTimers();
    }

    #spin(game: Extract<Running, { kind: "wheel" }>): void {
        if (game.spinning) return;
        const draw = drawWheel([...game.entrants.values()], this.#deps.rng);
        if (!draw) return;
        game.open = false;
        game.spinning = true;
        game.segments = draw.segments;
        game.winnerIndex = draw.winnerIndex;
        game.winner = draw.winner;
        game.spinAt = this.#now();
        this.#emitNow();
        this.#spinTimer = setTimeout(() => {
            this.#spinTimer = null;
            if (this.#game !== game) return;
            game.spinning = false;
            this.#emitNow();
            this.#announce(`Felicitări ${draw.winner.nickname}, ai câștigat tombola!`);
        }, WHEEL_SPIN_MS);
        this.#spinTimer.unref();
    }

    #announcePoll(game: Extract<Running, { kind: "poll" }>): void {
        const total = game.tally.voters.size;
        if (total === 0) return;
        let best = 0;
        game.tally.votes.forEach((v, i) => {
            if (v > (game.tally.votes[best] ?? 0)) best = i;
        });
        const votes = game.tally.votes[best] ?? 0;
        this.#announce(`Sondaj închis. A câștigat varianta ${best + 1}, ${game.options[best] ?? ""}, cu ${Math.round((votes / total) * 100)} la sută.`);
    }

    #announce(text: string): void {
        if (this.#deps.settings().games.announceWinners) this.#deps.announce(text);
    }

    #scheduleEmit(): void {
        if (this.#emitTimer) return;
        this.#emitTimer = setTimeout(() => {
            this.#emitTimer = null;
            this.#deps.emit(this.state);
        }, EMIT_THROTTLE_MS);
        this.#emitTimer.unref();
    }

    #emitNow(): void {
        if (this.#emitTimer) clearTimeout(this.#emitTimer);
        this.#emitTimer = null;
        this.#deps.emit(this.state);
    }

    #clearTimers(): void {
        if (this.#emitTimer) clearTimeout(this.#emitTimer);
        if (this.#spinTimer) clearTimeout(this.#spinTimer);
        this.#emitTimer = null;
        this.#spinTimer = null;
    }
}
