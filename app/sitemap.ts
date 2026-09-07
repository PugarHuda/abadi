import type { MetadataRoute } from "next";

const ORIGIN = "https://abadi-wheat.vercel.app";

/* The four pages a reader can land on. 404 is not one of them, which is the whole reason
 * this list is written down rather than globbed from the routes. */
/* `output: "export"` needs every route to declare itself static, and this one is. */
export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["/", "/dashboard", "/app", "/deck"].map((path) => ({ url: ORIGIN + path }));
}
