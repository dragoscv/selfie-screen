import { PET_CHOICES, type StudioSettings } from "@tiksee/core";
import { ChipSelector, SliderRow, SwitchRow } from "@tiksee/ui";
import { Aperture, Circle, Crosshair, Minus, Plus, Ruler, ScanFace, ZoomIn, ZoomOut } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { sidecarClient } from "../../lib/sidecar-client.js";
import { useFrame, useStudio } from "./context.js";
import { ActionButton, Section } from "./controls-parts.js";
import { HoldButton } from "./hold-button.js";

/** Studio dock panels (lazy chunk, opened on demand): zoom, focus, look, framing, camera, pets. */

const AF_INTERVALS = ["0", "5", "10", "30", "60"] as const;
const SPEEDS = ["1", "2", "3"] as const;
const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const signed = (v: number, digits = 1) => `${v > 0 ? "+" : ""}${v.toFixed(digits)}`;
export function ZoomPanel() {
    const { studio, controller, frames, patchStudio } = useStudio();
    const { t } = useTranslation();
    const connected = useFrame(frames, (i) => i?.camera.connected ?? false);
    const [speed, setSpeed] = useState<"1" | "2" | "3">("2");
    const sp = Number(speed) as 1 | 2 | 3;
    return (
        <>
            <Section title={t("studio.controls.zoom.optical")}>
                <div className="grid grid-cols-2 gap-2">
                    <HoldButton
                        label={t("studio.controls.zoom.wide")}
                        icon={<ZoomOut className="size-4" aria-hidden />}
                        disabled={!connected}
                        onStart={() => controller.cameraHold("zoomOut", sp)}
                        onStop={() => controller.cameraRelease()}
                    />
                    <HoldButton
                        label={t("studio.controls.zoom.tele")}
                        icon={<ZoomIn className="size-4" aria-hidden />}
                        disabled={!connected}
                        onStart={() => controller.cameraHold("zoomIn", sp)}
                        onStop={() => controller.cameraRelease()}
                    />
                </div>
                <ChipSelector label={t("studio.controls.speed")} options={SPEEDS} value={speed} onSelect={setSpeed} display={(v) => `${v}×`} />
                {!connected && <p className="text-[0.6875rem] text-white/70">{t("studio.controls.bleOffline")}</p>}
            </Section>
            <Section title={t("studio.controls.zoom.digital")}>
                <SliderRow
                    label={t("studio.controls.zoom.digitalLabel")}
                    value={studio.framing.zoom}
                    min={1}
                    max={2.5}
                    step={0.05}
                    format={(v) => `${v.toFixed(2)}×`}
                    onCommit={(zoom) => patchStudio({ framing: { ...studio.framing, zoom } })}
                />
            </Section>
            <Section title={t("studio.controls.zoom.pinch.title")}>
                <SwitchRow
                    label={t("studio.controls.zoom.pinch.label")}
                    description={t("studio.controls.zoom.pinch.hint")}
                    checked={studio.framing.pinchZoom}
                    onChange={(pinchZoom) => patchStudio({ framing: { ...studio.framing, pinchZoom } })}
                />
                <SwitchRow
                    label={t("studio.controls.zoom.pinch.dial")}
                    description={t("studio.controls.zoom.pinch.dialHint")}
                    checked={studio.framing.dialZoom}
                    onChange={(dialZoom) => patchStudio({ framing: { ...studio.framing, dialZoom } })}
                />
                {(studio.framing.pinchZoom || studio.framing.dialZoom) && (
                    <>
                        <SwitchRow
                            label={t("studio.controls.zoom.pinch.optical")}
                            description={t("studio.controls.zoom.pinch.opticalHint")}
                            checked={studio.framing.pinchOptical}
                            onChange={(pinchOptical) => patchStudio({ framing: { ...studio.framing, pinchOptical } })}
                        />
                        {studio.framing.pinchOptical && (
                            <>
                                <SliderRow
                                    label={t("studio.controls.zoom.pinch.range")}
                                    value={studio.framing.opticalRange}
                                    min={1}
                                    max={10}
                                    step={0.1}
                                    format={(v) => `${v.toFixed(1)}×`}
                                    onCommit={(opticalRange) => patchStudio({ framing: { ...studio.framing, opticalRange } })}
                                />
                                <SliderRow
                                    label={t("studio.controls.zoom.pinch.travel")}
                                    value={studio.framing.opticalTravelS}
                                    min={0.5}
                                    max={15}
                                    step={0.1}
                                    format={(v) => `${v.toFixed(1)} s`}
                                    onCommit={(opticalTravelS) => patchStudio({ framing: { ...studio.framing, opticalTravelS } })}
                                />
                                <p className="text-[0.6875rem] text-white/70">{t("studio.controls.zoom.pinch.travelHint")}</p>
                            </>
                        )}
                    </>
                )}
            </Section>
        </>
    );
}

