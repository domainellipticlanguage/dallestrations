import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";

export function Home() {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const createRoom = async () => {
    setCreating(true);
    setError(null);
    try {
      const { code, roomId } = await api.createRoom();
      // Pass the id along — the code index is eventually consistent, so a
      // lookup right after creation could miss.
      navigate(`/${code}`, { state: { roomId } });
    } catch (err) {
      setError((err as Error).message);
      setCreating(false);
    }
  };

  const joinRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim().toUpperCase();
    if (trimmed.length !== 4) {
      setError("Room codes are 4 letters");
      return;
    }
    setError(null);
    try {
      await api.resolveCode(trimmed);
      navigate(`/${trimmed}`);
    } catch {
      setError("Room not found — check the code");
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-8 p-6">
      <div className="text-center">
        <img
          src="/dallestrations-logo.png"
          alt="Dallestrations"
          className="mx-auto w-64 max-w-full"
        />
        <p className="mt-2 text-lg text-slate-600">
          The AI-powered game of visual telephone
        </p>
      </div>

      <div className="max-w-md text-center text-slate-600">
        <p>
          Write a prompt. The AI draws it. The next player guesses what you
          wrote from the pictures. The AI draws <em>their</em> guess… and at the
          end, everyone sees how gloriously wrong it all went.
        </p>
      </div>

      <div className="flex flex-col gap-4 w-full max-w-xs">
        <button
          onClick={createRoom}
          disabled={creating}
          className="rounded-xl bg-indigo-600 px-6 py-3 text-lg font-semibold text-white shadow hover:bg-indigo-700 disabled:opacity-50"
        >
          {creating ? "Creating…" : "Create Room"}
        </button>

        <form onSubmit={joinRoom} className="flex gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            maxLength={4}
            placeholder="CODE"
            className="w-full rounded-xl border border-slate-300 px-4 py-3 text-center text-lg font-mono uppercase tracking-widest"
          />
          <button
            type="submit"
            className="rounded-xl bg-slate-700 px-5 py-3 font-semibold text-white hover:bg-slate-800"
          >
            Join
          </button>
        </form>
      </div>

      {error && <p className="text-red-600">{error}</p>}

      <Link to="/about" className="text-sm text-slate-400 underline">
        About & source code
      </Link>
    </div>
  );
}
