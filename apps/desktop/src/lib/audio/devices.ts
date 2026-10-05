export interface AudioDevice {
    deviceId: string;
    label: string;
}

export interface AudioDeviceList {
    inputs: AudioDevice[];
    outputs: AudioDevice[];
    /** Labels are empty until the user has granted microphone access once. */
    labelled: boolean;
}

/** Voicemeeter's virtual inputs let the co-host voice sit on its own mixer strip. */
export function isVoicemeeter(label: string): boolean {
    return /voicemeeter/i.test(label);
}

export async function listAudioDevices(): Promise<AudioDeviceList> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const pick = (kind: MediaDeviceKind) =>
        devices
            // "default"/"communications" are aliases of real devices; "" already means default.
            .filter((d) => d.kind === kind && d.deviceId !== "" && d.deviceId !== "default" && d.deviceId !== "communications")
            .map((d) => ({ deviceId: d.deviceId, label: d.label }));
    return {
        inputs: pick("audioinput"),
        outputs: pick("audiooutput"),
        labelled: devices.some((d) => d.label !== ""),
    };
}

/** Ask for microphone access once so device labels become readable. */
export async function requestDeviceAccess(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
}
