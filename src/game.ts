import { randomUUID } from "node:crypto";
import {
  acquireBotLease,
  advanceRound,
  getRoomData,
  savePromptOnce,
  type RoomData,
} from "./db.js";
import { generateAndStoreImages } from "./images.js";
import { botGuessFromImages, botSeedPrompt } from "./llm.js";
import type { ChainLink, Player, PromptRecord, Room } from "./types.js";

const randomLetters = (n: number) =>
  Array.from({ length: n }, () =>
    String.fromCharCode(65 + Math.floor(Math.random() * 26))
  ).join("");

export const randomRoomCode = () => randomLetters(4);
export const randomCookieCode = () => randomLetters(10);

/** Players still in the game, in ring order. */
export const activePlayers = (players: Player[]): Player[] =>
  players.filter((p) => !p.isKicked);

/** The player whose prompt this player guesses: one step back around the ring. */
export function upstreamPlayer(players: Player[], player: Player): Player {
  const ring = activePlayers(players);
  const idx = ring.findIndex((p) => p.id === player.id);
  if (idx === -1) throw new Error("Player not in ring");
  return ring[(idx - 1 + ring.length) % ring.length];
}

/** The prompt this player must respond to in the current round (null = seed round). */
export function parentPromptFor(
  data: RoomData,
  player: Player
): PromptRecord | null {
  const { room, players, prompts } = data;
  if (room.currentRound === 0) return null;
  const upstream = upstreamPlayer(players, player);
  return (
    prompts.find(
      (p) => p.round === room.currentRound - 1 && p.playerId === upstream.id
    ) ?? null
  );
}

/**
 * Rebuild the reveal "albums": each chain is the sequence of prompts obtained
 * by walking parentPromptId links back from a leaf (a prompt nobody guessed on).
 */
export function buildChains(data: RoomData): ChainLink[][] {
  const { players, prompts } = data;
  const byId = new Map(prompts.map((p) => [p.id, p]));
  const referencedAsParent = new Set(
    prompts.map((p) => p.parentPromptId).filter(Boolean)
  );
  const leaves = prompts.filter((p) => !referencedAsParent.has(p.id));
  const playerById = new Map(players.map((p) => [p.id, p]));

  const chains = leaves.map((leaf) => {
    const chain: PromptRecord[] = [];
    let cur: PromptRecord | undefined = leaf;
    while (cur) {
      chain.unshift(cur);
      cur = cur.parentPromptId ? byId.get(cur.parentPromptId) : undefined;
    }
    return chain;
  });

  // Order albums by the seed author's ring position for a stable reveal order.
  chains.sort((a, b) => {
    const sa = playerById.get(a[0].playerId)?.sortOrder ?? "";
    const sb = playerById.get(b[0].playerId)?.sortOrder ?? "";
    return sa.localeCompare(sb);
  });

  return chains.map((chain) =>
    chain.map((p) => ({
      promptId: p.id,
      playerId: p.playerId,
      playerName: playerById.get(p.playerId)?.name ?? "Unknown",
      round: p.round,
      text: p.text,
      imageUrls: p.imageUrls,
    }))
  );
}

/** True when every active player has a submission for the current round. */
export function isRoundComplete(data: RoomData): boolean {
  const { room, players, prompts } = data;
  const ring = activePlayers(players);
  if (ring.length === 0) return false;
  const submitted = new Set(
    prompts.filter((p) => p.round === room.currentRound).map((p) => p.playerId)
  );
  return ring.every((p) => submitted.has(p.id));
}

/**
 * If every active player has submitted for the current round, advance it
 * (and finish the game after the last round). Conditional write makes this
 * safe under concurrent submits. Returns true if the round advanced.
 */
export async function maybeAdvanceRound(data: RoomData): Promise<boolean> {
  const { room } = data;
  if (!room.isStarted || room.isFinished) return false;
  if (!isRoundComplete(data)) return false;
  const isNowFinished = room.currentRound + 1 >= room.numberRounds;
  return advanceRound(room.id, room.currentRound, isNowFinished);
}

/**
 * Generate images for a submission and persist it.
 * Returns the saved record, or null on double-submit.
 */
export async function submitPrompt(
  room: Room,
  player: Player,
  text: string,
  parentPromptId: string | undefined
): Promise<PromptRecord | null> {
  const promptId = randomUUID();
  const imageUrls = await generateAndStoreImages(text, room.id, promptId);
  const record: PromptRecord = {
    id: promptId,
    roomId: room.id,
    round: room.currentRound,
    playerId: player.id,
    text,
    imageUrls,
    parentPromptId,
    createdAt: new Date().toISOString(),
  };
  return (await savePromptOnce(record)) ? record : null;
}

/**
 * Have every bot that hasn't submitted this round take its turn, then keep
 * advancing rounds while bots complete them (humans may already have submitted).
 *
 * Guarded by a per-round lease so concurrent triggers (submit handlers, the
 * poll-heal path) don't duplicate expensive generation, while a crashed
 * runner's work is retried once its lease expires.
 */
export async function runBotTurns(roomId: string): Promise<void> {
  for (let safety = 0; safety < 100; safety++) {
    const data = await getRoomData(roomId, { consistent: true });
    if (!data || !data.room.isStarted || data.room.isFinished) return;
    const { room, players, prompts } = data;
    const bots = activePlayers(players).filter((p) => p.isBot);
    const pendingBots = bots.filter(
      (b) => !prompts.some((p) => p.round === room.currentRound && p.playerId === b.id)
    );
    if (pendingBots.length === 0) return;
    if (!(await acquireBotLease(room.id, room.currentRound))) return;

    await Promise.allSettled(
      pendingBots.map(async (bot) => {
        try {
          const parent = parentPromptFor(data, bot);
          const text = parent
            ? await botGuessFromImages(parent.imageUrls)
            : await botSeedPrompt();
          await submitPrompt(room, bot, text, parent?.id);
        } catch (err) {
          console.error(`bot turn failed for ${bot.name}:`, err);
        }
      })
    );

    const after = await getRoomData(roomId, { consistent: true });
    if (!after) return;
    const advanced = await maybeAdvanceRound(after);
    // If the round didn't advance, humans are still playing — bots are done for now.
    if (!advanced) return;
  }
}
