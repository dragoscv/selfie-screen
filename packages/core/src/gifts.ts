import type { ChatEvent } from "./events.js";

/**
 * Diamond values for common TikTok gifts. The webcast payload usually carries
 * the real `diamondCount`, so this table is only a fallback for the replay
 * engine, the sniffer driver, and historical rows recorded before gift
 * metadata was captured.
 */
const GIFT_DIAMONDS: Readonly<Record<string, number>> = {
    rose: 1,
    "tiktok!": 1,
    ice_cream_cone: 1,
    "ice cream cone": 1,
    gg: 1,
    heart: 1,
    thumbs_up: 1,
    "thumbs up": 1,
    finger_heart: 5,
    "finger heart": 5,
    "cheer you up": 9,
    cheer_you_up: 9,
    friendship_necklace: 10,
    perfume: 20,
    "doughnut": 30,
    donut: 30,
    paper_crane: 99,
    "paper crane": 99,
    "little crown": 99,
    hand_hearts: 100,
    "hand hearts": 100,
    "sunglasses": 199,
    hat_and_mustache: 99,
    love_you: 199,
    "love you": 199,
    corgi: 299,
    "dancing flower": 499,
    boxing_gloves: 299,
    "swan": 699,
    "train": 899,
    galaxy: 1000,
    "money gun": 500,
    money_gun: 500,
    "diamond ring": 1500,
    fireworks: 1088,
    "sports car": 7000,
    sports_car: 7000,
    "leon and lion": 34000,
    lion: 29999,
    universe: 34999,
    "planet": 15000,
    rocket: 20000,
    "tiktok universe": 44999,
};

/** Diamond value of a single unit of the named gift, or 0 when unknown. */
export function giftDiamonds(giftName: string | undefined): number {
    if (!giftName) return 0;
    return GIFT_DIAMONDS[giftName.trim().toLowerCase()] ?? 0;
}

/**
 * Total diamonds an event is worth. Prefers the value reported by the
 * protocol; falls back to the catalogue only when the payload lacked it.
 */
export function eventDiamonds(event: ChatEvent): number {
    if (event.kind !== "gift") return 0;
    const count = event.giftCount ?? 1;
    const unit = event.giftDiamonds ?? giftDiamonds(event.giftName);
    return unit * count;
}

/**
 * Estimated creator payout. TikTok pays roughly half a US cent per diamond
 * before platform fees, so this is deliberately labelled an estimate in the UI.
 */
export function diamondsToUsd(diamonds: number, rateUsd = 0.005): number {
    return Math.round(diamonds * rateUsd * 100) / 100;
}

/** Format a whole-diamond count compactly: `1.2K`, `34.9K`. */
export function formatDiamonds(diamonds: number, locale = "en"): string {
    return new Intl.NumberFormat(locale, {
        notation: diamonds >= 10_000 ? "compact" : "standard",
        maximumFractionDigits: 1,
    }).format(diamonds);
}
