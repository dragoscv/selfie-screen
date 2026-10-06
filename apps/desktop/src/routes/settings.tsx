import {
    ACCENT_PRESETS,
    CAMERA_ROTATIONS,
    DENSITIES,
    FLASH_COLORS,
    GUIDE_KINDS,
    LOCALES,
    OVERLAY_LAYOUTS,
    PEAKING_COLORS,
    PET_CHOICES,
    PET_STYLES,
    SCOPE_KINDS,
    SPEECH_ENGINES,
    SPEECH_LANGUAGES,
    STUDIO_ORIENTATIONS,
    STREAM_SCENES,
    SURFACE_MODES,
    THEME_MODES,
    VOICES,
    type AccentPreset,
    type Settings,
} from "@tiksee/core";
import {
    ACCENT_LABELS,
    Button,
    Card,
    ChipSelector,
    Reveal,
    SliderRow,
    StatusPill,
    SwitchRow,
    TextInput,
    accentSwatch,
    cn,
} from "@tiksee/ui";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import {
    Bell,
    Cable,
    Camera,
    Copy,
    Dices,
    Eye,
    Gauge,
    Headphones,
    KeyRound,
    Languages,
    Layers,
    Lightbulb,
    Mic,
    MonitorSmartphone,
    Palette,
    Play,
    Plus,
    Shield,
    Sparkles,
    Target,
    Trash2,
    Video,
    Volume2,
    Zap,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { CameraRemote } from "../components/camera-remote.js";
import { CameraUsb } from "../components/camera-usb.js";
import { useSettingsUpdate } from "../hooks/use-settings.js";
import { isVoicemeeter, listAudioDevices, requestDeviceAccess, type AudioDeviceList } from "../lib/audio/devices.js";
import { acceleratorKey, isValidAccelerator } from "../lib/hotkeys.js";
import { sidecarClient } from "../lib/sidecar-client.js";
import { useAppStore } from "../store/app-store.js";
import { ChipToggleGroup, NumberField, SelectField } from "./settings-fields.js";

const SECTIONS = [
    { id: "appearance", icon: Palette },
    { id: "voice", icon: Volume2 },
    { id: "audio", icon: Headphones },
    { id: "filters", icon: Mic },
    { id: "assistant", icon: Sparkles },
    { id: "codai", icon: KeyRound },
    { id: "effects", icon: Lightbulb },
    { id: "interactive", icon: Target },
    { id: "studio", icon: Camera },
    { id: "safety", icon: Shield },
    { id: "display", icon: Eye },
    { id: "overlay", icon: Layers },
    { id: "obs", icon: Video },
    { id: "panel", icon: MonitorSmartphone },
    { id: "alerts", icon: Bell },
    { id: "behaviour", icon: Gauge },
    { id: "data", icon: Cable },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export function SettingsRoute() {
    const { t } = useTranslation();
    const [section, setSection] = useState<SectionId>("appearance");

    return (
        <div className="flex h-full min-h-0">
            <nav
                className="w-52 shrink-0 overflow-y-auto border-r border-border/60 p-2"
                aria-label={t("settings.title")}
            >
                {SECTIONS.map(({ id, icon: Icon }) => (
                    <button
                        key={id}
                        type="button"
                        onClick={() => setSection(id)}
                        aria-current={section === id ? "page" : undefined}
                        className={cn(
                            "no-drag mb-0.5 flex w-full items-center gap-2.5 rounded-chip px-3 py-2",
                            "text-left text-[0.8125rem] outline-none transition-colors duration-(--dur-fast)",
                            "focus-visible:ring-2 focus-visible:ring-ring",
                            section === id
                                ? "bg-accent-subtle font-semibold text-accent"
                                : "text-fg-muted hover:bg-panel-alt hover:text-fg",
                        )}
                    >
                        <Icon className="size-4 shrink-0" />
                        <span className="truncate">{t(`settings.sections.${id}`)}</span>
                    </button>
                ))}
            </nav>

            <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="measure-wide mx-auto flex flex-col gap-5 px-6 py-6">
                    {section === "appearance" && <AppearanceSection />}
                    {section === "voice" && <VoiceSection />}
                    {section === "audio" && <AudioSection />}
                    {section === "filters" && <FiltersSection />}
                    {section === "assistant" && <AssistantSection />}
                    {section === "codai" && <CodaiSection />}
                    {section === "effects" && <EffectsSection />}
                    {section === "interactive" && <InteractiveSection />}
                    {section === "studio" && <StudioSection />}
                    {section === "safety" && <SafetySection />}
                    {section === "display" && <DisplaySection />}
                    {section === "overlay" && <OverlaySection />}
                    {section === "obs" && <ObsSection />}
                    {section === "panel" && <PanelSection />}
                    {section === "alerts" && <AlertsSection />}
                    {section === "behaviour" && <BehaviourSection />}
                    {section === "data" && <DataSection />}
                </div>
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ */

function AppearanceSection() {
    const { t } = useTranslation();
    const update = useSettingsUpdate();
    const a = useAppStore((s) => s.settings.appearance);
    const custom = a.customAccentHue !== undefined;

    return (
        <>
            <Card title={t("settings.appearance.theme")} subtitle={t("settings.appearance.themeHint")} icon={<Palette />}>
                <ChipSelector
                    options={THEME_MODES}
                    value={a.mode}
                    onSelect={(mode) => update("appearance", { mode })}
                    display={(mode) => t(`settings.appearance.mode.${mode}`)}
                />
            </Card>

            <Card
                title={t("settings.appearance.accent")}
                subtitle={t("settings.appearance.accentHint")}
                icon={<Palette />}
                tint="var(--accent)"
            >
                <div className="flex flex-wrap gap-2">
                    {ACCENT_PRESETS.map((preset: AccentPreset) => {
                        const selected = !custom && a.accent === preset;
                        return (
                            <button
                                key={preset}
                                type="button"
                                onClick={() =>
                                    update("appearance", {
                                        accent: preset,
                                        customAccentHue: undefined,
                                        customAccentChroma: undefined,
                                    })
                                }
                                aria-pressed={selected}
                                title={ACCENT_LABELS[preset]}
                                className={cn(
                                    "no-drag grid size-9 place-items-center rounded-full outline-none",
                                    "transition-transform duration-(--dur-fast) hover:scale-110",
                                    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                                )}
                                style={{
                                    background: accentSwatch(preset),
                                    boxShadow: selected ? "0 0 0 2px var(--bg), 0 0 0 4px var(--accent)" : undefined,
                                }}
                            >
                                <span className="sr-only">{ACCENT_LABELS[preset]}</span>
                            </button>
                        );
                    })}
                    <button
                        type="button"
                        onClick={() =>
                            update("appearance", {
                                customAccentHue: custom ? undefined : 300,
                                customAccentChroma: custom ? undefined : 0.16,
                            })
                        }
                        aria-pressed={custom}
                        title={t("settings.appearance.customAccent")}
                        className={cn(
                            "no-drag grid size-9 place-items-center rounded-full text-xs font-bold outline-none",
                            "bg-[conic-gradient(from_0deg,oklch(0.7_0.18_0),oklch(0.7_0.18_120),oklch(0.7_0.18_240),oklch(0.7_0.18_360))]",
                            "transition-transform duration-(--dur-fast) hover:scale-110",
                            "focus-visible:ring-2 focus-visible:ring-ring",
                        )}
                        style={custom ? { boxShadow: "0 0 0 2px var(--bg), 0 0 0 4px var(--accent)" } : undefined}
                    >
                        <span className="sr-only">{t("settings.appearance.customAccent")}</span>
                    </button>
                </div>

                <Reveal show={custom}>
                    <SliderRow
                        label={t("settings.appearance.hue")}
                        value={a.customAccentHue ?? 300}
                        min={0}
                        max={360}
                        step={1}
                        format={(v) => `${Math.round(v)}°`}
                        onCommit={(customAccentHue) => update("appearance", { customAccentHue })}
                    />
                    <SliderRow
                        label={t("settings.appearance.chroma")}
                        value={a.customAccentChroma ?? 0.16}
                        min={0.02}
                        max={0.32}
                        step={0.005}
                        format={(v) => `${Math.round((v / 0.32) * 100)}%`}
                        onCommit={(customAccentChroma) => update("appearance", { customAccentChroma })}
                    />
                </Reveal>
            </Card>

            <Card title={t("settings.appearance.surface")} subtitle={t("settings.appearance.surfaceHint")} icon={<Layers />}>
                <ChipSelector
                    options={SURFACE_MODES}
                    value={a.surface}
                    onSelect={(surface) => update("appearance", { surface })}
                    display={(surface) => t(`settings.appearance.surfaces.${surface}`)}
                />
            </Card>

            <Card title={t("settings.appearance.language")} icon={<Languages />} tint="var(--kind-join)">
                <ChipSelector
                    options={LOCALES}
                    value={a.locale}
                    onSelect={(locale) => update("appearance", { locale })}
                    display={(locale) => t(`settings.appearance.languages.${locale}`)}
                    tint="var(--kind-join)"
                />
                <ChipSelector
                    label={t("settings.appearance.density")}
                    options={DENSITIES}
                    value={a.density}
                    onSelect={(density) => update("appearance", { density })}
                    display={(density) => t(`settings.appearance.densities.${density}`)}
                    tint="var(--kind-join)"
                />
                <SliderRow
                    label={t("settings.appearance.fontScale")}
                    value={a.fontScale}
                    min={0.8}
                    max={1.4}
                    step={0.05}
                    format={(v) => `${Math.round(v * 100)}%`}
                    onCommit={(fontScale) => update("appearance", { fontScale })}
                    tint="var(--kind-join)"
                />
                <SwitchRow
                    label={t("settings.appearance.reducedMotion")}
                    description={t("settings.appearance.reducedMotionHint")}
                    checked={a.reducedMotion}
                    onChange={(reducedMotion) => update("appearance", { reducedMotion })}
                    tint="var(--kind-join)"
                />
            </Card>
        </>
    );
}

/* ------------------------------------------------------------------ */

function VoiceSection() {
    const { t } = useTranslation();
    const update = useSettingsUpdate();
    const voice = useAppStore((s) => s.settings.voice);
    const shopMode = useAppStore((s) => s.liveControl.shopMode);
    const [systemVoices, setSystemVoices] = useState<SpeechSynthesisVoice[]>([]);

    useEffect(() => {
        const synth = window.speechSynthesis;
        if (voice.engine !== "system" || !synth) return;
        // Voices load asynchronously in Chromium; the first call is often empty.
        const load = () => setSystemVoices(synth.getVoices());
        load();
        synth.addEventListener("voiceschanged", load);
        return () => synth.removeEventListener("voiceschanged", load);
    }, [voice.engine]);

    const test = () => sidecarClient.send({ type: "speak", text: t("settings.voice.testPhrase") });

    return (
        <>
            <Card
                title={t("settings.sections.voice")}
                subtitle={t("settings.voice.enabledHint")}
                icon={<Volume2 />}
                actions={
                    <Button
                        size="sm"
                        variant="soft"
                        icon={<Play />}
                        onClick={test}
                        disabled={!voice.enabled || voice.engine === "off"}
                    >
                        {t("settings.voice.test")}
                    </Button>
                }
            >
                <SwitchRow
                    label={t("settings.voice.enabled")}
                    checked={voice.enabled}
                    onChange={(enabled) => update("voice", { enabled })}
                />
                <Reveal show={voice.enabled}>
                    <ChipSelector
                        label={t("settings.voice.engine")}
                        options={SPEECH_ENGINES}
                        value={voice.engine}
                        onSelect={(engine) => update("voice", { engine })}
                        display={(engine) => t(`settings.voice.engines.${engine}`)}
                    />
                    <p className="text-[0.6875rem] text-fg-muted">{t("settings.voice.engineHint")}</p>
                    {shopMode && (
                        <p className="rounded-chip bg-warning/12 px-3 py-2 text-xs text-warning" role="note">
                            {t("settings.voice.shopModeNote")}
                        </p>
                    )}
                </Reveal>
            </Card>

            <Reveal show={voice.enabled && voice.engine !== "off"}>
                <Card title={t("settings.voice.voice")} icon={<Mic />} tint="var(--kind-gift)">
                    {voice.engine === "codai" && (
                        <ChipSelector
                            options={VOICES}
                            value={voice.voice}
                            onSelect={(v) => update("voice", { voice: v })}
                            display={(v) => t(`settings.voice.voices.${v}`)}
                            tint="var(--kind-gift)"
                        />
                    )}
                    {voice.engine === "system" && (
                        <SelectField
                            label={t("settings.voice.systemVoice")}
                            value={voice.systemVoiceUri}
                            onChange={(systemVoiceUri) => update("voice", { systemVoiceUri })}
                            options={[
                                { value: "", label: t("settings.voice.systemVoiceAuto") },
                                ...systemVoices.map((v) => ({ value: v.voiceURI, label: `${v.name} (${v.lang})` })),
                            ]}
                        />
                    )}
                    <SliderRow
                        label={t("settings.voice.speed")}
                        value={voice.speed}
                        min={0.5}
                        max={1.5}
                        step={0.05}
                        format={(v) => `${v.toFixed(2)}×`}
                        onCommit={(speed) => update("voice", { speed })}
                        tint="var(--kind-gift)"
                    />
                    {voice.engine === "system" && (
                        <SliderRow
                            label={t("settings.voice.pitch")}
                            value={voice.pitch}
                            min={0.6}
                            max={1.4}
                            step={0.05}
                            format={(v) =>
                                v < 0.95
                                    ? t("settings.voice.pitchLower")
                                    : v > 1.05
                                        ? t("settings.voice.pitchHigher")
                                        : t("settings.voice.pitchNatural")
                            }
                            onCommit={(pitch) => update("voice", { pitch })}
                            tint="var(--kind-gift)"
                        />
                    )}
                    <SliderRow
                        label={t("settings.voice.volume")}
                        value={voice.volume}
                        min={0}
                        max={1}
                        step={0.05}
                        format={(v) => `${Math.round(v * 100)}%`}
                        onCommit={(volume) => update("voice", { volume })}
                        tint="var(--kind-gift)"
                    />
                    <ChipSelector
                        label={t("settings.voice.language")}
                        options={SPEECH_LANGUAGES}
                        value={voice.language}
                        onSelect={(language) => update("voice", { language })}
                        display={(l) => (l === "auto" ? t("settings.voice.languageAuto") : l.toUpperCase())}
                        tint="var(--kind-gift)"
                    />
                </Card>
            </Reveal>
        </>
    );
}

/* ------------------------------------------------------------------ */

function AudioSection() {
    const { t } = useTranslation();
    const update = useSettingsUpdate();
    const audio = useAppStore((s) => s.settings.audio);
    const [devices, setDevices] = useState<AudioDeviceList | null>(null);
    const [denied, setDenied] = useState(false);

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

    const grant = () => {
        void requestDeviceAccess()
            .then(() => {
                setDenied(false);
                refresh();
            })
            .catch(() => setDenied(true));
    };

    const label = (deviceLabel: string, index: number) => deviceLabel || t("settings.audio.unnamed", { n: index + 1 });
    const outputs = devices?.outputs ?? [];
    const inputs = devices?.inputs ?? [];
    const hasVoicemeeter = outputs.some((d) => isVoicemeeter(d.label));
    const outputMissing = audio.outputDeviceId !== "" && devices !== null && !outputs.some((d) => d.deviceId === audio.outputDeviceId);
    const inputMissing = audio.inputDeviceId !== "" && devices !== null && !inputs.some((d) => d.deviceId === audio.inputDeviceId);

    return (
        <>
            <Card
                title={t("settings.audio.devices")}
                subtitle={t("settings.audio.devicesHint")}
                icon={<Headphones />}
                tint="var(--kind-share)"
                actions={
                    <Button size="sm" variant="ghost" onClick={refresh}>
                        {t("settings.audio.refresh")}
                    </Button>
                }
            >
                {devices !== null && !devices.labelled && (
                    <div className="flex items-center gap-3 rounded-chip bg-panel-alt px-3 py-2.5">
                        <p className="min-w-0 flex-1 text-xs text-fg-muted">
                            {denied ? t("settings.audio.denied") : t("settings.audio.permission")}
                        </p>
                        <Button size="sm" variant="soft" onClick={grant}>
                            {t("settings.audio.allow")}
                        </Button>
                    </div>
                )}
                <SelectField
                    label={t("settings.audio.output")}
                    value={audio.outputDeviceId}
                    onChange={(outputDeviceId) => update("audio", { outputDeviceId })}
                    options={[
                        { value: "", label: t("settings.audio.systemDefault") },
                        ...(outputMissing ? [{ value: audio.outputDeviceId, label: t("settings.audio.missing") }] : []),
                        ...outputs.map((d, i) => ({ value: d.deviceId, label: label(d.label, i) })),
                    ]}
                    hint={hasVoicemeeter ? t("settings.audio.voicemeeterFound") : t("settings.audio.voicemeeterHint")}
                />
                <SelectField
                    label={t("settings.audio.input")}
                    value={audio.inputDeviceId}
                    onChange={(inputDeviceId) => update("audio", { inputDeviceId })}
                    options={[
                        { value: "", label: t("settings.audio.systemDefault") },
                        ...(inputMissing ? [{ value: audio.inputDeviceId, label: t("settings.audio.missing") }] : []),
                        ...inputs.map((d, i) => ({ value: d.deviceId, label: label(d.label, i) })),
                    ]}
                    hint={t("settings.audio.inputHint")}
                />
            </Card>

            <Card title={t("settings.audio.ducking")} subtitle={t("settings.audio.duckingHint")} icon={<Volume2 />} tint="var(--kind-share)">
                <SliderRow
                    label={t("settings.audio.duckTo")}
                    value={audio.duckTo}
                    min={0}
                    max={1}
                    step={0.05}
                    format={(v) => (v >= 0.99 ? t("settings.audio.duckOff") : `${Math.round(v * 100)}%`)}
                    onCommit={(duckTo) => update("audio", { duckTo })}
                    tint="var(--kind-share)"
                />
            </Card>
        </>
    );
}

/* ------------------------------------------------------------------ */

function FiltersSection() {
    const { t } = useTranslation();
    const update = useSettingsUpdate();
    const voice = useAppStore((s) => s.settings.voice);
    const safety = useAppStore((s) => s.settings.safety);
    const f = voice.filters;
    const setFilter = (patch: Partial<typeof f>) =>
        update("voice", { filters: { ...f, ...patch } });

    return (
        <>
            <Card title={t("settings.filters.title")} icon={<Mic />}>
                <SwitchRow label={t("settings.filters.chat")} checked={f.chat} onChange={(chat) => setFilter({ chat })} tint="var(--kind-chat)" />
                <SwitchRow label={t("settings.filters.gifts")} checked={f.gifts} onChange={(gifts) => setFilter({ gifts })} tint="var(--kind-gift)" />
                <SwitchRow label={t("settings.filters.follows")} checked={f.follows} onChange={(follows) => setFilter({ follows })} tint="var(--kind-follow)" />
                <SwitchRow label={t("settings.filters.shares")} checked={f.shares} onChange={(shares) => setFilter({ shares })} tint="var(--kind-share)" />
                <SwitchRow
                    label={t("settings.filters.joins")}
                    description={t("settings.filters.joinsHint")}
                    checked={f.joins}
                    onChange={(joins) => setFilter({ joins })}
                    tint="var(--kind-join)"
                />
                <SwitchRow
                    label={t("settings.filters.likes")}
                    description={t("settings.filters.likesHint")}
                    checked={f.likes}
                    onChange={(likes) => setFilter({ likes })}
                    tint="var(--kind-like)"
                />
            </Card>

            <Card title={t("settings.filters.style")} icon={<Sparkles />} tint="var(--kind-gift)">
                <SwitchRow
                    label={t("settings.filters.readUsernames")}
                    description={t("settings.filters.readUsernamesHint")}
                    checked={voice.readUsernames}
                    onChange={(readUsernames) => update("voice", { readUsernames })}
                    tint="var(--kind-gift)"
                />
                <SwitchRow
                    label={t("settings.filters.thankGifts")}
                    checked={safety.thankGifts}
                    onChange={(thankGifts) => update("safety", { thankGifts })}
                    tint="var(--kind-gift)"
                />
                <SwitchRow
                    label={t("settings.filters.greetReturning")}
                    checked={safety.greetReturningViewers}
                    onChange={(greetReturningViewers) => update("safety", { greetReturningViewers })}
                    tint="var(--kind-gift)"
                />
                <SwitchRow
                    label={t("settings.filters.skipDuplicates")}
                    checked={safety.skipDuplicates}
                    onChange={(skipDuplicates) => update("safety", { skipDuplicates })}
                    tint="var(--kind-gift)"
                />
                <SliderRow
                    label={t("settings.filters.minGift")}
                    value={voice.minGiftValueToRead}
                    min={0}
                    max={500}
                    step={1}
                    format={(v) => (v === 0 ? t("common.none") : `${Math.round(v)} 💎`)}
                    onCommit={(minGiftValueToRead) => update("voice", { minGiftValueToRead })}
                    tint="var(--kind-gift)"
                />
            </Card>
        </>
    );
}

/* ------------------------------------------------------------------ */

function AssistantSection() {
    const { t } = useTranslation();
    const update = useSettingsUpdate();
    const a = useAppStore((s) => s.settings.assistant);

    return (
        <>
            <Card title={t("settings.sections.assistant")} icon={<Sparkles />} tint="var(--kind-join)">
                <SwitchRow
                    label={t("settings.assistant.replies")}
                    description={t("settings.assistant.repliesHint")}
                    checked={a.aiReplies}
                    onChange={(aiReplies) => update("assistant", { aiReplies })}
                    tint="var(--kind-join)"
                />
                <Reveal show={a.aiReplies}>
                    <ChipSelector
                        label={t("settings.assistant.replyMode")}
                        options={["approve", "auto"] as const}
                        value={a.replyMode}
                        onSelect={(replyMode) => update("assistant", { replyMode })}
                        display={(m) => t(`replies.mode.${m}`)}
                        tint="var(--kind-join)"
                    />
                    <SliderRow
                        label={t("settings.assistant.repliesPerMinute")}
                        value={a.repliesPerMinute}
                        min={1}
                        max={20}
                        step={1}
                        format={(v) => t("settings.assistant.perMinute", { count: Math.round(v) })}
                        onCommit={(v) => update("assistant", { repliesPerMinute: Math.round(v) })}
                        tint="var(--kind-join)"
                    />
                    <SliderRow
                        label={t("settings.assistant.quietAfter")}
                        value={a.quietAfterStreamerMs / 1000}
                        min={0}
                        max={10}
                        step={0.5}
                        format={(v) => t("settings.assistant.secondsDecimal", { value: v.toFixed(1) })}
                        onCommit={(v) => update("assistant", { quietAfterStreamerMs: Math.round(v * 1000) })}
                        tint="var(--kind-join)"
                    />
                    <SwitchRow
                        label={t("settings.assistant.useSystemOne")}
                        description={t("settings.assistant.useSystemOneHint")}
                        checked={a.useSystemOne}
                        onChange={(useSystemOne) => update("assistant", { useSystemOne })}
                        tint="var(--kind-join)"
                    />
                </Reveal>
                <SwitchRow
                    label={t("settings.assistant.initiates")}
                    description={t("settings.assistant.initiatesHint")}
                    checked={a.aiInitiates}
                    onChange={(aiInitiates) => update("assistant", { aiInitiates })}
                    tint="var(--kind-join)"
                />
                <Reveal show={a.aiInitiates}>
                    <SliderRow
                        label={t("settings.assistant.idleAfter")}
                        value={a.idleChatterSeconds}
                        min={30}
                        max={600}
                        step={10}
                        format={(v) => `${Math.floor(v / 60)}m ${String(Math.round(v) % 60).padStart(2, "0")}s`}
                        onCommit={(idleChatterSeconds) => update("assistant", { idleChatterSeconds })}
                        tint="var(--kind-join)"
                    />
                </Reveal>
            </Card>

            <Card title={t("settings.assistant.listening")} subtitle={t("settings.assistant.listeningHint")} icon={<Mic />} tint="var(--kind-chat)">
                <SwitchRow
                    label={t("settings.assistant.transcribe")}
                    description={t("settings.assistant.transcribeHint")}
                    checked={a.transcribe}
                    onChange={(transcribe) => update("assistant", { transcribe })}
                    tint="var(--kind-chat)"
                />
                <SwitchRow
                    label={t("settings.assistant.pushToTalk")}
                    description={t("settings.assistant.pushToTalkHint")}
                    checked={a.pushToTalk}
                    onChange={(pushToTalk) => update("assistant", { pushToTalk })}
                    tint="var(--kind-chat)"
                    disabled={!a.transcribe}
                />
            </Card>

            <Card title={t("settings.assistant.persona")} icon={<Sparkles />} tint="var(--kind-follow)">
                <TextInput
                    label={t("settings.assistant.name")}
                    value={a.personaName}
                    onChange={(personaName) => update("assistant", { personaName })}
                    placeholder={t("settings.assistant.namePlaceholder")}
                />
                <TextInput
                    label={t("settings.assistant.personality")}
                    value={a.personality}
                    onChange={(personality) => update("assistant", { personality })}
                    placeholder={t("settings.assistant.personalityPlaceholder")}
                />
                <TextInput
                    label={t("settings.assistant.aboutMe")}
                    value={a.aboutMe}
                    onChange={(aboutMe) => update("assistant", { aboutMe })}
                    multiline
                    hint={t("settings.assistant.aboutMeHint")}
                />
            </Card>
        </>
    );
}

/* ------------------------------------------------------------------ */

const CODAI_KEY = "codai-api-key";
type KeyStatus = "unknown" | "stored" | "missing" | "unavailable";

function CodaiSection() {
    const { t } = useTranslation();
    const update = useSettingsUpdate();
    const codai = useAppStore((s) => s.settings.codai);
    const [status, setStatus] = useState<KeyStatus>("unknown");
    const [draft, setDraft] = useState("");

    const probe = useCallback(() => {
        void invoke<boolean>("secret_has", { key: CODAI_KEY })
            .then((has) => setStatus(has ? "stored" : "missing"))
            .catch(() => setStatus("unavailable"));
    }, []);

    useEffect(probe, [probe]);

    const save = () => {
        const value = draft.trim();
        if (value === "") return;
        void invoke("secret_set", { key: CODAI_KEY, value })
            .then(() => {
                setDraft("");
                probe();
                toast.success(t("settings.codai.keySaved"));
            })
            .catch(() => toast.error(t("common.error")));
    };

    const tone = status === "stored" ? "success" : status === "missing" ? "warning" : "neutral";

    return (
        <>
            <Card
                title={t("settings.codai.title")}
                subtitle={t("settings.codai.hint")}
                icon={<KeyRound />}
                tint="var(--kind-join)"
                actions={<StatusPill tone={tone}>{t(`settings.codai.key.${status}`)}</StatusPill>}
            >
                <p className="text-xs text-fg-muted">{t("settings.codai.keyHint")}</p>
                <div className="flex items-end gap-2">
                    <div className="min-w-0 flex-1">
                        <TextInput
                            label={t("settings.codai.replaceKey")}
                            value={draft}
                            onChange={setDraft}
                            secret
                            placeholder={t("settings.codai.keyPlaceholder")}
                        />
                    </div>
                    <Button size="md" variant="soft" onClick={save} disabled={draft.trim() === ""}>
                        {t("common.save")}
                    </Button>
                </div>
            </Card>

            <Card title={t("settings.codai.endpoint")} icon={<Cable />}>
                <TextInput
                    label={t("settings.codai.baseUrl")}
                    value={codai.baseUrl}
                    onChange={(baseUrl) => update("codai", { baseUrl })}
                    placeholder="https://ai.codai.ro"
                    invalid={!/^https:\/\/\S+$/.test(codai.baseUrl)}
                    hint={!/^https:\/\/\S+$/.test(codai.baseUrl) ? t("settings.codai.baseUrlInvalid") : undefined}
                />
                <TextInput label={t("settings.codai.replyModel")} value={codai.replyModel} onChange={(replyModel) => update("codai", { replyModel })} />
                <TextInput label={t("settings.codai.sttModel")} value={codai.sttModel} onChange={(sttModel) => update("codai", { sttModel })} />
                <TextInput label={t("settings.codai.ttsModel")} value={codai.ttsModel} onChange={(ttsModel) => update("codai", { ttsModel })} />
            </Card>
        </>
    );
}

/* ------------------------------------------------------------------ */

const COLOR_SWATCH: Record<(typeof FLASH_COLORS)[number], string> = {
    red: "#ef4444",
    green: "#22c55e",
    blue: "#3b82f6",
    cyan: "#06b6d4",
    purple: "#a855f7",
    pink: "#ec4899",
    gold: "#eab308",
    orange: "#f97316",
    white: "#ffffff",
};

type GiftTier = Settings["effects"]["giftTiers"][number];

function EffectsSection() {
    const { t } = useTranslation();
    const update = useSettingsUpdate();
    const e = useAppStore((s) => s.settings.effects);
    const sceneLabel = (scene: string) => t(`settings.effects.scenes.${scene}`);

    const setTier = (index: number, patch: Partial<GiftTier>) =>
        update("effects", { giftTiers: e.giftTiers.map((tier, i) => (i === index ? { ...tier, ...patch } : tier)) });
    const addTier = () => {
        const top = e.giftTiers.reduce((max, tier) => Math.max(max, tier.minDiamonds), 0);
        update("effects", { giftTiers: [...e.giftTiers, { minDiamonds: top + 100, scene: "party", durationSec: 15 }] });
    };
    const removeTier = (index: number) => update("effects", { giftTiers: e.giftTiers.filter((_, i) => i !== index) });

    return (
        <>
            <Card title={t("settings.effects.title")} subtitle={t("settings.effects.hint")} icon={<Lightbulb />} tint="var(--kind-gift)">
                <SwitchRow
                    label={t("settings.effects.enabled")}
                    checked={e.enabled}
                    onChange={(enabled) => update("effects", { enabled })}
                    tint="var(--kind-gift)"
                />
                <Reveal show={e.enabled}>
                    <TextInput
                        label={t("settings.effects.vmuiUrl")}
                        value={e.vmuiUrl}
                        onChange={(vmuiUrl) => update("effects", { vmuiUrl })}
                        placeholder="http://192.168.100.232:3737"
                        hint={t("settings.effects.vmuiUrlHint")}
                    />
                    <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="soft" icon={<Zap />} onClick={() => sidecarClient.send({ type: "effectTest", kind: "flash", value: "cyan" })}>
                            {t("settings.effects.testFlash")}
                        </Button>
                        <Button size="sm" variant="soft" icon={<Play />} onClick={() => sidecarClient.send({ type: "effectTest", kind: "scene", value: "party" })}>
                            {t("settings.effects.testScene")}
                        </Button>
                    </div>
                </Reveal>
            </Card>

            <Reveal show={e.enabled}>
                <Card title={t("settings.effects.chat")} subtitle={t("settings.effects.chatHint")} icon={<Zap />} tint="var(--kind-chat)">
                    <SwitchRow
                        label={t("settings.effects.chatCommands")}
                        checked={e.chatCommands}
                        onChange={(chatCommands) => update("effects", { chatCommands })}
                        tint="var(--kind-chat)"
                    />
                    <div className="grid grid-cols-2 gap-3">
                        <NumberField
                            label={t("settings.effects.perUserCooldown")}
                            value={e.perUserCooldownSec}
                            min={5}
                            max={3600}
                            suffix="s"
                            onCommit={(perUserCooldownSec) => update("effects", { perUserCooldownSec })}
                        />
                        <NumberField
                            label={t("settings.effects.globalCooldown")}
                            value={e.globalCooldownSec}
                            min={1}
                            max={600}
                            suffix="s"
                            onCommit={(globalCooldownSec) => update("effects", { globalCooldownSec })}
                        />
                    </div>
                    <ChipToggleGroup
                        label={t("settings.effects.allowedColors")}
                        options={FLASH_COLORS}
                        selected={e.allowedColors}
                        onChange={(allowedColors) => update("effects", { allowedColors })}
                        display={(c) => t(`settings.effects.colors.${c}`)}
                        swatch={(c) => COLOR_SWATCH[c]}
                    />
                    <ChipToggleGroup
                        label={t("settings.effects.allowedScenes")}
                        options={STREAM_SCENES}
                        selected={e.allowedChatScenes}
                        onChange={(allowedChatScenes) => update("effects", { allowedChatScenes })}
                        display={sceneLabel}
                    />
                </Card>

                <Card
                    title={t("settings.effects.giftTiers")}
                    subtitle={t("settings.effects.giftTiersHint")}
                    icon={<Sparkles />}
                    tint="var(--kind-gift)"
                    actions={
                        <Button size="sm" variant="soft" icon={<Plus />} onClick={addTier}>
                            {t("settings.effects.addTier")}
                        </Button>
                    }
                >
                    {e.giftTiers.length === 0 ? (
                        <p className="text-xs text-fg-subtle">{t("settings.effects.noTiers")}</p>
                    ) : (
                        <ul className="flex flex-col gap-2">
                            {e.giftTiers.map((tier, index) => (
                                <li
                                    // Tiers have no id; position is the identity while editing.
                                    key={index}
                                    className="grid grid-cols-[1fr_1.4fr_1fr_auto] items-end gap-2 rounded-chip bg-panel-alt/60 p-2"
                                >
                                    <NumberField
                                        label={t("settings.effects.minDiamonds")}
                                        value={tier.minDiamonds}
                                        min={1}
                                        max={1_000_000}
                                        onCommit={(minDiamonds) => setTier(index, { minDiamonds })}
                                    />
                                    <SelectField
                                        label={t("settings.effects.scene")}
                                        value={tier.scene}
                                        onChange={(scene) => {
                                            const picked = STREAM_SCENES.find((s) => s === scene);
                                            if (picked) setTier(index, { scene: picked });
                                        }}
                                        options={STREAM_SCENES.map((s) => ({ value: s, label: sceneLabel(s) }))}
                                    />
                                    <NumberField
                                        label={t("settings.effects.duration")}
                                        value={tier.durationSec}
                                        min={1}
                                        max={600}
                                        suffix="s"
                                        onCommit={(durationSec) => setTier(index, { durationSec })}
                                    />
                                    <Button
                                        size="icon-sm"
                                        variant="ghost"
                                        aria-label={t("settings.effects.removeTier")}
                                        title={t("settings.effects.removeTier")}
                                        onClick={() => removeTier(index)}
                                    >
                                        <Trash2 />
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                </Card>
            </Reveal>
        </>
    );
}

/* ------------------------------------------------------------------ */

function InteractiveSection() {
    const { t } = useTranslation();
    const update = useSettingsUpdate();
    const goals = useAppStore((s) => s.settings.goals);
    const games = useAppStore((s) => s.settings.games);
    const translation = useAppStore((s) => s.settings.translation);
    const setGoal = (kind: "gifts" | "likes", patch: Partial<Settings["goals"]["gifts"]>) =>
        update("goals", kind === "gifts" ? { gifts: { ...goals.gifts, ...patch } } : { likes: { ...goals.likes, ...patch } });

    return (
        <>
            <Card title={t("settings.goals.title")} subtitle={t("settings.goals.hint")} icon={<Target />} tint="var(--kind-gift)">
                <SwitchRow label={t("settings.goals.enabled")} checked={goals.enabled} onChange={(enabled) => update("goals", { enabled })} tint="var(--kind-gift)" />
                <Reveal show={goals.enabled}>
                    <SwitchRow
                        label={t("settings.goals.showInOverlay")}
                        description={t("settings.goals.showInOverlayHint")}
                        checked={goals.showInOverlay}
                        onChange={(showInOverlay) => update("goals", { showInOverlay })}
                        tint="var(--kind-gift)"
                    />
                    {(["gifts", "likes"] as const).map((kind) => {
                        const goal = goals[kind];
                        return (
                            <div key={kind} className="flex flex-col gap-2 rounded-chip bg-panel-alt/60 p-3">
                                <SwitchRow
                                    label={t(`settings.goals.${kind}`)}
                                    checked={goal.enabled}
                                    onChange={(enabled) => setGoal(kind, { enabled })}
                                    tint={kind === "gifts" ? "var(--kind-gift)" : "var(--kind-like)"}
                                />
                                <div className="grid grid-cols-[2fr_1fr] gap-2">
                                    <TextInput
                                        label={t("settings.goals.label")}
                                        value={goal.label}
                                        onChange={(label) => setGoal(kind, { label: label.slice(0, 60) })}
                                        placeholder={t(`goals.${kind}`)}
                                    />
                                    <NumberField
                                        label={t(`settings.goals.${kind}Target`)}
                                        value={goal.target}
                                        min={1}
                                        max={100_000_000}
                                        onCommit={(target) => setGoal(kind, { target })}
                                    />
                                </div>
                            </div>
                        );
                    })}
                </Reveal>
            </Card>

            <Card title={t("settings.games.title")} subtitle={t("settings.games.hint")} icon={<Dices />} tint="var(--kind-join)">
                <SwitchRow
                    label={t("settings.games.showInOverlay")}
                    checked={games.showInOverlay}
                    onChange={(showInOverlay) => update("games", { showInOverlay })}
                    tint="var(--kind-join)"
                />
                <SwitchRow
                    label={t("settings.games.allowVoteChange")}
                    description={t("settings.games.allowVoteChangeHint")}
                    checked={games.allowVoteChange}
                    onChange={(allowVoteChange) => update("games", { allowVoteChange })}
                    tint="var(--kind-join)"
                />
                <SwitchRow
                    label={t("settings.games.wheelFollowersOnly")}
                    checked={games.wheelFollowersOnly}
                    onChange={(wheelFollowersOnly) => update("games", { wheelFollowersOnly })}
                    tint="var(--kind-join)"
                />
                <SwitchRow
                    label={t("settings.games.announceWinners")}
                    description={t("settings.games.announceWinnersHint")}
                    checked={games.announceWinners}
                    onChange={(announceWinners) => update("games", { announceWinners })}
                    tint="var(--kind-join)"
                />
            </Card>

            <Card title={t("settings.translation.title")} subtitle={t("settings.translation.hint")} icon={<Languages />} tint="var(--kind-chat)">
                <SwitchRow
                    label={t("settings.translation.enabled")}
                    description={t("settings.translation.enabledHint")}
                    checked={translation.enabled}
                    onChange={(enabled) => update("translation", { enabled })}
                    tint="var(--kind-chat)"
                />
                <Reveal show={translation.enabled}>
                    <SliderRow
                        label={t("settings.translation.minLetters")}
                        value={translation.minLetters}
                        min={2}
                        max={40}
                        step={1}
                        format={(v) => String(Math.round(v))}
                        onCommit={(v) => update("translation", { minLetters: Math.round(v) })}
                        tint="var(--kind-chat)"
                    />
                </Reveal>
            </Card>
        </>
    );
}

/* ------------------------------------------------------------------ */

function SafetySection() {
    const { t } = useTranslation();
    const update = useSettingsUpdate();
    const s = useAppStore((state) => state.settings.safety);
    const toLines = (list: readonly string[]) => list.join("\n");
    const fromLines = (value: string) =>
        value.split("\n").map((line) => line.trim()).filter(Boolean);

    return (
        <>
            <Card title={t("settings.sections.safety")} icon={<Shield />} tint="var(--danger)">
                <SwitchRow
                    label={t("settings.safety.moderation")}
                    description={t("settings.safety.moderationHint")}
                    checked={s.moderation}
                    onChange={(moderation) => update("safety", { moderation })}
                    tint="var(--danger)"
                />
                <SwitchRow
                    label={t("settings.safety.hideSpam")}
                    checked={s.hideSpam}
                    onChange={(hideSpam) => update("safety", { hideSpam })}
                    tint="var(--danger)"
                />
                <SliderRow
                    label={t("settings.safety.spamWindow")}
                    value={s.spamWindowMs / 1000}
                    min={1}
                    max={120}
                    step={1}
                    format={(v) => t("common.seconds", { count: Math.round(v) })}
                    onCommit={(v) => update("safety", { spamWindowMs: Math.round(v) * 1000 })}
                    tint="var(--danger)"
                />
                <SliderRow
                    label={t("settings.safety.maxQueue")}
                    value={s.maxQueue}
                    min={3}
                    max={20}
                    step={1}
                    format={(v) => String(Math.round(v))}
                    onCommit={(maxQueue) => update("safety", { maxQueue: Math.round(maxQueue) })}
                    tint="var(--danger)"
                />
            </Card>

            <Card title={t("settings.safety.blockedWords")} icon={<Shield />} tint="var(--danger)">
                <TextInput
                    value={toLines(s.blockedWords)}
                    onChange={(value) => update("safety", { blockedWords: fromLines(value) })}
                    multiline
                    hint={t("settings.safety.blockedWordsHint")}
                />
                <TextInput
                    label={t("settings.safety.blockedUsers")}
                    value={toLines(s.blockedUsers)}
                    onChange={(value) => update("safety", { blockedUsers: fromLines(value) })}
                    multiline
                    hint={t("settings.safety.blockedUsersHint")}
                />
                <TextInput
                    label={t("settings.safety.alertKeywords")}
                    value={toLines(s.alertKeywords)}
                    onChange={(value) => update("safety", { alertKeywords: fromLines(value) })}
                    multiline
                    hint={t("settings.safety.alertKeywordsHint")}
                />
            </Card>
        </>
    );
}

/* ------------------------------------------------------------------ */

function DisplaySection() {
    const { t } = useTranslation();
    const update = useSettingsUpdate();
    const d = useAppStore((s) => s.settings.display);

    return (
        <>
            <Card title={t("settings.display.collapse")} subtitle={t("settings.display.collapseHint")} icon={<Eye />} tint="var(--kind-join)">
                <p className="text-xs font-semibold text-fg-muted">{t("settings.display.feed")}</p>
                <SwitchRow label={t("settings.display.collapseJoins")} checked={d.collapseJoinsFeed} onChange={(v) => update("display", { collapseJoinsFeed: v })} tint="var(--kind-join)" />
                <SwitchRow label={t("settings.display.collapseLikes")} checked={d.collapseLikesFeed} onChange={(v) => update("display", { collapseLikesFeed: v })} tint="var(--kind-join)" />

                <p className="pt-2 text-xs font-semibold text-fg-muted">{t("settings.display.overlaySurface")}</p>
                <SwitchRow label={t("settings.display.collapseJoins")} checked={d.collapseJoinsOverlay} onChange={(v) => update("display", { collapseJoinsOverlay: v })} tint="var(--kind-chat)" />
                <SwitchRow label={t("settings.display.collapseLikes")} checked={d.collapseLikesOverlay} onChange={(v) => update("display", { collapseLikesOverlay: v })} tint="var(--kind-chat)" />

                <p className="pt-2 text-xs font-semibold text-fg-muted">{t("settings.display.panelSurface")}</p>
                <SwitchRow label={t("settings.display.collapseJoins")} checked={d.collapseJoinsPanel} onChange={(v) => update("display", { collapseJoinsPanel: v })} tint="var(--kind-share)" />
                <SwitchRow label={t("settings.display.collapseLikes")} checked={d.collapseLikesPanel} onChange={(v) => update("display", { collapseLikesPanel: v })} tint="var(--kind-share)" />

                <div className="pt-2">
                    <SwitchRow
                        label={t("settings.display.mergeSameUser")}
                        description={t("settings.display.mergeSameUserHint")}
                        checked={d.mergeSameUser}
                        onChange={(mergeSameUser) => update("display", { mergeSameUser })}
                        tint="var(--kind-follow)"
                    />
                </div>
            </Card>

            <Card title={t("settings.sections.display")} icon={<Eye />}>
                <SwitchRow label={t("settings.display.showAvatars")} checked={d.showAvatars} onChange={(showAvatars) => update("display", { showAvatars })} />
                <SwitchRow label={t("settings.display.showTimestamps")} checked={d.showTimestamps} onChange={(showTimestamps) => update("display", { showTimestamps })} />
                <SliderRow
                    label={t("settings.display.maxEvents")}
                    value={d.maxFeedEvents}
                    min={50}
                    max={5000}
                    step={50}
                    format={(v) => String(Math.round(v))}
                    onCommit={(v) => update("display", { maxFeedEvents: Math.round(v) })}
                />
            </Card>
        </>
    );
}

/* ------------------------------------------------------------------ */

function StudioSection() {
    const { t } = useTranslation();
    const update = useSettingsUpdate();
    const s = useAppStore((state) => state.settings.studio);
    const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);

    useEffect(() => {
        void navigator.mediaDevices
            ?.enumerateDevices()
            .then((list) => setCameras(list.filter((d) => d.kind === "videoinput")))
            .catch(() => undefined);
    }, []);

    // The studio window is a separate document; push every change to it live.
    useEffect(() => {
        void emitTo("studio", "studio://settings", s).catch(() => undefined);
    }, [s]);

    const setEnabled = (enabled: boolean) => {
        update("studio", { enabled });
        void invoke("toggle_studio", { show: enabled, portrait: s.orientation === "portrait" }).catch(() =>
            toast.error(t("common.error")),
        );
    };
    const petOptions = PET_CHOICES.map((p) => ({ value: p, label: t(`settings.studio.pets.${p}`) }));

    return (
        <>
            <Card title={t("settings.studio.title")} subtitle={t("settings.studio.hint")} icon={<Camera />} tint="var(--kind-gift)">
                <SwitchRow
                    label={t("settings.studio.enabled")}
                    description={t("settings.studio.enabledHint")}
                    checked={s.enabled}
                    onChange={setEnabled}
                    tint="var(--kind-gift)"
                />
                <SelectField
                    label={t("settings.studio.camera")}
                    value={s.cameraId}
                    onChange={(cameraId) => update("studio", { cameraId })}
                    options={[
                        { value: "", label: t("settings.studio.cameraAuto") },
                        ...cameras.map((c, i) => ({ value: c.deviceId, label: c.label || `${t("settings.studio.camera")} ${i + 1}` })),
                    ]}
                />
                <ChipSelector
                    label={t("settings.studio.orientation")}
                    options={STUDIO_ORIENTATIONS}
                    value={s.orientation}
                    onSelect={(orientation) => update("studio", { orientation })}
                    display={(o) => t(`settings.studio.orientations.${o}`)}
                    tint="var(--kind-gift)"
                />
                <SwitchRow label={t("settings.studio.mirror")} checked={s.mirror} onChange={(mirror) => update("studio", { mirror })} />
                <ChipSelector
                    label={t("settings.studio.rotation")}
                    options={CAMERA_ROTATIONS.map(String) as readonly string[]}
                    value={String(s.rotation)}
                    onSelect={(r) => update("studio", { rotation: Number(r) as Settings["studio"]["rotation"] })}
                    display={(r) => (r === "0" ? t("settings.studio.rotationNone") : `${r}°`)}
                    tint="var(--kind-gift)"
                />
                <SwitchRow
                    label={t("settings.studio.showStats")}
                    description={t("settings.studio.showStatsHint")}
                    checked={s.showStats}
                    onChange={(showStats) => update("studio", { showStats })}
                />
            </Card>
            <VirtualCameraCard />
            <MonitorCard />
            <FramingCard />
            <CameraRemote />
            <CameraUsb />
            <Card title={t("settings.studio.petsTitle")} subtitle={t("settings.studio.petsHint")} icon={<Sparkles />} tint="var(--kind-like)">
                <SelectField
                    label={t("settings.studio.leftPet")}
                    value={s.leftPet}
                    options={petOptions}
                    onChange={(v) => update("studio", { leftPet: v as Settings["studio"]["leftPet"] })}
                />
                <SelectField
                    label={t("settings.studio.rightPet")}
                    value={s.rightPet}
                    options={petOptions}
                    onChange={(v) => update("studio", { rightPet: v as Settings["studio"]["rightPet"] })}
                />
                <ChipSelector
                    label={t("settings.studio.petStyle")}
                    options={PET_STYLES}
                    value={s.petStyle}
                    onSelect={(petStyle) => update("studio", { petStyle })}
                    display={(p) => t(`settings.studio.petStyles.${p}`)}
                    tint="var(--kind-like)"
                />
            </Card>
            <Card title={t("settings.studio.filtersTitle")} subtitle={t("settings.studio.filtersHint")} icon={<Palette />} tint="var(--kind-join)">
                <SliderRow
                    label={t("settings.studio.smoothing")}
                    value={s.smoothing}
                    min={0}
                    max={1}
                    step={0.01}
                    format={(v) => `${Math.round(v * 100)}%`}
                    onCommit={(smoothing) => update("studio", { smoothing })}
                />
                <SliderRow
                    label={t("settings.studio.backgroundBlur")}
                    value={s.backgroundBlur}
                    min={0}
                    max={1}
                    step={0.01}
                    format={(v) => (v < 0.02 ? t("settings.overlay.blurOff") : `${Math.round(v * 100)}%`)}
                    onCommit={(backgroundBlur) => update("studio", { backgroundBlur })}
                />
                <SliderRow
                    label={t("settings.studio.exposure")}
                    value={s.exposure}
                    min={-2}
                    max={2}
                    step={0.05}
                    format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(2)} EV`}
                    onCommit={(exposure) => update("studio", { exposure })}
                />
                <SliderRow
                    label={t("settings.studio.warmth")}
                    value={s.warmth}
                    min={-1}
                    max={1}
                    step={0.02}
                    format={(v) => `${v > 0 ? "+" : ""}${Math.round(v * 100)}`}
                    onCommit={(warmth) => update("studio", { warmth })}
                />
            </Card>
        </>
    );
}

/** Shape of `vcam_status` (WS25-01); every field optional so an older shell still renders. */
interface VcamStatus {
    state?: string;
    registered?: boolean;
    consumer?: [number, number, number] | null;
    fps?: number;
    error?: string | null;
}

function VirtualCameraCard() {
    const { t } = useTranslation();
    const update = useSettingsUpdate();
    const s = useAppStore((state) => state.settings.studio);
    const [status, setStatus] = useState<VcamStatus | null>(null);
    const [statusError, setStatusError] = useState<string | null>(null);
    const [repairing, setRepairing] = useState(false);

    // Polled only while this section is mounted (i.e. visible).
    useEffect(() => {
        let disposed = false;
        const poll = () =>
            void invoke<VcamStatus>("vcam_status")
                .then((next) => {
                    if (disposed) return;
                    setStatus(next);
                    setStatusError(null);
                })
                .catch((error: unknown) => {
                    if (!disposed) setStatusError(String(error));
                });
        poll();
        const id = window.setInterval(poll, 2000);
        return () => {
            disposed = true;
            window.clearInterval(id);
        };
    }, []);

    const repair = () => {
        setRepairing(true);
        void invoke("vcam_register")
            .then(() => toast.success(t("settings.studio.vcam.repaired")))
            .catch((error: unknown) => toast.error(t("settings.studio.vcam.repairFailed", { error: String(error) })))
            .finally(() => setRepairing(false));
    };

    const consumer = status?.consumer;
    const tone = statusError ? "danger" : status?.state === "streaming" ? "success" : status?.registered === false ? "warning" : "neutral";

    return (
        <Card title={t("settings.studio.vcam.title")} subtitle={t("settings.studio.vcam.hint")} icon={<Video />} tint="var(--kind-gift)">
            <SwitchRow
                label={t("settings.studio.vcam.enabled")}
                description={t("settings.studio.vcam.enabledHint")}
                checked={s.virtualCamera}
                onChange={(virtualCamera) => update("studio", { virtualCamera })}
                tint="var(--kind-gift)"
            />
            <ChipSelector
                label={t("settings.studio.vcam.fps")}
                options={["30", "60"] as const}
                value={String(s.virtualCameraFps) as "30" | "60"}
                onSelect={(v) => update("studio", { virtualCameraFps: v === "30" ? 30 : 60 })}
                display={(v) => `${v} fps`}
                tint="var(--kind-gift)"
            />
            <div className="flex flex-wrap items-center gap-2" aria-live="polite">
                <StatusPill tone={tone} pulse={status?.state === "streaming"}>
                    {statusError ? t("settings.studio.vcam.unavailable") : (status?.state ?? t("common.loading"))}
                </StatusPill>
                {status && (
                    <span className="text-xs text-fg-muted">
                        {status.registered ? t("settings.studio.vcam.registered") : t("settings.studio.vcam.notRegistered")}
                        {consumer ? ` · ${t("settings.studio.vcam.consumer", { w: consumer[0], h: consumer[1], fps: consumer[2] })}` : ` · ${t("settings.studio.vcam.noConsumer")}`}
                        {status.fps !== undefined ? ` · ${Math.round(status.fps)} fps` : ""}
                    </span>
                )}
                {(status?.error ?? statusError) && <span className="text-xs text-danger">{status?.error ?? statusError}</span>}
            </div>
            <div>
                <Button size="sm" variant="soft" loading={repairing} onClick={repair}>
                    {t("settings.studio.vcam.repair")}
                </Button>
            </div>
        </Card>
    );
}

function MonitorCard() {
    const { t } = useTranslation();
    const update = useSettingsUpdate();
    const studio = useAppStore((state) => state.settings.studio);
    const m = studio.monitor;
    const set = (patch: Partial<Settings["studio"]["monitor"]>) => update("studio", { monitor: { ...m, ...patch } });

    return (
        <Card title={t("settings.studio.monitor.title")} subtitle={t("settings.studio.monitor.hint")} icon={<Eye />} tint="var(--kind-chat)">
            <SwitchRow label={t("settings.studio.monitor.cleanFeed")} description={t("settings.studio.monitor.cleanFeedHint")} checked={m.cleanFeed} onChange={(cleanFeed) => set({ cleanFeed })} tint="var(--kind-chat)" />
            <SwitchRow label={t("settings.studio.monitor.peaking")} checked={m.peaking} onChange={(peaking) => set({ peaking })} tint="var(--kind-chat)" />
            <Reveal show={m.peaking}>
                <ChipSelector
                    label={t("settings.studio.monitor.peakingColor")}
                    options={PEAKING_COLORS}
                    value={m.peakingColor}
                    onSelect={(peakingColor) => set({ peakingColor })}
                    display={(c) => t(`settings.studio.monitor.colors.${c}`)}
                    tint="var(--kind-chat)"
                />
                <SliderRow
                    label={t("settings.studio.monitor.peakingThreshold")}
                    value={m.peakingThreshold}
                    min={0.03}
                    max={0.5}
                    step={0.01}
                    format={(v) => v.toFixed(2)}
                    onCommit={(peakingThreshold) => set({ peakingThreshold })}
                    tint="var(--kind-chat)"
                />
            </Reveal>
            <SwitchRow label={t("settings.studio.monitor.zebra")} checked={m.zebra} onChange={(zebra) => set({ zebra })} tint="var(--kind-chat)" />
            <Reveal show={m.zebra}>
                <SliderRow
                    label={t("settings.studio.monitor.zebraLevel")}
                    value={m.zebraLevel}
                    min={50}
                    max={100}
                    step={1}
                    format={(v) => `${Math.round(v)} IRE`}
                    onCommit={(v) => set({ zebraLevel: Math.round(v) })}
                    tint="var(--kind-chat)"
                />
            </Reveal>
            <SwitchRow label={t("settings.studio.monitor.falseColor")} checked={m.falseColor} onChange={(falseColor) => set({ falseColor })} tint="var(--kind-chat)" />
            <SwitchRow label={t("settings.studio.monitor.clipping")} checked={m.clipping} onChange={(clipping) => set({ clipping })} tint="var(--kind-chat)" />
            <SelectField
                label={t("settings.studio.monitor.guides")}
                value={m.guides}
                options={GUIDE_KINDS.map((g) => ({ value: g, label: t(`settings.studio.monitor.guideKinds.${g}`) }))}
                onChange={(v) => set({ guides: v as typeof m.guides })}
            />
            <SelectField
                label={t("settings.studio.monitor.scope")}
                value={m.scope}
                options={SCOPE_KINDS.map((k) => ({ value: k, label: t(`settings.studio.monitor.scopeKinds.${k}`) }))}
                onChange={(v) => set({ scope: v as typeof m.scope })}
            />
            <SwitchRow label={t("settings.studio.monitor.safeZones")} checked={m.safeZones} onChange={(safeZones) => set({ safeZones })} tint="var(--kind-chat)" />
            <SwitchRow label={t("settings.studio.monitor.afBox")} checked={m.afBox} onChange={(afBox) => set({ afBox })} tint="var(--kind-chat)" />
            <SwitchRow label={t("settings.studio.monitor.horizon")} checked={m.horizon} onChange={(horizon) => set({ horizon })} tint="var(--kind-chat)" />
            <ChipSelector
                label={t("settings.studio.monitor.loupeZoom")}
                options={["2", "4"] as const}
                value={String(m.loupeZoom) as "2" | "4"}
                onSelect={(v) => set({ loupeZoom: v === "4" ? 4 : 2 })}
                display={(v) => `${v}×`}
                tint="var(--kind-chat)"
            />
        </Card>
    );
}

function FramingCard() {
    const { t } = useTranslation();
    const update = useSettingsUpdate();
    const studio = useAppStore((state) => state.settings.studio);
    const f = studio.framing;
    const set = (patch: Partial<Settings["studio"]["framing"]>) => update("studio", { framing: { ...f, ...patch } });

    return (
        <Card title={t("settings.studio.framing.title")} subtitle={t("settings.studio.framing.hint")} icon={<Target />} tint="var(--kind-follow)">
            <SliderRow
                label={t("settings.studio.framing.zoom")}
                value={f.zoom}
                min={1}
                max={2.5}
                step={0.05}
                format={(v) => `${v.toFixed(2)}×`}
                onCommit={(zoom) => set({ zoom })}
                tint="var(--kind-follow)"
            />
            <SwitchRow label={t("settings.studio.framing.autoReframe")} description={t("settings.studio.framing.autoReframeHint")} checked={f.autoReframe} onChange={(autoReframe) => set({ autoReframe })} tint="var(--kind-follow)" />
            <Reveal show={f.autoReframe}>
                <SliderRow
                    label={t("settings.studio.framing.deadZone")}
                    value={f.deadZone}
                    min={0}
                    max={0.3}
                    step={0.01}
                    format={(v) => `${Math.round(v * 100)}%`}
                    onCommit={(deadZone) => set({ deadZone })}
                    tint="var(--kind-follow)"
                />
                <SwitchRow label={t("settings.studio.framing.smartWide")} description={t("settings.studio.framing.smartWideHint")} checked={f.smartWide} onChange={(smartWide) => set({ smartWide })} tint="var(--kind-follow)" />
            </Reveal>
            <SwitchRow label={t("settings.studio.framing.dof")} description={t("settings.studio.framing.dofHint")} checked={f.dof} onChange={(dof) => set({ dof })} tint="var(--kind-follow)" />
            <Reveal show={f.dof}>
                <SliderRow
                    label={t("settings.studio.framing.dofStrength")}
                    value={f.dofStrength}
                    min={0}
                    max={1}
                    step={0.01}
                    format={(v) => `${Math.round(v * 100)}%`}
                    onCommit={(dofStrength) => set({ dofStrength })}
                    tint="var(--kind-follow)"
                />
            </Reveal>
            <SliderRow
                label={t("settings.studio.framing.afInterval")}
                value={f.afIntervalS}
                min={0}
                max={120}
                step={1}
                format={(v) => (v < 1 ? t("common.off") : t("common.seconds", { count: Math.round(v) }))}
                onCommit={(v) => set({ afIntervalS: Math.round(v) })}
                tint="var(--kind-follow)"
            />
            <p className="text-[0.6875rem] text-fg-muted">{t("settings.studio.framing.arObjects", { count: studio.arObjects.length })}</p>
        </Card>
    );
}

/* ------------------------------------------------------------------ */

function OverlaySection() {
    const { t } = useTranslation();
    const update = useSettingsUpdate();
    const o = useAppStore((s) => s.settings.overlay);

    const setEnabled = (enabled: boolean) => {
        update("overlay", { enabled });
        void invoke("toggle_overlay", { show: enabled }).catch(() => toast.error(t("common.error")));
    };

    return (
        <Card title={t("settings.overlay.enabled")} subtitle={t("settings.overlay.enabledHint")} icon={<Layers />}>
            <SwitchRow label={t("settings.overlay.enabled")} checked={o.enabled} onChange={setEnabled} />
            <Reveal show={o.enabled}>
                <SliderRow
                    label={t("settings.overlay.opacity")}
                    value={o.opacity}
                    min={0.15}
                    max={1}
                    step={0.01}
                    format={(v) => `${Math.round(v * 100)}%`}
                    onCommit={(opacity) => update("overlay", { opacity })}
                />
                <SliderRow
                    label={t("settings.overlay.blur")}
                    value={o.blur}
                    min={0}
                    max={1}
                    step={0.01}
                    format={(v) => (v < 0.02 ? t("settings.overlay.blurOff") : `${Math.round(v * 100)}%`)}
                    onCommit={(blur) => update("overlay", { blur })}
                    tint="var(--kind-join)"
                />
                <SwitchRow
                    label={t("settings.overlay.clickThrough")}
                    description={t("settings.overlay.clickThroughHint")}
                    checked={o.clickThrough}
                    onChange={(clickThrough) => {
                        update("overlay", { clickThrough });
                        void invoke("set_overlay_click_through", { enabled: clickThrough }).catch(() => undefined);
                    }}
                />
                <SwitchRow label={t("settings.overlay.alwaysOnTop")} checked={o.alwaysOnTop} onChange={(alwaysOnTop) => update("overlay", { alwaysOnTop })} />
                <SwitchRow label={t("settings.overlay.compact")} checked={o.compact} onChange={(compact) => update("overlay", { compact })} />
            </Reveal>
        </Card>
    );
}

/* ------------------------------------------------------------------ */

function ObsSection() {
    const { t } = useTranslation();
    const update = useSettingsUpdate();
    const obs = useAppStore((s) => s.settings.obs);
    const port = useAppStore((s) => s.overlayPort);
    const obsConnected = useAppStore((s) => s.obsConnected);
    const obsError = useAppStore((s) => s.obsError);
    const url = port > 0 ? `http://127.0.0.1:${port}/overlay` : "";

    return (
        <>
            <Card
                title={t("settings.obs.browserSource")}
                subtitle={t("settings.obs.browserSourceHint")}
                icon={<Video />}
                tint="var(--kind-share)"
                actions={
                    url !== "" ? (
                        <Button
                            size="sm"
                            variant="soft"
                            icon={<Copy />}
                            onClick={() => {
                                void navigator.clipboard.writeText(url);
                                toast.success(t("settings.obs.copied"));
                            }}
                        >
                            {t("settings.obs.copyUrl")}
                        </Button>
                    ) : undefined
                }
            >
                <SwitchRow
                    label={t("settings.obs.browserSource")}
                    checked={obs.browserSourceEnabled}
                    onChange={(browserSourceEnabled) => update("obs", { browserSourceEnabled })}
                    tint="var(--kind-share)"
                />
                <Reveal show={obs.browserSourceEnabled}>
                    {url !== "" && (
                        <code className="block select-all truncate rounded-chip bg-panel-alt px-3 py-2 font-mono text-xs text-accent">
                            {url}
                        </code>
                    )}
                    <ChipSelector
                        label={t("settings.obs.layout")}
                        options={OVERLAY_LAYOUTS}
                        value={obs.layout}
                        onSelect={(layout) => update("obs", { layout })}
                        display={(l) => t(`settings.obs.layouts.${l}`)}
                        tint="var(--kind-share)"
                    />
                    <SwitchRow
                        label={t("settings.obs.transparent")}
                        checked={obs.transparent}
                        onChange={(transparent) => update("obs", { transparent })}
                        tint="var(--kind-share)"
                    />
                    <SliderRow
                        label={t("settings.obs.maxRows")}
                        value={obs.maxRows}
                        min={3}
                        max={30}
                        step={1}
                        format={(v) => String(Math.round(v))}
                        onCommit={(v) => update("obs", { maxRows: Math.round(v) })}
                        tint="var(--kind-share)"
                    />
                    <SliderRow
                        label={t("settings.obs.rowTtl")}
                        value={obs.rowTtlMs / 1000}
                        min={0}
                        max={120}
                        step={1}
                        format={(v) => (v === 0 ? t("settings.obs.rowTtlNever") : t("common.seconds", { count: Math.round(v) }))}
                        onCommit={(v) => update("obs", { rowTtlMs: Math.round(v) * 1000 })}
                        tint="var(--kind-share)"
                    />
                </Reveal>
            </Card>

            <Card
                title={t("settings.obs.control")}
                subtitle={t("settings.obs.controlHint")}
                icon={<Video />}
                actions={
                    <StatusPill tone={obsConnected ? "success" : obsError ? "danger" : "neutral"} pulse={obsConnected}>
                        {obsConnected ? t("settings.obs.connected") : t("settings.obs.disconnected")}
                    </StatusPill>
                }
            >
                <SwitchRow
                    label={t("settings.obs.control")}
                    checked={obs.controlEnabled}
                    onChange={(controlEnabled) => update("obs", { controlEnabled })}
                />
                <Reveal show={obs.controlEnabled}>
                    <TextInput
                        label={t("settings.obs.controlUrl")}
                        value={obs.controlUrl}
                        onChange={(controlUrl) => update("obs", { controlUrl })}
                        placeholder="ws://127.0.0.1:4455"
                    />
                    {obsError !== null && !obsConnected && <p className="text-xs text-danger">{obsError}</p>}
                    <div className="flex gap-2">
                        {obsConnected ? (
                            <Button size="sm" variant="danger" onClick={() => sidecarClient.send({ type: "obsDisconnect" })}>
                                {t("settings.obs.disconnect")}
                            </Button>
                        ) : (
                            <Button
                                size="sm"
                                variant="soft"
                                onClick={() => sidecarClient.send({ type: "obsConnect", url: obs.controlUrl })}
                            >
                                {t("settings.obs.connect")}
                            </Button>
                        )}
                    </div>
                </Reveal>
            </Card>
        </>
    );
}

/* ------------------------------------------------------------------ */

function PanelSection() {
    const { t } = useTranslation();
    const update = useSettingsUpdate();
    const p = useAppStore((s) => s.settings.panel);
    const status = useAppStore((s) => s.panel);
    const ports = useAppStore((s) => s.panelPorts);
    const preview = useAppStore((s) => s.panelPreview);

    useEffect(() => {
        sidecarClient.send({ type: "panelListPorts" });
    }, []);

    const busy = status.error?.toLowerCase().includes("access denied") === true;

    return (
        <Card
            title={t("settings.panel.enabled")}
            subtitle={t("settings.panel.enabledHint")}
            icon={<MonitorSmartphone />}
            tint="var(--kind-share)"
            actions={
                <StatusPill tone={status.connected ? "success" : busy ? "warning" : "neutral"} pulse={status.connected}>
                    {status.connected ? t("common.on") : t("common.off")}
                </StatusPill>
            }
        >
            <SwitchRow
                label={t("settings.panel.enabled")}
                checked={p.enabled}
                onChange={(enabled) => {
                    update("panel", { enabled });
                    sidecarClient.send(
                        enabled ? { type: "panelConnect", portPath: p.portPath } : { type: "panelDisconnect" },
                    );
                }}
                tint="var(--kind-share)"
            />

            <Reveal show={p.enabled}>
                {busy && (
                    <div className="rounded-chip bg-warning/12 px-3 py-2.5">
                        <p className="text-xs font-semibold text-warning">{t("settings.panel.busy")}</p>
                        <p className="mt-0.5 text-[0.6875rem] text-fg-muted">{t("settings.panel.busyHint")}</p>
                    </div>
                )}

                <div className="space-y-2">
                    <div className="flex items-center justify-between">
                        <span className="text-[0.8125rem] text-fg-muted">{t("settings.panel.port")}</span>
                        <Button size="sm" variant="ghost" onClick={() => sidecarClient.send({ type: "panelListPorts" })}>
                            {t("settings.panel.refreshPorts")}
                        </Button>
                    </div>
                    {ports.length === 0 ? (
                        <p className="text-xs text-fg-subtle">{t("settings.panel.noPorts")}</p>
                    ) : (
                        <div className="flex flex-wrap gap-2">
                            <ChipSelector
                                options={["", ...ports.map((port) => port.path)]}
                                value={p.portPath}
                                onSelect={(portPath) => {
                                    update("panel", { portPath });
                                    sidecarClient.send({ type: "panelConnect", portPath });
                                }}
                                display={(path) =>
                                    path === ""
                                        ? t("settings.panel.portAuto")
                                        : ports.find((port) => port.path === path)?.isPanel
                                            ? `${path} · ${t("settings.panel.detected")}`
                                            : path
                                }
                                tint="var(--kind-share)"
                            />
                        </div>
                    )}
                </div>

                <SliderRow
                    label={t("settings.panel.brightness")}
                    value={p.brightness}
                    min={0}
                    max={100}
                    step={1}
                    format={(v) => `${Math.round(v)}%`}
                    onCommit={(v) => {
                        update("panel", { brightness: Math.round(v) });
                        sidecarClient.send({ type: "panelBrightness", level: Math.round(v) });
                    }}
                    tint="var(--kind-share)"
                />
                <SwitchRow
                    label={t("settings.panel.showClock")}
                    checked={p.showClock}
                    onChange={(showClock) => update("panel", { showClock })}
                    tint="var(--kind-share)"
                />

                {preview && (
                    <div className="space-y-1.5">
                        <span className="text-[0.8125rem] text-fg-muted">{t("settings.panel.preview")}</span>
                        <img
                            src={preview}
                            alt={t("settings.panel.preview")}
                            width={160}
                            height={240}
                            className="rounded-chip border border-border"
                        />
                    </div>
                )}
            </Reveal>
        </Card>
    );
}

/* ------------------------------------------------------------------ */

function AlertsSection() {
    const { t } = useTranslation();
    const update = useSettingsUpdate();
    const a = useAppStore((s) => s.settings.alerts);

    return (
        <Card title={t("settings.sections.alerts")} icon={<Bell />} tint="var(--kind-gift)">
            <SwitchRow label={t("settings.alerts.sound")} checked={a.soundEnabled} onChange={(soundEnabled) => update("alerts", { soundEnabled })} tint="var(--kind-gift)" />
            <Reveal show={a.soundEnabled}>
                <SliderRow
                    label={t("settings.alerts.volume")}
                    value={a.soundVolume}
                    min={0}
                    max={1}
                    step={0.05}
                    format={(v) => `${Math.round(v * 100)}%`}
                    onCommit={(soundVolume) => update("alerts", { soundVolume })}
                    tint="var(--kind-gift)"
                />
            </Reveal>
            <SwitchRow label={t("settings.alerts.notifyGift")} checked={a.notifyOnGift} onChange={(notifyOnGift) => update("alerts", { notifyOnGift })} tint="var(--kind-gift)" />
            <SwitchRow label={t("settings.alerts.notifyFollow")} checked={a.notifyOnFollow} onChange={(notifyOnFollow) => update("alerts", { notifyOnFollow })} tint="var(--kind-follow)" />
            <SwitchRow label={t("settings.alerts.notifyKeyword")} checked={a.notifyOnKeyword} onChange={(notifyOnKeyword) => update("alerts", { notifyOnKeyword })} tint="var(--kind-chat)" />
            <SliderRow
                label={t("settings.alerts.giftThreshold")}
                value={a.giftDiamondThreshold}
                min={0}
                max={1000}
                step={1}
                format={(v) => `${Math.round(v)} 💎`}
                onCommit={(v) => update("alerts", { giftDiamondThreshold: Math.round(v) })}
                tint="var(--kind-gift)"
            />
        </Card>
    );
}

/* ------------------------------------------------------------------ */

function BehaviourSection() {
    const { t } = useTranslation();
    const update = useSettingsUpdate();
    const b = useAppStore((s) => s.settings.behaviour);
    const hotkeys = [
        ["hotkeyToggleOverlay", "hotkeyOverlay"],
        ["hotkeyMuteVoice", "hotkeyMute"],
        ["hotkeyPushToTalk", "hotkeyTalk"],
        ["hotkeyPauseReplies", "hotkeyPause"],
        ["hotkeySkipReply", "hotkeySkip"],
        ["hotkeyEffectsOff", "hotkeyEffects"],
        ["hotkeyHighlight", "hotkeyHighlight"],
    ] as const;
    const counts = new Map<string, number>();
    for (const [field] of hotkeys) {
        const key = acceleratorKey(b[field]);
        if (key !== "") counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return (
        <>
            <Card title={t("settings.sections.behaviour")} icon={<Gauge />}>
                <SwitchRow label={t("settings.behaviour.autostart")} checked={b.autostart} onChange={(autostart) => update("behaviour", { autostart })} />
                <SwitchRow label={t("settings.behaviour.minimiseToTray")} checked={b.minimiseToTray} onChange={(minimiseToTray) => update("behaviour", { minimiseToTray })} />
                <SwitchRow label={t("settings.behaviour.closeToTray")} checked={b.closeToTray} onChange={(closeToTray) => update("behaviour", { closeToTray })} />
                <SwitchRow
                    label={t("settings.behaviour.autoReconnect")}
                    description={t("settings.behaviour.autoReconnectHint")}
                    checked={b.autoReconnect}
                    onChange={(autoReconnect) => update("behaviour", { autoReconnect })}
                />
                <SwitchRow
                    label={t("connection.waitUntilLive")}
                    description={t("connection.waitUntilLiveHint")}
                    checked={b.waitUntilLive}
                    onChange={(waitUntilLive) => update("behaviour", { waitUntilLive })}
                />
            </Card>

            <Card title={t("settings.behaviour.hotkeys")} subtitle={t("settings.behaviour.hotkeysHint")} icon={<KeyRound />} tint="var(--kind-join)">
                {hotkeys.map(([field, labelKey]) => {
                    const value = b[field];
                    const valid = isValidAccelerator(value);
                    const duplicate = (counts.get(acceleratorKey(value)) ?? 0) > 1;
                    return (
                        <TextInput
                            key={field}
                            label={t(`settings.behaviour.${labelKey}`)}
                            value={value}
                            onChange={(v) => update("behaviour", { [field]: v })}
                            placeholder={t("settings.behaviour.hotkeyPlaceholder")}
                            invalid={!valid || duplicate}
                            hint={
                                !valid
                                    ? t("settings.behaviour.hotkeyInvalid")
                                    : duplicate
                                        ? t("settings.behaviour.hotkeyDuplicate")
                                        : undefined
                            }
                        />
                    );
                })}
                <SwitchRow
                    label={t("settings.behaviour.triggerServer")}
                    description={t("settings.behaviour.triggerServerHint")}
                    checked={b.triggerServerEnabled}
                    onChange={(triggerServerEnabled) => update("behaviour", { triggerServerEnabled })}
                    tint="var(--kind-join)"
                />
            </Card>
        </>
    );
}

/* ------------------------------------------------------------------ */

function DataSection() {
    const { t } = useTranslation();
    const update = useSettingsUpdate();
    const d = useAppStore((s) => s.settings.data);
    const recording = useAppStore((s) => s.replayRecording);
    const replays = useAppStore((s) => s.replays);

    useEffect(() => {
        sidecarClient.send({ type: "replayList" });
    }, []);

    return (
        <>
            <Card title={t("settings.sections.data")} icon={<Cable />}>
                <SwitchRow label={t("settings.data.persist")} checked={d.persistHistory} onChange={(persistHistory) => update("data", { persistHistory })} />
                <SliderRow
                    label={t("settings.data.retention")}
                    value={d.retentionDays}
                    min={0}
                    max={730}
                    step={1}
                    format={(v) => (v === 0 ? t("settings.data.retentionForever") : t("common.days", { count: Math.round(v) }))}
                    onCommit={(v) => update("data", { retentionDays: Math.round(v) })}
                />
                <SwitchRow label={t("settings.data.trackEarnings")} checked={d.trackEarnings} onChange={(trackEarnings) => update("data", { trackEarnings })} tint="var(--kind-gift)" />
                <Reveal show={d.trackEarnings}>
                    <SliderRow
                        label={t("settings.data.diamondRate")}
                        value={d.diamondRateUsd}
                        min={0.001}
                        max={0.02}
                        step={0.001}
                        format={(v) => `$${v.toFixed(3)}`}
                        onCommit={(diamondRateUsd) => update("data", { diamondRateUsd })}
                        tint="var(--kind-gift)"
                    />
                </Reveal>
            </Card>

            <Card title={t("replay.title")} subtitle={t("replay.hint")} icon={<Video />} tint="var(--kind-join)">
                <div className="flex flex-wrap gap-2">
                    <Button
                        size="sm"
                        variant={recording ? "danger" : "soft"}
                        onClick={() =>
                            sidecarClient.send(
                                recording
                                    ? { type: "recordStop" }
                                    : { type: "recordStart", name: `session-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}` },
                            )
                        }
                    >
                        {recording ? t("replay.stopRecording") : t("replay.record")}
                    </Button>
                </div>
                {replays.length === 0 ? (
                    <p className="text-xs text-fg-subtle">{t("replay.empty")}</p>
                ) : (
                    <ul className="space-y-1.5">
                        {replays.map((replay) => (
                            <li
                                key={replay.name}
                                className="flex items-center gap-2 rounded-chip bg-panel-alt px-3 py-2"
                            >
                                <span className="min-w-0 flex-1 truncate text-xs text-fg">{replay.name}</span>
                                <span className="shrink-0 text-[0.625rem] text-fg-subtle">
                                    {t("replay.events", { count: replay.events })}
                                </span>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                        sidecarClient.send({
                                            type: "replayStart",
                                            name: replay.name,
                                            streamId: "main",
                                            speed: 1,
                                            loop: false,
                                        })
                                    }
                                >
                                    {t("replay.play")}
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
            </Card>
        </>
    );
}
