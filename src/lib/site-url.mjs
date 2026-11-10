// One place that decides what the site's public URL is.
// Order: `siteUrl` in src/data/site.json, then the SITE_URL environment variable.
// Returns "" when neither is set. Never has a trailing slash.

/** Shown in docs and on the homepage when no site URL is configured. */
export const FALLBACK_SITE_URL = "https://your-domain.com";

export function normalizeSiteUrl(value) {
  return String(value ?? "")
    .trim()
    .replace(/\/+$/, "");
}

export function resolveSiteUrl(...candidates) {
  for (const c of candidates) {
    const url = normalizeSiteUrl(c);
    if (url) return url;
  }
  return "";
}
