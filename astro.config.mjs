// @ts-check
import { readFileSync } from "node:fs";
import { defineConfig } from "astro/config";
import tailwind from "@tailwindcss/vite";
import mdx from "@astrojs/mdx";
import { remarkWrapTables } from "./src/lib/remark-wrap-tables.mjs";
import { remarkSiteUrl } from "./src/lib/remark-site-url.mjs";
import { resolveSiteUrl } from "./src/lib/site-url.mjs";
import hoverOnly from "./src/lib/postcss-hover-only.mjs";

const siteData = JSON.parse(
  readFileSync(new URL("./src/data/site.json", import.meta.url), "utf-8"),
);

// Public domain of the site, used for canonical/Open Graph URLs, the install command and
// /installer.sh. Set `siteUrl` in src/data/site.json or the SITE_URL environment variable
// (for example in your deploy environment). Leave both unset and these URLs are left out.
// On Netlify, the URL environment variable is the site's primary address, so it is used last.
const siteUrl = resolveSiteUrl(siteData.siteUrl, process.env.SITE_URL, process.env.URL);

// https://astro.build/config
export default defineConfig({
  site: siteUrl || undefined,
  output: "static",
  trailingSlash: "always",
  integrations: [mdx()],
  markdown: {
    remarkPlugins: [remarkWrapTables, [remarkSiteUrl, { siteUrl }]],
  },
  server: {
    host: "0.0.0.0",
    port: 4321,
    allowedHosts: true,
  },
  vite: {
    plugins: [tailwind()],
    // Hover styles only apply on devices with a real pointer (no sticky hover on touch).
    css: { postcss: { plugins: [hoverOnly()] } },
  },
});
