import type { CodaiClient, S1Answer, S1Question } from "../codai/client.js";

/**
 * System One enrichment (WS20-15): batches unhandled chat candidates into one
 * `/v1/systemone` call every 1.5 s and turns confident labels into score
 * adjustments. Never on the critical path — a candidate is drafted whether or
 * not its labels have arrived, and every failure is silent (debug log only).
 */

export const S1_QUESTIONS: Record<string, S1Question> = {
    is_question: { type: "noul", instructions: "Does this live-chat message ask the streamer or the AI co-host a question?" },
    needs_reply: { type: "noul", instructions: "Would a short spoken reply to this live-chat message make the viewer feel noticed?" },
    intent: {
        type: "choice",
        instructions: "What does the viewer want with this live-chat message?",
        criteria: { greeting: null, question: null, compliment: null, request_effect: null, spam: null, other: null },
    },
    emotion: {
        type: "choice",
        instructions: "Which emotion does the viewer express?",
        criteria: { happy: null, excited: null, curious: null, sad: null, angry: null, neutral: null },
    },
};

export const S1_MIN_CONFIDENCE = 0.7;
export const S1_BATCH_SIZE = 8;
export const S1_INTERVAL_MS = 1_500;

export interface S1Adjustment {
    delta: number;
    reasons: string[];
    /** Drop the candidate (confident spam). */
    skip: boolean;
}

/** Pure mapping from typed answers to a score adjustment. */
export function adjustmentFor(answers: Record<string, S1Answer>, alreadyQuestion: boolean): S1Adjustment {
    const out: S1Adjustment = { delta: 0, reasons: [], skip: false };

    // A noul answer is P(true); >= 0.7 / <= 0.3 are the confident ends.
    const question = answers.is_question;
    if (question?.type === "noul" && question.noul >= S1_MIN_CONFIDENCE && !alreadyQuestion) {
        out.delta += 3;
        out.reasons.push("question");
    }

    const needs = answers.needs_reply;
    if (needs?.type === "noul") {
        if (needs.noul >= S1_MIN_CONFIDENCE) {
            out.delta += 1.5;
            out.reasons.push("s1:needs-reply");
        } else if (needs.noul <= 1 - S1_MIN_CONFIDENCE) {
            out.delta -= 2;
        }
    }

    const intent = answers.intent;
    if (intent?.type === "choice" && intent.confidence >= S1_MIN_CONFIDENCE) {
        if (intent.choice === "spam") out.skip = true;
        else if (intent.choice === "compliment" || intent.choice === "greeting") out.delta += 0.5;
        else if (intent.choice === "request_effect") out.delta -= 1;
        out.reasons.push(`s1:${intent.choice}`);
    }

    const emotion = answers.emotion;
    if (emotion?.type === "choice" && emotion.confidence >= S1_MIN_CONFIDENCE) {
        if (emotion.choice === "sad") out.delta += 1;
        else if (emotion.choice === "angry") out.delta -= 1;
        if (emotion.choice !== "neutral") out.reasons.push(`mood:${emotion.choice}`);
    }
    return out;
}

export interface S1Candidate {
    id: string;
    text: string;
    nickname: string;
    alreadyQuestion: boolean;
}

export interface S1EnricherDeps {
    client: Pick<CodaiClient, "systemOne">;
    onAdjust: (id: string, adjustment: S1Adjustment) => void;
    /** Raw answers, for future training data. */
    onLog: (record: { id: string; text: string; answers: Record<string, S1Answer>; model: string; fallbackUsed: boolean }) => void;
}

export class S1Enricher {
    #deps: S1EnricherDeps;
    #pending: S1Candidate[] = [];
    #timer: NodeJS.Timeout | null = null;
    #busy = false;
    enabled = true;

    constructor(deps: S1EnricherDeps) {
        this.#deps = deps;
    }

    add(candidate: S1Candidate): void {
        if (!this.enabled) return;
        this.#pending.push(candidate);
        // Keep the freshest; stale candidates are not worth labelling.
        if (this.#pending.length > S1_BATCH_SIZE * 4) this.#pending.splice(0, this.#pending.length - S1_BATCH_SIZE * 4);
        this.#schedule();
    }

    #schedule(): void {
        if (this.#timer) return;
        this.#timer = setTimeout(() => {
            this.#timer = null;
            void this.flush();
        }, S1_INTERVAL_MS);
        this.#timer.unref();
    }

    async flush(): Promise<void> {
        if (this.#busy || this.#pending.length === 0) return;
        this.#busy = true;
        const batch = this.#pending.splice(Math.max(0, this.#pending.length - S1_BATCH_SIZE));
        this.#pending = [];
        try {
            const result = await this.#deps.client.systemOne({
                items: batch.map((c) => ({ id: c.id, state: { viewer: c.nickname, message: c.text } })),
                questions: S1_QUESTIONS,
                timeoutMs: 800,
                fallback: "codai-fast",
            });
            if (!result.ok) return;
            const byId = new Map(batch.map((c) => [c.id, c]));
            for (const item of result.value.items) {
                const candidate = byId.get(item.id);
                if (!candidate) continue;
                this.#deps.onLog({ id: item.id, text: candidate.text, answers: item.answers, model: result.value.model, fallbackUsed: result.value.fallbackUsed });
                this.#deps.onAdjust(item.id, adjustmentFor(item.answers, candidate.alreadyQuestion));
            }
        } finally {
            this.#busy = false;
        }
    }

    dispose(): void {
        if (this.#timer) clearTimeout(this.#timer);
        this.#timer = null;
        this.#pending = [];
    }
}
