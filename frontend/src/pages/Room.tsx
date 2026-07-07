import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, type RoomState } from "../api";

const POLL_MS = 2000;

export function RoomPage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  // Room creation passes the id via navigation state, sparing us the
  // eventually-consistent code lookup right after creation.
  const [roomId, setRoomId] = useState<string | null>(
    (location.state as { roomId?: string } | null)?.roomId ?? null
  );
  const [state, setState] = useState<RoomState | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Resolve the code in the URL to the live room id (codes move on replay).
  // Retries cover index lag on freshly created/replaced rooms.
  const resolve = useCallback(async (attempts = 3) => {
    if (!code) return;
    for (let i = 0; i < attempts; i++) {
      try {
        const { roomId } = await api.resolveCode(code);
        setRoomId(roomId);
        setError(null);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    setError("Room not found");
  }, [code]);

  useEffect(() => {
    if (!roomId) void resolve();
  }, [resolve, roomId]);

  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await api.getState(roomId);
        if (cancelled) return;
        if (s.room.supersededBy) {
          // Host started a new game with the same code — follow it.
          setRoomId(s.room.supersededBy);
          return;
        }
        setState(s);
      } catch {
        // Transient poll errors are fine; re-resolve in case the room moved.
        void resolve();
      }
    };
    void tick();
    const interval = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [roomId, resolve]);

  if (error) {
    return (
      <Shell code={code ?? ""}>
        <p className="text-red-600">{error}</p>
        <Link to="/" className="text-indigo-600 underline">
          Back home
        </Link>
      </Shell>
    );
  }
  if (!state) {
    return (
      <Shell code={code ?? ""}>
        <p className="text-slate-500">Loading…</p>
      </Shell>
    );
  }

  const { room } = state;
  return (
    <Shell code={room.code}>
      {!room.isStarted && <Lobby state={state} roomId={roomId!} />}
      {room.isStarted && !room.isFinished && (
        <Play state={state} roomId={roomId!} />
      )}
      {room.isFinished && (
        <Finished state={state} roomId={roomId!} onNewGame={() => navigate(0)} />
      )}
    </Shell>
  );
}

function Shell({ code, children }: { code: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen p-4 sm:p-6">
      <header className="mx-auto max-w-2xl flex items-center justify-between pb-4">
        <Link to="/" className="font-display text-2xl font-bold text-indigo-700">
          Dallestrations
        </Link>
        {code && (
          <span className="rounded-lg bg-indigo-100 px-3 py-1 font-mono text-lg font-bold tracking-widest text-indigo-700">
            {code}
          </span>
        )}
      </header>
      <main className="mx-auto max-w-2xl flex flex-col gap-6">{children}</main>
    </div>
  );
}

function Lobby({ state, roomId }: { state: RoomState; roomId: string }) {
  const { room, players, you } = state;
  const [name, setName] = useState("");
  const [rounds, setRounds] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shareUrl = `${window.location.origin}/${room.code}`;
  const qrUrl = `https://quickchart.io/qr?size=180&text=${encodeURIComponent(shareUrl)}`;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="rounded-2xl bg-white p-6 shadow flex flex-col sm:flex-row gap-6 items-center">
        <img src={qrUrl} alt="QR code to join" width={140} height={140} className="rounded-lg" />
        <div>
          <p className="text-slate-600">Friends join at</p>
          <p className="font-mono text-lg font-semibold text-indigo-700 break-all">
            {shareUrl}
          </p>
        </div>
      </section>

      <section className="rounded-2xl bg-white p-6 shadow">
        <h2 className="mb-3 text-lg font-semibold">
          Players ({players.length})
        </h2>
        <ul className="flex flex-col gap-2">
          {players.map((p) => (
            <li key={p.id} className="flex items-center gap-2">
              <span>
                {p.isBot ? "🤖" : "🧑‍🎨"} {p.name}
              </span>
              {p.isAdmin && (
                <span className="rounded bg-amber-100 px-1.5 text-xs text-amber-700">
                  host
                </span>
              )}
              {you?.isAdmin && !p.isAdmin && (
                <button
                  onClick={() => act(() => api.kick(roomId, p.id))}
                  className="ml-auto text-xs text-red-500 hover:underline"
                >
                  kick
                </button>
              )}
            </li>
          ))}
          {players.length === 0 && (
            <li className="text-slate-400">Nobody here yet</li>
          )}
        </ul>
      </section>

      {!you && (
        <form
          className="rounded-2xl bg-white p-6 shadow flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void act(() => api.join(roomId, name.trim()));
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            maxLength={30}
            className="w-full rounded-xl border border-slate-300 px-4 py-3"
          />
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="rounded-xl bg-indigo-600 px-6 py-3 font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            Join
          </button>
        </form>
      )}

      {you?.isAdmin && (
        <section className="rounded-2xl bg-white p-6 shadow flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <label htmlFor="rounds" className="text-slate-600">
              Rounds
            </label>
            <input
              id="rounds"
              type="number"
              min={1}
              max={20}
              value={rounds}
              onChange={(e) => setRounds(e.target.value)}
              placeholder={`${players.length} (default)`}
              className="w-36 rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>
          <div className="flex gap-3">
            <button
              onClick={() =>
                act(() =>
                  api.start(roomId, rounds ? Number(rounds) : undefined)
                )
              }
              disabled={busy || players.length < 2}
              className="flex-1 rounded-xl bg-green-600 px-6 py-3 font-semibold text-white hover:bg-green-700 disabled:opacity-50"
            >
              Start Game
            </button>
            <button
              onClick={() => act(() => api.addBot(roomId))}
              disabled={busy}
              className="rounded-xl bg-slate-200 px-4 py-3 font-semibold text-slate-700 hover:bg-slate-300 disabled:opacity-50"
            >
              + Bot
            </button>
          </div>
          {players.length < 2 && (
            <p className="text-sm text-slate-500">
              Need at least 2 players (bots count!)
            </p>
          )}
        </section>
      )}

      {you && !you.isAdmin && (
        <p className="text-center text-slate-500">
          Waiting for the host to start the game…
        </p>
      )}
      {error && <p className="text-red-600">{error}</p>}
    </>
  );
}

