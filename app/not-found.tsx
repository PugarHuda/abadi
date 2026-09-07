import type { Metadata } from "next";
import "./not-found.css";

export const metadata: Metadata = {
  title: "Abadi — not here",
  description: "Nothing lives at this address.",
  alternates: { canonical: "/404" },
  openGraph: {
    title: "Abadi — not here",
    description: "Nothing lives at this address.",
    url: "/404",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630 }],
  },
};

export default function NotFound() {
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>

      <main id="main" tabIndex={-1}>
        {/* The trace runs, then the pen lifts. Decorative: the sentence below says the same
             thing, so a reader who never sees this loses nothing. */}
        <svg className="lift" viewBox="0 0 320 54" aria-hidden="true" focusable="false">
          <path className="line" fill="none" stroke="#16262B" strokeWidth="1.5" d="M0 34 L28 30 L46 38 L70 22 L92 31 L118 18 L140 27 L162 24 L178 33" />
          <path fill="none" stroke="#B4331C" strokeWidth="1.5" strokeDasharray="3 4" d="M178 33 L200 33" />
          <path fill="none" stroke="#93805E" strokeWidth="1" d="M206 6 L206 48" />
        </svg>

        <h1>This market expired. <em>The others didn’t.</em></h1>
        <p>404: nothing lives at this address. Everything that does is one of these.</p>

        <div className="out">
          <a className="lead" href="/app">Open the app</a>
          <a href="/">Landing</a>
          <a href="/dashboard">The working</a>
          <a href="/deck">Deck</a>
        </div>
      </main>
    </>
  );
}
