import crypto from "node:crypto";
// All /api/admin/* routes. Content is saved by committing to GitHub; Netlify rebuilds from there.
import { HttpError, json, readJSON } from "./util.mjs";
import { kvGet } from "./store.mjs";
import {
  ROLE_RANK, audit, authenticate, checkOrigin, clearCookie, getUsers, hashPassword, issueSession,
  login, need, ownerName, publicUser, saveUsers, sessionCookie, verifyPassword,
} from "./auth.mjs";
import * as gh from "./github.mjs";
import { parse, serialize } from "./frontmatter.mjs";

const TODAY = () => new Date().toISOString().slice(0, 10);

/* ── Validation ────────────────────────────────────────────────────────────── */

function clean(kind, input) {
  const d = input && typeof input === "object" ? input : {};
  const str = (k, max = 300) => String(d[k] ?? "").trim().slice(0, max);
  const errors = {};
  const out = {};

  out.title = str("title", 200);
  if (!out.title) errors.title = "Title is required";

  if (kind === "blog") {
    out.date = str("date", 40);
    if (!/^\d{4}-\d{2}-\d{2}/.test(out.date) || Number.isNaN(Date.parse(out.date))) errors.date = "Use a valid date";
    out.author = str("author", 100);
    if (!out.author) errors.author = "Author is required";
    const g = str("authorGithub", 60);
    if (g && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(g)) errors.authorGithub = "Not a valid GitHub username";
    if (g) out.authorGithub = g;
    if (d.pinned === true) out.pinned = true;
  } else {
    out.description = str("description", 500);
    if (!out.description) errors.description = "Description is required";
    out.section = str("section", 80);
    if (!out.section) errors.section = "Section is required";
    const order = Number(d.order);
    if (!Number.isInteger(order) || order < 0 || order > 9999) errors.order = "Use a whole number from 0 to 9999";
    out.order = order;
    const author = str("author", 100);
    if (author) out.author = author;
    const date = str("date", 40);
    if (date) {
      if (Number.isNaN(Date.parse(date))) errors.date = "Use a valid date";
      out.date = date;
    }
  }
  if (Object.keys(errors).length) throw new HttpError(422, "Fix the highlighted fields", { fields: errors });
  return out;
}

/* ── Images ────────────────────────────────────────────────────────────────── */

const MAX_IMAGE = 4 * 1024 * 1024;

function checkImage(name, buf) {
  const ext = name.split(".").pop().toLowerCase();
  const head = buf.subarray(0, 12);
  const is = (...bytes) => bytes.every((b, i) => head[i] === b);
  const ok = {
    png: () => is(0x89, 0x50, 0x4e, 0x47),
    jpg: () => is(0xff, 0xd8, 0xff),
    jpeg: () => is(0xff, 0xd8, 0xff),
    gif: () => is(0x47, 0x49, 0x46, 0x38),
    webp: () => head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP",
    avif: () => head.toString("latin1", 4, 8) === "ftyp",
    svg: () => {
      const t = buf.toString("utf8");
      return /<svg[\s>]/i.test(t) && !/<script|<foreignObject|\son\w+\s*=|javascript:/i.test(t);
    },
  }[ext];
  if (!ok || !ok()) throw new HttpError(422, "That file is not a valid image (SVGs with scripts are refused)");
}

function safeName(raw) {
  const base = String(raw || "image").replace(/\\/g, "/").split("/").pop();
  const m = base.match(/^(.*?)(?:\.([A-Za-z0-9]+))?$/);
  const stem = (m[1] || "image").normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "").slice(0, 70) || "image";
  return `${stem}.${(m[2] || "").toLowerCase()}`;
}

/* ── Routes ────────────────────────────────────────────────────────────────── */

