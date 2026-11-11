import type { APIRoute } from "astro";
import template from "../../admin/config.yml?raw";
import site from "../../data/site.json";
import { resolveSiteUrl } from "../../lib/site-url.mjs";

// Served at /admin/config.yml for the content manager at /admin/. The template in
// src/admin/config.yml gets the GitHub repo and branch from site.json ("admin") and the
// public URL from the site URL (siteUrl or SITE_URL).
export const GET: APIRoute = ({ site: astroSite }) => {
  const repo = (site.admin?.repo || "").trim();
  const branch = (site.admin?.branch || "main").trim();
  const siteUrl = resolveSiteUrl(site.siteUrl, astroSite?.href);

  if (!repo) {
    console.warn(
      '[admin] "admin.repo" is empty in src/data/site.json. Set it to "owner/repo" or the content manager at /admin/ cannot sign in.',
    );
  }

  let body = template
    .replaceAll("__REPO__", repo || "OWNER/REPO")
    .replaceAll("__BRANCH__", branch);
  body = siteUrl
    ? body.replaceAll("__SITE_URL__", siteUrl)
    : body.replace(/^site_url:.*\n/m, "");

  return new Response(body, {
    headers: { "Content-Type": "text/yaml; charset=utf-8" },
  });
};
