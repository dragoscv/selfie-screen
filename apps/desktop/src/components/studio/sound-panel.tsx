import { listen } from "@tauri-apps/api/event";
import { load } from "@tauri-apps/plugin-store";
import { parseSettings, VOICES, type AudioSettings, type VoiceSettings } from "@tiksee/core";
import { ChipSelector, SliderRow, SwitchRow } from "@tiksee/ui";
import { Play, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { listAudioDevices, requestDeviceAccess, type AudioDeviceList } from "../../lib/audio/devices.js";
import { sidecarClient } from "../../lib/sidecar-client.js";
import { FOCUS_RING, useStudio } from "./context.js";
import { ActionButton, Section } from "./controls-parts.js";

/**
 * Studio dock Sound panel (lazy chunk): output/input device, co-host volume, ducking, voice,
 * speed and pitch, and each pet's own voice, speed and pitch with an audition button.
 *
 * The main window owns playback and the mic, so edits go through the settings store
 * (`patchSound` → `studio://patch`) and come back as `studio://sound`.
 */

interface Sound {
    voice: VoiceSettings;
    audio: AudioSettings;
}

const PET_VOICE_DEFAULT = "default";
const PET_VOICES = [PET_VOICE_DEFAULT, ...VOICES] as const;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const times = (v: number) => `${v.toFixed(2)}×`;

function useSound(): [Sound | null, (next: Sound) => void] {
    const [sound, setSound] = useState<Sound | null>(null);
    useEffect(() => {
        let disposed = false;
        let stop: (() => void) | undefined;
        void load("settings.json", { autoSave: false })
            .then((store) => store.get("settings"))
            .then((raw) => {
                const s = parseSettings(raw);
                if (!disposed) setSound((cur) => cur ?? { voice: s.voice, audio: s.audio });
            })
            .catch(() => undefined);
        void listen<Sound>("studio://sound", (e) => setSound(e.payload))
            .then((u) => (disposed ? u() : (stop = u)))
            .catch(() => undefined);
        return () => {
            disposed = true;
            stop?.();
        };
    }, []);
    return [sound, setSound];
}

function DeviceSelect({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
    const id = useId();
    return (
        <div className="space-y-1">
            <label htmlFor={id} className="block text-[0.8125rem] text-white/80">
                {label}
            </label>
            <select
                id={id}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className={`w-full truncate rounded-xl border border-white/15 bg-neutral-900/80 px-2.5 py-1.5 text-xs text-white ${FOCUS_RING}`}
            >
                {options.map((o) => (
                    <option key={o.value} value={o.value}>
                        {o.label}
                    </option>
                ))}
            </select>
        </div>
    );
}

function Devices({ sound, patch }: { sound: Sound; patch: (p: Partial<AudioSettings>) => void }) {
    const { t } = useTranslation();
    const [devices, setDevices] = useState<AudioDeviceList | null>(null);
    const refresh = useCallback(() => {
        void listAudioDevices()
            .then(setDevices)
            .catch(() => setDevices({ inputs: [], outputs: [], labelled: false }));
    }, []);
    useEffect(() => {
        refresh();
        const media = navigator.mediaDevices;
        media.addEventListener("devicechange", refresh);
        return () => media.removeEventListener("devicechange", refresh);
    }, [refresh]);

    const name = (label: string, i: number) => label || t("studio.sound.unnamed", { n: i + 1 });
    const list = (items: { deviceId: string; label: string }[], current: string) => [
        { value: "", label: t("studio.sound.systemDefault") },
        ...(current !== "" && devices !== null && !items.some((d) => d.deviceId === current) ? [{ value: current, label: t("studio.sound.missing") }] : []),
        ...items.map((d, i) => ({ value: d.deviceId, label: name(d.label, i) })),
    ];

    return (
        <Section title={t("studio.sound.devices")}>
            {devices !== null && !devices.labelled && (
                <ActionButton icon={<RefreshCw className="size-4" aria-hidden />} label={t("studio.sound.allow")} onClick={() => void requestDeviceAccess().then(refresh).catch(() => undefined)} />
            )}
            <DeviceSelect label={t("studio.sound.output")} value={sound.audio.outputDeviceId} options={list(devices?.outputs ?? [], sound.audio.outputDeviceId)} onChange={(outputDeviceId) => patch({ outputDeviceId })} />
            <DeviceSelect label={t("studio.sound.input")} value={sound.audio.inputDeviceId} options={list(devices?.inputs ?? [], sound.audio.inputDeviceId)} onChange={(inputDeviceId) => patch({ inputDeviceId })} />
        </Section>
    );
}

function PetVoice({ pet, sample }: { pet: string; sample: string }) {
    const { studio, patchStudio } = useStudio();
    const { t } = useTranslation();
    const ai = studio.petAi;
    const voice = ai.voices[pet] ?? PET_VOICE_DEFAULT;
    const prosody = ai.prosody[pet] ?? { speed: 1, pitch: 1 };
    const setProsody = (p: Partial<typeof prosody>) => patchStudio({ petAi: { ...ai, prosody: { ...ai.prosody, [pet]: { ...prosody, ...p } } } });
    const setVoice = (v: (typeof PET_VOICES)[number]) => {
        const voices = { ...ai.voices };
        if (v === PET_VOICE_DEFAULT) delete voices[pet];
        else voices[pet] = v;
        patchStudio({ petAi: { ...ai, voices } });
    };
    const petName = t(`studio.pets.${pet}`, { defaultValue: pet });
    return (
        <div className="space-y-2 rounded-2xl bg-white/5 p-2.5">
            <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold">{petName}</h3>
                <button
                    type="button"
                    onClick={() => sidecarClient.send({ type: "speak", text: sample, ...(ai.voices[pet] ? { voice: ai.voices[pet] } : {}), speed: prosody.speed, pitch: prosody.pitch })}
                    aria-label={t("studio.sound.testPet", { name: petName })}
                    className={`flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[0.6875rem] hover:bg-white/20 ${FOCUS_RING}`}
                >
                    <Play className="size-3" aria-hidden />
                    {t("studio.sound.test")}
                </button>
            </div>
            <ChipSelector label={t("studio.sound.voice")} options={PET_VOICES} value={voice} onSelect={setVoice} display={(v) => t(`studio.sound.voices.${v}`)} />
            <SliderRow label={t("studio.sound.speed")} value={prosody.speed} min={0.5} max={1.5} step={0.05} format={times} onCommit={(speed) => setProsody({ speed })} />
            <SliderRow label={t("studio.sound.pitch")} value={prosody.pitch} min={0.6} max={1.6} step={0.05} format={times} onCommit={(pitch) => setProsody({ pitch })} />
        </div>
    );
}

export function SoundPanel() {
    const { studio, patchStudio, patchSound } = useStudio();
    const { t } = useTranslation();
    const [sound, setSound] = useSound();
    const ai = studio.petAi;
    const pets = [studio.leftPet, studio.rightPet].filter((p, i, a) => p !== "none" && a.indexOf(p) === i);

    if (!sound) return <div className="h-40" aria-busy />;

    // Optimistic: the main window confirms with studio://sound.
    const voice = (p: Partial<VoiceSettings>) => {
        setSound({ ...sound, voice: { ...sound.voice, ...p } });
        patchSound({ voice: p });
    };
    const audio = (p: Partial<AudioSettings>) => {
        setSound({ ...sound, audio: { ...sound.audio, ...p } });
        patchSound({ audio: p });
    };

    return (
        <>
            <Devices sound={sound} patch={audio} />
            <Section title={t("studio.sound.cohost")}>
                <SwitchRow label={t("studio.sound.voiceOn")} checked={sound.voice.enabled} onChange={(enabled) => voice({ enabled })} />
                <SliderRow label={t("studio.sound.volume")} value={sound.voice.volume} min={0} max={1} step={0.05} format={pct} onCommit={(volume) => voice({ volume })} />
                <SliderRow
                    label={t("studio.sound.duck")}
                    value={sound.audio.duckTo}
                    min={0}
                    max={1}
                    step={0.05}
                    format={(v) => (v >= 0.99 ? t("studio.common.off") : pct(v))}
                    onCommit={(duckTo) => audio({ duckTo })}
                />
                <ChipSelector label={t("studio.sound.voice")} options={VOICES} value={sound.voice.voice} onSelect={(v) => voice({ voice: v })} display={(v) => t(`studio.sound.voices.${v}`)} />
                <SliderRow label={t("studio.sound.speed")} value={sound.voice.speed} min={0.5} max={1.5} step={0.05} format={times} onCommit={(speed) => voice({ speed })} />
                <SliderRow label={t("studio.sound.pitch")} value={sound.voice.pitch} min={0.6} max={1.4} step={0.05} format={times} onCommit={(pitch) => voice({ pitch })} />
                <ActionButton icon={<Play className="size-4" aria-hidden />} label={t("studio.sound.testCohost")} onClick={() => sidecarClient.send({ type: "speak", text: t("studio.sound.sampleCohost") })} />
            </Section>
            <Section title={t("studio.sound.pets")}>
                <SwitchRow label={t("studio.sound.petVoice")} description={t("studio.sound.petVoiceHint")} checked={ai.voice} onChange={(on) => patchStudio({ petAi: { ...ai, voice: on } })} />
                {pets.length === 0 ? (
                    <p className="text-[0.6875rem] text-white/70">{t("studio.sound.noPets")}</p>
                ) : (
                    pets.map((pet) => <PetVoice key={pet} pet={pet} sample={t("studio.sound.samplePet")} />)
                )}
            </Section>
        </>
    );
}
