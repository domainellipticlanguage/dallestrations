/**
 * Migrate dallestrations data from the old Heroku Postgres + Cloudinary setup
 * into the new DynamoDB table + S3 bucket.
 *
 * The old app stored every model as a JSON blob in a single key-value table:
 *   objects(key TEXT PRIMARY KEY, value TEXT)
 * with keys like "dev:GameRoom:<uuid>", "dev:Player:<uuid>", "dev:Prompt:<uuid>".
 *
 * Usage:
 *   DATABASE_URL=<old postgres url> DYNAMODB_TABLE=<table> S3_BUCKET=<bucket> \
 *   npx tsx scripts/migrate.ts [--dry-run] [--skip-images]
 *
 * Idempotent: prompts/players/rooms are keyed deterministically by their old
 * UUIDs, and images are re-uploaded to the same S3 keys on re-run.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import pg from "pg";
import { extensionFor, fetchImage, uploadImage } from "../src/s3.js";

const DRY_RUN = process.argv.includes("--dry-run");
const SKIP_IMAGES = process.argv.includes("--skip-images");
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

interface OldGameRoom {
  id: string;
  createdAt: string;
  gameRoomCode: string;
  isStarted: boolean;
  isFinished: boolean;
  numberRounds: number;
  currentRound: number;
}
interface OldPlayer {
  id: string;
  createdAt: string;
  cookieCode: string;
  playerName: string;
  sortOrder: string;
  gameRoomId: string;
  isAdmin: boolean;
  isBot: boolean;
}
interface OldPrompt {
  id: string;
  createdAt: string;
  gameRoomId: string;
  gameRound: number;
  playerId: string;
  imageUrlList: string[];
  promptText: string;
  parentPromptId: string | null;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var is required`);
  return v;
}

async function loadOldData() {
  const client = new pg.Client({
    connectionString: need("DATABASE_URL"),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  const res = await client.query<{ key: string; value: string }>(
    "SELECT key, value FROM objects"
  );
  await client.end();

  const rooms: OldGameRoom[] = [];
  const players: OldPlayer[] = [];
  const prompts: OldPrompt[] = [];
  for (const row of res.rows) {
    const [, className] = row.key.split(":");
    try {
      const obj = JSON.parse(row.value);
      if (className === "GameRoom") rooms.push(obj);
      else if (className === "Player") players.push(obj);
      else if (className === "Prompt") prompts.push(obj);
      else console.warn(`Skipping unknown class in key ${row.key}`);
    } catch {
      console.warn(`Skipping unparseable row ${row.key}`);
    }
  }
  return { rooms, players, prompts };
}

/** Download a Cloudinary image and re-home it in S3. Falls back to the old URL. */
async function migrateImage(url: string, key: string): Promise<string> {
  try {
    const { body, contentType } = await fetchImage(url.replace(/^http:/, "https:"));
    return await uploadImage(`${key}.${extensionFor(contentType)}`, body, contentType);
  } catch (err) {
    console.warn(`  ! image migration failed for ${url}: ${err} — keeping old URL`);
    return url;
  }
}

async function batchWrite(items: Record<string, unknown>[]) {
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    let requests = chunk.map((Item) => ({ PutRequest: { Item } }));
    while (requests.length > 0) {
      const res = await ddb.send(
        new BatchWriteCommand({
          RequestItems: { [need("DYNAMODB_TABLE")]: requests },
        })
      );
      requests = (res.UnprocessedItems?.[need("DYNAMODB_TABLE")] ?? []) as typeof requests;
      if (requests.length > 0) await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function main() {
  const { rooms, players, prompts } = await loadOldData();
  console.log(
    `Loaded from Postgres: ${rooms.length} rooms, ${players.length} players, ${prompts.length} prompts`
  );
  if (DRY_RUN) {
    const kicked = players.filter((p) => p.gameRoomId === ZERO_UUID).length;
    const images = prompts.reduce((n, p) => n + (p.imageUrlList?.length ?? 0), 0);
    console.log(`Would skip ${kicked} kicked players; would migrate ${images} images.`);
    return;
  }

  const items: Record<string, unknown>[] = [];

  for (const r of rooms) {
    const displayCode = r.gameRoomCode.split(".")[0].toUpperCase();
    const isArchived = r.gameRoomCode.includes(".archived");
    // Only in-flight, non-archived rooms keep ownership of their code (GSI);
    // finished/archived rooms stay reachable by id via /results/<id>.
    const ownsCode = !isArchived && !r.isFinished;
    items.push({
      pk: `ROOM#${r.id}`,
      sk: "META",
      type: "room",
      ...(ownsCode ? { roomCode: displayCode } : {}),
      id: r.id,
      code: displayCode,
      isStarted: r.isStarted,
      isFinished: r.isFinished,
      numberRounds: r.numberRounds,
      currentRound: r.currentRound,
      createdAt: r.createdAt,
    });
  }

  for (const p of players) {
    if (p.gameRoomId === ZERO_UUID) continue; // kicked players lost their room reference
    items.push({
      pk: `ROOM#${p.gameRoomId}`,
      sk: `PLAYER#${p.id}`,
      type: "player",
      id: p.id,
      roomId: p.gameRoomId,
      name: p.playerName,
      cookieCode: p.cookieCode.split(".")[0],
      sortOrder: p.sortOrder,
      isAdmin: p.isAdmin,
      isBot: p.isBot,
      isKicked: false,
      createdAt: p.createdAt,
    });
  }

  // Re-home images with a bounded worker pool (they dominate migration time).
  let migratedImages = 0;
  const migratedUrlsByPrompt = new Map<string, string[]>();
  if (!SKIP_IMAGES) {
    let cursor = 0;
    let done = 0;
    const worker = async () => {
      while (cursor < prompts.length) {
        const p = prompts[cursor++];
        const urls = await Promise.all(
          (p.imageUrlList ?? []).map((url, i) =>
            migrateImage(url, `rooms/${p.gameRoomId}/${p.id}/${i}`)
          )
        );
        migratedUrlsByPrompt.set(p.id, urls);
        migratedImages += urls.length;
        if (++done % 100 === 0) {
          console.log(`  images: processed ${done}/${prompts.length} prompts`);
        }
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
  }

  const usedSks = new Set<string>();
  for (const p of prompts) {
    const imageUrls = migratedUrlsByPrompt.get(p.id) ?? p.imageUrlList ?? [];
    // The old app had no unique constraint; suffix duplicates so none are lost.
    let sk = `PROMPT#${String(p.gameRound).padStart(3, "0")}#${p.playerId}`;
    if (usedSks.has(`${p.gameRoomId}|${sk}`)) sk = `${sk}#${p.id}`;
    usedSks.add(`${p.gameRoomId}|${sk}`);
    items.push({
      pk: `ROOM#${p.gameRoomId}`,
      sk,
      type: "prompt",
      id: p.id,
      roomId: p.gameRoomId,
      round: p.gameRound,
      playerId: p.playerId,
      text: p.promptText,
      imageUrls,
      ...(p.parentPromptId ? { parentPromptId: p.parentPromptId } : {}),
      createdAt: p.createdAt,
    });
  }

  console.log(`Writing ${items.length} items to DynamoDB…`);
  await batchWrite(items);
  console.log(
    `Done. Migrated ${rooms.length} rooms, ${players.length} players, ${prompts.length} prompts, ${migratedImages} images.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