export function FocusPanel({ onLoupe }: { onLoupe: (on: boolean) => void }) {
    const { studio, controller, frames, patchStudio } = useStudio();
    const { t } = useTranslation();
    const connected = useFrame(frames, (i) => i?.camera.connected ?? false);
    const [speed, setSpeed] = useState<"1" | "2" | "3">("1");
    const sp = Number(speed) as 1 | 2 | 3;
    return (
        <>
            <Section title={t("studio.controls.focus.auto")}>
                <ActionButton icon={<ScanFace className="size-4" aria-hidden />} label={t("studio.controls.focus.af")} onClick={() => void controller.run({ type: "camera", action: "af" })} />
                <ChipSelector
                    label={t("studio.controls.focus.interval")}
                    options={AF_INTERVALS}
                    value={String(studio.framing.afIntervalS) as (typeof AF_INTERVALS)[number]}
                    onSelect={(v) => patchStudio({ framing: { ...studio.framing, afIntervalS: Number(v) } })}
                    display={(v) => (v === "0" ? t("studio.common.off") : t("studio.controls.focus.everyS", { s: v }))}
                />
            </Section>
            <Section title={t("studio.controls.focus.manual")}>
                <div className="grid grid-cols-2 gap-2">
                    <HoldButton
                        label={t("studio.controls.focus.near")}
                        icon={<Minus className="size-4" aria-hidden />}
                        disabled={!connected}
                        onStart={() => controller.cameraHold("focusNear", sp)}
                        onStop={() => controller.cameraRelease()}
                    />
                    <HoldButton
                        label={t("studio.controls.focus.far")}
                        icon={<Plus className="size-4" aria-hidden />}
                        disabled={!connected}
                        onStart={() => controller.cameraHold("focusFar", sp)}
                        onStop={() => controller.cameraRelease()}
                    />
                </div>
                <ChipSelector label={t("studio.controls.speed")} options={SPEEDS} value={speed} onSelect={setSpeed} display={(v) => `${v}×`} />
                <HoldButton
                    label={t("studio.controls.focus.loupe", { zoom: studio.monitor.loupeZoom })}
                    icon={<Crosshair className="size-4" aria-hidden />}
                    onStart={() => onLoupe(true)}
                    onStop={() => onLoupe(false)}
                    className="w-full"
                />
            </Section>
        </>
    );
}

