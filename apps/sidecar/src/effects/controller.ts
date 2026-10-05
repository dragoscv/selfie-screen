import type { ChatEvent, EffectFired, Settings } from "@tiksee/core";

import type { ScopedLogger } from "../logger.js";
import { EffectPlanner, fire, testPlan, type EffectsBackend } from "./router.js";

export interface EffectsControllerDeps {
    settings: () => Settings;
    effectsOff: () => boolean;
    backend: EffectsBackend;
    emit: (effect: EffectFired) => void;
    log: ScopedLogger;
}

/** Glue between live events, the planner, vmui and the UI effect log (WS21-04). */
export class EffectsController {
    #deps: EffectsControllerDeps;
    #planner: EffectPlanner;

    constructor(deps: EffectsControllerDeps) {
        this.#deps = deps;
        this.#planner = new EffectPlanner(deps.settings().effects);
    }

    setSettings(settings: Settings): void {
        this.#planner.setSettings(settings.effects);
    }

    onEvent(event: ChatEvent): void {
        // Replays must never flash the real room.
        if (event.replay || this.#deps.effectsOff()) return;
        const plan = this.#planner.plan(event, Date.now());
        if (!plan) return;
        void fire(this.#deps.backend, plan, Date.now()).then((effect) => {
            if (effect.error) this.#deps.log.info(`effect ${plan.label} failed: ${effect.error}`);
            this.#deps.emit(effect);
        });
    }

    /** Settings "test" button; ignores the enable switch, never Live Control's kill switch. */
    async test(kind: "flash" | "scene", value: string): Promise<EffectFired> {
        const at = Date.now();
        if (this.#deps.effectsOff()) {
            const blocked: EffectFired = { id: `test-${at.toString(36)}`, kind, label: value, by: "manual", at, limited: false, error: "Efectele sunt oprite din Live Control" };
            this.#deps.emit(blocked);
            return blocked;
        }
        const effect = await fire(this.#deps.backend, testPlan(kind, value, at), at);
        this.#deps.emit(effect);
        return effect;
    }
}
