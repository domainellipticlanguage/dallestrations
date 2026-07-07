import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import {
  getRoomByCode,
  getRoomData,
  replaceRoom,
  savePlayer,
  savePlayerOnce,
  saveRoom,
  updatePlayer,
  updateRoom,
  type RoomData,
} from "./db.js";
import {
  activePlayers,
  buildChains,
  isRoundComplete,
  maybeAdvanceRound,
  parentPromptFor,
  randomCookieCode,
  randomRoomCode,
  runBotTurns,
  submitPrompt,
} from "./game.js";
import type { Player, Room } from "./types.js";

const COOKIE_NAME = "dallestrations_cookie";
const MAX_BOTS = 3;

export const app = new Hono();

function cookieCode(c: Context): string {
  let code = getCookie(c, COOKIE_NAME);
  if (!code) {
    code = randomCookieCode();
    setCookie(c, COOKIE_NAME, code, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return code;
}

const findYou = (players: Player[], code: string): Player | null =>
  players.find((p) => p.cookieCode === code && !p.isKicked) ?? null;

async function loadRoomData(c: Context): Promise<RoomData | null> {
  const roomId = c.req.param("roomId");
  if (!roomId) return null;
  return getRoomData(roomId);
}

function requireAdmin(data: RoomData, code: string): Player {
  const you = findYou(data.players, code);
  if (!you?.isAdmin) throw new HttpError(403, "Admin only");
  return you;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message }, err.status as 400);
  }
  console.error(err);
  return c.json({ error: "Internal error" }, 500);
});

// ---------- Rooms ----------

app.post("/api/rooms", async (c) => {
  cookieCode(c);
  // Retry on the (unlikely) code collision with a live room.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomRoomCode();
    if (await getRoomByCode(code)) continue;
    const room: Room = {
      id: randomUUID(),
      code,
      isStarted: false,
      isFinished: false,
      numberRounds: 0,
      currentRound: 0,
      createdAt: new Date().toISOString(),
    };
    await saveRoom(room, { isNew: true });
    return c.json({ roomId: room.id, code: room.code });
  }
  throw new HttpError(500, "Could not allocate a room code");
});

app.get("/api/rooms/code/:code", async (c) => {
  const room = await getRoomByCode(c.req.param("code"));
  if (!room) throw new HttpError(404, "Room not found");
  return c.json({ roomId: room.id, code: room.code });
});

function stateResponse(data: RoomData, yourCookie: string) {
  const { room, players, prompts } = data;
  const you = findYou(players, yourCookie);
  const ring = activePlayers(players);
  const submittedIds = new Set(
    prompts.filter((p) => p.round === room.currentRound).map((p) => p.playerId)
  );

  let view: null | {
    round: number;
    isSeedRound: boolean;
    submitted: boolean;
    parentImages: string[] | null;
  } = null;
  if (room.isStarted && !room.isFinished && you) {
    const parent = parentPromptFor(data, you);
    view = {
      round: room.currentRound,
      isSeedRound: room.currentRound === 0,
      submitted: submittedIds.has(you.id),
      // Only images cross the wire — the upstream text is the secret being guessed.
      parentImages: parent ? parent.imageUrls : null,
    };
  }

  return {
    room: {
      id: room.id,
      code: room.code,
      isStarted: room.isStarted,
      isFinished: room.isFinished,
      numberRounds: room.numberRounds,
      currentRound: room.currentRound,
      supersededBy: room.supersededBy ?? null,
    },
    players: ring.map((p) => ({
      id: p.id,
      name: p.name,
      isAdmin: p.isAdmin,
      isBot: p.isBot,
      submitted: submittedIds.has(p.id),
    })),
    you: you ? { id: you.id, name: you.name, isAdmin: you.isAdmin } : null,
    view,
  };
}

// The single polling endpoint that drives the whole UI. It also self-heals:
// if a round is complete but un-advanced (kick, crashed Lambda, consistency
// race) it advances it, and if bots owe a turn with no live lease it re-runs
// them — so a stuck game recovers within one poll interval.
app.get("/api/rooms/:roomId/state", async (c) => {
  const code = cookieCode(c);
  let data = await loadRoomData(c);
  if (!data) throw new HttpError(404, "Room not found");

  if (data.room.isStarted && !data.room.isFinished && isRoundComplete(data)) {
    if (await maybeAdvanceRound(data)) {
      data = (await getRoomData(data.room.id, { consistent: true })) ?? data;
    }
  }

  const { room, players, prompts } = data;
  const ring = activePlayers(players);
  const submittedIds = new Set(
    prompts.filter((p) => p.round === room.currentRound).map((p) => p.playerId)
  );
  const botsPending =
    room.isStarted &&
    !room.isFinished &&
    ring.some((p) => p.isBot && !submittedIds.has(p.id));
  const leaseHeld =
    room.botLeaseRound === room.currentRound &&
    (room.botLeaseUntil ?? 0) > Date.now();

  const payload = stateResponse(data, code);
  if (botsPending && !leaseHeld) {
    const roomId = room.id;
    return streamThen(c, payload, () => runBotTurns(roomId));
  }
  return c.json(payload);
});

