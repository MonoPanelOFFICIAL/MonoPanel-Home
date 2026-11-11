// Reads and writes the small YAML frontmatter used by the blog and docs files.
// Handles the simple "key: value" lines the site uses. Anything more complex (lists, nested
// values, multi-line strings) is kept word for word in `extra` and written back untouched.

const KEY_ORDER = [
  "title",
  "description",
  "section",
  "order",
  "date",
  "author",
  "authorGithub",
  "pinned",
];
const ALWAYS_QUOTE = new Set(["title", "description", "section", "authorGithub"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[Tt ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function parseScalar(raw) {
  const v = raw.trim();
  if (v === "") return "";
  if (v[0] === '"') {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, v.endsWith('"') ? -1 : undefined);
    }
  }
  if (v[0] === "'" && v.endsWith("'") && v.length >= 2) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d*\.\d+$/.test(v)) return Number(v);
  return v;
}

export function parse(raw) {
  const text = String(raw).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const m = text.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!m) return { data: {}, extra: "", body: text.replace(/^\n+/, "") };

  const data = {};
  const extra = [];
  const lines = m[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z_][\w-]*):(?:\s+(.*)|\s*)$/);
    const value = kv ? (kv[2] ?? "") : "";
    const complex = !kv || value === "" || /^[|>\[{&*!]/.test(value);
    if (kv && !complex) {
      data[kv[1]] = parseScalar(value);
      continue;
    }
    // Keep this line and any indented or list lines under it exactly as they were.
    extra.push(line);
    while (i + 1 < lines.length && /^(\s+|-\s)/.test(lines[i + 1])) extra.push(lines[++i]);
  }
  return {
    data,
    extra: extra.join("\n"),
    body: text.slice(m[0].length).replace(/^\n+/, ""),
  };
}

function scalar(key, value) {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (value === null) return "null";
  const s = String(value);
  if (key === "date" && DATE_RE.test(s)) return s;
  if (
    !ALWAYS_QUOTE.has(key) &&
    /^[A-Za-z][A-Za-z0-9 ._-]*$/.test(s) &&
    !/^(true|false|null|yes|no|on|off)$/i.test(s) &&
    s === s.trim()
  ) {
    return s;
  }
  return JSON.stringify(s);
}

export function serialize(data, body, extra = "") {
  const keys = [
    ...KEY_ORDER.filter((k) => k in data),
    ...Object.keys(data).filter((k) => !KEY_ORDER.includes(k)),
  ];
  const lines = [];
  for (const k of keys) {
    const v = data[k];
    if (v === undefined || v === "" || (v === null && k !== "order")) continue;
    if (!/^[A-Za-z_][\w-]*$/.test(k)) continue;
    lines.push(`${k}: ${scalar(k, v)}`);
  }
  if (extra && extra.trim()) lines.push(extra.replace(/\s+$/, ""));
  const cleanBody = String(body ?? "").replace(/\r\n/g, "\n").replace(/^\n+/, "").replace(/\s+$/, "");
  return `---\n${lines.join("\n")}\n---\n\n${cleanBody}\n`;
}
