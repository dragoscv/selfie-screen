// Single catalogue of pets for the asset tools (concepts, image-to-3D,
// optimisation). The Blender scripts read assets/pets/pets.json, written from
// this file by `node assets/pets/tools/pets.mjs`.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {"quadruped" | "bird" | "dragon" | "robot"} Family */

/** @type {{ id: string, family: Family, heightM: number, concept: string }[]} */
export const PETS = [
    {
        id: "parrot",
        family: "bird",
        heightM: 0.2,
        concept:
            "A small scarlet macaw parrot sitting upright with wings folded, vivid red head and chest, yellow and blue wing bands, curved ivory beak, short tail",
    },
    {
        id: "cat",
        family: "quadruped",
        heightM: 0.18,
        concept:
            "A small fluffy orange tabby kitten standing on four legs, white chest and paws, big ears, long curled tail, small closed smile",
    },
    {
        id: "dragon",
        family: "dragon",
        heightM: 0.22,
        concept:
            "A baby dragon standing on four legs with small folded bat wings, teal scales, cream belly plates, two short rounded horns, small spikes along the back, chubby body",
    },
    {
        id: "drone",
        family: "robot",
        heightM: 0.14,
        concept:
            "A small friendly hovering robot drone mascot, round glossy white shell, a dark visor face with two glowing cyan eyes, four tiny propeller arms, accents in blue yellow and red",
    },
    {
        id: "fox",
        family: "quadruped",
        heightM: 0.2,
        concept:
            "A small red fox cub standing on four legs, orange fur, white chest muzzle and tail tip, black socks, big pointed ears, very fluffy tail",
    },
    {
        id: "owl",
        family: "bird",
        heightM: 0.18,
        concept:
            "A small round snowy-brown owl chick perched upright with wings folded, fluffy feathers, big round amber eyes, tiny beak, small ear tufts",
    },
    {
        id: "redpanda",
        family: "quadruped",
        heightM: 0.2,
        concept:
            "A small red panda cub standing on four legs, rusty red fur, white face markings, dark legs, big ringed fluffy tail, round ears",
    },
];

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const file = join(dirname(fileURLToPath(import.meta.url)), "..", "pets.json");
    writeFileSync(file, `${JSON.stringify(PETS, null, 2)}\n`);
    console.log(file);
}