export function LookPanel() {
    const { studio, patchStudio } = useStudio();
    const { t } = useTranslation();
    return (
        <Section title={t("studio.controls.look.title")}>
            <SliderRow label={t("studio.controls.look.exposure")} value={studio.exposure} min={-2} max={2} step={0.1} format={(v) => `${signed(v)} EV`} onCommit={(exposure) => patchStudio({ exposure })} />
            <SliderRow label={t("studio.controls.look.warmth")} value={studio.warmth} min={-1} max={1} step={0.05} format={(v) => signed(v, 2)} onCommit={(warmth) => patchStudio({ warmth })} />
            <SliderRow label={t("studio.controls.look.smoothing")} value={studio.smoothing} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onCommit={(smoothing) => patchStudio({ smoothing })} />
            <SliderRow label={t("studio.controls.look.blur")} value={studio.backgroundBlur} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onCommit={(backgroundBlur) => patchStudio({ backgroundBlur })} />
        </Section>
    );
}
export function FramingPanel() {
    const { studio, patchStudio } = useStudio();
    const { t } = useTranslation();
    const f = studio.framing;
    const set = (p: Partial<StudioSettings["framing"]>) => patchStudio({ framing: { ...f, ...p } });
    return (
        <>
            <Section title={t("studio.controls.framing.reframe")}>
                <SwitchRow label={t("studio.controls.framing.auto")} description={t("studio.controls.framing.autoHint")} checked={f.autoReframe} onChange={(autoReframe) => set({ autoReframe })} />
                <SwitchRow label={t("studio.controls.framing.smartWide")} checked={f.smartWide} onChange={(smartWide) => set({ smartWide })} />
                <SliderRow label={t("studio.controls.framing.deadZone")} value={f.deadZone} min={0} max={0.3} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onCommit={(deadZone) => set({ deadZone })} disabled={!f.autoReframe} />
            </Section>
            <Section title={t("studio.controls.framing.dof")}>
                <SwitchRow label={t("studio.controls.framing.dofOn")} checked={f.dof} onChange={(dof) => set({ dof })} />
                <SliderRow label={t("studio.controls.framing.dofStrength")} value={f.dofStrength} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onCommit={(dofStrength) => set({ dofStrength })} disabled={!f.dof} />
            </Section>
        </>
    );
}

export function CameraPanel({ onSpace }: { onSpace: () => void }) {
    const { controller, frames, studio } = useStudio();
    const { t } = useTranslation();
    const recording = useFrame(frames, (i) => i?.camera.recording ?? false);
    const [counting, setCounting] = useState(false);
    const photo = async () => {
        if (counting) return;
        setCounting(true);
        try {
            await controller.run({ type: "effect", effect: "countdown" });
            await sleep(3000);
            await controller.run({ type: "camera", action: "photo" });
        } finally {
            setCounting(false);
        }
    };
    return (
        <Section title={t("studio.controls.camera.title")}>
            <div className="grid grid-cols-2 gap-2">
                <ActionButton icon={<Aperture className="size-4" aria-hidden />} label={counting ? t("studio.controls.camera.counting") : t("studio.controls.camera.photo")} onClick={() => void photo()} />
                <ActionButton
                    icon={<Circle className={`size-4 ${recording ? "fill-white" : "fill-red-500 text-red-500"}`} aria-hidden />}
                    label={recording ? t("studio.controls.camera.stop") : t("studio.controls.camera.record")}
                    active={recording}
                    onClick={() => void controller.run({ type: "camera", action: "record" })}
                />
            </div>
            <p className="text-[0.6875rem] text-white/70">{t("studio.controls.camera.hint")}</p>
            <ActionButton icon={<Ruler className="size-4" aria-hidden />} label={t("studio.space.open")} onClick={onSpace} />
            <p className="text-[0.6875rem] text-white/70">
                {studio.space.calibratedAt > 0 ? t("studio.space.calibratedShort", { vfov: Math.round(studio.vfovDeg) }) : t("studio.space.notCalibrated")}
            </p>
        </Section>
    );
}

export function PetsPanel() {
    const { studio, petsHidden, patchStudio } = useStudio();
    const { t } = useTranslation();
    return (
        <Section title={t("studio.controls.pets.title")}>
            <ChipSelector label={t("studio.controls.pets.left")} options={PET_CHOICES} value={studio.leftPet} onSelect={(leftPet) => patchStudio({ leftPet })} display={(v) => t(`studio.pets.${v}`)} />
            <ChipSelector label={t("studio.controls.pets.right")} options={PET_CHOICES} value={studio.rightPet} onSelect={(rightPet) => patchStudio({ rightPet })} display={(v) => t(`studio.pets.${v}`)} />
            <SwitchRow
                label={t("studio.controls.pets.hide")}
                checked={petsHidden}
                onChange={(hide) => sidecarClient.send({ type: "control", action: hide ? "petsHide" : "petsShow" })}
            />
        </Section>
    );
}
