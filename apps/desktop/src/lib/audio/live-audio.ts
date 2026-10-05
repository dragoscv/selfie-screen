import type { LiveControlState, ServerMessage, Settings } from "@tiksee/core";

import { useAppStore } from "../../store/app-store.js";
import { sidecarClient } from "../sidecar-client.js";
import type { Mic } from "./mic.js";
import type { Speaker, Utterance } from "./speaker.js";

/**
 * Glue between the sidecar's speech/transcript protocol and the lazily
 * loaded audio engines. This module is tiny on purpose: `speaker.ts` and
 * `mic.ts` are only fetched once the voice or transcription is enabled, so
 * they stay out of the entry bundle.
 */

interface AudioInputs {
    settings: Settings;
    control: LiveControlState;
}

function voiceActive({ settings, control }: AudioInputs): boolean {
    // TikTok Shop LIVE forbids AI voices outright.
    return settings.voice.enabled && settings.voice.engine !== "off" && !control.shopMode;
}

class LiveAudio {
    #inputs: AudioInputs | null = null;
    #speaker: Speaker | null = null;
    #speakerLoading: Promise<Speaker> | null = null;
    #mic: Mic | null = null;
    #micLoading = false;
    #offMessage: (() => void) | null = null;
    #generation = 0;

    attach(): () => void {
        this.#offMessage ??= sidecarClient.onMessage((message) => this.#onMessage(message));
        return () => {
            this.#offMessage?.();
            this.#offMessage = null;
            this.#generation++;
            this.#speaker?.dispose();
            this.#speaker = null;
            this.#speakerLoading = null;
            this.#mic?.dispose();
            this.#mic = null;
            this.#micLoading = false;
        };
    }

    update(inputs: AudioInputs): void {
        this.#inputs = inputs;
        const { settings } = inputs;
        const config = { voice: settings.voice, audio: settings.audio, codai: settings.codai };

        if (voiceActive(inputs)) {
            this.#speaker?.configure(config);
        } else if (this.#speaker) {
            this.#speaker.cancelAll();
        }

        if (settings.assistant.transcribe) {
            this.#mic?.configure({ assistant: settings.assistant, audio: settings.audio, codai: settings.codai });
            if (!this.#mic && !this.#micLoading) void this.#startMic();
        } else if (this.#mic || this.#micLoading) {
            this.#mic?.dispose();
            this.#mic = null;
            this.#micLoading = false;
            this.#generation++;
            useAppStore.getState().patchTranscript({ mic: "off", speaking: false, error: null, partial: "" });
        }
    }

    setPushToTalk(active: boolean): void {
        this.#mic?.setPushToTalk(active);
        useAppStore.getState().patchTranscript({ pushToTalk: active });
    }

    #onMessage(message: ServerMessage): void {
        if (message.type === "say") {
            const utterance: Utterance = {
                id: message.id,
                text: message.text,
                voice: message.voice,
                ...(message.eventId !== undefined ? { eventId: message.eventId } : {}),
            };
            void this.#say(utterance);
        } else if (message.type === "sayCancel") {
            this.#speaker?.cancel(message.id);
        }
    }

    async #say(utterance: Utterance): Promise<void> {
        const inputs = this.#inputs;
        if (!inputs || !voiceActive(inputs)) {
            sidecarClient.send({ type: "sayState", id: utterance.id, state: "error", error: "voice disabled" });
            return;
        }
        try {
            const speaker = await this.#loadSpeaker();
            speaker.say(utterance);
        } catch (error) {
            sidecarClient.send({
                type: "sayState",
                id: utterance.id,
                state: "error",
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    #loadSpeaker(): Promise<Speaker> {
        if (this.#speaker) return Promise.resolve(this.#speaker);
        this.#speakerLoading ??= import("./speaker.js").then(({ Speaker }) => {
            const settings = this.#inputs?.settings ?? useAppStore.getState().settings;
            const speaker = new Speaker(
                { voice: settings.voice, audio: settings.audio, codai: settings.codai },
                {
                    onState: (id, state, error) =>
                        sidecarClient.send({
                            type: "sayState",
                            id,
                            state,
                            ...(error !== undefined ? { error } : {}),
                        }),
                    onTimeline: (id, visemes, words) =>
                        sidecarClient.send({ type: "speechTimeline", id, visemes, words }),
                    onSpeaking: (u) =>
                        useAppStore
                            .getState()
                            .setSpeaking(u ? { id: u.id, text: u.text, ...(u.eventId !== undefined ? { eventId: u.eventId } : {}) } : null),
                },
            );
            speaker.setDucked(useAppStore.getState().transcript.speaking);
            this.#speaker = speaker;
            return speaker;
        });
        return this.#speakerLoading;
    }

    async #startMic(): Promise<void> {
        this.#micLoading = true;
        const generation = this.#generation;
        const { Mic } = await import("./mic.js");
        const settings = this.#inputs?.settings;
        if (generation !== this.#generation || !settings?.assistant.transcribe) return;
        const store = useAppStore.getState();
        const mic = new Mic(
            { assistant: settings.assistant, audio: settings.audio, codai: settings.codai },
            {
                onPhase: (phase, error) =>
                    useAppStore.getState().patchTranscript({ mic: phase, error: error ?? null }),
                onSpeaking: (speaking) => {
                    useAppStore.getState().patchTranscript({ speaking });
                    this.#speaker?.setDucked(speaking);
                },
                onPartial: (itemId, text) => {
                    useAppStore.getState().patchTranscript({ partial: text });
                    sidecarClient.send({ type: "transcript", itemId, text, final: false, at: Date.now() });
                },
                onFinal: (itemId, text) => {
                    const at = Date.now();
                    useAppStore.getState().addTranscriptFinal({ itemId, text, at });
                    sidecarClient.send({ type: "transcript", itemId, text, final: true, at });
                },
            },
        );
        mic.setPushToTalk(store.transcript.pushToTalk);
        this.#mic = mic;
        this.#micLoading = false;
        await mic.start();
    }
}

export const liveAudio = new LiveAudio();
