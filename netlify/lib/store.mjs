// Small key-value store for admin accounts, the activity log and login throttling.
// Uses Netlify Blobs, which needs no setup on Netlify and works under `netlify dev`.
import { getStore } from "@netlify/blobs";
import { HttpError } from "./util.mjs";

const memory = new Map();
const memoryStore = {
  async get(key) {
    return memory.has(key) ? structuredClone(memory.get(key)) : null;
  },
  async set(key, value) {
    memory.set(key, structuredClone(value));
  },
  async del(key) {
    memory.delete(key);
  },
};

let blobStore = null;

function open() {
  // Only for automated tests. Never set this in production: data would not persist.
  if (process.env.ADMIN_DEV_MEMORY_STORE === "1") return memoryStore;
  if (!blobStore) {
    try {
      const s = getStore({ name: "monopanel-admin", consistency: "strong" });
      blobStore = {
        get: (key) => s.get(key, { type: "json" }),
        set: (key, value) => s.setJSON(key, value),
        del: (key) => s.delete(key),
      };
    } catch (err) {
      throw new HttpError(
        500,
        "Netlify Blobs is not available here. Deploy to Netlify, or run `npx netlify dev` locally.",
        { detail: String(err?.message || err) },
      );
    }
  }
  return blobStore;
}

export const kvGet = (key) => open().get(key);
export const kvSet = (key, value) => open().set(key, value);
export const kvDel = (key) => open().del(key);
