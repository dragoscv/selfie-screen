/** Mirrors assets/pets/pets.json (the Blender pipeline's source of truth). */
export type PetFamily = "quadruped" | "bird" | "dragon" | "robot";

export interface PetInfo {
    id: PetId;
    family: PetFamily;
    /** Real-world height in metres; scales the pet against the shoulder span. */
    heightM: number;
}

export const PET_IDS = ["parrot", "cat", "dragon", "drone", "fox", "owl", "redpanda"] as const;
export type PetId = (typeof PET_IDS)[number];

export const PETS: Readonly<Record<PetId, PetInfo>> = {
    parrot: { id: "parrot", family: "bird", heightM: 0.2 },
    cat: { id: "cat", family: "quadruped", heightM: 0.18 },
    dragon: { id: "dragon", family: "dragon", heightM: 0.22 },
    drone: { id: "drone", family: "robot", heightM: 0.14 },
    fox: { id: "fox", family: "quadruped", heightM: 0.2 },
    owl: { id: "owl", family: "bird", heightM: 0.18 },
    redpanda: { id: "redpanda", family: "quadruped", heightM: 0.2 },
};

/** Average adult biacromial width; maps metres to the shoulder span in pixels. */
export const SHOULDER_WIDTH_M = 0.4;

export function petPixelHeight(pet: PetId, shoulderSpanPx: number): number {
    return (PETS[pet].heightM / SHOULDER_WIDTH_M) * shoulderSpanPx;
}

export function petUrl(base: string, pet: PetId): string {
    return `${base.replace(/\/$/, "")}/${pet}.glb`;
}
