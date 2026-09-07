/**
 * Static export, deliberately.
 *
 * Nothing on this site is rendered per request: every number a reader sees is read from the
 * chain in their own browser, which is the project's first rule and predates the framework.
 * A server runtime would add a place for that rule to be broken and buy nothing, so the build
 * emits the same flat files Vercel was already serving — which is also what keeps
 * `vercel.json`'s headers, the QA mirror and the design detector pointed at the same bytes.
 *
 * `trailingSlash: false` with `cleanUrls` in `vercel.json` is what keeps `/dashboard` rather
 * than `/dashboard/`, the URLs the film, the README and every evidence file already cite.
 */
/** @type {import('next').NextConfig} */
export default {
  output: "export",
  trailingSlash: false,
  // No <Image> on this site: the one raster is the OG card, which is never rendered in a page.
  images: { unoptimized: true },
};
