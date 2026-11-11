/* MonoPanel admin — own panel, own backend (/api/admin, a Netlify Function).
   No framework, no inline scripts or handlers (the page's CSP forbids them). */
(() => {
  "use strict";

  /* ── Helpers ─────────────────────────────────────────────────────────────── */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const state = { user: null, dirty: false, route: "" };
  let routeId = 0; // bumped on every navigation so a slow view never overwrites a newer one
  const actions = {};
  let ed = null; // the open editor

  const ICONS = {
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
    blog: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h6"/>',
    docs: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5V21h16"/>',
    media: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/>',
    settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 5.5"/>',
    activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7V3M8 21v-7h8v7"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
    logout: '<path d="M9 4H5v16h4M16 8l4 4-4 4M20 12H9"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    pin: '<path d="M12 17v5M8 3h8l-1 7 3 4H6l3-4z"/>',
  };
  const icon = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ""}</svg>`;

  const fmt = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");
  const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "");
  function ago(iso) {
    const s = Math.max(1, Math.round((Date.now() - new Date(iso)) / 1000));
    if (s < 60) return "just now";
    const t = [[60, "minute"], [3600, "hour"], [86400, "day"], [2592000, "month"]];
    for (let i = t.length - 1; i >= 0; i--) if (s >= t[i][0]) { const n = Math.floor(s / t[i][0]); return `${n} ${t[i][1]}${n === 1 ? "" : "s"} ago`; }
    return fmt(iso);
  }
  const slugify = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70);
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  function toast(msg, kind = "") {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $("#toasts").replaceChildren(el); // one at a time, so toasts never pile up over dialogs
    setTimeout(() => el.remove(), kind === "bad" ? 7000 : 4200);
  }

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch("/api/admin" + path, {
        method, credentials: "same-origin",
        headers: { "x-requested-with": "monopanel-admin", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw Object.assign(new Error("Can't reach the server. Check your connection."), { status: 0 });
    }
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      const err = Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status, fields: data?.fields, conflict: data?.conflict });
      if (res.status === 401 && !["/login", "/me"].includes(path)) { state.user = null; state.dirty = false; renderLogin("Your session ended. Sign in again."); }
      throw err;
    }
    return data;
  }

  /* ── Modal ───────────────────────────────────────────────────────────────── */
  function openModal(html, { wide = false } = {}) {
    closeModal();
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true">${html}</div>`;
    back.addEventListener("mousedown", (e) => { if (e.target === back) closeModal(); });
    $("#modal-root").append(back);
    const f = $("input:not([type=hidden]), textarea, select, button.primary", back);
    if (f && matchMedia("(pointer: fine)").matches) f.focus();
    return back;
  }
  function closeModal() { $("#modal-root").innerHTML = ""; }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#modal-root").firstChild) closeModal(); });

  function confirmBox(title, message, ok = "Confirm", danger = false) {
    return new Promise((resolve) => {
      const m = openModal(`<h2>${esc(title)}</h2><p class="muted">${esc(message)}</p>
        <div class="acts"><button class="btn" data-x="no">Cancel</button><button class="btn ${danger ? "danger" : "primary"}" data-x="yes">${esc(ok)}</button></div>`);
      m.addEventListener("click", (e) => {
        const b = e.target.closest("[data-x]");
        if (b) { closeModal(); resolve(b.dataset.x === "yes"); }
      });
    });
  }

  /* ── Markdown preview and MDX safety check ───────────────────────────────── */
  const safeUrl = (u) => { u = String(u).replace(/&amp;/g, "&").replace(/&quot;/g, '"'); return /^(https?:|mailto:|\/|#|\.\.?\/)/i.test(u) ? esc(u) : "#"; };
  function inline(raw) {
    const codes = [];
    let s = esc(raw).replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (m, a, u) => `<img alt="${a}" src="${safeUrl(u)}">`);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (m, t, u) => `<a href="${safeUrl(u)}" target="_blank" rel="noopener">${t}</a>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>").replace(/(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g, "$1<em>$2</em>");
    return s.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${codes[i]}</code>`);
  }
  function renderMarkdown(src) {
    const lines = String(src).replace(/\r\n/g, "\n").split("\n");
    const out = [];
    for (let i = 0; i < lines.length;) {
      const ln = lines[i];
      let m;
      if ((m = ln.match(/^\s*(```|~~~)\s*([\w-]*)/))) {
        const buf = []; i++;
        while (i < lines.length && !/^\s*(```|~~~)/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      } else if (/^\s*$/.test(ln)) { i++;
      } else if (/^\s*(import|export)\s.+/.test(ln) && !out.length) { out.push(`<pre><code>${esc(ln)}</code></pre>`); i++;
      } else if ((m = ln.match(/^(#{1,4})\s+(.*?)\s*#*$/))) { out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++;
      } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(ln)) { out.push("<hr>"); i++;
      } else if (/^\s*>/.test(ln)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
        out.push(`<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`);
      } else if (/^\s*\|.*\|\s*$/.test(ln) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || "")) {
        const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
        const head = cells(ln); i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        out.push(`<div class="tw"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      } else if ((m = ln.match(/^(\s*)([-*+]|\d+\.)\s+/))) {
        const ordered = /\d/.test(m[2]), buf = [];
        while (i < lines.length && /^(\s*)([-*+]|\d+\.)\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, ""));
        out.push(`<${ordered ? "ol" : "ul"}>${buf.map((t) => `<li>${inline(t)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      } else {
        const buf = [];
        while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\s*(```|~~~|#{1,4}\s|>|([-*+]|\d+\.)\s)/.test(lines[i])) buf.push(lines[i++]);
        out.push(`<p>${inline(buf.join(" "))}</p>`);
      }
    }
    return out.join("\n");
  }
  // The site builds these files as MDX, where a stray "<" or "{" outside code breaks the build.
  function lintMdx(body) {
    const out = [];
    let fence = false;
    body.split("\n").forEach((ln, i) => {
      if (/^\s*(```|~~~)/.test(ln)) { fence = !fence; return; }
      if (fence || /^\s*(import|export)\s/.test(ln)) return;
      const t = ln.replace(/`[^`]*`/g, "").replace(/<br\s*\/>/g, "").replace(/<!--.*?-->/g, "");
      if (/<[A-Za-z\/!]/.test(t)) out.push(`Line ${i + 1}: a “<” outside code can break the site build. Wrap it in backticks.`);
      else if (/[{}]/.test(t)) out.push(`Line ${i + 1}: “{” and “}” outside code can break the site build. Wrap them in backticks.`);
    });
    if (fence) out.push("A code block (```) is opened but never closed.");
    return out.slice(0, 6);
  }

  /* ── Login and shell ─────────────────────────────────────────────────────── */
  async function renderLogin(notice = "") {
    document.title = "Sign in · MonoPanel admin";
    let health = null;
    try { health = await api("GET", "/health"); } catch { /* shown below */ }
    const c = health?.configured;
    const problems = !health
      ? ["The admin API did not answer. It runs as a Netlify Function, so this page only works on a Netlify deploy (or under `netlify dev`)."]
      : [!c.secret && "ADMIN_SECRET is not set.", !c.owner && "ADMIN_USERNAME and ADMIN_PASSWORD are not set.", !c.github && "GITHUB_TOKEN is not set."].filter(Boolean);
    $("#app").innerHTML = `<div class="login"><div class="login-box">
      <div class="brand"><img src="/assets/logo.svg" alt="" /> MonoPanel</div>
      <div><h1>Sign in</h1><p class="muted">Manage the blog, docs, images and site settings.</p></div>
      ${notice ? `<div class="alert warn">${esc(notice)}</div>` : ""}
      ${problems.length ? `<div class="alert bad"><b>Setup needed</b><br>${problems.map((p) => esc(p).replace(/`([^`]+)`/g, "<code>$1</code>")).join("<br>")}<br><span class="muted">Add them in Netlify → Site configuration → Environment variables, then redeploy.</span></div>` : ""}
      <form id="login-form" autocomplete="on">
        <div class="field"><label for="u">Username</label><input id="u" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required></div>
        <div class="field"><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required></div>
        <label class="check"><input type="checkbox" id="remember"> Keep me signed in for 30 days</label>
        <div id="login-err" class="err" role="alert" style="color:var(--bad);font-size:13.5px"></div>
        <button class="btn primary" id="login-btn" type="submit">Sign in</button>
      </form></div></div>`;
    $("#login-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = $("#login-btn");
      btn.disabled = true; btn.textContent = "Signing in…"; $("#login-err").textContent = "";
      try {
        const r = await api("POST", "/login", { username: $("#u").value, password: $("#p").value, remember: $("#remember").checked });
        state.user = r.user;
        if (!location.hash.startsWith("#/")) history.replaceState(null, "", "#/");
        renderShell();
        lastHash = location.hash;
        route();
      } catch (err) {
        $("#login-err").textContent = err.message;
        btn.disabled = false; btn.textContent = "Sign in";
        $("#p").select();
      }
    });
    $("#u").focus();
  }

  const NAV = [
    ["#/", "home", "Dashboard"], ["#/blog", "blog", "Blog posts"], ["#/docs", "docs", "Docs pages"], ["#/media", "media", "Media"],
    ["sep", "Site"], ["#/settings", "settings", "Settings", "admin"], ["#/users", "users", "Users", "admin"], ["#/activity", "activity", "Activity", "admin"],
  ];
  const RANK = { editor: 1, admin: 2, owner: 3 };

  function renderShell() {
    const u = state.user;
    const items = NAV.filter((n) => !n[3] || RANK[u.role] >= RANK[n[3]]).map((n) => n[0] === "sep" ? `<div class="sep">${n[1]}</div>` : `<a href="${n[0]}" data-nav="${n[0]}">${icon(n[1])}<span>${n[2]}</span></a>`).join("");
    $("#app").innerHTML = `<div class="shell">
      <aside class="side" id="side">
        <div class="brand"><img src="/assets/logo.svg" alt="" /> MonoPanel admin</div>
        <nav class="nav" aria-label="Admin">${items}</nav>
        <div class="me"><div><b>${esc(u.name)}</b><span class="muted" style="font-size:12.5px;text-transform:capitalize">${esc(u.role)}</span></div>
          <div class="actions"><a class="btn sm" href="/" target="_blank" rel="noopener">${icon("external")} View site</a><a class="btn sm" href="#/account">${icon("key")} Account</a><button class="btn sm" data-act="logout">${icon("logout")} Sign out</button></div></div>
      </aside>
      <div class="scrim" id="scrim" data-act="menu"></div>
      <header class="topbar"><button class="btn icon" data-act="menu" aria-label="Menu">${icon("menu")}</button><div class="ttl" id="ttl">Admin</div></header>
      <main class="main" id="view"></main></div>`;
  }
  const setMenu = (open) => { $("#side")?.classList.toggle("open", open); $("#scrim")?.classList.toggle("on", open); };
  actions.menu = () => setMenu(!$("#side").classList.contains("open"));
  actions.logout = async () => {
    if (state.dirty && !(await confirmBox("Sign out?", "You have unsaved changes that will be lost.", "Sign out", true))) return;
    state.dirty = false;
    try { await api("POST", "/logout", {}); } catch { /* ignore */ }
    state.user = null; renderLogin();
  };

  function setView(html, title, navKey) {
    $("#view").innerHTML = html;
    $("#ttl").textContent = title;
    document.title = `${title} · MonoPanel admin`;
    $$("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === navKey));
    setMenu(false);
    scrollTo(0, 0);
  }
  const loading = () => { $("#view").innerHTML = '<p class="boot">Loading…</p>'; };
  const fail = (err) => `<div class="alert bad">${esc(err.message)}${err.status === 502 || err.status === 500 ? "<br><span class='muted'>Check GITHUB_TOKEN, GITHUB_REPO and GITHUB_BRANCH in your Netlify environment variables.</span>" : ""}</div>`;

  /* ── Dashboard ───────────────────────────────────────────────────────────── */
  async function viewDashboard() {
    const my = routeId;
    setView('<p class="boot">Loading…</p>', "Dashboard", "#/");
    let o;
    try { o = await api("GET", "/overview"); } catch (err) { if (my !== routeId) return; $("#view").innerHTML = `<div class="page-head"><h1>Dashboard</h1></div>${fail(err)}`; return; }
    if (my !== routeId) return;
    const d = o.deploy;
    const dep = d ? `<div class="card"><h2>Latest deploy</h2><p><span class="badge ${d.state === "ready" ? "ok" : d.state === "error" ? "bad" : "warn"}">${esc(d.state)}</span> <span class="muted">${esc(ago(d.createdAt))}</span></p>${d.error ? `<p class="muted" style="margin-top:8px">${esc(d.error)}</p>` : ""}</div>`
      : `<div class="card"><h2>Deploys</h2><p class="muted">Saving commits to GitHub; Netlify then rebuilds, usually within a minute. Add <code>NETLIFY_API_TOKEN</code> to see the deploy state here.</p></div>`;
    $("#view").innerHTML = `
      <div class="page-head"><div><h1>Hello, ${esc(state.user.name)}</h1><p class="sub">Editing <span class="mono">${esc(o.repo)}</span> on <span class="mono">${esc(o.branch)}</span></p></div>
        <div class="actions"><a class="btn primary" href="#/blog/new">${icon("plus")} New post</a><a class="btn" href="#/docs/new">${icon("plus")} New doc</a></div></div>
      <div class="stats">
        <a class="card stat" href="#/blog" style="text-decoration:none"><b>${o.counts.blog}</b><span>Blog posts</span></a>
        <a class="card stat" href="#/docs" style="text-decoration:none"><b>${o.counts.docs}</b><span>Docs pages</span></a>
        <a class="card stat" href="#/media" style="text-decoration:none"><b>${o.counts.media}</b><span>Images</span></a>
      </div>
      <div class="two"><div class="card"><h2>Recent changes</h2>${o.commits.length ? `<ul class="feed">${o.commits.map((c) => `<li><span class="m">${esc(c.message)}</span><span class="s">${esc(c.author)} · ${esc(ago(c.date))}</span></li>`).join("")}</ul>` : '<p class="muted">No commits yet.</p>'}</div>${dep}</div>`;
  }

  /* ── Lists ───────────────────────────────────────────────────────────────── */
  const cache = {};
  async function viewList(kind) {
    const my = routeId;
    const isBlog = kind === "blog";
    setView(`<div class="page-head"><h1>${isBlog ? "Blog posts" : "Docs pages"}</h1></div><p class="boot">Loading…</p>`, isBlog ? "Blog posts" : "Docs pages", `#/${kind}`);
    let items;
    try { items = (await api("GET", `/content?type=${kind}`)).items; } catch (err) { if (my !== routeId) return; $("#view").innerHTML = `<div class="page-head"><h1>${isBlog ? "Blog posts" : "Docs pages"}</h1></div>${fail(err)}`; return; }
    cache[kind] = items;
    if (my !== routeId) return;
    const sections = [...new Set(items.map((i) => i.section).filter(Boolean))].sort();
    $("#view").innerHTML = `
      <div class="page-head"><div><h1>${isBlog ? "Blog posts" : "Docs pages"}</h1><p class="sub">${items.length} ${isBlog ? "posts" : "pages"}</p></div>
        <a class="btn primary" href="#/${kind}/new">${icon("plus")} New ${isBlog ? "post" : "page"}</a></div>
      <div class="toolbar"><input class="grow" id="q" type="search" placeholder="Search ${isBlog ? "posts" : "pages"}…" aria-label="Search">${isBlog ? "" : `<select id="sec" aria-label="Section"><option value="">All sections</option>${sections.map((s) => `<option>${esc(s)}</option>`).join("")}</select>`}</div>
      <div class="list" id="rows"></div>`;
    const draw = () => {
      const q = $("#q").value.trim().toLowerCase(), sec = $("#sec")?.value || "";
      let rows = items.filter((i) => (!q || `${i.title} ${i.description} ${i.slug} ${i.section}`.toLowerCase().includes(q)) && (!sec || i.section === sec));
      if (!rows.length) { $("#rows").innerHTML = '<div class="empty">Nothing matches.</div>'; return; }
      const link = (i) => `#/${kind}/edit/${i.path.replace(isBlog ? "src/content/blog/" : "src/content/docs/", "").split("/").map(encodeURIComponent).join("/")}`;
      if (isBlog) {
        rows.sort((a, b) => (b.pinned - a.pinned) || String(b.date).localeCompare(String(a.date)));
        $("#rows").innerHTML = rows.map((i) => `<a class="row" href="${link(i)}"><div class="t">${esc(i.title || i.slug)} ${i.pinned ? `<span class="badge">${"Pinned"}</span>` : ""}</div><div class="d">${esc(fmtDay(i.date))} · ${esc(i.author)}</div><div class="r muted">${icon("external")}</div></a>`).join("");
      } else {
        const g = new Map();
        for (const i of rows) { if (!g.has(i.section)) g.set(i.section, []); g.get(i.section).push(i); }
        const ordered = [...g.entries()].sort((a, b) => Math.min(...a[1].map((x) => x.order ?? 999)) - Math.min(...b[1].map((x) => x.order ?? 999)));
        $("#rows").innerHTML = ordered.map(([s, list]) => `<div class="group-h">${esc(s || "No section")}</div>${list.sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.title.localeCompare(b.title)).map((i) => `<a class="row" href="${link(i)}"><div class="t">${esc(i.title || i.slug)}</div><div class="d">/docs/${esc(i.folder ? i.folder + "/" : "")}${esc(i.slug)} · order ${i.order ?? "—"}</div><div class="r muted">${icon("external")}</div></a>`).join("")}`).join("");
      }
    };
    $("#q").addEventListener("input", draw);
    $("#sec")?.addEventListener("change", draw);
    draw();
  }

  /* ── Editor ──────────────────────────────────────────────────────────────── */
  const draftKey = () => `mp-draft:${ed.isNew ? "new-" + ed.kind : ed.path}`;
  const blank = (kind) => kind === "blog"
    ? { title: "", date: new Date().toISOString().slice(0, 10), author: state.user.name, authorGithub: "", pinned: false }
    : { title: "", description: "", section: "", order: 50, author: "", date: "" };

  async function viewEditor(kind, rel) {
    const my = routeId;
    const isBlog = kind === "blog";
    const isNew = rel === null;
    setView('<p class="boot">Loading…</p>', isNew ? `New ${isBlog ? "post" : "page"}` : "Edit", `#/${kind}`);
    let file = null, items = cache[kind];
    try {
      if (!items) items = cache[kind] = (await api("GET", `/content?type=${kind}`)).items;
      if (!isNew) {
        const path = (isBlog ? "src/content/blog/" : "src/content/docs/") + rel;
        file = await api("GET", `/file?path=${encodeURIComponent(path)}`);
      }
    } catch (err) { if (my !== routeId) return; $("#view").innerHTML = `<div class="page-head"><h1>Edit</h1></div>${fail(err)}<p><a class="btn" href="#/${kind}">Back</a></p>`; return; }
    if (my !== routeId) return;

    const data = file ? { ...blank(kind), ...file.data } : blank(kind);
    const pathRel = rel ? rel.split("/") : [];
    const fileName = pathRel.pop() || "";
    ed = {
      kind, isNew, path: file?.path || "", sha: file?.sha || "", extra: file?.extra || "", ext: /\.md$/.test(fileName) ? ".md" : ".mdx",
      folder: pathRel.join("/"), slug: fileName.replace(/\.mdx?$/, ""), slugTouched: !isNew, data, body: file?.body || "",
      folders: [...new Set(items.map((i) => i.folder))].filter(Boolean).sort(), sections: [...new Set(items.map((i) => i.section).filter(Boolean))].sort(),
      tab: isNew ? "details" : "write",
    };
    ed.orig = JSON.stringify([ed.data, ed.body, ed.folder, ed.slug]);
    state.dirty = false;

    const f = ed.data;
    const field = (id, label, input, hint = "") => `<div class="field"><label for="f-${id}">${label}</label>${input}${hint ? `<div class="hint">${hint}</div>` : ""}<div class="err" id="e-${id}"></div></div>`;
    const text = (id, v, extra = "") => `<input id="f-${id}" type="text" value="${esc(v ?? "")}" ${extra}>`;
    const details = isBlog ? `
      ${field("title", "Title", text("title", f.title, 'autocomplete="off"'))}
      <div class="grid2">
        ${field("slug", "Address (file name)", text("slug", ed.slug, 'autocapitalize="none" spellcheck="false"'), `/blog/<b id="slug-prev">${esc(ed.slug || "…")}</b>/`)}
        ${field("date", "Date", `<input id="f-date" type="date" value="${esc(String(f.date || "").slice(0, 10))}">`)}
        ${field("author", "Author", text("author", f.author))}
        ${field("authorGithub", "Author's GitHub username", text("authorGithub", f.authorGithub, 'autocapitalize="none" spellcheck="false"'), "Optional. Shows their avatar.")}
      </div>
      <label class="check"><input type="checkbox" id="f-pinned" ${f.pinned ? "checked" : ""}> Pin to the top of the blog</label>` : `
      ${field("title", "Title", text("title", f.title, 'autocomplete="off"'))}
      ${field("description", "Description", `<textarea id="f-description" rows="2" style="min-height:70px">${esc(f.description || "")}</textarea>`, "Shown under the title and in search results.")}
      <div class="grid2">
        ${field("folder", "Folder", `<input id="f-folder" type="text" list="dl-folders" value="${esc(ed.folder)}" autocapitalize="none" spellcheck="false"><datalist id="dl-folders">${ed.folders.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>`, "Leave empty for a top-level page.")}
        ${field("slug", "Address (file name)", text("slug", ed.slug, 'autocapitalize="none" spellcheck="false"'), `/docs/<b id="slug-prev">${esc((ed.folder ? ed.folder + "/" : "") + (ed.slug || "…"))}</b>/`)}
        ${field("section", "Section", `<input id="f-section" type="text" list="dl-sections" value="${esc(f.section || "")}"><datalist id="dl-sections">${ed.sections.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>`, "Groups pages in the sidebar.")}
        ${field("order", "Order", `<input id="f-order" type="number" min="0" max="9999" step="1" value="${esc(f.order ?? 50)}">`, "Lower numbers come first.")}
      </div>`;

    const title = isNew ? `New ${isBlog ? "post" : "page"}` : f.title || ed.slug;
    $("#view").innerHTML = `<div class="editor">
      <div class="ed-top">
        <a class="btn sm icon" href="#/${kind}" aria-label="Back">←</a>
        <div class="grow" id="ed-title">${esc(title)}</div><span class="dirty" id="dirty" hidden>Unsaved</span>
        ${isNew ? "" : `<button class="btn sm" data-act="history">${icon("clock")}<span class="hide-s"> History</span></button><button class="btn sm danger" data-act="del-file" aria-label="Delete">${icon("trash")}</button>`}
        <button class="btn sm primary" data-act="save" id="save-btn">${icon("save")} Save</button>
      </div>
      <div id="draft-note"></div>
      <div class="tabs narrow-only" role="tablist">${["details", "write", "preview"].map((t) => `<button role="tab" data-act="tab" data-tab="${t}" class="${t === ed.tab ? "on" : ""}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</div>
      <div class="pane force card" id="pane-details" ${ed.tab === "details" ? "" : "hidden"}>${details}</div>
      <div class="ed-body split">
        <div class="pane force" id="pane-write" ${ed.tab === "write" ? "" : "hidden"}>
          <div class="tool" role="toolbar" aria-label="Formatting">
            <button data-act="md" data-md="h2" title="Heading">H2</button><button data-act="md" data-md="h3" title="Subheading">H3</button><span class="gap"></span>
            <button data-act="md" data-md="bold" title="Bold (Ctrl+B)"><b>B</b></button><button data-act="md" data-md="italic" title="Italic (Ctrl+I)"><i>I</i></button><button data-act="md" data-md="code" title="Inline code">&lt;/&gt;</button><span class="gap"></span>
            <button data-act="md" data-md="link" title="Link (Ctrl+K)">${icon("link")}</button><button data-act="md" data-md="image" title="Insert image">${icon("media")}</button><span class="gap"></span>
            <button data-act="md" data-md="ul" title="Bullet list">•</button><button data-act="md" data-md="ol" title="Numbered list">1.</button><button data-act="md" data-md="quote" title="Quote">❝</button><button data-act="md" data-md="codeblock" title="Code block">{ }</button><button data-act="md" data-md="table" title="Table">▦</button><button data-act="md" data-md="hr" title="Divider">—</button>
          </div>
          <textarea id="md" spellcheck="true" aria-label="Content (Markdown)" placeholder="Write in Markdown…">${esc(ed.body)}</textarea>
          <div class="status"><span id="wc"></span><span>Markdown · Ctrl/⌘+S to save</span></div>
          <div class="lint" id="lint"></div>
        </div>
        <div class="pane force" id="pane-preview" ${ed.tab === "preview" ? "" : "hidden"}><div class="preview" id="pv"></div></div>
      </div></div>`;
    refreshEditor();
    offerDraft();
  }

  function collect() {
    const v = (id) => $(`#f-${id}`)?.value ?? "";
    const d = { ...ed.data, title: v("title").trim() };
    if (ed.kind === "blog") Object.assign(d, { date: v("date"), author: v("author").trim(), authorGithub: v("authorGithub").trim(), pinned: $("#f-pinned").checked });
    else Object.assign(d, { description: v("description").trim(), section: v("section").trim(), order: v("order") === "" ? NaN : Number(v("order")), author: d.author || "" });
    return d;
  }
  function targetPath() {
    const slug = ($("#f-slug")?.value || "").trim();
    if (ed.kind === "blog") return `src/content/blog/${slug}.mdx`;
    const folder = ($("#f-folder")?.value || "").trim().replace(/^\/+|\/+$/g, "");
    return `src/content/docs/${folder ? folder + "/" : ""}${slug}${ed.isNew ? ".mdx" : ed.ext}`;
  }
  const bodyText = () => $("#md")?.value ?? "";

  function refreshEditor() {
    const body = bodyText();
    $("#pv").innerHTML = renderMarkdown(body) || '<p class="muted">Nothing to preview yet.</p>';
    const words = (body.match(/\S+/g) || []).length;
    $("#wc").textContent = `${words} words · ${Math.max(1, Math.round(words / 200))} min read`;
    $("#lint").innerHTML = lintMdx(body).map((w) => `<div class="alert warn">${esc(w)}</div>`).join("");
    const slug = ($("#f-slug")?.value || "").trim();
    const folder = ($("#f-folder")?.value || "").trim();
    if ($("#slug-prev")) $("#slug-prev").textContent = (ed.kind === "docs" && folder ? folder + "/" : "") + (slug || "…");
    const cur = JSON.stringify([collectSafe(), body, ($("#f-folder")?.value || "").trim(), slug]);
    state.dirty = cur !== ed.orig;
    $("#dirty").hidden = !state.dirty;
  }
  function collectSafe() { const d = collect(); if (Number.isNaN(d.order)) d.order = ed.data.order; return d; }

  const saveDraft = debounce(() => {
    if (!ed || !state.dirty) return;
    try { localStorage.setItem(draftKey(), JSON.stringify({ at: Date.now(), data: collectSafe(), body: bodyText(), slug: $("#f-slug").value, folder: $("#f-folder")?.value || "" })); } catch { /* storage full or blocked */ }
  }, 800);

  function offerDraft() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(draftKey()) || "null"); } catch { /* ignore */ }
    if (!raw || (JSON.stringify([raw.data, raw.body]) === JSON.stringify([ed.data, ed.body]))) return;
    $("#draft-note").innerHTML = `<div class="alert warn" style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between"><span>You have an unsaved draft from ${esc(ago(new Date(raw.at).toISOString()))}.</span><span class="actions"><button class="btn sm" data-act="draft-restore">Restore</button><button class="btn sm" data-act="draft-drop">Discard</button></span></div>`;
    ed.draft = raw;
  }
  actions["draft-restore"] = () => {
    const d = ed.draft; if (!d) return;
    ed.data = { ...ed.data, ...d.data };
    for (const [k, v] of Object.entries(d.data)) { const el = $(`#f-${k}`); if (el) el.type === "checkbox" ? (el.checked = !!v) : (el.value = v ?? ""); }
    $("#f-slug").value = d.slug; if ($("#f-folder")) $("#f-folder").value = d.folder;
    $("#md").value = d.body; $("#draft-note").innerHTML = ""; ed.slugTouched = true; refreshEditor(); toast("Draft restored");
  };
  actions["draft-drop"] = () => { try { localStorage.removeItem(draftKey()); } catch { /* ignore */ } $("#draft-note").innerHTML = ""; };

  actions.tab = (el) => {
    ed.tab = el.dataset.tab;
    $$(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === ed.tab));
    for (const t of ["details", "write", "preview"]) $(`#pane-${t}`).hidden = t !== ed.tab;
  };

  /* Toolbar */
  function mdSet(text, from, to, selStart, selEnd) {
    const ta = $("#md");
    ta.focus(); ta.setRangeText(text, from, to, "end");
    ta.setSelectionRange(selStart ?? from + text.length, selEnd ?? from + text.length);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function mdWrap(before, after, ph) {
    const ta = $("#md"), s = ta.selectionStart, e = ta.selectionEnd, sel = ta.value.slice(s, e) || ph;
    mdSet(before + sel + after, s, e, s + before.length, s + before.length + sel.length);
  }
  function mdLines(fn) {
    const ta = $("#md"), v = ta.value;
    const s = v.lastIndexOf("\n", ta.selectionStart - 1) + 1;
    let e = v.indexOf("\n", ta.selectionEnd); if (e < 0) e = v.length;
    const out = v.slice(s, e).split("\n").map(fn).join("\n");
    mdSet(out, s, e, s, s + out.length);
  }
  function mdBlock(text) {
    const ta = $("#md"), v = ta.value, p = ta.selectionStart;
    const pre = p === 0 || v.slice(p - 2, p) === "\n\n" ? "" : v.slice(p - 1, p) === "\n" ? "\n" : "\n\n";
    mdSet(pre + text + "\n\n", p, ta.selectionEnd);
  }
  actions.md = (el) => {
    const k = el.dataset.md;
    if (k === "bold") mdWrap("**", "**", "bold text");
    else if (k === "italic") mdWrap("*", "*", "italic text");
    else if (k === "code") mdWrap("`", "`", "code");
    else if (k === "link") { const ta = $("#md"), sel = ta.value.slice(ta.selectionStart, ta.selectionEnd) || "link text"; const s = ta.selectionStart; mdSet(`[${sel}](https://)`, s, ta.selectionEnd, s + sel.length + 3, s + sel.length + 11); }
    else if (k === "h2") mdLines((l) => "## " + l.replace(/^#+\s*/, ""));
    else if (k === "h3") mdLines((l) => "### " + l.replace(/^#+\s*/, ""));
    else if (k === "ul") mdLines((l) => "- " + l.replace(/^([-*]|\d+\.)\s+/, ""));
    else if (k === "ol") { let n = 0; mdLines((l) => `${++n}. ` + l.replace(/^([-*]|\d+\.)\s+/, "")); }
    else if (k === "quote") mdLines((l) => "> " + l.replace(/^>\s?/, ""));
    else if (k === "codeblock") mdBlock("```\ncode\n```");
    else if (k === "table") mdBlock("| Column | Meaning |\n| --- | --- |\n| one | First value |\n| two | Second value |");
    else if (k === "hr") mdBlock("---");
    else if (k === "image") pickImage((m) => { const ta = $("#md"), s = ta.selectionStart; mdSet(`![${m.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ")}](${m.url})`, s, ta.selectionEnd); });
  };

  document.addEventListener("input", (e) => {
    if (!ed || !e.target.closest("#view .editor")) return;
    if (e.target.id === "f-title" && ed.isNew && !ed.slugTouched) $("#f-slug").value = slugify(e.target.value);
    if (e.target.id === "f-slug") ed.slugTouched = true;
    if (e.target.id === "f-title") $("#ed-title").textContent = e.target.value || (ed.isNew ? "New" : ed.slug);
    $$(".err", $("#view")).forEach((x) => (x.textContent = ""));
    $$(".bad", $("#view")).forEach((x) => x.classList.remove("bad"));
    refreshEditor(); saveDraft();
  });
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s" && ed && $("#save-btn")) { e.preventDefault(); actions.save(); return; }
    if (mod && e.target.id === "md") {
      const k = e.key.toLowerCase();
      if (k === "b") { e.preventDefault(); actions.md({ dataset: { md: "bold" } }); }
      if (k === "i") { e.preventDefault(); actions.md({ dataset: { md: "italic" } }); }
      if (k === "k") { e.preventDefault(); actions.md({ dataset: { md: "link" } }); }
    }
  });

  /* Save, delete, history */
  function showFieldErrors(fields) {
    let first = null;
    for (const [k, msg] of Object.entries(fields || {})) {
      const el = $(`#f-${k}`), er = $(`#e-${k}`);
      if (el) { el.classList.add("bad"); first ??= el; }
      if (er) er.textContent = msg;
    }
    if (first) { actions.tab({ dataset: { tab: "details" } }); first.focus(); }
  }
  actions.save = async () => {
    const btn = $("#save-btn"); if (!btn || btn.disabled) return;
    const slug = ($("#f-slug").value || "").trim();
    const data = collect();
    const errs = {};
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) errs.slug = "Use lowercase letters, numbers and dashes";
    if (ed.kind === "docs") { const fo = ($("#f-folder").value || "").trim(); if (fo && !/^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*){0,1}$/.test(fo)) errs.folder = "Use lowercase letters, numbers and dashes"; if (Number.isNaN(data.order)) errs.order = "Enter a number"; }
    if (Object.keys(errs).length) { showFieldErrors(errs); toast("Fix the highlighted fields", "bad"); return; }
    const path = targetPath();
    const moved = !ed.isNew && path !== ed.path.replace(/\.mdx?$/, ed.ext);
    if (moved && !(await confirmBox("Move this page?", `The address will change to ${path.replace(/^src\/content\/(blog|docs)\//, "/$1/").replace(/\.mdx?$/, "/")}. Old links to it will stop working.`, "Move and save"))) return;
    btn.disabled = true; btn.innerHTML = "Saving…";
    try {
      const res = await api("PUT", "/file", { path, data, body: bodyText(), extra: ed.extra, sha: moved ? undefined : ed.sha || undefined, ...(moved ? { renameFrom: ed.path, renameSha: ed.sha } : {}) });
      try { localStorage.removeItem(draftKey()); } catch { /* ignore */ }
      delete cache[ed.kind];
      state.dirty = false;
      toast("Saved. The site is rebuilding, which usually takes under a minute.", "ok");
      const rel = path.replace(ed.kind === "blog" ? "src/content/blog/" : "src/content/docs/", "");
      if (ed.isNew || moved) { location.hash = `#/${ed.kind}/edit/${rel.split("/").map(encodeURIComponent).join("/")}`; }
      else { ed.sha = res.sha; ed.path = path; ed.data = data; ed.orig = JSON.stringify([ed.data, bodyText(), ($("#f-folder")?.value || "").trim(), slug]); refreshEditor(); }
    } catch (err) {
      if (err.fields) showFieldErrors(err.fields);
      if (err.conflict && !ed.isNew) conflictDialog(path, data);
      else toast(err.message, "bad");
    } finally { const b = $("#save-btn"); if (b) { b.disabled = false; b.innerHTML = `${icon("save")} Save`; } }
  };
  function conflictDialog(path, data) {
    const m = openModal(`<h2>This file changed on GitHub</h2><p class="muted">Someone else (or another tab) saved it after you opened it. You can overwrite their version with yours, or reload theirs and lose your edits here.</p>
      <div class="acts"><button class="btn" data-x="cancel">Cancel</button><button class="btn" data-x="reload">Reload latest</button><button class="btn danger" data-x="over">Overwrite with mine</button></div>`);
    m.addEventListener("click", async (e) => {
      const k = e.target.closest("[data-x]")?.dataset.x; if (!k) return;
      closeModal();
      if (k === "reload") { state.dirty = false; try { localStorage.removeItem(draftKey()); } catch { /* ignore */ } viewEditor(ed.kind, ed.path.replace(ed.kind === "blog" ? "src/content/blog/" : "src/content/docs/", "")); }
      if (k === "over") {
        try {
          const latest = await api("GET", `/file?path=${encodeURIComponent(ed.path)}`);
          ed.sha = latest.sha; actions.save();
        } catch (err) { toast(err.message, "bad"); }
      }
    });
  }
  actions["del-file"] = async () => {
    if (!(await confirmBox("Delete this " + (ed.kind === "blog" ? "post" : "page") + "?", "It is removed from the site on the next build. You can still get it back from the GitHub history.", "Delete", true))) return;
    try {
      await api("DELETE", `/file?path=${encodeURIComponent(ed.path)}&sha=${ed.sha}`);
      try { localStorage.removeItem(draftKey()); } catch { /* ignore */ }
      state.dirty = false; delete cache[ed.kind];
      toast("Deleted", "ok"); location.hash = `#/${ed.kind}`;
    } catch (err) { toast(err.message, "bad"); }
  };
  actions.history = async () => {
    const m = openModal('<h2>Version history</h2><p class="boot">Loading…</p>', { wide: true });
    try {
      const { commits } = await api("GET", `/history?path=${encodeURIComponent(ed.path)}`);
      $(".modal", m).innerHTML = `<h2>Version history</h2><p class="muted">Load an older version into the editor, review it, then save to restore it.</p>
        <ul class="feed">${commits.map((c, i) => `<li style="grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px"><div><span class="m">${esc(c.message)}</span><br><span class="s">${esc(c.author)} · ${esc(fmt(c.date))}${i === 0 ? " · latest" : ""}</span></div>${i === 0 ? "" : `<button class="btn sm" data-act="load-version" data-sha="${esc(c.sha)}">Load</button>`}</li>`).join("") || '<li class="muted">No history.</li>'}</ul>
        <div class="acts"><button class="btn" data-act="close">Close</button></div>`;
    } catch (err) { $(".modal", m).innerHTML = `<h2>Version history</h2>${fail(err)}<div class="acts"><button class="btn" data-act="close">Close</button></div>`; }
  };
  actions.close = closeModal;
  actions["load-version"] = async (el) => {
    el.disabled = true;
    try {
      const v = await api("GET", `/file?path=${encodeURIComponent(ed.path)}&ref=${encodeURIComponent(el.dataset.sha)}`);
      for (const [k, val] of Object.entries(v.data)) { const f = $(`#f-${k}`); if (f) f.type === "checkbox" ? (f.checked = !!val) : (f.value = val ?? ""); }
      $("#md").value = v.body; closeModal(); refreshEditor(); saveDraft();
      toast("Older version loaded. Review it, then save to restore.", "ok");
    } catch (err) { toast(err.message, "bad"); el.disabled = false; }
  };

  /* ── Media ───────────────────────────────────────────────────────────────── */
  const localThumbs = new Map();
  async function prepareImage(file) {
    let blob = file;
    if (/^image\/(png|jpeg|webp)$/.test(file.type)) {
      const bmp = await createImageBitmap(file).catch(() => null);
      if (bmp && (Math.max(bmp.width, bmp.height) > 2400 || file.size > 1.5 * 1024 * 1024)) {
        const k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
        const c = document.createElement("canvas");
        c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
        c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
        const out = await new Promise((r) => c.toBlob(r, file.type, 0.88));
        if (out && out.size < file.size) blob = out;
      }
    }
    if (blob.size > 4 * 1024 * 1024) throw new Error(`${file.name} is over 4 MB, even after shrinking`);
    const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(blob); });
    return { name: file.name, data, blob };
  }
  async function uploadFiles(files) {
    const done = [];
    for (const file of files) {
      if (!file.type.startsWith("image/")) { toast(`${file.name} is not an image`, "bad"); continue; }
      try {
        toast(`Uploading ${file.name}…`);
        const p = await prepareImage(file);
        const res = await api("POST", "/media", { name: p.name, data: p.data });
        localThumbs.set(res.name, URL.createObjectURL(p.blob));
        done.push(res);
      } catch (err) { toast(`${file.name}: ${err.message}`, "bad"); }
    }
    if (done.length) toast(`Uploaded ${done.length} image${done.length === 1 ? "" : "s"}. They go live on the next build.`, "ok");
    return done;
  }
  const tile = (m, pick) => `<div class="tile ${pick ? "pick" : ""}" ${pick ? `data-act="pick" data-url="${esc(m.url)}" data-name="${esc(m.name)}" role="button" tabindex="0"` : ""}>
      <div class="pic"><img src="${esc(localThumbs.get(m.name) || m.url)}" alt="" loading="lazy"></div>
      <div class="meta"><div class="nm">${esc(m.name)}</div>${pick ? "" : `<div class="btns"><button class="btn sm" data-act="copy" data-text="${esc(m.url)}" title="Copy path">${icon("copy")} Path</button><button class="btn sm" data-act="copy" data-text="![${esc(m.name.replace(/\.[^.]+$/, ""))}](${esc(m.url)})">${icon("copy")} Markdown</button><button class="btn sm danger icon" data-act="del-media" data-path="${esc(m.path)}" data-sha="${esc(m.sha)}" aria-label="Delete ${esc(m.name)}">${icon("trash")}</button></div>`}</div></div>`;
  document.addEventListener("error", (e) => {
    const img = e.target;
    if (img.tagName === "IMG" && img.closest(".tile .pic")) img.replaceWith(Object.assign(document.createElement("span"), { textContent: "Live after next build" }));
  }, true);

  async function viewMedia() {
    const my = routeId;
    setView('<div class="page-head"><h1>Media</h1></div><p class="boot">Loading…</p>', "Media", "#/media");
    let items;
    try { items = (await api("GET", "/media")).items; } catch (err) { if (my !== routeId) return; $("#view").innerHTML = `<div class="page-head"><h1>Media</h1></div>${fail(err)}`; return; }
    if (my !== routeId) return;
    $("#view").innerHTML = `<div class="page-head"><div><h1>Media</h1><p class="sub">${items.length} image${items.length === 1 ? "" : "s"} in <span class="mono">/assets/uploads/</span></p></div></div>
      <div class="drop" id="drop"><div>${icon("upload")}</div><div>Drag images here, or</div><label class="btn primary">Choose images<input class="sr" id="file" type="file" accept="image/*" multiple></label><div class="muted" style="font-size:13px">PNG, JPG, GIF, WebP, AVIF or SVG. Large photos are shrunk automatically.</div></div>
      <div class="media-grid" id="grid">${items.map((m) => tile(m)).join("") || '<div class="empty" style="grid-column:1/-1">No images yet.</div>'}</div>`;
    const go = async (files) => { if ((await uploadFiles([...files])).length) viewMedia(); };
    $("#file").addEventListener("change", (e) => go(e.target.files));
    const drop = $("#drop");
    ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", (e) => go(e.dataTransfer.files));
  }
  actions["del-media"] = async (el) => {
    if (!(await confirmBox("Delete this image?", "Pages that use it will show a broken image after the next build.", "Delete", true))) return;
    try { await api("DELETE", `/media?path=${encodeURIComponent(el.dataset.path)}&sha=${el.dataset.sha}`); toast("Deleted", "ok"); viewMedia(); } catch (err) { toast(err.message, "bad"); }
  };
  actions.copy = async (el) => {
    try { await navigator.clipboard.writeText(el.dataset.text); toast("Copied", "ok"); } catch { toast(el.dataset.text); }
  };
  let pickCb = null;
  async function pickImage(cb) {
    pickCb = cb;
    const m = openModal('<h2>Insert image</h2><p class="boot">Loading…</p>', { wide: true });
    const draw = async () => {
      try {
        const { items } = await api("GET", "/media");
        $(".modal", m).innerHTML = `<h2>Insert image</h2><label class="btn">${icon("upload")} Upload new<input class="sr" id="pick-file" type="file" accept="image/*" multiple></label>
          <div class="media-grid">${items.map((i) => tile(i, true)).join("") || '<div class="empty" style="grid-column:1/-1">No images yet. Upload one.</div>'}</div>
          <div class="acts"><button class="btn" data-act="close">Cancel</button></div>`;
        $("#pick-file").addEventListener("change", async (e) => { if ((await uploadFiles([...e.target.files])).length) draw(); });
      } catch (err) { $(".modal", m).innerHTML = `<h2>Insert image</h2>${fail(err)}<div class="acts"><button class="btn" data-act="close">Close</button></div>`; }
    };
    draw();
  }
  actions.pick = (el) => { const cb = pickCb; closeModal(); cb?.({ url: el.dataset.url, name: el.dataset.name }); };
  document.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.matches?.(".tile.pick")) { e.preventDefault(); e.target.click(); } });

  /* ── Settings (src/data/site.json) ───────────────────────────────────────── */
  const SETTINGS = [
    ["General", [["title", "Site title"], ["description", "Description"], ["siteUrl", "Public site URL", "url", "Used for the installer and canonical links. Leave empty to use the Netlify URL."]]],
    ["Release", [["version.name", "Release name"], ["version.number", "Version number"], ["version.channel", "Channel"], ["version.label", "Label shown on the homepage"]]],
    ["Links", [["links.github", "GitHub organisation", "url"], ["links.githubPanel", "Panel repository", "url"], ["links.githubDaemon", "Daemon repository", "url"], ["links.discord", "Discord invite", "url"], ["links.installVideo", "Install video (optional)", "url"]]],
  ];
  const getPath = (o, p) => p.split(".").reduce((a, k) => (a == null ? a : a[k]), o);
  function setPath(o, p, v) { const ks = p.split("."); let t = o; for (const k of ks.slice(0, -1)) t = t[k] ??= {}; t[ks.at(-1)] = v; }

  async function viewSettings() {
    const my = routeId;
    setView('<div class="page-head"><h1>Settings</h1></div><p class="boot">Loading…</p>', "Settings", "#/settings");
    let s;
    try { s = await api("GET", "/settings"); } catch (err) { if (my !== routeId) return; $("#view").innerHTML = `<div class="page-head"><h1>Settings</h1></div>${fail(err)}`; return; }
    if (my !== routeId) return;
    let obj; try { obj = JSON.parse(s.text); } catch { obj = {}; }
    const text = JSON.stringify(obj, null, 2);
    ed = { settings: true, sha: s.sha, orig: text };
    $("#view").innerHTML = `<div id="sroot" style="display:grid;gap:20px"><div class="page-head"><div><h1>Settings</h1><p class="sub">Stored in <span class="mono">src/data/site.json</span></p></div><div class="actions"><span class="dirty" id="dirty" hidden>Unsaved</span><button class="btn primary" data-act="save-settings" id="save-btn">${icon("save")} Save</button></div></div>
      ${SETTINGS.map(([h, fs]) => `<div class="card" style="display:grid;gap:14px"><h2 style="margin:0">${h}</h2><div class="grid2">${fs.map(([p, l, t, hint]) => `<div class="field"><label for="s-${p}">${l}</label><input id="s-${p}" data-path="${p}" type="${t === "url" ? "text" : "text"}" value="${esc(getPath(obj, p) ?? "")}" ${t === "url" ? 'inputmode="url" autocapitalize="none" spellcheck="false"' : ""}>${hint ? `<div class="hint">${hint}</div>` : ""}</div>`).join("")}</div>${h === "General" ? `<label class="check"><input type="checkbox" data-path="loader.enabled" ${getPath(obj, "loader.enabled") ? "checked" : ""}> Show the loading screen</label><label class="check"><input type="checkbox" data-path="loader.oncePerSession" ${getPath(obj, "loader.oncePerSession") ? "checked" : ""}> Only once per visit</label>` : ""}</div>`).join("")}
      <div class="card" style="display:grid;gap:10px"><h2 style="margin:0">Advanced: whole file</h2><p class="muted" style="font-size:13.5px">Features and install steps are edited here as JSON. The fields above stay in sync with it.</p><div id="json-err" class="alert bad" hidden></div><textarea id="json" class="json" spellcheck="false" autocapitalize="none">${esc(text)}</textarea></div></div>`;
    const ta = $("#json");
    const mark = () => { state.dirty = ta.value !== ed.orig; $("#dirty").hidden = !state.dirty; };
    const parse = () => { try { const o = JSON.parse(ta.value); $("#json-err").hidden = true; return o; } catch (e) { $("#json-err").hidden = false; $("#json-err").textContent = "Not valid JSON yet: " + e.message; return null; } };
    // Listen on this page's own wrapper, so the handler goes away when you leave the page.
    $("#sroot").addEventListener("input", (e) => {
      const el = e.target;
      if (el.dataset.path) {
        const o = parse(); if (!o) { toast("Fix the JSON below first", "bad"); return; }
        setPath(o, el.dataset.path, el.type === "checkbox" ? el.checked : el.value);
        ta.value = JSON.stringify(o, null, 2);
      } else if (el === ta) {
        const o = parse();
        if (o) $$("[data-path]").forEach((i) => { const v = getPath(o, i.dataset.path); i.type === "checkbox" ? (i.checked = !!v) : (i.value = v ?? ""); });
      }
      mark();
    });
  }
  actions["save-settings"] = async () => {
    const btn = $("#save-btn"); btn.disabled = true;
    try {
      const res = await api("PUT", "/settings", { text: $("#json").value, sha: ed.sha });
      ed.sha = res.sha; ed.orig = JSON.stringify(JSON.parse($("#json").value), null, 2); state.dirty = false; $("#dirty").hidden = true;
      toast("Saved. The site is rebuilding.", "ok");
    } catch (err) { toast(err.conflict ? "Settings changed on GitHub since you opened them. Reload this page." : err.message, "bad"); }
    finally { btn.disabled = false; }
  };

  /* ── Users ───────────────────────────────────────────────────────────────── */
  const genPassword = () => { const a = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const r = crypto.getRandomValues(new Uint32Array(16)); return [...r].map((n) => a[n % a.length]).join(""); };

  async function viewUsers() {
    const my = routeId;
    setView('<div class="page-head"><h1>Users</h1></div><p class="boot">Loading…</p>', "Users", "#/users");
    let r;
    try { r = await api("GET", "/users"); } catch (err) { if (my !== routeId) return; $("#view").innerHTML = `<div class="page-head"><h1>Users</h1></div>${fail(err)}`; return; }
    if (my !== routeId) return;
    const me = state.user, isOwner = me.role === "owner";
    $("#view").innerHTML = `<div class="page-head"><div><h1>Users</h1><p class="sub">Editors write content. Admins also manage settings and users.</p></div><button class="btn primary" data-act="user-add">${icon("plus")} Add user</button></div>
      <div class="list"><div class="row userrow"><div class="t">${esc(r.owner || "owner")} <span class="badge">Owner</span></div><div class="d">Set by the ADMIN_USERNAME and ADMIN_PASSWORD environment variables in Netlify</div></div>
      ${r.users.map((u) => { const locked = u.role === "admin" && !isOwner; return `<div class="row userrow"><div class="t">${esc(u.name)} <span class="badge">${esc(u.role)}</span>${u.disabled ? ' <span class="badge bad">Disabled</span>' : ""}</div><div class="d">${u.lastLogin ? "Last sign-in " + esc(ago(u.lastLogin)) : "Never signed in"}</div>${locked ? "" : `<div class="r"><button class="btn sm" data-act="user-pw" data-u="${esc(u.name)}">Reset password</button><button class="btn sm" data-act="user-toggle" data-u="${esc(u.name)}" data-disabled="${u.disabled ? 1 : 0}">${u.disabled ? "Enable" : "Disable"}</button>${isOwner ? `<button class="btn sm" data-act="user-role" data-u="${esc(u.name)}" data-role="${u.role === "admin" ? "editor" : "admin"}">Make ${u.role === "admin" ? "editor" : "admin"}</button>` : ""}<button class="btn sm danger icon" data-act="user-del" data-u="${esc(u.name)}" aria-label="Delete ${esc(u.name)}">${icon("trash")}</button></div>`}</div>`; }).join("")}</div>`;
  }
  actions["user-add"] = () => {
    const isOwner = state.user.role === "owner", pw = genPassword();
    const m = openModal(`<h2>Add user</h2><form id="uf" style="display:grid;gap:14px">
      <div class="field"><label for="nu">Username</label><input id="nu" type="text" autocapitalize="none" spellcheck="false" autocomplete="off" required></div>
      <div class="field"><label for="nr">Role</label><select id="nr"><option value="editor">Editor: blog, docs and media</option>${isOwner ? '<option value="admin">Admin: also settings and users</option>' : ""}</select></div>
      <div class="field"><label for="np">Password</label><input id="np" type="text" value="${pw}" autocomplete="off" spellcheck="false"><div class="hint">At least 10 characters. Share it with them privately; they can change it under Account.</div></div>
      <div class="err" id="uerr" style="color:var(--bad)"></div>
      <div class="acts"><button class="btn" type="button" data-act="close">Cancel</button><button class="btn primary" type="submit">Create user</button></div></form>`);
    $("#uf", m).addEventListener("submit", async (e) => {
      e.preventDefault();
      try { await api("POST", "/users", { username: $("#nu").value, role: $("#nr").value, password: $("#np").value }); closeModal(); toast("User created", "ok"); viewUsers(); } catch (err) { $("#uerr").textContent = err.message; }
    });
  };
  actions["user-pw"] = (el) => {
    const m = openModal(`<h2>Reset password for ${esc(el.dataset.u)}</h2><form id="pf" style="display:grid;gap:14px"><div class="field"><label for="rp">New password</label><input id="rp" type="text" value="${genPassword()}" autocomplete="off" spellcheck="false"><div class="hint">They are signed out everywhere when you save.</div></div><div class="err" id="perr" style="color:var(--bad)"></div><div class="acts"><button class="btn" type="button" data-act="close">Cancel</button><button class="btn primary" type="submit">Set password</button></div></form>`);
    $("#pf", m).addEventListener("submit", async (e) => { e.preventDefault(); try { await api("PATCH", `/users/${el.dataset.u}`, { password: $("#rp").value }); closeModal(); toast("Password updated", "ok"); } catch (err) { $("#perr").textContent = err.message; } });
  };
  actions["user-toggle"] = async (el) => { try { await api("PATCH", `/users/${el.dataset.u}`, { disabled: el.dataset.disabled !== "1" }); viewUsers(); } catch (err) { toast(err.message, "bad"); } };
  actions["user-role"] = async (el) => { try { await api("PATCH", `/users/${el.dataset.u}`, { role: el.dataset.role }); viewUsers(); } catch (err) { toast(err.message, "bad"); } };
  actions["user-del"] = async (el) => { if (!(await confirmBox(`Delete ${el.dataset.u}?`, "They lose access immediately.", "Delete", true))) return; try { await api("DELETE", `/users/${el.dataset.u}`); toast("User deleted", "ok"); viewUsers(); } catch (err) { toast(err.message, "bad"); } };

  /* ── Activity and account ────────────────────────────────────────────────── */
  async function viewActivity() {
    const my = routeId;
    setView('<div class="page-head"><h1>Activity</h1></div><p class="boot">Loading…</p>', "Activity", "#/activity");
    try {
      const { items } = await api("GET", "/activity");
      if (my !== routeId) return;
      $("#view").innerHTML = `<div class="page-head"><div><h1>Activity</h1><p class="sub">The last ${items.length} actions in this panel</p></div></div>
        <div class="card">${items.length ? `<ul class="feed">${items.map((i) => `<li><span class="m"><b>${esc(i.user)}</b> · ${esc(i.action)}${i.detail ? ` <span class="muted mono" style="font-size:12.5px">${esc(i.detail)}</span>` : ""}</span><span class="s">${esc(fmt(i.at))}</span></li>`).join("")}</ul>` : '<p class="muted">Nothing yet.</p>'}</div>`;
    } catch (err) { $("#view").innerHTML = `<div class="page-head"><h1>Activity</h1></div>${fail(err)}`; }
  }
  function viewAccount() {
    const u = state.user;
    setView(`<div class="page-head"><h1>Account</h1></div>
      <div class="card"><div class="kv"><div><span>Username</span><span>${esc(u.name)}</span></div><div><span>Role</span><span style="text-transform:capitalize">${esc(u.role)}</span></div></div></div>
      ${u.role === "owner" ? `<div class="card"><h2>Password</h2><p class="muted">The owner password is the <code>ADMIN_PASSWORD</code> environment variable in Netlify. Change it there and redeploy; every owner session is then signed out.</p></div>` :
      `<form class="card" id="cp" style="display:grid;gap:14px;max-width:460px"><h2 style="margin:0">Change password</h2><div class="field"><label for="cur">Current password</label><input id="cur" type="password" autocomplete="current-password" required></div><div class="field"><label for="nxt">New password</label><input id="nxt" type="password" autocomplete="new-password" minlength="10" required><div class="hint">At least 10 characters.</div></div><div class="err" id="cperr" style="color:var(--bad)"></div><button class="btn primary" type="submit" style="justify-self:start">Update password</button></form>`}
      <div><button class="btn" data-act="logout">${icon("logout")} Sign out</button></div>`, "Account", "");
    $("#cp")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      try { await api("POST", "/me/password", { current: $("#cur").value, next: $("#nxt").value }); toast("Password updated. Other devices were signed out.", "ok"); e.target.reset(); $("#cperr").textContent = ""; } catch (err) { $("#cperr").textContent = err.message; }
    });
  }

  /* ── Router ──────────────────────────────────────────────────────────────── */
  let lastHash = "";
  function route() {
    if (!state.user || !$("#view")) return;
    routeId++;
    ed = null;
    const parts = (location.hash.replace(/^#/, "") || "/").split("/").filter(Boolean).map(decodeURIComponent);
    const [a, b, ...rest] = parts;
    const need = (role) => RANK[state.user.role] >= RANK[role];
    if (!a) return viewDashboard();
    if (a === "blog" || a === "docs") {
      if (!b) return viewList(a);
      if (b === "new") return viewEditor(a, null);
      if (b === "edit" && rest.length) return viewEditor(a, rest.join("/"));
    }
    if (a === "media") return viewMedia();
    if (a === "settings" && need("admin")) return viewSettings();
    if (a === "users" && need("admin")) return viewUsers();
    if (a === "activity" && need("admin")) return viewActivity();
    if (a === "account") return viewAccount();
    location.hash = "#/";
  }
  window.addEventListener("hashchange", async () => {
    const next = location.hash;
    if (state.dirty && next !== lastHash) {
      history.replaceState(null, "", lastHash || "#/");
      if (!(await confirmBox("Leave without saving?", "Your unsaved changes will be lost. (Editor drafts are also kept on this device.)", "Leave", true))) return;
      state.dirty = false; location.hash = next; return;
    }
    lastHash = next; route();
  });
  window.addEventListener("beforeunload", (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ""; } });
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    const fn = el && actions[el.dataset.act];
    if (fn) { e.preventDefault(); fn(el, e); }
    else if (e.target.closest("[data-nav]")) setMenu(false);
  });

  async function boot() {
    try { state.user = (await api("GET", "/me")).user; } catch { state.user = null; }
    if (!state.user) return renderLogin();
    renderShell();
    lastHash = location.hash;
    route();
  }
  boot();
})();
