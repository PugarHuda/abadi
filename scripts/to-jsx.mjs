/**
 * One-shot migration: the five page sources that used to live in `web/` become App Router
 * routes under `app/`.
 *
 * Kept in the repository rather than run and deleted, because it is the answer to "is the
 * framework version the same page?" — a question settled by reading what was mechanically
 * transformed and what was not, and then by the byte comparison in
 * `scripts/compare-render.mjs`.
 *
 *   node scripts/to-jsx.mjs        # reads web/*.html, writes app/<route>/page.tsx
 *
 * What it deliberately does NOT touch: `web/*.js`. Those modules read the chain and drive the
 * DOM by id, they are covered by 96 browser tests, and rewriting them as components two days
 * from a deadline would trade working code for an idiom. They move to `public/` and the pages
 * load them exactly as before.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const ROUTES = {
  "index.html": {
    dir: "app", route: "/", name: "Home", inlineName: "home",
    description:
      "A vault that quotes both sides of DreamDEX Event Contract markets holding no inventory, and captures the spread with no directional exposure. Live on Somnia Shannon testnet.",
  },
  "dashboard.html": {
    dir: "app/dashboard", route: "/dashboard", name: "Dashboard", inlineName: "dashboard",
    description:
      "The working behind Abadi: 2,422 settled markets measured, the live order book with the vault's quote inside it, and the position that filled — with what went wrong and what it cost.",
  },
  "app.html": {
    dir: "app/app", route: "/app", name: "AppPage", inlineName: "operate",
    description:
      "Deposit into the Abadi vault, redeem your shares, mint test collateral — from the wallet you already have, with every call built in the open.",
  },
  "deck.html": {
    dir: "app/deck", route: "/deck", name: "Deck", inlineName: "deck",
    description:
      "Ten slides on Abadi: why 2,422 settled markets pointed at market making rather than prediction, and what happened when the vault quoted inside the spread.",
  },
  "404.html": {
    dir: "app", route: "/404", name: "NotFound", file: "not-found.tsx", inlineName: "notfound",
    description: "Nothing lives at this address.",
  },
};

const VOID = new Set(
  "area base br col embed hr img input link meta param source track wbr path rect circle ellipse line polygon polyline stop use".split(" "),
);

/** HTML attribute -> JSX prop. `data-*` and `aria-*` are already right in JSX. */
const ATTR = {
  class: "className", for: "htmlFor", tabindex: "tabIndex", colspan: "colSpan",
  rowspan: "rowSpan", maxlength: "maxLength", minlength: "minLength", readonly: "readOnly",
  autocomplete: "autoComplete", autofocus: "autoFocus", contenteditable: "contentEditable",
  spellcheck: "spellCheck", enterkeyhint: "enterKeyHint", inputmode: "inputMode",
  crossorigin: "crossOrigin", srcset: "srcSet", usemap: "useMap", novalidate: "noValidate",
  "stroke-width": "strokeWidth", "stroke-dasharray": "strokeDasharray",
  "stroke-dashoffset": "strokeDashoffset", "stroke-linecap": "strokeLinecap",
  "stroke-linejoin": "strokeLinejoin", "fill-rule": "fillRule", "clip-rule": "clipRule",
  "clip-path": "clipPath", "stop-color": "stopColor", "stop-opacity": "stopOpacity",
  "text-anchor": "textAnchor", "dominant-baseline": "dominantBaseline",
  "font-family": "fontFamily", "font-size": "fontSize", "font-weight": "fontWeight",
  "vector-effect": "vectorEffect", "shape-rendering": "shapeRendering",
};

/** Props React types as numbers. `tabindex="-1"` is a string in HTML and a number in JSX. */
const NUMERIC = new Set(["tabIndex", "colSpan", "rowSpan", "maxLength", "minLength", "span", "start", "aria-valuemin", "aria-valuemax", "aria-valuenow", "aria-level", "aria-posinset", "aria-setsize"]);

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** `style="a: b; c: d"` -> a JSX object. Custom properties keep their exact name. */
function styleObject(css) {
  const props = css
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const i = d.indexOf(":");
      const k = d.slice(0, i).trim();
      const v = d.slice(i + 1).trim();
      return (k.startsWith("--") ? JSON.stringify(k) : camel(k)) + ": " + JSON.stringify(v);
    });
  return "{{ " + props.join(", ") + " }}";
}

