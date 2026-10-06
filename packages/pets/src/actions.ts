/**
 * The utility AI's action set (mind.ts). Kept in its own module so the
 * personality layer can use it without an import cycle. Mirrored by
 * PET_ACTION_KINDS in @tiksee/core vision.ts (core cannot depend on pets).
 */
export const ACTION_KINDS = [
    "perchShoulder",
    "perchHead",
    "landOnHand",
    "restOnLedge",
    "orbit",
    "watchOwner",
    "watchCohost",
    "visitPet",
    "playWithPet",
    "celebrate",
    "sleep",
    "inspectPoint",
    "greetViewers",
    /** The pet wants to say something (the stage asks the LLM for a line). */
    "chatter",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
