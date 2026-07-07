export interface Room {
  id: string;
  code: string;
  isStarted: boolean;
  isFinished: boolean;
  numberRounds: number;
  currentRound: number;
  createdAt: string;
  /** Set when "new game with same players" replaces this room. */
  supersededBy?: string;
  /** Bot-turn recovery lease (see acquireBotLease). */
  botLeaseUntil?: number;
  botLeaseRound?: number;
}

export interface Player {
  id: string;
  roomId: string;
  name: string;
  /** Long-lived browser cookie value identifying this human across rooms/replays. */
  cookieCode: string;
  /** Random value; players sorted by it form the guessing ring. */
  sortOrder: string;
  isAdmin: boolean;
  isBot: boolean;
  isKicked: boolean;
  createdAt: string;
}

export interface PromptRecord {
  id: string;
  roomId: string;
  round: number;
  playerId: string;
  text: string;
  imageUrls: string[];
  /** The upstream prompt whose images this one guessed; undefined for round-0 seeds. */
  parentPromptId?: string;
  createdAt: string;
}

export interface ChainLink {
  promptId: string;
  playerId: string;
  playerName: string;
  round: number;
  text: string;
  imageUrls: string[];
}