// ---------- Players ----------

app.post("/api/rooms/:roomId/join", async (c) => {
  const code = cookieCode(c);
  const data = await loadRoomData(c);
  if (!data) throw new HttpError(404, "Room not found");
  if (data.room.isStarted) throw new HttpError(400, "Game already started");
  const existing = findYou(data.players, code);
  if (existing) return c.json({ playerId: existing.id });

  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  const name = (body.name ?? "").trim().slice(0, 30);
  if (!name) throw new HttpError(400, "Name required");

  const player: Player = {
    id: randomUUID(),
    roomId: data.room.id,
    name,
    cookieCode: code,
    sortOrder: randomUUID(),
    isAdmin: !data.players.some((p) => p.isAdmin && !p.isKicked),
    isBot: false,
    isKicked: false,
    createdAt: new Date().toISOString(),
  };
  // Conditional on the cookie-keyed slot: a double-clicked join can't create
  // a phantom player, and a kicked browser can't rejoin over its record.
  if (!(await savePlayerOnce(player))) {
    throw new HttpError(403, "You were removed from this game");
  }
  return c.json({ playerId: player.id });
});

app.post("/api/rooms/:roomId/addBot", async (c) => {
  const code = cookieCode(c);
  const data = await loadRoomData(c);
  if (!data) throw new HttpError(404, "Room not found");
  if (data.room.isStarted) throw new HttpError(400, "Game already started");
  requireAdmin(data, code);
  const bots = activePlayers(data.players).filter((p) => p.isBot);
  if (bots.length >= MAX_BOTS) throw new HttpError(400, `Max ${MAX_BOTS} bots`);

  const botNames = ["Botticelli", "Robo Picasso", "Vincent van Bot"];
  const player: Player = {
    id: randomUUID(),
    roomId: data.room.id,
    name: botNames[bots.length] ?? `Bot ${bots.length + 1}`,
    cookieCode: `BOT-${randomUUID()}`,
    sortOrder: randomUUID(),
    isAdmin: false,
    isBot: true,
    isKicked: false,
    createdAt: new Date().toISOString(),
  };
  await savePlayer(player);
  return c.json({ playerId: player.id });
});

app.post("/api/rooms/:roomId/kick", async (c) => {
  const code = cookieCode(c);
  const data = await loadRoomData(c);
  if (!data) throw new HttpError(404, "Room not found");
  requireAdmin(data, code);
  const body = await c.req.json<{ playerId?: string }>();
  const target = data.players.find((p) => p.id === body.playerId);
  if (!target) throw new HttpError(404, "Player not found");
  if (target.isAdmin) throw new HttpError(400, "Cannot kick the host");
  if (!(await updatePlayer(data.room.id, target.cookieCode, { isKicked: true }))) {
    throw new HttpError(409, "This player predates the rewrite and can't be kicked");
  }
  // If they were the last holdout, the next poll's self-heal advances the round.
  return c.json({ success: true });
});

// ---------- Gameplay ----------

app.post("/api/rooms/:roomId/start", async (c) => {
  const code = cookieCode(c);
  const data = await loadRoomData(c);
  if (!data) throw new HttpError(404, "Room not found");
  requireAdmin(data, code);
  if (data.room.isStarted) throw new HttpError(400, "Already started");
  const ring = activePlayers(data.players);
  if (ring.length < 2) throw new HttpError(400, "Need at least 2 players");

  const body = await c.req
    .json<{ numberOfRounds?: number }>()
    .catch(() => ({}) as { numberOfRounds?: number });
  // Default (and 0): a full trip around the ring, so chains return to their authors.
  const numberRounds = Math.max(1, Math.min(20, body.numberOfRounds || ring.length));

  await updateRoom(data.room.id, { isStarted: true, numberRounds, currentRound: 0 });
  // Respond immediately; bots take their round-0 turns while the Lambda stays warm.
  const roomId = data.room.id;
  return streamThen(c, { success: true }, () => runBotTurns(roomId));
});

