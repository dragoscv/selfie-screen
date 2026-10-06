import { describe, expect, it } from "vitest";

import { PERSONALITIES, PetMind } from "./mind.js";
import {
    CHECKPOINT_MS,
    LIKE_STEP,
    PersonalityLearner,
    TRAIT_KEYS,
    TRAIT_STEP,
    defaultPersonalityState,
    defaultTraits,
    normaliseState,
    traitsToPersonality,
    type PersonalityState,
} from "./personality.js";
import type { AnchorId } from "./roam.js";

const NEUTRAL: PersonalityState = { traits: { openness: 0.5, conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5, neuroticism: 0.5 }, likes: {}, sessions: 0 };

describe("personality traits", () => {
    it("species defaults are plausible (parrot extravert, cat introvert and less agreeable)", () => {
        expect(defaultTraits("parrot").extraversion).toBeGreaterThan(defaultTraits("cat").extraversion);
        expect(defaultTraits("parrot").openness).toBeGreaterThan(0.6);
        expect(defaultTraits("cat").agreeableness).toBeLessThan(defaultTraits("redpanda").agreeableness);
    });

    it("species traits leave the species temperament unchanged", () => {
        const p = traitsToPersonality(PERSONALITIES.cat, defaultPersonalityState("cat"), defaultTraits("cat"));
        expect(p.weights.sleep).toBeCloseTo(PERSONALITIES.cat.weights.sleep ?? 1);
        expect(p.baseline).toEqual(PERSONALITIES.cat.baseline);
    });

    it("each trait moves the actions it should", () => {
        const base = PERSONALITIES.fox;
        const at = (k: (typeof TRAIT_KEYS)[number], v: number) => traitsToPersonality(base, { ...NEUTRAL, traits: { ...NEUTRAL.traits, [k]: v } });
        expect(at("extraversion", 1).weights.greetViewers ?? 1).toBeGreaterThan(at("extraversion", 0).weights.greetViewers ?? 1);
        expect(at("extraversion", 1).baseline.arousal).toBeGreaterThan(at("extraversion", 0).baseline.arousal);
        expect(at("agreeableness", 1).weights.landOnHand ?? 1).toBeGreaterThan(at("agreeableness", 0).weights.landOnHand ?? 1);
        expect(at("openness", 1).weights.orbit ?? 1).toBeGreaterThan(at("openness", 0).weights.orbit ?? 1);
        expect(at("openness", 1).drift.curiosity ?? 0).toBeGreaterThan(at("openness", 0).drift.curiosity ?? 0);
        expect(at("conscientiousness", 1).weights.sleep ?? 1).toBeLessThan(at("conscientiousness", 0).weights.sleep ?? 1);
        expect(at("conscientiousness", 1).momentum ?? 1).toBeGreaterThan(at("conscientiousness", 0).momentum ?? 1);
        expect(at("neuroticism", 1).startle ?? 1).toBeGreaterThan(at("neuroticism", 0).startle ?? 1);
        expect(at("neuroticism", 1).baseline.valence).toBeLessThan(at("neuroticism", 0).baseline.valence);
    });

    it("likes multiply action weights", () => {
        const p = traitsToPersonality(PERSONALITIES.fox, { ...NEUTRAL, likes: { orbit: 1.5 } });
        const q = traitsToPersonality(PERSONALITIES.fox, NEUTRAL);
        expect((p.weights.orbit ?? 1) / (q.weights.orbit ?? 1)).toBeCloseTo(1.5);
    });

    it("normalises untrusted state", () => {
        const s = normaliseState({ traits: { ...NEUTRAL.traits, openness: 7, neuroticism: Number.NaN }, likes: { orbit: 9, sleep: 0.1 }, sessions: -3 });
        expect(s.traits.openness).toBe(1);
        expect(s.traits.neuroticism).toBe(0.5);
        expect(s.likes).toEqual({ orbit: 1.6, sleep: 0.6 });
        expect(s.sessions).toBe(0);
    });
});

