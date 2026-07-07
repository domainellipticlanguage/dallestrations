import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type ResultsResponse } from "../api";

export function ResultsPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const [data, setData] = useState<ResultsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!roomId) return;
    api
      .results(roomId)
      .then(setData)
      .catch((err) => setError((err as Error).message));
  }, [roomId]);

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4">
        <p className="text-red-600">{error}</p>
        <Link to="/" className="text-indigo-600 underline">
          Back home
        </Link>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-500">
        Loading albums…
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 sm:p-6">
      <header className="mx-auto max-w-3xl flex items-center justify-between pb-6 no-print">
        <Link to="/" className="font-display text-2xl font-bold text-indigo-700">
          Dallestrations
        </Link>
        <div className="flex items-center gap-4">
          {!data.room.isFinished && (
            <span className="rounded bg-amber-100 px-2 py-1 text-xs text-amber-700">
              preview — game still going
            </span>
          )}
          <Link
            to={`/${data.room.code}`}
            className="rounded-lg bg-indigo-100 px-3 py-1 font-mono font-bold tracking-widest text-indigo-700"
          >
            {data.room.code}
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl flex flex-col gap-8">
        <h1 className="text-center text-3xl font-bold">The Albums</h1>
        {data.chains.length === 0 && (
          <p className="text-center text-slate-500">Nothing here yet.</p>
        )}
        {data.chains.map((chain, i) => (
          <section
            key={chain[0]?.promptId ?? i}
            className="rounded-2xl bg-white p-6 shadow print-break"
          >
            <h2 className="mb-4 text-xl font-semibold text-indigo-700">
              Chain {i + 1}: started by {chain[0]?.playerName}
            </h2>
            <ol className="flex flex-col gap-6">
              {chain.map((link) => (
                <li key={link.promptId} className="flex flex-col gap-2">
                  <p>
                    <span className="font-semibold">{link.playerName}</span>{" "}
                    <span className="text-slate-500">
                      {link.round === 0 ? "started with" : "guessed"}:
                    </span>{" "}
                    “{link.text}”
                  </p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {link.imageUrls.map((url) => (
                      <img
                        key={url}
                        src={url}
                        alt={link.text}
                        className="w-full rounded-lg shadow"
                        loading="lazy"
                      />
                    ))}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </main>
    </div>
  );
}
