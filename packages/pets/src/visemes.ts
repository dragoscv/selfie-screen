/**
 * Azure Speech viseme ids 0–21 (what codai-tts-ro streams) folded onto the 8
 * mouth shape keys every pet carries (Q36). Names match the glTF morph targets
 * `mouth_<shape>` written by assets/pets/blender/build.py.
 */
export const MOUTH_SHAPES = ["rest", "aa", "ee", "ih", "oh", "ou", "fv", "mbp"] as const;
export type MouthShape = (typeof MOUTH_SHAPES)[number];

// https://learn.microsoft.com/azure/ai-services/speech-service/how-to-speech-synthesis-viseme
const AZURE_TO_MOUTH: readonly MouthShape[] = [
    "rest", // 0 silence
    "aa", // 1 æ ə ʌ
    "aa", // 2 ɑ
    "oh", // 3 ɔ
    "ee", // 4 ɛ ʊ
    "ee", // 5 ɝ
    "ih", // 6 j i ɪ
    "ou", // 7 w u
    "oh", // 8 o
    "aa", // 9 aʊ
    "oh", // 10 ɔɪ
    "aa", // 11 aɪ
    "ih", // 12 h
    "ou", // 13 ɹ
    "ih", // 14 l
    "ih", // 15 s z
    "ou", // 16 ʃ tʃ dʒ ʒ
    "ih", // 17 ð
    "fv", // 18 f v
    "ih", // 19 d t n θ
    "ih", // 20 k g ŋ
    "mbp", // 21 p b m
];

export function mouthForViseme(id: number): MouthShape {
    return AZURE_TO_MOUTH[id] ?? "rest";
}

export interface VisemeEvent {
    id: number;
    offsetMs: number;
}

/**
 * Per-shape weights at `tMs` into an utterance: cross-fades the current and
 * next viseme over `blendMs` so the mouth never snaps.
 */
export function mouthWeights(
    visemes: readonly VisemeEvent[],
    tMs: number,
    blendMs = 60,
): Record<MouthShape, number> {
    const w = Object.fromEntries(MOUTH_SHAPES.map((s) => [s, 0])) as Record<MouthShape, number>;
    let i = -1;
    for (let k = 0; k < visemes.length; k++) {
        const v = visemes[k];
        if (v && v.offsetMs <= tMs) i = k;
        else break;
    }
    const cur = visemes[i];
    if (!cur) {
        w.rest = 1;
        return w;
    }
    const next = visemes[i + 1];
    const toNext = next ? next.offsetMs - tMs : Infinity;
    const mix = toNext < blendMs ? 1 - toNext / blendMs : 0;
    const a = mouthForViseme(cur.id);
    w[a] += 1 - mix;
    if (next && mix > 0) w[mouthForViseme(next.id)] += mix;
    return w;
}
