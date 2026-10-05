import { describe, expect, it } from "vitest";

import en from "./en.json";
import ro from "./ro.json";

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): string[] {
    return Object.entries(tree).flatMap(([key, value]) => {
        const path = prefix === "" ? key : `${prefix}.${key}`;
        return typeof value === "string" ? [path] : flatten(value, path);
    });
}

const enKeys = flatten(en);
const roKeys = flatten(ro);

describe("i18n parity (WS15-09)", () => {
    it("en and ro have exactly the same keys, ignoring Romanian-only _few plurals", () => {
        const roComparable = roKeys.filter((key) => !key.endsWith("_few")).sort();
        const missingInRo = enKeys.filter((key) => !roComparable.includes(key));
        const missingInEn = roComparable.filter((key) => !enKeys.includes(key));
        expect({ missingInRo, missingInEn }).toEqual({ missingInRo: [], missingInEn: [] });
    });

    it("every Romanian _few plural has its _one and _other siblings", () => {
        const orphans = roKeys
            .filter((key) => key.endsWith("_few"))
            .map((key) => key.slice(0, -"_few".length))
            .filter((base) => !roKeys.includes(`${base}_one`) || !roKeys.includes(`${base}_other`));
        expect(orphans).toEqual([]);
    });

    it("every Romanian plural with _one/_other also has _few", () => {
        const missingFew = roKeys
            .filter((key) => key.endsWith("_other"))
            .map((key) => key.slice(0, -"_other".length))
            .filter((base) => roKeys.includes(`${base}_one`) && !roKeys.includes(`${base}_few`));
        expect(missingFew).toEqual([]);
    });

    it("English never uses the Romanian-only _few form", () => {
        expect(enKeys.filter((key) => key.endsWith("_few"))).toEqual([]);
    });

    it("no value is empty", () => {
        const empty = (tree: Tree) => flatten(tree).filter((key) => {
            const value = key.split(".").reduce<string | Tree | undefined>(
                (node, part) => (typeof node === "object" ? node[part] : undefined),
                tree,
            );
            return typeof value !== "string" || value.trim() === "";
        });
        expect({ en: empty(en), ro: empty(ro) }).toEqual({ en: [], ro: [] });
    });
});