describe("PersonalityLearner", () => {
    function social(l: PersonalityLearner) {
        for (let i = 0; i < 60; i++) {
            l.stimulus("gift");
            l.stimulus("petted");
            l.stimulus("heart");
        }
        for (let i = 0; i < 1800; i++) l.observe("landOnHand", 1, 0.8);
        for (let i = 0; i < 600; i++) l.observe("sleep", 1, -0.6);
    }

    it("is deterministic", () => {
        const a = new PersonalityLearner(NEUTRAL);
        const b = new PersonalityLearner(NEUTRAL);
        social(a);
        social(b);
        expect(a.endSession()).toEqual(b.endSession());
    });

    it("drifts traits by at most 0.02 and likes by at most 0.05 per session, toward experience", () => {
        const l = new PersonalityLearner(NEUTRAL);
        social(l);
        const s = l.endSession();
        expect(s.sessions).toBe(1);
        for (const k of TRAIT_KEYS) expect(Math.abs(s.traits[k] - NEUTRAL.traits[k])).toBeLessThanOrEqual(TRAIT_STEP + 1e-9);
        expect(s.traits.agreeableness).toBeCloseTo(0.5 + TRAIT_STEP);
        expect(s.traits.extraversion).toBeGreaterThan(0.5);
        expect(s.likes.landOnHand).toBeCloseTo(1 + LIKE_STEP);
        expect(s.likes.sleep).toBeCloseTo(1 - LIKE_STEP);
    });

    it("clamps traits to 0..1 and likes to 0.6..1.6 over many sessions", () => {
        const l = new PersonalityLearner(NEUTRAL);
        let s = NEUTRAL;
        for (let i = 0; i < 200; i++) {
            for (let k = 0; k < 600; k++) l.observe("orbit", 1, 1);
            s = l.endSession();
        }
        expect(s.likes.orbit).toBeLessThanOrEqual(1.6);
        expect(s.likes.orbit).toBeGreaterThan(1.5);
        for (const k of TRAIT_KEYS) {
            expect(s.traits[k]).toBeGreaterThanOrEqual(0);
            expect(s.traits[k]).toBeLessThanOrEqual(1);
        }
        expect(s.sessions).toBe(200);
    });

    it("an empty session changes nothing but the count", () => {
        const l = new PersonalityLearner(NEUTRAL);
        const s = l.endSession();
        expect(s.traits).toEqual(NEUTRAL.traits);
        expect(s.likes).toEqual({});
    });

    it("checkpoints every 10 min with drift scaled by the session fraction, never exceeding a full session", () => {
        const l = new PersonalityLearner(NEUTRAL, 0);
        for (let i = 0; i < 300; i++) l.observe("orbit", 1, 1);
        expect(l.checkpoint(CHECKPOINT_MS - 1)).toBeNull();
        for (let i = 0; i < 300; i++) l.observe("orbit", 1, 1);
        const c = l.checkpoint(CHECKPOINT_MS);
        expect(c).not.toBeNull();
        // 10 min of a 60 min reference session: 1/6 of the like step.
        expect(c?.likes.orbit).toBeCloseTo(1 + LIKE_STEP / 6);
        expect(c?.sessions).toBe(0);
        for (let i = 0; i < 6000; i++) l.observe("orbit", 1, 1);
        const end = l.endSession();
        expect(end.likes.orbit).toBeLessThanOrEqual(1 + LIKE_STEP + 1e-9);
        expect(end.likes.orbit).toBeCloseTo(1 + LIKE_STEP);
    });
});

describe("PetMind personality + chatter", () => {
    it("loads a personality and exposes it for saving", () => {
        const state: PersonalityState = { ...defaultPersonalityState("owl"), likes: { perchHead: 1.4 }, sessions: 3 };
        const m = new PetMind("owl", "left", 1, { personality: state });
        expect(m.personalityState.sessions).toBe(3);
        expect(m.personality.weights.perchHead ?? 1).toBeCloseTo((PERSONALITIES.owl.weights.perchHead ?? 1) * 1.4);
        m.setPersonality(defaultPersonalityState("owl"));
        expect(m.personality.weights.perchHead).toBeCloseTo(PERSONALITIES.owl.weights.perchHead ?? 1);
    });

    it("grabbed counts as petted for learning; the session drifts agreeableness up", () => {
        const m = new PetMind("cat", "left", 1);
        for (let i = 0; i < 50; i++) m.stimulus({ kind: "grabbed" });
        const before = m.personalityState.traits.agreeableness;
        expect(m.endSession().traits.agreeableness).toBeGreaterThan(before);
    });

    it("an extravert with an attention need eventually wants to chatter, and consumeChatter ends it", () => {
        const m = new PetMind("parrot", "left", 11, { personality: { ...defaultPersonalityState("parrot"), likes: { chatter: 1.6 } } });
        m.needs.attention = 1;
        let at = -1;
        const ctx = (t: number) => ({
            nowMs: t,
            family: "bird" as const,
            available: new Set<AnchorId>(["ledgeL", "ledgeR"]),
            ownerPresent: false,
            palmUp: false,
            cohostSpeaking: false,
            ownerTalking: false,
            chatActivity: 0.3,
            otherPet: null,
            spotlight: false,
            pointActive: false,
        });
        for (let t = 0; t < 60_000 && at < 0; t += 200) {
            m.needs.attention = 1;
            if (m.tick(ctx(t), true).action === "chatter") at = t;
        }
        expect(at).toBeGreaterThanOrEqual(0);
        m.consumeChatter(at);
        expect(m.decision).toBeNull();
        expect(m.tick(ctx(at + 200), true).action).not.toBe("chatter");
    });
});
