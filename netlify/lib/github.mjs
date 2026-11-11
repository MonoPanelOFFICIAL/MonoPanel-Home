// Talks to the GitHub repository. Saving content = committing a file; Netlify then rebuilds.
import site from "../../src/data/site.json" with { type: "json" };
import { HttpError, mapLimit } from "./util.mjs";
import { parse } from "./frontmatter.mjs";

export function cfg() {
  const token = process.env.GITHUB_TOKEN;
  const repo = (process.env.GITHUB_REPO || site.admin?.repo || "").trim();
  const branch = (process.env.GITHUB_BRANCH || site.admin?.branch || "main").trim();
  if (!token) throw new HttpError(500, "GITHUB_TOKEN is not set");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new HttpError(500, "GITHUB_REPO must look like owner/repo");
  return { token, repo, branch, api: (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "") };
}

const enc = (p) => p.split("/").map(encodeURIComponent).join("/");

async function gh(method, path, body) {
  const c = cfg();
  const res = await fetch(c.api + path, {
    method,
    headers: {
      authorization: `Bearer ${c.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "monopanel-admin",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { /* not JSON */ } }
  if (res.ok) return data;

  const msg = data?.message || res.statusText;
  if (res.status === 401) throw new HttpError(502, "GitHub rejected GITHUB_TOKEN (wrong or expired token)");
  if (res.status === 403 || res.status === 429) throw new HttpError(502, `GitHub refused the request: ${msg}`);
  if (res.status === 404) throw new HttpError(404, "Not found on GitHub", { github: true });
  if (res.status === 409 || res.status === 422) throw new HttpError(res.status, msg, { github: true });
  throw new HttpError(502, `GitHub error ${res.status}: ${msg}`);
}

/* ── Caches ────────────────────────────────────────────────────────────────── */

let treeCache = { at: 0, entries: null };
const metaCache = new Map(); // blob sha → parsed frontmatter summary (immutable, so safe forever)
export const invalidate = () => { treeCache = { at: 0, entries: null }; };

export async function tree() {
  if (treeCache.entries && Date.now() - treeCache.at < 10_000) return treeCache.entries;
  const c = cfg();
  const data = await gh("GET", `/repos/${c.repo}/git/trees/${encodeURIComponent(c.branch)}?recursive=1`);
  if (data.truncated) throw new HttpError(502, "The repository is too large to list through GitHub's tree API");
  treeCache = { at: Date.now(), entries: data.tree };
  return data.tree;
}

async function blobText(sha) {
  const c = cfg();
  const blob = await gh("GET", `/repos/${c.repo}/git/blobs/${sha}`);
  return Buffer.from(blob.content, "base64").toString("utf8");
}

/* ── Files ─────────────────────────────────────────────────────────────────── */

export async function getFile(path, ref) {
  const c = cfg();
  try {
    const f = await gh("GET", `/repos/${c.repo}/contents/${enc(path)}?ref=${encodeURIComponent(ref || c.branch)}`);
    if (Array.isArray(f) || f.type !== "file") throw new HttpError(400, "Not a file");
    let content = f.content;
    if (!content && f.sha) content = (await gh("GET", `/repos/${c.repo}/git/blobs/${f.sha}`)).content;
    return { path: f.path, sha: f.sha, size: f.size, text: Buffer.from(content || "", "base64").toString("utf8") };
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

export async function putFile(path, content, message, sha) {
  const c = cfg();
  const data = await gh("PUT", `/repos/${c.repo}/contents/${enc(path)}`, {
    message,
    branch: c.branch,
    content: Buffer.isBuffer(content) ? content.toString("base64") : Buffer.from(content, "utf8").toString("base64"),
    ...(sha ? { sha } : {}),
  });
  invalidate();
  return { sha: data.content.sha, path: data.content.path, commit: { sha: data.commit.sha, url: data.commit.html_url } };
}

export async function deleteFile(path, sha, message) {
  const c = cfg();
  const data = await gh("DELETE", `/repos/${c.repo}/contents/${enc(path)}`, { message, sha, branch: c.branch });
  invalidate();
  return { commit: { sha: data.commit.sha, url: data.commit.html_url } };
}

export async function commits(path, perPage = 15) {
  const c = cfg();
  const q = new URLSearchParams({ sha: c.branch, per_page: String(perPage) });
  if (path) q.set("path", path);
  const list = await gh("GET", `/repos/${c.repo}/commits?${q}`);
  return list.map((x) => ({
    sha: x.sha,
    message: String(x.commit.message || "").split("\n")[0],
    author: x.commit.author?.name || x.author?.login || "",
    date: x.commit.author?.date || "",
    url: x.html_url,
  }));
}

/* ── Content index (titles, order, dates) ──────────────────────────────────── */

export async function contentIndex(type) {
  const prefix = type === "blog" ? "src/content/blog/" : "src/content/docs/";
  const files = (await tree()).filter(
    (e) => e.type === "blob" && e.path.startsWith(prefix) && /\.mdx?$/.test(e.path),
  );
  return mapLimit(files, 8, async (e) => {
    let meta = metaCache.get(e.sha);
    if (!meta) {
      const { data } = parse(await blobText(e.sha));
      meta = {
        title: String(data.title ?? ""), description: String(data.description ?? ""),
        section: String(data.section ?? ""), order: typeof data.order === "number" ? data.order : null,
        date: data.date ? String(data.date) : "", author: String(data.author ?? ""),
        pinned: data.pinned === true,
      };
      metaCache.set(e.sha, meta);
    }
    const rel = e.path.slice(prefix.length);
    const parts = rel.split("/");
    const file = parts.pop();
    return { path: e.path, sha: e.sha, size: e.size, folder: parts.join("/"), slug: file.replace(/\.mdx?$/, ""), ...meta };
  });
}

export async function mediaIndex() {
  const prefix = "public/assets/uploads/";
  return (await tree())
    .filter((e) => e.type === "blob" && e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes("/"))
    .map((e) => ({ path: e.path, name: e.path.slice(prefix.length), url: "/assets/" + e.path.slice("public/assets/".length), sha: e.sha, size: e.size }))
    .filter((e) => e.name !== ".gitkeep");
}

export async function repoCounts() {
  const t = await tree();
  const n = (re) => t.filter((e) => e.type === "blob" && re.test(e.path)).length;
  return {
    blog: n(/^src\/content\/blog\/[^/]+\.mdx?$/),
    docs: n(/^src\/content\/docs\/.+\.mdx?$/),
    media: n(/^public\/assets\/uploads\/[^/]+$/) - n(/^public\/assets\/uploads\/\.gitkeep$/),
  };
}

/* ── What the admin may touch ──────────────────────────────────────────────── */

const SEG = "[a-z0-9][a-z0-9-]*";
const PATHS = {
  blog: new RegExp(`^src/content/blog/${SEG}\\.mdx$`),
  docs: new RegExp(`^src/content/docs/(?:${SEG}/){0,2}${SEG}\\.mdx?$`),
  media: /^public\/assets\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.(?:png|jpe?g|gif|webp|avif|svg)$/i,
};
export const SETTINGS_PATH = "src/data/site.json";

export function kindOf(path) {
  if (typeof path !== "string" || path.includes("..") || path.includes("//")) return null;
  for (const [kind, re] of Object.entries(PATHS)) if (re.test(path)) return kind;
  return null;
}
export function assertPath(path, kinds) {
  const k = kindOf(path);
  if (!k || !kinds.includes(k)) throw new HttpError(400, "That path cannot be edited from the admin panel");
  return k;
}
