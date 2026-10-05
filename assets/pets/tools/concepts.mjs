// Generate concept images per pet on Vertex AI (gemini-3-pro-image; Imagen is
// not enabled on the project), the input of image-to-3D (TRELLIS.2). Usage:
//   $env:GCP_TOKEN = gcloud auth print-access-token
//   node assets/pets/tools/concepts.mjs [pet ...]
// Writes assets/pets/concepts/<pet>-<n>.png. The token is read from the
// environment and never printed.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PETS } from "./pets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "concepts");
const project = process.env.GCP_PROJECT ?? "codai-inference";
const model = process.env.IMAGE_MODEL ?? "gemini-3-pro-image";
const samples = Number(process.env.SAMPLES ?? 2);
const token = process.env.GCP_TOKEN;
if (!token) throw new Error("GCP_TOKEN is not set");

const STYLE =
    "Stylized 3D character render in a premium animated-feature style, cute chibi proportions, big expressive glossy eyes, " +
    "soft rounded shapes, clean readable silhouette, full body fully visible and centered, symmetric neutral pose, " +
    "three-quarter front view, plain light grey seamless background, soft even studio lighting, no ground shadow, " +
    "no text, no props, single character only";

const wanted = process.argv.slice(2);
const pets = PETS.filter((p) => wanted.length === 0 || wanted.includes(p.id));
mkdirSync(out, { recursive: true });

for (const pet of pets) {
    const url = `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models/${model}:generateContent`;
    const body = {
        contents: [{ role: "user", parts: [{ text: `${pet.concept}. ${STYLE}.` }] }],
        generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "1:1" } },
    };
    for (let n = 1; n <= samples; n++) {
        const res = await fetch(url, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            console.error(`${pet.id}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
            continue;
        }
        const json = await res.json();
        const parts = json.candidates?.[0]?.content?.parts ?? [];
        const img = parts.find((p) => p.inlineData?.data);
        if (!img) {
            console.error(`${pet.id}: no image ${JSON.stringify(json).slice(0, 200)}`);
            continue;
        }
        const file = join(out, `${pet.id}-${n}.png`);
        writeFileSync(file, Buffer.from(img.inlineData.data, "base64"));
        console.log(`${pet.id}: ${file}`);
    }
}
