import { describe, expect, it } from "vitest";

import { draftToSpec, splitList, wheelRotation } from "./games.js";

describe("splitList", () => {
    it("splits on lines, commas and semicolons, trimming and de-duplicating", () => {
        expect(splitList("Da\n nu ,da; poate\n\n", 6)).toEqual(["Da", "nu", "poate"]);
        expect(splitList("a,b,c,d", 2)).toEqual(["a", "b"]);
    });
});

describe("draftToSpec", () => {
    it("builds valid specs and rejects incomplete drafts", () => {
        expect(draftToSpec({ kind: "poll", question: "Ce joc?", list: "A\nB", keyword: "" })).toEqual({ kind: "poll", question: "Ce joc?", options: ["A", "B"] });
        expect(draftToSpec({ kind: "poll", question: "Ce joc?", list: "A", keyword: "" })).toBeNull();
        expect(draftToSpec({ kind: "quiz", question: "", list: "Paris", keyword: "" })).toBeNull();
        expect(draftToSpec({ kind: "quiz", question: "Capitala?", list: "Paris", keyword: "" })).toMatchObject({ answers: ["Paris"] });
        expect(draftToSpec({ kind: "wheel", question: "", list: "", keyword: "  tombola " })).toEqual({ kind: "wheel", keyword: "tombola" });
        expect(draftToSpec({ kind: "wheel", question: "", list: "", keyword: " " })).toBeNull();
    });
});

describe("wheelRotation", () => {
    it("lands the winner's segment centre under the top pointer", () => {
        for (const [index, count] of [[0, 4], [3, 4], [7, 24], [0, 1]] as const) {
            const deg = wheelRotation(index, count);
            const seg = 360 / count;
            // The segment centre starts at (index + 0.5) * seg; after rotating it sits at 0 mod 360.
            const centre = (((index + 0.5) * seg + deg) % 360 + 360) % 360;
            expect(centre).toBeCloseTo(0, 6);
            expect(deg).toBeGreaterThan(5 * 360);
        }
    });

    it("clamps an out-of-range index", () => {
        expect(wheelRotation(99, 4)).toBe(wheelRotation(3, 4));
    });
});