function Play({ state, roomId }: { state: RoomState; roomId: string }) {
  const { room, players, you, view } = state;
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track the round we last submitted for so the textarea clears on new rounds.
  const lastRound = useRef(-1);

  useEffect(() => {
    if (view && view.round !== lastRound.current) {
      lastRound.current = view.round;
      setText("");
      setSubmitting(false);
      setError(null);
    }
  }, [view]);

  if (!you) {
    return (
      <p className="text-center text-slate-500">
        This game is in progress. Spectator mode isn't a thing (yet) — ask the
        host to start a new game with you in it!
      </p>
    );
  }
  if (!view) return null;

  const submitted = view.submitted || submitting;
  const isSeed = view.isSeedRound;

  if (!isSeed && !view.parentImages) {
    return (
      <p className="animate-pulse text-center text-slate-500">
        Waiting for your neighbor's images…
      </p>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.guess(roomId, text.trim());
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="text-center">
        <h2 className="text-xl font-semibold">
          Round {room.currentRound + 1} of {room.numberRounds}
        </h2>
      </div>

      <section className="rounded-2xl bg-white p-6 shadow flex flex-col gap-4">
        {isSeed ? (
          <p className="text-lg">
            ✏️ <strong>Write a starting prompt.</strong> Something fun and
            drawable — the AI will paint it and the next player has to guess
            what you wrote.
          </p>
        ) : (
          <>
            <p className="text-lg">
              🔍 <strong>What was the prompt for these images?</strong>
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {view.parentImages!.map((url) => (
                <img
                  key={url}
                  src={url}
                  alt="AI generated"
                  className="w-full rounded-xl shadow"
                />
              ))}
            </div>
          </>
        )}

        {submitted ? (
          <p className="rounded-xl bg-green-50 p-4 text-green-700">
            ✅ Submitted! Waiting for the other players…
          </p>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder={
                isSeed
                  ? "e.g. a grandma winning a skateboard competition on the moon"
                  : "Your best guess at the original prompt…"
              }
              className="rounded-xl border border-slate-300 px-4 py-3"
            />
            <button
              type="submit"
              disabled={!text.trim()}
              className="rounded-xl bg-indigo-600 px-6 py-3 font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              Submit
            </button>
          </form>
        )}
        {submitting && !view.submitted && (
          <p className="animate-pulse text-slate-500">
            🎨 The AI is painting your masterpiece…
          </p>
        )}
        {error && <p className="text-red-600">{error}</p>}
      </section>

      <section className="rounded-2xl bg-white p-6 shadow">
        <h3 className="mb-3 font-semibold">This round</h3>
        <ul className="flex flex-col gap-1">
          {players.map((p) => (
            <li key={p.id} className="flex items-center justify-between">
              <span>
                {p.isBot ? "🤖" : "🧑‍🎨"} {p.name}
                {you.id === p.id && " (you)"}
              </span>
              <span className={p.submitted ? "text-green-600" : "text-slate-400"}>
                {p.submitted ? "done" : "thinking…"}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {you.isAdmin && (
        <p className="text-center">
          <Link
            to={`/results/${room.id}`}
            className="text-sm text-slate-400 underline"
          >
            Results preview (host)
          </Link>
        </p>
      )}
    </>
  );
}

function Finished({
  state,
  roomId,
  onNewGame,
}: {
  state: RoomState;
  roomId: string;
  onNewGame: () => void;
}) {
  const { room, you } = state;
  const [busy, setBusy] = useState(false);

  return (
    <section className="rounded-2xl bg-white p-6 shadow flex flex-col items-center gap-4 text-center">
      <h2 className="text-2xl font-semibold">🎉 That's a wrap!</h2>
      <p className="text-slate-600">
        Every chain has run its course. Time for the reveal.
      </p>
      <Link
        to={`/results/${room.id}`}
        className="rounded-xl bg-indigo-600 px-6 py-3 font-semibold text-white hover:bg-indigo-700"
      >
        View the albums
      </Link>
      {you?.isAdmin && (
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.newGame(roomId);
              onNewGame();
            } finally {
              setBusy(false);
            }
          }}
          className="text-sm text-slate-500 underline disabled:opacity-50"
        >
          Start a new game with the same players
        </button>
      )}
    </section>
  );
}
