import { liveControlStateSchema, type ControlAction, type LiveControlState } from "@tiksee/core";

/** Side effects an action asks for beyond the state flip. */
export type ControlEffect = "skipCurrent" | "highlight" | "silence";

export interface ControlTransition {
    state: LiveControlState;
    changed: boolean;
    effects: ControlEffect[];
}

/**
 * Pure transition function for Live Control (WS22-01). Toggles are
 * idempotent; `skipCurrent` and `highlight` are one-shot effects. Turning on
 * mute or Shop LIVE also asks the engine to cut the current utterance —
 * TikTok Shop LIVE forbids AI voices outright.
 */
export function applyControl(state: LiveControlState, action: ControlAction): ControlTransition {
    const next: LiveControlState = { ...state };
    const effects: ControlEffect[] = [];
    switch (action) {
        case "muteAssistant":
            next.muted = true;
            effects.push("silence");
            break;
        case "unmuteAssistant":
            next.muted = false;
            break;
        case "pauseReplies":
            next.repliesPaused = true;
            break;
        case "resumeReplies":
            next.repliesPaused = false;
            break;
        case "skipCurrent":
            effects.push("skipCurrent");
            break;
        case "effectsOff":
            next.effectsOff = true;
            break;
        case "effectsOn":
            next.effectsOff = false;
            break;
        case "shopModeOn":
            next.shopMode = true;
            effects.push("silence");
            break;
        case "shopModeOff":
            next.shopMode = false;
            break;
        case "petsHide":
            next.petsHidden = true;
            break;
        case "petsShow":
            next.petsHidden = false;
            break;
        case "highlight":
            effects.push("highlight");
            break;
    }
    const changed =
        next.muted !== state.muted ||
        next.repliesPaused !== state.repliesPaused ||
        next.effectsOff !== state.effectsOff ||
        next.shopMode !== state.shopMode ||
        next.petsHidden !== state.petsHidden;
    return { state: next, changed, effects };
}

/** Runtime holder; resets on every launch by design (never persisted). */
export class LiveControl {
    #state: LiveControlState = liveControlStateSchema.parse({});
    #onChange: (state: LiveControlState) => void;

    constructor(onChange: (state: LiveControlState) => void) {
        this.#onChange = onChange;
    }

    get state(): LiveControlState {
        return this.#state;
    }

    apply(action: ControlAction): ControlEffect[] {
        const transition = applyControl(this.#state, action);
        this.#state = transition.state;
        if (transition.changed) this.#onChange(this.#state);
        return transition.effects;
    }

    setSpeaking(id: string | undefined): void {
        if (this.#state.speakingId === id) return;
        const next: LiveControlState = { ...this.#state };
        if (id === undefined) delete next.speakingId;
        else next.speakingId = id;
        this.#state = next;
        this.#onChange(this.#state);
    }
}
