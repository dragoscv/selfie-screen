/** The server TTS speed range (codai `speed`, same as voice.speed in settings). */
export const SERVER_SPEED_MIN = 0.5;
export const SERVER_SPEED_MAX = 1.5;

export interface ProsodyPlan {
    /** `speed` sent to the TTS server. */
    serverSpeed: number;
    /** WebAudio playbackRate: raises/lowers pitch AND tempo by the same factor. */
    rate: number;
}

/**
 * Pitch without changing tempo: playbackRate = pitch shifts both, so the server is asked
 * for speed / pitch and playback speeds it back up (net tempo = speed). When speed / pitch
 * falls outside the server range the server speed is clamped and the tempo follows the clamp.
 */
export function prosodyPlan(speed: number, pitch: number): ProsodyPlan {
    const rate = Number.isFinite(pitch) && pitch > 0 ? pitch : 1;
    const wanted = (Number.isFinite(speed) && speed > 0 ? speed : 1) / rate;
    const serverSpeed = Math.round(Math.min(SERVER_SPEED_MAX, Math.max(SERVER_SPEED_MIN, wanted)) * 1000) / 1000;
    return { serverSpeed, rate };
}
