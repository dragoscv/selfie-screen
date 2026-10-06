import { SEED_DOGS, type IdentityProfile, type ProfileKind } from "@tiksee/core";
import { Button, Card, EmptyState, StatusPill, SwitchRow } from "@tiksee/ui";
import { emitTo } from "@tauri-apps/api/event";
import { Dog, Pencil, Plus, ScanFace, Trash2, User, UserRound, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { sidecarClient } from "../../lib/sidecar-client.js";
import { useOpenStudio, useVisionSettings } from "../../lib/vision/use-vision.js";
import { useAppStore } from "../../store/app-store.js";
import { ConfirmDialog, MiniSelect, MiniText } from "./fields.js";

const ORDER: Record<ProfileKind, number> = { owner: 0, person: 1, dog: 2 };
const ICON = { owner: UserRound, person: User, dog: Dog } as const;

function newProfileId(kind: ProfileKind, name: string): string {
    const slug = name
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24);
    return `${kind}-${slug || "x"}-${Date.now().toString(36)}`.slice(0, 64);
}

function upsert(profile: IdentityProfile): void {
    sidecarClient.send({ type: "identityUpsert", profile });
}

export function PeopleTab() {
    const { t, i18n } = useTranslation();
    const [vision, patch] = useVisionSettings();
    const identities = useAppStore((s) => s.identities);
    const openStudio = useOpenStudio();
    const [editing, setEditing] = useState<string | null>(null);
    const [adding, setAdding] = useState<{ name: string; kind: ProfileKind; note: string } | null>(null);
    const [deleting, setDeleting] = useState<IdentityProfile | null>(null);

    const sorted = useMemo(
        () => [...identities].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.name.localeCompare(b.name, i18n.language)),
        [identities, i18n.language],
    );
    const hasOwner = identities.some((p) => p.kind === "owner");
    const missingDogs = SEED_DOGS.filter((d) => !identities.some((p) => p.kind === "dog" && p.name.toLowerCase() === d.name.toLowerCase()));

    const create = (name: string, kind: ProfileKind, note: string) => {
        const now = Date.now();
        upsert({ id: newProfileId(kind, name), name: name.trim().slice(0, 60), kind, note: note.slice(0, 200), embeddings: [], createdAt: now, updatedAt: now });
    };

    const enrol = async (profile: IdentityProfile) => {
        try {
            await openStudio();
            await emitTo("studio", "studio://enrol", { profileId: profile.id, kind: profile.kind });
            toast(t("vision.people.enrolSent", { name: profile.name }));
        } catch {
            toast.error(t("common.error"));
        }
    };

    return (
        <div className="flex flex-col gap-3">
            <Card title={t("vision.people.identityTitle")} subtitle={t("vision.people.identityHint")} icon={<ScanFace />} tint="var(--kind-join)">
                <SwitchRow
                    label={t("vision.people.identity")}
                    description={t("vision.people.identityPrivacy")}
                    checked={vision.identity}
                    onChange={(identity) => patch({ identity })}
                    tint="var(--kind-join)"
                />
                <p className="text-[0.6875rem] text-fg-muted">{t("vision.people.modelsNote")}</p>
            </Card>

            <Card
                title={t("vision.people.title")}
                subtitle={t("vision.people.hint")}
                icon={<Users />}
                actions={
                    <Button size="sm" icon={<Plus />} onClick={() => setAdding({ name: "", kind: hasOwner ? "person" : "owner", note: "" })}>
                        {t("vision.people.add")}
                    </Button>
                }
            >
                {adding && (
                    <form
                        className="grid grid-cols-1 gap-2 rounded-chip border border-border/70 p-2 sm:grid-cols-[1fr_9rem_1fr_auto]"
                        onSubmit={(e) => {
                            e.preventDefault();
                            if (adding.name.trim() === "") return;
                            create(adding.name, adding.kind, adding.note);
                            setAdding(null);
                        }}
                    >
                        <MiniText label={t("vision.people.name")} value={adding.name} maxLength={60} invalid={adding.name.trim() === ""} onChange={(name) => setAdding({ ...adding, name })} />
                        <MiniSelect
                            label={t("vision.people.kind")}
                            value={adding.kind}
                            options={(["owner", "person", "dog"] as const)
                                .filter((k) => k !== "owner" || !hasOwner)
                                .map((k) => ({ value: k, label: t(`vision.kinds.${k}`) }))}
                            onChange={(kind) => setAdding({ ...adding, kind: kind as ProfileKind })}
                        />
                        <MiniText label={t("vision.people.note")} value={adding.note} maxLength={200} onChange={(note) => setAdding({ ...adding, note })} />
                        <div className="flex items-end gap-1">
                            <Button type="submit" size="sm" disabled={adding.name.trim() === ""}>
                                {t("common.save")}
                            </Button>
                            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(null)}>
                                {t("common.cancel")}
                            </Button>
                        </div>
                    </form>
                )}

                {missingDogs.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 rounded-chip bg-panel-alt p-2">
                        <span className="text-[0.6875rem] text-fg-muted">{t("vision.people.seedDogs")}</span>
                        {missingDogs.map((d) => (
                            <Button key={d.name} size="sm" variant="soft" icon={<Dog />} onClick={() => create(d.name, "dog", d.note)}>
                                {d.name} <span className="font-normal text-fg-muted">({d.note})</span>
                            </Button>
                        ))}
                    </div>
                )}

                {sorted.length === 0 ? (
                    <EmptyState icon={<Users />} title={t("vision.people.empty")} description={t("vision.people.emptyHint")} />
                ) : (
                    <ul className="flex flex-col gap-2">
                        {sorted.map((p) => {
                            const Icon = ICON[p.kind];
                            const isEditing = editing === p.id;
                            return (
                                <li key={p.id} className="flex flex-col gap-2 rounded-chip border border-border/60 bg-panel-alt p-2">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <Icon className="size-4 shrink-0 text-accent" aria-hidden />
                                        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">
                                            {p.name}
                                            {p.note && <span className="ml-2 text-xs font-normal text-fg-muted">{p.note}</span>}
                                        </p>
                                        <StatusPill tone={p.kind === "owner" ? "accent" : "neutral"}>{t(`vision.kinds.${p.kind}`)}</StatusPill>
                                        <StatusPill tone={p.embeddings.length > 0 ? "success" : "warning"}>
                                            {t("vision.people.samples", { count: p.embeddings.length })}
                                        </StatusPill>
                                    </div>
                                    {isEditing ? (
                                        <ProfileEditor
                                            profile={p}
                                            onDone={(next) => {
                                                if (next) upsert({ ...next, updatedAt: Date.now() });
                                                setEditing(null);
                                            }}
                                        />
                                    ) : (
                                        <div className="flex flex-wrap gap-1">
                                            <Button size="sm" variant="soft" icon={<ScanFace />} disabled={!vision.identity} onClick={() => void enrol(p)} title={vision.identity ? undefined : t("vision.people.enableFirst")}>
                                                {p.embeddings.length > 0 ? t("vision.people.addSamples") : t("vision.people.enrol")}
                                            </Button>
                                            <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => setEditing(p.id)}>
                                                {t("vision.people.edit")}
                                            </Button>
                                            <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => setDeleting(p)}>
                                                {t("common.delete")}
                                            </Button>
                                        </div>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </Card>

            <ConfirmDialog
                open={deleting !== null}
                title={t("vision.people.deleteTitle", { name: deleting?.name ?? "" })}
                body={t("vision.people.deleteBody")}
                confirmLabel={t("vision.people.deleteConfirm")}
                danger
                onClose={() => setDeleting(null)}
                onConfirm={() => {
                    if (deleting) sidecarClient.send({ type: "identityDelete", id: deleting.id });
                }}
            />
        </div>
    );
}

function ProfileEditor({ profile, onDone }: { profile: IdentityProfile; onDone: (next: IdentityProfile | null) => void }) {
    const { t } = useTranslation();
    const [name, setName] = useState(profile.name);
    const [note, setNote] = useState(profile.note);
    return (
        <form
            className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]"
            onSubmit={(e) => {
                e.preventDefault();
                if (name.trim() === "") return;
                onDone({ ...profile, name: name.trim().slice(0, 60), note: note.slice(0, 200) });
            }}
        >
            <MiniText label={t("vision.people.name")} value={name} maxLength={60} invalid={name.trim() === ""} onChange={setName} />
            <MiniText label={t("vision.people.note")} value={note} maxLength={200} onChange={setNote} />
            <div className="flex items-end gap-1">
                <Button type="submit" size="sm" disabled={name.trim() === ""}>
                    {t("common.save")}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => onDone(null)}>
                    {t("common.cancel")}
                </Button>
            </div>
        </form>
    );
}