export async function handle(req, context) {
  const url = new URL(req.url);
  const secure = url.protocol === "https:";
  const route = url.pathname.replace(/^\/api\/admin/, "").replace(/\/+$/, "") || "/";
  const method = req.method;
  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  try {
    checkOrigin(req, url);

    if (route === "/health" && method === "GET") {
      return json(200, {
        ok: true,
        configured: {
          secret: (process.env.ADMIN_SECRET || "").length >= 24,
          owner: !!(process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD),
          github: !!process.env.GITHUB_TOKEN,
        },
      });
    }

    if (route === "/login" && method === "POST") {
      const body = await readJSON(req);
      const user = await login({ username: body.username, password: body.password, ip });
      const { token, maxAge } = issueSession(user, body.remember === true);
      await audit(user, "login");
      return json(200, { user: { name: user.name, role: user.role } }, { "set-cookie": sessionCookie(token, maxAge, secure) });
    }

    if (route === "/logout" && method === "POST") {
      return json(200, { ok: true }, { "set-cookie": clearCookie(secure) });
    }

    const user = await authenticate(req);

    if (route === "/me" && method === "GET") return json(200, { user });

    if (route === "/me/password" && method === "POST") {
      if (user.role === "owner") throw new HttpError(400, "The owner password is the ADMIN_PASSWORD value in your Netlify environment variables");
      const body = await readJSON(req);
      const users = await getUsers();
      const rec = users[user.name.toLowerCase()];
      if (!rec || !(await verifyPassword(String(body.current || ""), rec.hash))) throw new HttpError(400, "Current password is wrong");
      if (String(body.next || "").length < 10) throw new HttpError(422, "Use at least 10 characters");
      rec.hash = await hashPassword(String(body.next));
      rec.sv = crypto.randomUUID().slice(0, 8);
      await saveUsers(users);
      await audit(user, "password.change");
      const { token, maxAge } = issueSession({ name: rec.name, role: rec.role, sv: rec.sv }, true);
      return json(200, { ok: true }, { "set-cookie": sessionCookie(token, maxAge, secure) });
    }

    /* Overview */
    if (route === "/overview" && method === "GET") {
      const c = gh.cfg();
      const [counts, commits, deploy] = await Promise.all([
        gh.repoCounts(),
        gh.commits(null, 8).catch(() => []),
        netlifyDeploy(context).catch(() => null),
      ]);
      return json(200, { counts, commits, deploy, repo: c.repo, branch: c.branch });
    }

    /* Content lists */
    if (route === "/content" && method === "GET") {
      const type = url.searchParams.get("type");
      if (type !== "blog" && type !== "docs") throw new HttpError(400, "type must be blog or docs");
      return json(200, { items: await gh.contentIndex(type) });
    }

    /* One file */
    if (route === "/file" && method === "GET") {
      const path = url.searchParams.get("path");
      gh.assertPath(path, ["blog", "docs"]);
      const file = await gh.getFile(path, url.searchParams.get("ref") || undefined);
      if (!file) throw new HttpError(404, "File not found");
      const { data, extra, body } = parse(file.text);
      return json(200, { path: file.path, sha: file.sha, data, extra, body });
    }

    if (route === "/file" && method === "PUT") {
      const b = await readJSON(req);
      const kind = gh.assertPath(b.path, ["blog", "docs"]);
      const data = clean(kind, b.data);
      const text = serialize(data, String(b.body ?? ""), String(b.extra ?? ""));
      const who = ` (via admin: ${user.name})`;
      const name = data.title.slice(0, 60);

      if (b.renameFrom && b.renameFrom !== b.path) {
        if (gh.assertPath(b.renameFrom, ["blog", "docs"]) !== kind) throw new HttpError(400, "Cannot move between blog and docs");
        if (await gh.getFile(b.path)) throw new HttpError(409, "A page already exists at that address");
        const saved = await gh.putFile(b.path, text, `${kind}: move and update "${name}"${who}`);
        await gh.deleteFile(b.renameFrom, String(b.renameSha || ""), `${kind}: remove old path of "${name}"${who}`);
        await audit(user, `${kind}.move`, `${b.renameFrom} → ${b.path}`);
        return json(200, saved);
      }

      try {
        const saved = await gh.putFile(b.path, text, `${kind}: ${b.sha ? "update" : "add"} "${name}"${who}`, b.sha || undefined);
        await audit(user, b.sha ? `${kind}.update` : `${kind}.create`, b.path);
        return json(200, saved);
      } catch (err) {
        if (err.extra?.github && (err.status === 409 || err.status === 422)) {
          throw new HttpError(409, b.sha ? "This file changed on GitHub since you opened it" : "A page already exists at that address", { conflict: true });
        }
        throw err;
      }
    }

    if (route === "/file" && method === "DELETE") {
      const path = url.searchParams.get("path");
      const kind = gh.assertPath(path, ["blog", "docs"]);
      const sha = url.searchParams.get("sha");
      if (!sha) throw new HttpError(400, "sha is required");
      const res = await gh.deleteFile(path, sha, `${kind}: delete ${path.split("/").pop()} (via admin: ${user.name})`);
      await audit(user, `${kind}.delete`, path);
      return json(200, res);
    }

    if (route === "/history" && method === "GET") {
      const path = url.searchParams.get("path");
      gh.assertPath(path, ["blog", "docs"]);
      return json(200, { commits: await gh.commits(path, 20) });
    }

    /* Media */
    if (route === "/media" && method === "GET") return json(200, { items: await gh.mediaIndex() });

    if (route === "/media" && method === "POST") {
      const b = await readJSON(req);
      const name = safeName(b.name);
      const buf = Buffer.from(String(b.data || ""), "base64");
      if (!buf.length) throw new HttpError(400, "Empty file");
      if (buf.length > MAX_IMAGE) throw new HttpError(413, "Image is over 4 MB");
      let stem = name.replace(/\.[^.]+$/, ""), ext = name.split(".").pop();
      if (!/^(png|jpe?g|gif|webp|avif|svg)$/.test(ext)) throw new HttpError(422, "Use PNG, JPG, GIF, WebP, AVIF or SVG");
      checkImage(name, buf);
      let path = `public/assets/uploads/${stem}.${ext}`;
      for (let n = 2; (await gh.getFile(path)) && n < 50; n++) path = `public/assets/uploads/${stem}-${n}.${ext}`;
      gh.assertPath(path, ["media"]);
      const saved = await gh.putFile(path, buf, `media: upload ${path.split("/").pop()} (via admin: ${user.name})`);
      await audit(user, "media.upload", path);
      return json(200, { ...saved, name: path.split("/").pop(), url: "/assets/uploads/" + path.split("/").pop() });
    }

    if (route === "/media" && method === "DELETE") {
      const path = url.searchParams.get("path");
      gh.assertPath(path, ["media"]);
      const sha = url.searchParams.get("sha");
      if (!sha) throw new HttpError(400, "sha is required");
      const res = await gh.deleteFile(path, sha, `media: delete ${path.split("/").pop()} (via admin: ${user.name})`);
      await audit(user, "media.delete", path);
      return json(200, res);
    }

    /* Site settings */
    if (route === "/settings" && method === "GET") {
      need(user, "admin");
      const f = await gh.getFile(gh.SETTINGS_PATH);
      if (!f) throw new HttpError(404, "src/data/site.json was not found");
      return json(200, { sha: f.sha, text: f.text });
    }
    if (route === "/settings" && method === "PUT") {
      need(user, "admin");
      const b = await readJSON(req);
      let obj;
      try { obj = JSON.parse(String(b.text || "")); } catch (e) { throw new HttpError(422, `Not valid JSON: ${e.message}`); }
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new HttpError(422, "Settings must be a JSON object");
      if (typeof obj.title !== "string" || !obj.title.trim()) throw new HttpError(422, "\"title\" is required");
      try {
        const saved = await gh.putFile(gh.SETTINGS_PATH, JSON.stringify(obj, null, 2) + "\n", `settings: update site.json (via admin: ${user.name})`, b.sha || undefined);
        await audit(user, "settings.update");
        return json(200, saved);
      } catch (err) {
        if (err.extra?.github && (err.status === 409 || err.status === 422)) throw new HttpError(409, "Settings changed on GitHub since you opened them", { conflict: true });
        throw err;
      }
    }

    /* Users */
    if (route === "/users" && method === "GET") {
      need(user, "admin");
      const users = Object.values(await getUsers()).map(publicUser);
      return json(200, { owner: ownerName(), users });
    }
    if (route === "/users" && method === "POST") {
      need(user, "admin");
      const b = await readJSON(req);
      const name = String(b.username || "").trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(name)) throw new HttpError(422, "Username: 3–32 letters, numbers, dots, dashes or underscores");
      if (name === ownerName().toLowerCase()) throw new HttpError(409, "That username belongs to the owner");
      if (String(b.password || "").length < 10) throw new HttpError(422, "Use at least 10 characters for the password");
      const role = b.role === "admin" ? "admin" : "editor";
      if (role === "admin" && user.role !== "owner") throw new HttpError(403, "Only the owner can create admins");
      const users = await getUsers();
      if (users[name]) throw new HttpError(409, "That username is taken");
      users[name] = { name, role, hash: await hashPassword(String(b.password)), sv: crypto.randomUUID().slice(0, 8), created: new Date().toISOString() };
      await saveUsers(users);
      await audit(user, "user.create", `${name} (${role})`);
      return json(200, { user: publicUser(users[name]) });
    }
    const um = route.match(/^\/users\/([a-z0-9][a-z0-9_.-]*)$/);
    if (um && (method === "PATCH" || method === "DELETE")) {
      need(user, "admin");
      const users = await getUsers();
      const rec = users[um[1]];
      if (!rec) throw new HttpError(404, "User not found");
      if (rec.role === "admin" && user.role !== "owner") throw new HttpError(403, "Only the owner can change admins");
      if (method === "DELETE") {
        delete users[um[1]];
        await saveUsers(users);
        await audit(user, "user.delete", rec.name);
        return json(200, { ok: true });
      }
      const b = await readJSON(req);
      if (b.password !== undefined) {
        if (String(b.password).length < 10) throw new HttpError(422, "Use at least 10 characters for the password");
        rec.hash = await hashPassword(String(b.password));
      }
      if (b.disabled !== undefined) rec.disabled = !!b.disabled;
      if (b.role !== undefined) {
        if (!(b.role in ROLE_RANK) || b.role === "owner") throw new HttpError(422, "Invalid role");
        if (b.role === "admin" && user.role !== "owner") throw new HttpError(403, "Only the owner can make admins");
        rec.role = b.role;
      }
      rec.sv = crypto.randomUUID().slice(0, 8); // signs the person out everywhere
      await saveUsers(users);
      await audit(user, "user.update", rec.name);
      return json(200, { user: publicUser(rec) });
    }

    if (route === "/activity" && method === "GET") {
      need(user, "admin");
      return json(200, { items: (await kvGet("audit")) || [] });
    }

    throw new HttpError(404, "Unknown endpoint");
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message, ...err.extra, github: undefined });
    console.error("admin-api error:", err);
    return json(500, { error: "Something went wrong on the server" });
  }
}

/* Optional: show the latest Netlify deploy on the dashboard (needs NETLIFY_API_TOKEN). */
async function netlifyDeploy(context) {
  const token = process.env.NETLIFY_API_TOKEN;
  const site = context?.site?.id || process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  if (!token || !site) return null;
  const res = await fetch(`https://api.netlify.com/api/v1/sites/${site}/deploys?per_page=1`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const [d] = await res.json();
  return d ? { state: d.state, createdAt: d.created_at, error: d.error_message || "", url: d.deploy_ssl_url || d.ssl_url || "" } : null;
}
