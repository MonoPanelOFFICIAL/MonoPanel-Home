# MonoPanel website

The public website and documentation for **MonoPanel** (Katharos V2.0.2, stable): a hosting platform for Discord bot, Node.js, website, Lavalink and VPS hosting, made of a panel and a node daemon.

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
| `public/admin/` | The admin panel's pages (`index.html`, `admin.css`, `admin.js`) |
| `netlify/` | The admin panel's backend: the function in `functions/` and its code in `lib/` |
| `src/styles/responsive.css` | Phone and tablet layout fixes, loaded after every other stylesheet |

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

## Admin panel (`/admin/`)

`/admin/` is this site's own admin panel, with its own sign-in and its own backend. The backend is a Netlify Function (`netlify/functions/admin-api.mjs`), so the panel works on Netlify. Every save is a commit to this repository through the GitHub API, and Netlify rebuilds the site from it.

What it does:

- **Blog posts and docs pages**: list, search, create, edit, move, delete. A Markdown editor with a toolbar, live preview, word count, a warning for characters that would break the MDX build, unsaved-draft recovery and version history with one-click restore.
- **Media**: upload by choosing or dragging images (large photos are shrunk in the browser), copy a path or Markdown, insert from inside the editor, delete.
- **Settings**: edit `src/data/site.json` (title, release, links, loader) with a form, or the whole file as JSON.
- **Users and roles**: the **owner** (from environment variables), **admins** (content, settings, users) and **editors** (content only). Passwords are stored as scrypt hashes.
- **Activity log** of who did what, and a dashboard with recent commits.
- Works on phones, tablets and desktops.

### Setup (once)

1. Deploy the repo to Netlify (**Add new site > Import an existing project**). `netlify.toml` already sets the build command, the output folder and the functions folder.
2. Create a GitHub **fine-grained personal access token** limited to this repo with **Contents: Read and write**.
3. In Netlify, open **Site configuration > Environment variables** and add the variables from `.env.example`:

   | Variable | What it is |
   |---|---|
   | `ADMIN_SECRET` | A long random string (24+ characters) that signs login cookies |
   | `ADMIN_USERNAME` / `ADMIN_PASSWORD` | The owner account |
   | `GITHUB_TOKEN` | The token from step 2 |
   | `GITHUB_REPO` | `owner/repo`. Falls back to `admin.repo` in `src/data/site.json` |
   | `GITHUB_BRANCH` | The branch Netlify deploys from. Defaults to `main` |
   | `NETLIFY_API_TOKEN` | Optional. Shows the latest deploy state on the dashboard |

4. Redeploy, then open `https://your-site/admin/` and sign in as the owner. Add your team under **Users**.

Notes:

- Accounts, the activity log and login throttling are kept in Netlify Blobs, which needs no setup.
- To test locally, copy `.env.example` to `.env` and run `npm run dev:netlify` (it uses the Netlify CLI through `npx`). Plain `npm run dev` serves the site only, with no admin backend.
- Five wrong passwords from one address and username lock that combination for 15 minutes. Changing a user's password or disabling them signs them out everywhere. Changing `ADMIN_PASSWORD` signs the owner out everywhere.
- Images are limited to 4 MB each (Netlify Functions accept requests up to 6 MB).
- Posts and docs are `.mdx` files. Write plain Markdown, and put any `<` or `{` outside code in backticks, or the build fails. A failed build never replaces the live site.
- The docs sidebar groups pages by **Section** and sorts them by **Order**, not by folder.
- Anyone who can write to the repository can still edit content directly on GitHub. The admin panel is an easier way in, not the only one.
- The Sveltia CMS setup (`src/admin/config.yml`, `src/pages/admin/config.yml.ts`) has been removed.

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

## Deploy to GitHub Pages

1. In the repo, go to **Settings > Pages** and set **Source** to **GitHub Actions** (not "Deploy from a branch").
2. Push to `main`. `.github/workflows/deploy.yml` builds the site and publishes it.
3. The site must live at the root of a domain, because it uses absolute `/assets/...` paths. Either name the repo `monopanelofficial.github.io` (the organization's own Pages address), or add a custom domain under **Settings > Pages** and set a repository variable `SITE_URL` to `https://your-domain.com`. A repo named anything else is published at `/<repo-name>/` and will look broken.
4. The admin panel needs Netlify Functions, so it does not run on GitHub Pages. Use Netlify if you want `/admin/`.