function convertTag(close, name, attrs, selfClose) {
  if (close) return "</" + name + ">";
  let out = "";
  const re = /([:@a-zA-Z_][-:.\w]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>`=]+)))?/g;
  let m;
  while ((m = re.exec(attrs))) {
    const raw = m[1];
    const val = m[3] ?? m[4] ?? m[5];
    if (raw === "style" && val !== undefined) {
      out += " style=" + styleObject(val);
      continue;
    }
    const key = ATTR[raw] ?? raw;
    if (val === undefined) { out += " " + key + "={true}"; continue; }
    out += NUMERIC.has(key) ? " " + key + "={" + Number(val) + "}" : " " + key + "=" + JSON.stringify(val);
  }
  return "<" + name + out + (selfClose || VOID.has(name.toLowerCase()) ? " />" : ">");
}

function toJsx(html) {
  const tags = [];
  const comments = [];
  let s = html;
  // Comments first, so nothing inside one is parsed as a tag.
  s = s.replace(/<!--([\s\S]*?)-->/g, (_, body) => {
    comments.push(body);
    return " C" + (comments.length - 1) + " ";
  });
  s = s.replace(/<(\/)?([a-zA-Z][-\w]*)((?:\s+[^<>]*?)?)(\/)?>/g, (_, close, name, attrs, self) => {
    tags.push(convertTag(close, name, attrs ?? "", !!self));
    return " T" + (tags.length - 1) + " ";
  });
  // A brace in prose would be read as a JSX expression.
  s = s.replace(/[{}]/g, (c) => "{'" + c + "'}");
  s = s.replace(/ T(\d+) /g, (_, i) => tags[Number(i)]);
  s = s.replace(/ C(\d+) /g, (_, i) => "{/*" + comments[Number(i)].split("*/").join("* /") + "*/}");
  return s;
}

mkdirSync("public", { recursive: true });

for (const [file, cfg] of Object.entries(ROUTES)) {
  const raw = readFileSync("web/" + file, "utf8");
  const title = (raw.match(/<title>([^<]*)<\/title>/i) ?? [, "Abadi"])[1].trim();
  const stem = cfg.file === "not-found.tsx" ? "not-found" : "page";

  // The page stylesheet leaves the document and becomes a stylesheet the framework links.
  const styles = [];
  let body = raw.replace(/<style>([\s\S]*?)<\/style>/gi, (_, css) => {
    styles.push(css.trim());
    return "";
  });

  const srcs = [];
  const inline = [];
  body = body.replace(/<script([^>]*)>([\s\S]*?)<\/script>/gi, (_, attrs, code) => {
    const src = (attrs.match(/src\s*=\s*"([^"]+)"/) ?? [])[1];
    if (src) srcs.push(src);
    else if (code.trim()) inline.push(code.trim());
    return "";
  });
  body = body.replace(/<title>[\s\S]*?<\/title>/i, "").trim();

  mkdirSync(cfg.dir, { recursive: true });
  const cssName = stem + ".css";
  if (styles.length) writeFileSync(cfg.dir + "/" + cssName, styles.join("\n\n") + "\n");

  // An inline script becomes a real file, which is one fewer thing the policy has to allow.
  if (inline.length) {
    srcs.push("/" + cfg.inlineName + "-inline.js");
    writeFileSync("public/" + cfg.inlineName + "-inline.js", inline.join("\n\n") + "\n");
  }

  /* The two footers that name the vault in prose. The old build script rewrote them with a
   * regex over the finished document, because prose does not follow `.vault-addr` and a
   * redeploy once left them naming a retired address. Here the prose becomes an expression,
   * so there is nothing left to rewrite. */
  const jsx = toJsx(body).replace(/vault 0x[0-9a-fA-F]{8}…[0-9a-fA-F]{4}/g, "{shortVault}");
  const usesVault = jsx.includes("{shortVault}");

  const lines = [];
  if (usesVault) lines.push('import { readFileSync } from "node:fs";');
  lines.push('import type { Metadata } from "next";');
  if (srcs.length) lines.push('import Script from "next/script";');
  lines.push('import "./' + cssName + '";');
  lines.push("");
  lines.push("export const metadata: Metadata = {");
  lines.push("  title: " + JSON.stringify(title) + ",");
  lines.push("  description: " + JSON.stringify(cfg.description) + ",");
  lines.push("  alternates: { canonical: " + JSON.stringify(cfg.route) + " },");
  lines.push("  openGraph: {");
  lines.push("    title: " + JSON.stringify(title) + ",");
  lines.push("    description: " + JSON.stringify(cfg.description) + ",");
  lines.push("    url: " + JSON.stringify(cfg.route) + ",");
  // Next replaces the whole openGraph object rather than merging into the layout's, so the
  // card image has to be repeated on every route or it is only on the ones that omit it.
  lines.push("    type: \"website\",");
  lines.push("    images: [{ url: \"/og.png\", width: 1200, height: 630 }],");
  lines.push("  },");
  lines.push("};");
  if (usesVault) {
    lines.push("");
    lines.push("/* Read at build time in a server component, the same file the old build read. */");
    lines.push('const vault = readFileSync(".vault-addr", "utf8").trim();');
    lines.push("const shortVault = `vault ${vault.slice(0, 10)}…${vault.slice(-4)}`;");
  }
  lines.push("");
  lines.push("export default function " + cfg.name + "() {");
  lines.push("  return (");
  lines.push("    <>");
  for (const l of jsx.split("\n")) lines.push(l.trim() ? "      " + l : "");
  /* `next/script` with `afterInteractive`, NOT a plain `<script defer>`.
   *
   * These modules mutate the DOM the moment they run — they disable buttons, write status
   * lines, fill panels. A deferred script wins that race against React's hydration on a fast
   * machine and loses it on a slow one: hydration then finds markup it did not render, throws
   * the subtree away, and every listener attached a moment earlier goes with it. It passed
   * locally and took twenty-two tests down in CI, which is exactly the shape of failure that
   * timing bugs have. `afterInteractive` is the framework's guarantee that hydration is done. */
  for (const s of srcs) {
    lines.push("      <Script src=" + JSON.stringify(s) + ' strategy="afterInteractive" />');
  }
  lines.push("    </>");
  lines.push("  );");
  lines.push("}");

  writeFileSync(cfg.dir + "/" + (cfg.file ?? "page.tsx"), lines.join("\n") + "\n");
  console.log(
    file + " -> " + cfg.dir + "/" + (cfg.file ?? "page.tsx") +
      "  (" + styles.length + " css, " + srcs.length + " script" + (usesVault ? ", vault expr" : "") + ")",
  );
}
