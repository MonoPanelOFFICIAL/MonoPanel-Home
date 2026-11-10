import type { APIRoute } from "astro";
import template from "../installer/installer.sh?raw";
import site from "../data/site.json";
import { resolveSiteUrl } from "../lib/site-url.mjs";

// Served as a static file at /installer.sh, so `curl -fsSL <site>/installer.sh | bash` works.
// The <url>/installer.sh placeholder in the script's usage notes is filled in from the site URL
// (site.json `siteUrl`, or SITE_URL at build time). Left as <url> when neither is set.
export const GET: APIRoute = ({ site: astroSite }) => {
  const base = resolveSiteUrl(site.siteUrl, astroSite?.href);
  if (!base) {
    console.warn(
      "[installer.sh] No site URL set: leaving <url> in the script. Set SITE_URL or siteUrl in src/data/site.json.",
    );
  }
  // Only the "<url>/installer.sh" usage lines: other "<url>" text in the script (like the
  // "fetch <url> <dest>" comment) is not the site URL.
  const body = base
    ? template.replaceAll("<url>/installer.sh", `${base}/installer.sh`)
    : template;
  return new Response(body, {
    headers: { "Content-Type": "text/x-shellscript; charset=utf-8" },
  });
};
