import { Link } from "react-router-dom";

export function AboutPage() {
  return (
    <div className="min-h-screen p-4 sm:p-6">
      <header className="mx-auto max-w-2xl pb-6">
        <Link to="/" className="font-display text-2xl font-bold text-indigo-700">
          Dallestrations
        </Link>
      </header>
      <main className="mx-auto max-w-2xl flex flex-col gap-6">
        <section className="rounded-2xl bg-white p-6 shadow flex flex-col gap-4">
          <h1 className="text-2xl font-bold">About</h1>
          <p>
            Dallestrations is the AI-powered game of visual telephone. Everyone
            writes a prompt, an AI paints it, and the next player has to guess
            the prompt from the pictures alone. Their guess gets painted too, and
            so on around the circle. At the end, the albums reveal how each
            idea mutated along the way.
          </p>
          <h2 className="text-lg font-semibold">How to play</h2>
          <ol className="list-decimal pl-5 flex flex-col gap-1">
            <li>Create a room and share the 4-letter code (or QR code).</li>
            <li>Everyone writes a starting prompt — the AI draws it.</li>
            <li>
              Each round, you see the images your neighbor's words produced and
              guess what they wrote.
            </li>
            <li>After the last round, gather around for the reveal.</li>
          </ol>
          <p>
            Short on players? Add a bot — it writes its own prompts and
            genuinely guesses from the images.
          </p>
          <h2 className="text-lg font-semibold">Source code</h2>
          <p>
            Dallestrations is open source:{" "}
            <a
              href="https://github.com/domainellipticlanguage/dallestrations"
              className="text-indigo-600 underline"
              target="_blank"
              rel="noreferrer"
            >
              github.com/domainellipticlanguage/dallestrations
            </a>
          </p>
        </section>
        <p className="text-center">
          <Link to="/" className="text-indigo-600 underline">
            ← Back to the game
          </Link>
        </p>
      </main>
    </div>
  );
}