app.post("/api/rooms/:roomId/guess", async (c) => {
  const code = cookieCode(c);
  const data = await loadRoomData(c);
  if (!data) throw new HttpError(404, "Room not found");
  const { room } = data;
  if (!room.isStarted || room.isFinished) throw new HttpError(400, "Game is not in play");
  const you = findYou(data.players, code);
  if (!you) throw new HttpError(403, "You are not in this game");

  const body = await c.req.json<{ text?: string }>();
  const text = (body.text ?? "").trim().slice(0, 500);
  if (!text) throw new HttpError(400, "Prompt required");

  const alreadySubmitted = data.prompts.some(
    (p) => p.round === room.currentRound && p.playerId === you.id
  );
  if (alreadySubmitted) throw new HttpError(400, "Already submitted this round");

  const parent = parentPromptFor(data, you);
  if (room.currentRound > 0 && !parent) {
    throw new HttpError(409, "Upstream prompt not ready yet — try again shortly");
  }

  const saved = await submitPrompt(room, you, text, parent?.id);
  if (!saved) throw new HttpError(400, "Already submitted this round");

  // Check advancement against the in-memory snapshot plus our own write —
  // no re-read needed; a concurrency miss is healed by the next poll.
  data.prompts.push(saved);
  const advanced = await maybeAdvanceRound(data);
  const roomId = room.id;
  return streamThen(c, { success: true }, async () => {
    if (advanced) await runBotTurns(roomId);
  });
});

app.get("/api/rooms/:roomId/results", async (c) => {
  const data = await loadRoomData(c);
  if (!data) throw new HttpError(404, "Room not found");
  return c.json({
    room: { id: data.room.id, code: data.room.code, isFinished: data.room.isFinished },
    chains: buildChains(data),
  });
});

app.post("/api/rooms/:roomId/newGame", async (c) => {
  const code = cookieCode(c);
  const data = await loadRoomData(c);
  if (!data) throw new HttpError(404, "Room not found");
  requireAdmin(data, code);
  if (data.room.supersededBy) {
    return c.json({ roomId: data.room.supersededBy, code: data.room.code });
  }

  const newRoom: Room = {
    id: randomUUID(),
    code: data.room.code,
    isStarted: false,
    isFinished: false,
    numberRounds: 0,
    currentRound: 0,
    createdAt: new Date().toISOString(),
  };
  // One transaction moves the code to the successor — no window where the
  // code is owned by nobody.
  await replaceRoom(data.room.id, newRoom);
  await Promise.all(
    activePlayers(data.players).map((p) =>
      savePlayer({
        ...p,
        id: randomUUID(),
        roomId: newRoom.id,
        createdAt: new Date().toISOString(),
      })
    )
  );
  return c.json({ roomId: newRoom.id, code: newRoom.code });
});

/**
 * Send a JSON body immediately, then keep the (streaming) Lambda alive to
 * finish background work — the pattern used for bot turns.
 */
function streamThen(c: Context, payload: unknown, work: () => Promise<void>) {
  c.header("Content-Type", "application/json");
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(JSON.stringify(payload)));
      try {
        await work();
      } catch (err) {
        console.error("post-response work failed:", err);
      }
      controller.close();
    },
  });
  return c.body(stream);
}

// ---------- Static SPA ----------

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
  ".txt": "text/plain",
  ".woff2": "font/woff2",
};

const distDir = resolve(
  process.env.LAMBDA_TASK_ROOT ?? process.cwd(),
  "frontend/dist"
);

// dist is immutable per deploy — cache file bytes in memory after first read.
const fileCache = new Map<string, Uint8Array<ArrayBuffer> | null>();
function readDistFile(filePath: string): Uint8Array<ArrayBuffer> | null {
  let cached = fileCache.get(filePath);
  if (cached === undefined) {
    // Uint8Array.from copies into a fresh ArrayBuffer (Buffer pools share one).
    cached = existsSync(filePath) ? Uint8Array.from(readFileSync(filePath)) : null;
    fileCache.set(filePath, cached);
  }
  return cached;
}

app.get("*", (c) => {
  const path = decodeURIComponent(new URL(c.req.url).pathname);
  if (path.startsWith("/api/")) return c.json({ error: "Not found" }, 404);
  // Canonical containment check: resolve and verify we stayed inside dist.
  const filePath = resolve(distDir, `.${path}`);
  const contained = filePath === distDir || filePath.startsWith(distDir + sep);
  const ext = path.slice(path.lastIndexOf("."));
  if (contained && MIME[ext]) {
    const body = readDistFile(filePath);
    if (body) {
      const cache = path.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "public, max-age=300";
      return c.body(body, 200, { "Content-Type": MIME[ext], "Cache-Control": cache });
    }
  }
  const index = readDistFile(join(distDir, "index.html"));
  if (!index) return c.text("Frontend not built", 500);
  return c.body(index, 200, {
    "Content-Type": "text/html",
    "Cache-Control": "no-cache",
  });
});
