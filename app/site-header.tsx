/**
 * One masthead, on every page that has one.
 *
 * There used to be three. The landing page's wordmark was a `<div>` and did not go home; the
 * dashboard's was an `<a>` and put its nav outside the header; `/app` restyled the whole nav
 * again under `.masthead nav` instead of `.nav`, so its links were a different size to the
 * same links one click away. The landing page offered three destinations and the others four,
 * which moved every item sideways as you navigated, and the same link was called "Open the
 * app" on two pages and "App" on the third.
 *
 * None of that was a decision. It is what happens when a header is copied into each page and
 * then edited in one of them, and it is the first thing the framework is actually good for:
 * there is one component now and the pages cannot drift apart again.
 */

const LINKS = [
  { href: "/", label: "Landing" },
  { href: "/dashboard", label: "The working" },
  { href: "/deck", label: "Deck" },
  { href: "/app", label: "Open the app", go: true },
];

export default function SiteHeader({
  current,
  children,
}: {
  /** The path of the page this is rendered on, so one link can say it is where you are. */
  current: string;
  /** Anything the page wants beside the wordmark — the dashboard's dateline uses it. */
  children?: React.ReactNode;
}) {
  return (
    <header className="masthead">
      <a className="lockup" href="/" aria-label="Abadi home">
        <svg viewBox="0 0 20 38" aria-hidden="true">
          <rect x="0" y="4" width="11.7" height="30" fill="#16262B" />
          <rect x="13.1" y="4" width="6.9" height="30" fill="#2A3A6B" />
          <path d="M12.4 0V38" stroke="#B4331C" strokeWidth="1.4" />
        </svg>
        <h1 className="wordmark">abadi</h1>
      </a>
      {children}
      <nav className="nav" aria-label="Site">
        {LINKS.map((l) => (
          <a
            key={l.href}
            href={l.href}
            className={l.go ? "go" : undefined}
            aria-current={l.href === current ? "page" : undefined}
          >
            {l.label}
          </a>
        ))}
      </nav>
    </header>
  );
}
