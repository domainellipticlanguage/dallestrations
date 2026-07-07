import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const s3 = new S3Client({});

const BUCKET = () => {
  const b = process.env.S3_BUCKET;
  if (!b) throw new Error("S3_BUCKET not set");
  return b;
};

export async function uploadImage(
  key: string,
  body: Buffer,
  contentType: string
): Promise<string> {
  const bucket = BUCKET();
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
    })
  );
  return `https://${bucket}.s3.amazonaws.com/${encodeURI(key)}`;
}

/** Download an image URL to a buffer + content type. */
export async function fetchImage(
  url: string
): Promise<{ body: Buffer; contentType: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image: HTTP ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "image/png";
  const body = Buffer.from(await res.arrayBuffer());
  return { body, contentType };
}

export function extensionFor(contentType: string): string {
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("gif")) return "gif";
  return "png";
}
