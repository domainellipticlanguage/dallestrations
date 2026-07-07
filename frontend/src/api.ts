export interface PlayerSummary {
  id: string;
  name: string;
  isAdmin: boolean;
  isBot: boolean;
  submitted: boolean;
}

export interface RoomState {
  room: {
    id: string;
    code: string;
    isStarted: boolean;
    isFinished: boolean;
    numberRounds: number;
    currentRound: number;
    supersededBy: string | null;
  };
  players: PlayerSummary[];
  you: { id: string; name: string; isAdmin: boolean } | null;
  view: {
    round: number;
    isSeedRound: boolean;
    submitted: boolean;
    parentImages: string[] | null;
  } | null;
}

export interface ChainLink {
  promptId: string;
  playerId: string;
  playerName: string;
  round: number;
  text: string;
  imageUrls: string[];
}

export interface ResultsResponse {
  room: { id: string; code: string; isFinished: boolean };
  chains: ChainLink[][];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      (body as { error?: string } | null)?.error ?? `Request failed (${res.status})`
    );
  }
  return body as T;
}

export const api = {
  createRoom: () =>
    request<{ roomId: string; code: string }>("/api/rooms", { method: "POST" }),
  resolveCode: (code: string) =>
    request<{ roomId: string; code: string }>(`/api/rooms/code/${encodeURIComponent(code)}`),
  getState: (roomId: string) => request<RoomState>(`/api/rooms/${roomId}/state`),
  join: (roomId: string, name: string) =>
    request<{ playerId: string }>(`/api/rooms/${roomId}/join`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  addBot: (roomId: string) =>
    request<{ playerId: string }>(`/api/rooms/${roomId}/addBot`, { method: "POST" }),
  kick: (roomId: string, playerId: string) =>
    request<{ success: boolean }>(`/api/rooms/${roomId}/kick`, {
      method: "POST",
      body: JSON.stringify({ playerId }),
    }),
  start: (roomId: string, numberOfRounds?: number) =>
    request<{ success: boolean }>(`/api/rooms/${roomId}/start`, {
      method: "POST",
      body: JSON.stringify({ numberOfRounds }),
    }),
  guess: (roomId: string, text: string) =>
    request<{ success: boolean }>(`/api/rooms/${roomId}/guess`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  results: (roomId: string) => request<ResultsResponse>(`/api/rooms/${roomId}/results`),
  newGame: (roomId: string) =>
    request<{ roomId: string; code: string }>(`/api/rooms/${roomId}/newGame`, {
      method: "POST",
    }),
};
