/**
 * Copy the export into `dist/` as well as `out/`.
 *
 * Belt and braces, and it is here because the alternative cost the live site four pages.
 * This Vercel project was created as a plain static build long before any framework, so the
 * directory it serves is a setting in the dashboard rather than anything in this repository —
 * and the first framework deployment built `out/` while production went on serving whatever
 * that setting names. Every route but `/` answered 404.
 *
 * `vercel.json` now says `outputDirectory: "out"`, which should settle it. This makes the
 * answer the same either way: whichever of the two directories that project is pointed at, it
 * holds the site that was just built.
 *
 * `scripts/compare-render.mjs` overwrites `dist/` with the pre-framework build on purpose,
 * immediately before comparing the two — so if you are looking at `dist/` and wondering why it
 * is the old site, that is why, and it is only ever true after that script has run.
 *
 * Delete this once the project's own setting is known to be right.
 */
import { cpSync, rmSync, existsSync } from "node:fs";

if (!existsSync("out")) {
  console.error("out/ is not there. `next build` has to run first.");
  process.exit(1);
}
rmSync("dist", { recursive: true, force: true });
cpSync("out", "dist", { recursive: true });
console.log("mirrored out/ -> dist/");
