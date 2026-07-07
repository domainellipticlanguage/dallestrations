import Replicate from "replicate";
import { extensionFor, fetchImage, uploadImage } from "./s3.js";

// Lazy singleton so a warm Lambda reuses the client's connection pool.
let _replicate: Replicate | undefined;
const replicate = () =>
  (_replicate ??= new Replicate({ auth: process.env.REPLICATE_API_TOKEN }));

const MODEL = () =>
  (process.env.IMAGE_MODEL ?? "black-forest-labs/flux-2-klein-4b") as `${string}/${string}`;

export const imagesPerPrompt = () => {
  const n = Number(process.env.IMAGES_PER_PROMPT ?? "2");
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 4) : 2;
};

/** Replicate returns FileOutput | FileOutput[] | string[] depending on model/version. */
function toOutputUrl(output: unknown): string {
  const first = Array.isArray(output) ? output[0] : output;
  if (!first) throw new Error("Replicate returned no output");
  if (typeof first === "string") return first;
  if (typeof (first as { url?: () => URL }).url === "function") {
    return (first as { url: () => URL }).url().toString();
  }
  throw new Error(`Unrecognized Replicate output shape: ${typeof first}`);
}

async function generateOne(prompt: string): Promise<{ body: Buffer; contentType: string }> {
  const started = Date.now();
  const output = await replicate().run(MODEL(), {
    input: {
      prompt,
      aspect_ratio: "1:1",
      output_megapixels: process.env.ART_MEGAPIXELS ?? "1",
    },
  });
  const image = await fetchImage(toOutputUrl(output));
  console.log(`image generated in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return image;
}

/**
 * Generate N interpretations of the prompt in parallel and store them in S3.
 * Succeeds if at least one image succeeds (mirrors the old ensemble behavior).
 */
export async function generateAndStoreImages(
  prompt: string,
  roomId: string,
  promptId: string
): Promise<string[]> {
  const n = imagesPerPrompt();
  const results = await Promise.allSettled(
    Array.from({ length: n }, async (_, i) => {
      const { body, contentType } = await generateOne(prompt);
      const key = `rooms/${roomId}/${promptId}/${i}.${extensionFor(contentType)}`;
      return uploadImage(key, body, contentType);
    })
  );
  const urls = results
    .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
    .map((r) => r.value);
  const failures = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  failures.forEach((f) => console.error("image generation failed:", f.reason));
  if (urls.length === 0) {
    throw new Error(`All ${n} image generations failed: ${failures[0]?.reason}`);
  }
  return urls;
}
