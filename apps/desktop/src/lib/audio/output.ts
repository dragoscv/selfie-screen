/** `setSinkId` is Chromium-only; typed loosely so older DOM libs still compile. */
type SinkCapable = { setSinkId?: (sinkId: string) => Promise<void> };

/**
 * Route an AudioContext to an output device ("" = system default).
 * Returns false when the runtime cannot pick a device or the id is gone
 * (unplugged Voicemeeter strip) — playback then stays on the default.
 */
export async function applySink(target: AudioContext | HTMLMediaElement, deviceId: string): Promise<boolean> {
    const sinkable = target as unknown as SinkCapable;
    if (typeof sinkable.setSinkId !== "function") return deviceId === "";
    try {
        await sinkable.setSinkId(deviceId);
        return true;
    } catch (error) {
        console.error("[audio] setSinkId failed", error);
        return false;
    }
}
