import type { LiveControlState } from "@tiksee/core";

export type GateBlock = "muted" | "shopMode" | "repliesPaused" | "speaking" | "streamerTalking" | "voiceOff";

export interface GateInput {
    control: LiveControlState;
    /** Epoch ms of the last streamer transcript frame; 0 if none. */
    lastTranscriptAt: number;
    quietAfterStreamerMs: number;
    voiceEnabled: boolean;
    now: number;
}

/**
 * Whether a `say` may be sent right now. Pure, so every rule is unit-tested:
 * never while muted / Shop LIVE / replies paused, never over another
 * utterance, never within the quiet window after the streamer's last word.
 */
export function speakBlock(input: GateInput): GateBlock | null {
    if (!input.voiceEnabled) return "voiceOff";
    if (input.control.shopMode) return "shopMode";
    if (input.control.muted) return "muted";
    if (input.control.repliesPaused) return "repliesPaused";
    if (input.control.speakingId !== undefined) return "speaking";
    if (input.lastTranscriptAt > 0 && input.now - input.lastTranscriptAt < input.quietAfterStreamerMs) {
        return "streamerTalking";
    }
    return null;
}
