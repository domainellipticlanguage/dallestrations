import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Player, PromptRecord, Room } from "./types.js";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const TABLE = () => {
  const t = process.env.DYNAMODB_TABLE;
  if (!t) throw new Error("DYNAMODB_TABLE not set");
  return t;
};

const roomPk = (roomId: string) => `ROOM#${roomId}`;
// Keying players by cookieCode makes one browser = one ring slot, so a
// double-clicked join can't create a phantom player.
const playerSk = (cookieCode: string) => `PLAYER#${cookieCode}`;
const promptSk = (round: number, playerId: string) =>
  `PROMPT#${String(round).padStart(3, "0")}#${playerId}`;

const isConditionFailure = (err: unknown) =>
  (err as { name?: string }).name === "ConditionalCheckFailedException";

/** Build UpdateExpression parts from a plain partial-updates object. */
function buildSetExpression(updates: Record<string, unknown>) {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  for (const [k, v] of Object.entries(updates)) {
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    sets.push(`#${k} = :${k}`);
  }
  return { expression: `SET ${sets.join(", ")}`, names, values };
}

export async function saveRoom(room: Room, opts?: { isNew?: boolean }): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: TABLE(),
      Item: roomItem(room),
      ...(opts?.isNew ? { ConditionExpression: "attribute_not_exists(pk)" } : {}),
    })
  );
}

function roomItem(room: Room) {
  return {
    pk: roomPk(room.id),
    sk: "META",
    type: "room",
    // GSI attribute — present only while the room is the live owner of its code.
    ...(room.supersededBy ? {} : { roomCode: room.code }),
    ...room,
  };
}

export async function getRoomByCode(code: string): Promise<Room | null> {
  const res = await client.send(
    new QueryCommand({
      TableName: TABLE(),
      IndexName: "CodeIndex",
      KeyConditionExpression: "roomCode = :c",
      ExpressionAttributeValues: { ":c": code.toUpperCase() },
    })
  );
  const items = (res.Items ?? []) as Room[];
  if (items.length === 0) return null;
  // If a stale duplicate ever exists, prefer the newest.
  // (Some pre-2023 migrated rooms have no createdAt.)
  items.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return items[0];
}

/**
 * Atomically archive a room and create its successor: the code's GSI entry
 * moves in one transaction, so no interleaving leaves the code unowned.
 */
export async function replaceRoom(oldRoomId: string, newRoom: Room): Promise<void> {
  await client.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE(),
            Key: { pk: roomPk(oldRoomId), sk: "META" },
            UpdateExpression: "SET supersededBy = :s REMOVE roomCode",
            ConditionExpression: "attribute_not_exists(supersededBy)",
            ExpressionAttributeValues: { ":s": newRoom.id },
          },
        },
        { Put: { TableName: TABLE(), Item: roomItem(newRoom) } },
      ],
    })
  );
}

export async function updateRoom(
  roomId: string,
  updates: Partial<Pick<Room, "isStarted" | "isFinished" | "numberRounds" | "currentRound">>
): Promise<void> {
  const { expression, names, values } = buildSetExpression(updates);
  await client.send(
    new UpdateCommand({
      TableName: TABLE(),
      Key: { pk: roomPk(roomId), sk: "META" },
      UpdateExpression: expression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );
}

/**
 * Advance currentRound from `fromRound` exactly once even under concurrent
 * submits — the condition makes the losing writer a no-op.
 * Returns true if this call performed the advance.
 */
export async function advanceRound(
  roomId: string,
  fromRound: number,
  isNowFinished: boolean
): Promise<boolean> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: TABLE(),
        Key: { pk: roomPk(roomId), sk: "META" },
        UpdateExpression: "SET currentRound = :next, isFinished = :fin",
        ConditionExpression: "currentRound = :cur",
        ExpressionAttributeValues: {
          ":next": fromRound + 1,
          ":cur": fromRound,
          ":fin": isNowFinished,
        },
      })
    );
    return true;
  } catch (err: unknown) {
    if (isConditionFailure(err)) return false;
    throw err;
  }
}

/**
 * Claim the right to run bot turns for a round for ~90s. Any poller can call
 * this; only one wins, and an expired lease (crashed Lambda) is reclaimable —
 * that's what un-sticks a game whose bot-runner died mid-turn.
 */
