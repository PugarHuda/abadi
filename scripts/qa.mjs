/**
 * `npm run qa` — build, then run the browser suite against THIS build.
 *
 * This exists because the two obvious ways to say that are both wrong on Windows. A POSIX
 * env prefix (`BASE=… npx playwright test`) is handed to cmd.exe, where it is not a command.
 * Setting `process.env.BASE` inside `playwright.config.ts` looks like it works and does not:
 * the config is evaluated in the runner, the specs run in worker processes, and the workers
 * do not see the mutation. The specs then fall back to their default, which is **production**.
 *
 * That is not a hypothetical. For several runs on 2026-09-07 this suite reported 96 passing
 * against the live site while the local build was never loaded once, and it only became
 * visible when production started answering with Vercel's bot-mitigation page and 71 tests
 * failed at once on a page that was fine. A test that silently measures something other than
 * what you changed is worse than no test.
 *
 * So the variable is set in a real process before Playwright starts, and every argument is
 * passed through: `npm run qa -- --grep deck` works.
 */
import { spawnSync } from "node:child_process";

process.env.BASE ??= "http://localhost:4321";
console.log(`qa against ${process.env.BASE}`);

const build = spawnSync("npm", ["run", "build"], { stdio: "inherit", shell: true });
if (build.status !== 0) process.exit(build.status ?? 1);

const test = spawnSync("npx", ["playwright", "test", ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: true,
  env: process.env,
});
process.exit(test.status ?? 1);
