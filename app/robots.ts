import type { MetadataRoute } from "next";

/* Was a hand-written file emitted by the old build script; now the framework's own route.
 * Same two lines, one fewer thing to keep in step with the page list. */
/* `output: "export"` needs every route to declare itself static, and this one is. */
export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: "https://abadi-wheat.vercel.app/sitemap.xml",
  };
}
