# MonoPanel website

The public website and documentation for **MonoPanel** (Katharos V2.0.1, stable): a hosting platform for Discord bot hosting and VPS hosting, made of a panel and a node daemon.

Built with [Astro](https://astro.build) 7, Tailwind CSS 4 and MDX. It is a fully static site.

## Run it

```bash
pnpm install
pnpm dev        # http://localhost:4321
pnpm build      # static output in dist/
pnpm preview
```

Node.js 22.12 or newer is required.

## Where things live

| Path | What it is |
|---|---|
| `src/data/site.json` | Name, release label, links, the feature list and the install steps shown on the homepage |
| `src/pages/index.astro` | Homepage |
| `src/content/docs/` | Documentation (MDX). Each page needs `title`, `description`, `section` and `order` |
| `src/content/blog/` | Blog posts (MDX) with `title`, `date`, `author` |
| `public/assets/` | Logo mark (`logo.svg`, `icon.png`), banner and icons |

## Links that only show when set

The GitHub, Discord and repository links are set in `src/data/site.json` under `links`. The install video link is empty, so it is not shown. Any link left as `""` is simply not rendered.

Set `SITE_URL` in your build environment (or `siteUrl` in `src/data/site.json`, which wins if both are set) to your public domain to get canonical and Open Graph URLs.

## One-line installer

The installer script is served at `<site url>/installer.sh`, so installing is:

```bash
curl -fsSL https://your-domain.com/installer.sh | bash
```

The script's source is `src/installer/installer.sh`. It is built into `/installer.sh` by `src/pages/installer.sh.ts`, which replaces the `<url>` placeholder in its usage notes with the site URL (`siteUrl` or `SITE_URL`). The homepage command and the `%SITE_URL%` placeholder in docs code blocks use the same URL. With no site URL set, `<url>` is left in the script and the homepage shows the visitor's own origin.

The site must be served from the root of its domain (assets use absolute `/` paths).

## Screenshots

Drop images into `public/assets/screenshots/` and map a feature id to a file in the `screenshotMap` object in `public/js/main.js` to show it in that feature's popup.

## Blog and docs editor (`/admin/`)

`/admin/` is a content manager (Sveltia CMS) where your team writes blog posts and docs pages in the browser. Every save is a commit to this repository, and the deploy workflow rebuilds the site.

One-time setup:

1. Set `admin.repo` in `src/data/site.json` to this site's GitHub repo, like `"your-org/monopanel-site"` (`admin.branch` defaults to `main`).
2. Give each team member write access to the repo.
3. Each person opens `https://your-domain.com/admin/`, picks **Sign in with token** and pastes a GitHub fine-grained personal access token limited to this repo with **Contents: Read and write** (add **Pull requests: Read and write** if you turn on the editorial workflow). The token stays in that person's browser.

Notes:

- Collections: **Blog posts**, one **Docs** collection per folder (Features, Administration, API, Panel, Configuration, Development, Daemon) and **Overview pages** (About, Architecture). The docs sidebar groups pages by the **Section** field, not by folder, and sorts them by **Sidebar order**.
- To add a docs section, add its name to the `sections` list in `src/admin/config.yml` (and a collection for its folder if you want one). The config is served at `/admin/config.yml` with the repo and site URL filled in by `src/pages/admin/config.yml.ts`.
- Images uploaded in the editor go to `public/assets/uploads/`.
- Posts and docs are `.mdx` files. Write plain Markdown, and put any `<` or `{` outside code in backticks, or the build fails. A failed build never replaces the live site.
- To review before publishing, uncomment `publish_mode: editorial_workflow` in `src/admin/config.yml`.
- `public/admin/index.html` loads the editor from unpkg. To lock it to one release, change the URL to `@sveltia/cms@<version>`.
- Teams who don't want personal access tokens can add an OAuth proxy and set `base_url` under `backend:` (see the Sveltia CMS docs).

## Loading screen

`src/components/Loader.astro` shows a short black-and-white "panel boot" animation (a ring of tiles lighting up around the logo, a progress bar, a wipe-up exit) while the page loads. It is included by both layouts. In `src/data/site.json`:

```json
"loader": { "enabled": true, "oncePerSession": true }
```

`enabled: false` removes it. With `oncePerSession` it shows on the first page of a visit only; add `?loader` to any URL to see it again. It shows for at least 0.9 s, never longer than 6 s, never without JavaScript, and is simplified with `prefers-reduced-motion`.

## 404 page

`src/pages/404.astro` builds to `404.html`, which Cloudflare Pages, Netlify and GitHub Pages serve for unknown URLs automatically. It suggests the closest docs and blog pages to the missing URL. Self-hosting with Caddy needs one extra block:

```caddy
your-domain.com {
    root * /var/www/monopanel
    file_server
    handle_errors {
        rewrite * /404.html
        file_server
    }
}
```
