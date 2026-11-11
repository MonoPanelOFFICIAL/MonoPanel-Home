// Own sign-in system: signed session cookie, scrypt password hashes, roles, login throttling.
import crypto from "node:crypto";
import { promisify } from "node:util";
import { HttpError, parseCookies, safeEqual, sha256 } from "./util.mjs";
import { kvGet, kvSet } from "./store.mjs";

const scrypt = promisify(crypto.scrypt);
const COOKIE = "mp_admin";
export const ROLE_RANK = { editor: 1, admin: 2, owner: 3 };

/* ── Passwords ─────────────────────────────────────────────────────────────── */

export async function hashPassword(password) {
  const N = 16384, r = 8, p = 1;
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 32, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored || "").split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const key = await scrypt(password, Buffer.from(salt, "base64"), expected.length, {
    N: Number(N), r: Number(r), p: Number(p),
  });
  return crypto.timingSafeEqual(key, expected);
}

let dummyHash;
async function burnTime(password) {
  dummyHash ??= await hashPassword("not-a-real-password");
  await verifyPassword(password, dummyHash);
}

/* ── Session cookie ────────────────────────────────────────────────────────── */

function secret() {
  const s = process.env.ADMIN_SECRET || "";
  if (s.length < 24) {
    throw new HttpError(500, "ADMIN_SECRET is not set (use a random string of at least 24 characters)");
  }
  return s;
}

const sign = (body) => crypto.createHmac("sha256", secret()).update(body).digest("base64url");

function makeToken(claims, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ ...claims, iat: now, exp: now + ttlSeconds })).toString("base64url");
  return `${body}.${sign(body)}`;
}

function readToken(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(body));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString());
    return claims.exp > Date.now() / 1000 ? claims : null;
  } catch {
    return null;
  }
}

export function sessionCookie(token, maxAge, secure) {
  return [
    `${COOKIE}=${token}`,
    "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAge}`,
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

export const clearCookie = (secure) => sessionCookie("", 0, secure);

/* ── Users ─────────────────────────────────────────────────────────────────── */

export const ownerName = () => (process.env.ADMIN_USERNAME || "").trim();
const ownerSv = () => sha256(process.env.ADMIN_PASSWORD || "").toString("hex").slice(0, 10);

export async function getUsers() {
  return (await kvGet("users")) || {};
}
export const saveUsers = (users) => kvSet("users", users);

export const publicUser = (u) => ({
  name: u.name, role: u.role, disabled: !!u.disabled, created: u.created, lastLogin: u.lastLogin || null,
});

/* ── Login throttling (5 failed tries per 15 minutes per IP and username) ──── */

const memFails = new Map();
const WINDOW = 15 * 60 * 1000, MAX_FAILS = 5;

async function failKey(ip, username) {
  return "rl:" + sha256(`${ip}|${username.toLowerCase()}`).toString("hex").slice(0, 24);
}
async function readFails(key) {
  try { return (await kvGet(key)) || memFails.get(key) || null; } catch { return memFails.get(key) || null; }
}
async function writeFails(key, value) {
  memFails.set(key, value);
  try { await kvSet(key, value); } catch { /* the in-memory copy still limits this instance */ }
}

export async function login({ username, password, ip }) {
  username = String(username || "").trim();
  password = String(password || "");
  if (!username || !password) throw new HttpError(400, "Enter your username and password");

  const key = await failKey(ip, username);
  const fails = await readFails(key);
  if (fails && fails.count >= MAX_FAILS && Date.now() - fails.first < WINDOW) {
    const mins = Math.ceil((WINDOW - (Date.now() - fails.first)) / 60000);
    throw new HttpError(429, `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`);
  }

  let user = null;
  const owner = ownerName();
  if (owner && process.env.ADMIN_PASSWORD && username.toLowerCase() === owner.toLowerCase()) {
    if (safeEqual(password, process.env.ADMIN_PASSWORD)) {
      user = { name: owner, role: "owner", sv: ownerSv() };
    }
  } else {
    const users = await getUsers();
    const rec = users[username.toLowerCase()];
    if (rec) {
      if ((await verifyPassword(password, rec.hash)) && !rec.disabled) {
        user = { name: rec.name, role: rec.role, sv: rec.sv };
        rec.lastLogin = new Date().toISOString();
        await saveUsers(users);
      }
    } else {
      await burnTime(password);
    }
  }

  if (!user) {
    const now = Date.now();
    const f = fails && now - fails.first < WINDOW ? fails : { count: 0, first: now };
    await writeFails(key, { count: f.count + 1, first: f.first });
    throw new HttpError(401, "Wrong username or password");
  }
  await writeFails(key, { count: 0, first: Date.now() });
  return user;
}

export function issueSession(user, remember) {
  const ttl = remember ? 30 * 24 * 3600 : 12 * 3600;
  return { token: makeToken({ u: user.name, r: user.role, sv: user.sv }, ttl), maxAge: ttl };
}

/** Returns the signed-in user for a request, or throws 401. */
export async function authenticate(req) {
  const claims = readToken(parseCookies(req.headers.get("cookie") || "").mp_admin);
  if (!claims) throw new HttpError(401, "Please sign in");

  if (claims.r === "owner") {
    if (!ownerName() || claims.u !== ownerName() || claims.sv !== ownerSv()) {
      throw new HttpError(401, "Please sign in again");
    }
    return { name: claims.u, role: "owner" };
  }
  const rec = (await getUsers())[String(claims.u).toLowerCase()];
  if (!rec || rec.disabled || rec.sv !== claims.sv) throw new HttpError(401, "Please sign in again");
  return { name: rec.name, role: rec.role };
}

export function need(user, role) {
  if (ROLE_RANK[user.role] < ROLE_RANK[role]) {
    throw new HttpError(403, "Your role does not allow this");
  }
}

/** Mutating requests must come from this site and carry our header (CSRF defence). */
export function checkOrigin(req, url) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  if (req.headers.get("x-requested-with") !== "monopanel-admin") {
    throw new HttpError(403, "Missing request header");
  }
  const origin = req.headers.get("origin");
  if (origin) {
    let host = "";
    try { host = new URL(origin).host; } catch { /* handled below */ }
    if (host !== url.host) throw new HttpError(403, "Cross-site request blocked");
  }
}

/* ── Activity log ──────────────────────────────────────────────────────────── */

export async function audit(user, action, detail = "") {
  try {
    const log = (await kvGet("audit")) || [];
    log.unshift({ at: new Date().toISOString(), user: user?.name || "?", action, detail: String(detail).slice(0, 200) });
    await kvSet("audit", log.slice(0, 300));
  } catch { /* the log is best-effort */ }
}