export async function acquireBotLease(roomId: string, round: number): Promise<boolean> {
  const now = Date.now();
  try {
    await client.send(
      new UpdateCommand({
        TableName: TABLE(),
        Key: { pk: roomPk(roomId), sk: "META" },
        UpdateExpression: "SET botLeaseUntil = :until, botLeaseRound = :round",
        ConditionExpression:
          "attribute_not_exists(botLeaseUntil) OR botLeaseUntil < :now OR botLeaseRound <> :round",
        ExpressionAttributeValues: {
          ":until": now + 90_000,
          ":now": now,
          ":round": round,
        },
      })
    );
    return true;
  } catch (err: unknown) {
    if (isConditionFailure(err)) return false;
    throw err;
  }
}

export function playerItem(player: Player) {
  return {
    pk: roomPk(player.roomId),
    sk: playerSk(player.cookieCode),
    type: "player",
    ...player,
  };
}

export async function savePlayer(player: Player): Promise<void> {
  await client.send(new PutCommand({ TableName: TABLE(), Item: playerItem(player) }));
}

/** Insert a player, failing if this browser already has a slot in the room. */
export async function savePlayerOnce(player: Player): Promise<boolean> {
  try {
    await client.send(
      new PutCommand({
        TableName: TABLE(),
        Item: playerItem(player),
        ConditionExpression: "attribute_not_exists(pk)",
      })
    );
    return true;
  } catch (err: unknown) {
    if (isConditionFailure(err)) return false;
    throw err;
  }
}

/**
 * Update an existing player (keyed by cookieCode). Returns false if no such
 * item exists — e.g. pre-migration players stored under a legacy key.
 */
export async function updatePlayer(
  roomId: string,
  cookieCode: string,
  updates: Partial<Pick<Player, "isKicked" | "isBot" | "isAdmin">>
): Promise<boolean> {
  const { expression, names, values } = buildSetExpression(updates);
  try {
    await client.send(
      new UpdateCommand({
        TableName: TABLE(),
        Key: { pk: roomPk(roomId), sk: playerSk(cookieCode) },
        UpdateExpression: expression,
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
    return true;
  } catch (err: unknown) {
    if (isConditionFailure(err)) return false;
    throw err;
  }
}

/**
 * Insert a prompt, failing if this player already submitted this round.
 * The (round, playerId) sort key is the uniqueness guarantee the old app lacked.
 * Returns false if a submission already existed.
 */
export async function savePromptOnce(prompt: PromptRecord): Promise<boolean> {
  try {
    await client.send(
      new PutCommand({
        TableName: TABLE(),
        Item: {
          pk: roomPk(prompt.roomId),
          sk: promptSk(prompt.round, prompt.playerId),
          type: "prompt",
          ...prompt,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      })
    );
    return true;
  } catch (err: unknown) {
    if (isConditionFailure(err)) return false;
    throw err;
  }
}

export interface RoomData {
  room: Room;
  players: Player[];
  prompts: PromptRecord[];
}

/**
 * One query fetches the room, its players, and all prompts.
 * Pass consistent=true on read-modify-write paths (round advance, bot turns)
 * so a just-written prompt is never missed; polls can stay eventually
 * consistent (half the read cost).
 */
export async function getRoomData(
  roomId: string,
  opts?: { consistent?: boolean }
): Promise<RoomData | null> {
  const res = await client.send(
    new QueryCommand({
      TableName: TABLE(),
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": roomPk(roomId) },
      ConsistentRead: opts?.consistent ?? false,
    })
  );
  const items = res.Items ?? [];
  const roomItem = items.find((i) => i.sk === "META");
  if (!roomItem) return null;
  const players = items.filter((i) => i.type === "player") as unknown as Player[];
  const prompts = items.filter((i) => i.type === "prompt") as unknown as PromptRecord[];
  players.sort((a, b) => a.sortOrder.localeCompare(b.sortOrder));
  prompts.sort((a, b) => a.round - b.round || a.createdAt.localeCompare(b.createdAt));
  return { room: roomItem as unknown as Room, players, prompts };
}
