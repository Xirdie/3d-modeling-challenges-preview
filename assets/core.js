// CritPass core: config, copy (design.md ## UX U10, verbatim), storage, Worker calls,
// health gate, goals, Turnstile. Imported by app.js, preview.js, actions.js and review.js.
// No three.js here.

/* global PAYMENT_LINKS, WORKER_URL, PORTAL_URL, ANALYTICS_TOKEN, TURNSTILE_SITE_KEY, HUB_URL, CONTACT_EMAIL */
// config.js is a classic script: its top-level consts live in the global lexical scope, which a module
// reads by bare name (no eval, so the page CSP needs no 'unsafe-eval'). typeof guards a missing config.js.
const g = (v, fallback) => (v === undefined || v === null ? fallback : v);

const links = g(typeof PAYMENT_LINKS === "undefined" ? undefined : PAYMENT_LINKS, {}) || {};
export const CFG = {
  links: {
    one_off: typeof links.one_off === "string" ? links.one_off.trim() : "",
    pack: typeof links.pack === "string" ? links.pack.trim() : "",
    monthly: typeof links.monthly === "string" ? links.monthly.trim() : "",
    deep: typeof links.deep === "string" ? links.deep.trim() : "",
  },
  worker: String(g(typeof WORKER_URL === "undefined" ? undefined : WORKER_URL, "") || "").replace(/\/+$/, ""),
  portal: String(g(typeof PORTAL_URL === "undefined" ? undefined : PORTAL_URL, "") || ""),
  analytics: String(g(typeof ANALYTICS_TOKEN === "undefined" ? undefined : ANALYTICS_TOKEN, "") || ""),
  turnstileKey: String(g(typeof TURNSTILE_SITE_KEY === "undefined" ? undefined : TURNSTILE_SITE_KEY, "") || ""),
  hub: String(g(typeof HUB_URL === "undefined" ? undefined : HUB_URL, "") || ""),
  email: String(g(typeof CONTACT_EMAIL === "undefined" ? undefined : CONTACT_EMAIL, "business@xirdie.com") || "business@xirdie.com"),
  preview: !!(typeof window !== "undefined" && window.STUDIO_PREVIEW),
};
export const DEEP_ON = CFG.links.deep !== "";

// Site root, from this module's own URL (assets/ -> ..), so pages in challenges/ and guides/ work.
export const ROOT = new URL("..", import.meta.url);
export const url = (p) => new URL(p, ROOT).href;
export const SLUG_PATH = "/3d-modeling-challenges-preview/";

// ---------- tiny DOM helpers ----------
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export function esc(s) {
  return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
export function html(strings, ...vals) {
  let out = "";
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) {
      const v = vals[i];
      out += v && v.__html !== undefined ? v.__html : Array.isArray(v) ? v.map((x) => (x && x.__html !== undefined ? x.__html : esc(x))).join("") : esc(v);
    }
  });
  return { __html: out };
}
export const raw = (s) => ({ __html: String(s) });
export function setHTML(el, h) {
  el.innerHTML = h && h.__html !== undefined ? h.__html : esc(h);
  return el;
}
export function frag(h) {
  const t = document.createElement("template");
  t.innerHTML = h.__html;
  return t.content;
}
export const fmtInt = (n) => Number(n || 0).toLocaleString("en-US");
export function fmtSize(bytes) {
  if (bytes >= 1048576) return (Math.round((bytes / 1048576) * 10) / 10) + " MB";
  if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
  return bytes + " bytes";
}
export const mb = (bytes) => Math.round(bytes / 1048576);

// "00:00 UTC (01:00 your time)" pieces: the local time of the next UTC midnight, or of a reset timestamp.
export function localTimeOf(reset) {
  let d;
  if (reset === undefined || reset === null || reset === "") {
    const now = new Date();
    d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  } else {
    d = typeof reset === "number" ? new Date(reset < 1e12 ? reset * 1000 : reset) : new Date(reset);
    if (isNaN(d)) return localTimeOf();
  }
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(d);
  } catch (e) {
    return d.toTimeString().slice(0, 5);
  }
}
export function shortDate(reset) {
  const d = typeof reset === "number" ? new Date(reset < 1e12 ? reset * 1000 : reset) : new Date(reset);
  if (isNaN(d)) return String(reset || "");
  try {
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(d);
  } catch (e) {
    return d.toDateString();
  }
}
export const utcDay = () => new Date().toISOString().slice(0, 10);

// ---------- copy: design.md ## UX U10 (exact) ----------
const M = () => CFG.email;
export const COPY = {
  E1: (ext) => "CritPass can't read " + (ext ? "." + ext + " files" : "this file") + ". Modeling challenges take OBJ (or GLB, glTF or FBX, without topology stats); animation challenges take MP4, WebM or PNG/JPG frames." + (ext === "zip" ? " Unzip it first, then drop the file inside." : ""),
  E2: "This file is empty (0 bytes), usually an export that didn't finish. Export again and drop the new file.",
  E3: "Blender files can't be read in the browser. Export OBJ (File > Export > Wavefront (.obj), Selection Only on, Triangulate Faces off) and drop that.",
  E3a: "Blender files can't be read in the browser. Render a playblast instead (View > Viewport Render Animation, with Output set to FFmpeg video, MPEG-4, H.264, or to PNG) and drop the MP4 or the frames.",
  E4m: "Maya scenes can't be read in the browser. Export OBJ (File > Export Selection > OBJexport; turn on objExport.mll in the Plug-in Manager first) and drop that.",
  E4a: "Maya scenes can't be read in the browser. Playblast to images instead (Playblast options: Format image, Encoding png) and drop the PNG frames.",
  E5m: "3ds Max scenes can't be read in the browser. Export OBJ (File > Export > OBJ, Faces: Polygons) and drop that.",
  E5a: "3ds Max scenes can't be read in the browser. Render the range to a PNG sequence (Render Setup > Render Output) and drop the frames.",
  E6: "ZBrush files can't be read in the browser. Export OBJ (Tool > Export) at your lowest subdivision level and drop that.",
  E7: (fmt) => "Topology not measured: " + fmt + " files usually arrive triangulated, so we can't count your quads and n-gons. This file is still graded on silhouette, proportion and the brief. For topology stats, re-export as OBJ",
  E7row: "Not measured (needs OBJ)",
  E8: "This .gltf points to separate files we can't see. Export GLB (glTF Binary, one file), or OBJ for topology stats.",
  E9: "This FBX didn't load (older and ASCII FBX files often won't open in a browser). Export OBJ instead",
  E10: (sizeMb, limitMb, budget) => "This file is " + sizeMb + " MB; the limit is " + limitMb + " MB." + (budget ? " This challenge's budget is " + fmtInt(budget) + " faces, so a file this big usually has a Subdivision modifier applied." : "") + " Turn it off or lower it, export again and drop the new file.",
  E11: (faces, budget) => "This OBJ has " + fmtInt(faces) + " faces; the limit is 500,000" + (budget ? " and this challenge's budget is " + fmtInt(budget) : "") + ". Turn off or lower the Subdivision modifier, export again and drop the new file.",
  E12: "We couldn't find any faces in this OBJ. Check your mesh was selected when you exported with Selection Only on, then export again.",
  E13: "Your browser has 3D graphics turned off, so we can't draw the preview or take snapshots. Turn on hardware acceleration or try another browser.",
  E14: "Your OBJ is fully triangulated (0 quads, 0 n-gons), so its topology can't be graded. Export again with Triangulate Faces off (Blender) or Faces: Polygons (3ds Max) and drop the new file",
  E14above: "Reviews are off for this file: re-export with quads.",
  E15anim: "This is an animation challenge: drop a playblast (MP4 or WebM) or PNG frames. Have a model to check?",
  E15model: "This is a modeling challenge: drop an OBJ (or GLB, glTF, FBX). Have an animation to check?",
  E16: "Your browser can't play this video. Maya's default AVI/QuickTime playblasts and HEVC or ProRes videos don't open in browsers. Playblast again as H.264 MP4 or PNG frames",
  E17len: (secs, range) => "This clip is " + secs + " s long; challenges take up to 30 s. Playblast just the frame range (" + range + ") and drop it again.",
  E17size: (sizeMb) => "This video is " + sizeMb + " MB; the limit is 200 MB. Playblast at 1280 px wide or as PNG frames.",
  E18count: (n, range) => "That's " + fmtInt(n) + " frames; the limit is 300. Drop only frames " + range + ".",
  E18sort: "These images don't share a numbered name, so we can't put them in order. Name them like ball_0001.png, ball_0002.png and drop them again.",
  E19: "Drop one model file at a time. We'll use the OBJ; .mtl and textures aren't needed.",
  E20: "We couldn't complete the security check. Reload the page and try again; if it keeps failing, allow challenges.cloudflare.com in your content blocker.",
  E21: (reset) => "You've had today's free quick review. The next one is free after 00:00 UTC (" + localTimeOf(reset) + " your time). Your preview and topology score still work, and the full review is $9.",
  E22: (reset) => "Today's free quick reviews are all used; they reset at 00:00 UTC (" + localTimeOf(reset) + " your time). Your preview and topology score still work, and the full review is $9.",
  E23: "That code wasn't recognised, so no review ran. Check it under 'Owner code'. Your free quick review is still available.",
  E24: "Too many wrong codes today. Codes work again after 00:00 UTC; your free quick review is still available.",
  E25: (reset) => "Your code's 3 full reviews for today are used; they reset at 00:00 UTC (" + localTimeOf(reset) + " your time).",
  E26: "Reviews are temporarily unavailable. No payment can be taken right now; your preview and topology counts still work. Check back in about 10 minutes.",
  E27: (restored) => "The quick review didn't run: our AI provider isn't answering." + (restored ? " Your free review for today is still available." : "") + " Reviews and checkout are paused for about 10 minutes; your preview still works.",
  E28: "The model declined to review this content, so no quick review was produced.",
  E29: "You're offline. Your preview and counts still work; reviews and checkout need a connection.",
  E30: "Checkout closed. If you didn't finish paying, you haven't been charged. Your preview is still here.",
  E31a: "Thanks. Your payment is with Stripe but not confirmed on our side yet. Keep this tab open and try again in a minute. Checkout id:",
  E31b: () => "If it still isn't confirmed after 10 minutes, email " + M() + " with this id.",
  E32: "Your snapshots aren't on this device. Drop the same file again and your review starts; your payment is safe and unused.",
  E34first: {
    one: "The review failed on our side and no grade was produced. Your payment is safe.",
    pack: "The review failed on our side, no grade was produced and no review was used from your pack.",
    plan: "The review failed on our side, no grade was produced and nothing was counted against your plan.",
  },
  E34session: "Checkout session:",
  E34tail: () => "Try again once, or email " + M() + " with that id for a full refund.",
  E34wait: (secs) => "The last attempt may still be finishing on our side. Try again in " + secs + " seconds; your payment is safe.",
  E34ready: "Try again is ready.",
  E35one: () => ["The review failed again and no grade was produced. Email " + M() + " with checkout session", "for a full refund."],
  E35multi: () => ["The review failed again; no review was used. Drop your file again later for a fresh attempt, or email " + M() + " with", "for a refund."],
  E36: () => ["The model declined to review this content, so no grade was produced. Checkout session:", "If you think that is wrong, email " + M() + "."],
  E37: "This checkout was already used for a review. The review is saved under your progress in the browser that ran it.",
  E38: ["Your plan isn't active, so no review ran.", "to restart it, or get this one review for $9."],
  E39: (reset) => "You've used all 60 reviews this period; they reset on " + shortDate(reset) + ". A 5-pack is $29.",
  E40: "No reviews left on this pack. Another 5 are $29, or $9 for this one.",
  E41: () => ["This single-review checkout is more than 29 days old and can't start a review. Email " + M() + " with", ""],
  E42: "Your snapshots were too large to send, so no review ran and your purchase is untouched. Reload the page and drop the file again; if it happens twice,",
  E42quick: "Your snapshots were too large to send, so no quick review ran and nothing was counted. Reload the page and drop the file again; if it happens twice,",
  E43tail: "Your purchase is untouched.",
  E44: "Reviews are paused for a few minutes because our AI provider isn't answering. Your payment is safe and unused, and your snapshots are saved in this browser. Try again in about 10 minutes, here or from the 'paid review waiting' banner on any page.",
  E45lead: "No answer after two minutes.",
  E47format: "That doesn't look like a restore code. It starts with cs_ and is about 66 characters.",
  E47other: "That checkout isn't for CritPass.",
  E47missing: () => "We couldn't find a paid CritPass checkout with that code. Check it, or email " + M() + ".",
  E48empty: "Tell us what happened first.",
  E48limit: () => "That's 5 reports from here today, the daily limit. Email " + M() + " and we'll read it there.",
  E48network: () => "Your report didn't send. Try again, or email " + M() + "; your text is still here.",
  E49: "That file isn't a CritPass progress export. Nothing was changed.",
  previewNoBuy: "Preview — purchases disabled.",
  quickBadge: "Quick review · AI (Claude Haiku 5.5) · 3 low-res views · not the full rubric",
  aiLabel: "AI review · Claude Sonnet 5.5 (Anthropic) · graded against this challenge's published rubric · topology measured by code · not a human critique",
  aiDisclosure: "AI review: written by Claude Sonnet 5.5 (Anthropic), or Claude Haiku 5.5 for quick reviews, from snapshots your browser rendered, against this challenge's published rubric. Topology counts are measured by code. Edge flow is noted, not scored. A fast first pass, not a human critique.",
};

// ---------- storage ----------
export const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  },
  del(key) {
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
  },
};
export const sess = {
  get(key, fallback = null) {
    try {
      const v = sessionStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  },
  set(key, value) {
    try { sessionStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  },
  del(key) {
    try { sessionStorage.removeItem(key); } catch (e) { /* ignore */ }
  },
};
export const LS_KEYS = ["progress", "unlock", "unlockPrev", "ownerCode", "challenge", "exportTab", "quickUsed", "lastFile"];

let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return reject(new Error("no idb"));
    const req = indexedDB.open("critpass", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction("kv", mode);
    const s = t.objectStore("kv");
    const r = fn(s);
    t.oncomplete = () => resolve(r && "result" in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}
export const idb = {
  get: (key) => tx("readonly", (s) => s.get(key)).catch(() => undefined),
  put: (key, val) => tx("readwrite", (s) => s.put(val, key)).catch(() => false),
  del: (key) => tx("readwrite", (s) => s.delete(key)).catch(() => false),
  clear: () => tx("readwrite", (s) => s.clear()).catch(() => false),
  keys: () => tx("readonly", (s) => s.getAllKeys()).catch(() => []),
};
export const captureKey = (id) => "capture:" + id;

// ---------- catalog ----------
let catp = null;
export function getCatalog() {
  if (!catp) catp = fetch(url("catalog.json")).then((r) => {
    if (!r.ok) throw new Error("catalog " + r.status);
    return r.json();
  });
  return catp;
}
export async function getChallenge(id) {
  const c = await getCatalog();
  return c.challenges.find((x) => x.id === id) || null;
}

// ---------- live region and focus ----------
export function announce(msg) {
  const r = document.getElementById("live");
  if (!r) return;
  r.textContent = "";
  setTimeout(() => { r.textContent = msg; }, 30);
}
export function focusEl(el) {
  if (!el) return;
  if (!el.hasAttribute("tabindex") && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) el.setAttribute("tabindex", "-1");
  try { el.focus({ preventScroll: false }); } catch (e) { el.focus(); }
}
export const reducedMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- copy button ----------
export function copyButtonHTML(value, label = "Copy") {
  return html`<button type="button" class="btn btn--copy" data-state="idle" data-copy="${value}">${label}</button>`;
}
export function wireCopy(root) {
  for (const b of $$("[data-copy]", root)) {
    if (b.dataset.wired) continue;
    b.dataset.wired = "1";
    b.addEventListener("click", async () => {
      const text = b.dataset.copy;
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch (e) {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { ok = document.execCommand("copy"); } catch (e2) { ok = false; }
        ta.remove();
      }
      if (ok) {
        const old = b.textContent;
        b.textContent = "Copied";
        b.dataset.state = "copied";
        announce("Copied");
        setTimeout(() => { b.textContent = old; b.dataset.state = "idle"; }, 1600);
      }
    });
  }
}

// ---------- UTM + goals (integrations.md W2: UTM in the path) ----------
const UTM_RE = /^[A-Za-z0-9_-]{1,150}$/;
export function captureUtm(params) {
  const p = params || new URLSearchParams(location.search);
  const cur = sess.get("utm", {}) || {};
  let changed = false;
  for (const k of ["utm_source", "utm_medium", "utm_campaign"]) {
    const v = p.get(k);
    if (v && UTM_RE.test(v)) { cur[k] = v; changed = true; }
  }
  if (changed) sess.set("utm", cur);
  return cur;
}
const utmPart = (v) => {
  const s = String(v || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
  return s || "-";
};
export function goalPath(event, detail) {
  const u = sess.get("utm", {}) || {};
  return SLUG_PATH + "goal/" + event + "/" + utmPart(detail) + "/u/" + utmPart(u.utm_source) + "/" + utmPart(u.utm_medium) + "/" + utmPart(u.utm_campaign);
}
// A virtual page view pair: the beacon (SPA tracking on by default) records the goal route.
// Harmless when the beacon is absent (empty ANALYTICS_TOKEN, preview builds, ad blockers).
export function goal(event, detail) {
  try {
    const here = location.pathname + location.search + location.hash;
    history.pushState(history.state, "", goalPath(event, detail));
    history.pushState(history.state, "", here);
  } catch (e) { /* never break the page for analytics */ }
}
export function utmQuery() {
  const u = sess.get("utm", {}) || {};
  let q = "";
  for (const k of ["utm_source", "utm_medium", "utm_campaign"]) if (u[k] && UTM_RE.test(u[k])) q += "&" + k + "=" + encodeURIComponent(u[k]);
  return q;
}

// ---------- Worker calls ----------
// Returns {ok, status, data, network}. Never throws.
export async function api(path, body, opts = {}) {
  if (!CFG.worker) return { ok: false, status: 0, data: null, network: true, noworker: true };
  const ctrl = new AbortController();
  const timeout = opts.timeout || 15000;
  const timer = setTimeout(() => ctrl.abort(), timeout);
  if (opts.signal) opts.signal.addEventListener("abort", () => ctrl.abort());
  try {
    const res = await fetch(CFG.worker + path, {
      method: body === undefined ? "GET" : "POST",
      headers: Object.assign(body === undefined ? {} : { "Content-Type": "application/json" }, opts.headers || {}),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
      cache: "no-store",
    });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { ok: res.ok, status: res.status, data: data || {}, network: false };
  } catch (e) {
    return { ok: false, status: 0, data: null, network: true, aborted: ctrl.signal.aborted, timedOut: ctrl.signal.aborted && !(opts.signal && opts.signal.aborted) };
  } finally {
    clearTimeout(timer);
  }
}
// Dev-only fault header for the dry harness: ?dryfault=provider_error on localhost.
export function devHeaders() {
  try {
    if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return {};
    const f = new URLSearchParams(location.search).get("dryfault") || sess.get("dryfault", "");
    if (f) { sess.set("dryfault", f); return { "X-Dry-Fault": f }; }
  } catch (e) { /* ignore */ }
  return {};
}

// ---------- health gate (GET /verify) ----------
export const health = { up: false, checked: false, mode: null, online: navigator.onLine !== false };
const gateFns = new Set();
export function onGate(fn) {
  gateFns.add(fn);
  fn(health);
  return () => gateFns.delete(fn);
}
export function emitGate() {
  for (const fn of gateFns) {
    try { fn(health); } catch (e) { /* keep others running */ }
  }
}
// The reason shown above disabled review and pay buttons, or "" when they may be used.
export function gateReason() {
  if (!health.online) return COPY.E29;
  if (!health.up) return COPY.E26;
  return "";
}
let recheckTimer = null;
export async function checkHealth() {
  if (!CFG.worker) {
    health.up = false;
    health.checked = true;
  } else {
    const r = await api("/verify", undefined, { timeout: 5000 });
    health.checked = true;
    if (r.network) {
      health.up = false;
      if (!navigator.onLine) health.online = false;
    } else {
      health.up = !!(r.ok && r.data && r.data.provider === "up");
      health.mode = r.data && r.data.mode;
    }
  }
  emitGate();
  if (!health.up && CFG.worker) {
    if (!recheckTimer) recheckTimer = setInterval(checkHealth, 60000);
  } else if (recheckTimer) {
    clearInterval(recheckTimer);
    recheckTimer = null;
  }
  return health;
}
export function markProviderDown() {
  health.up = false;
  emitGate();
  if (!recheckTimer && CFG.worker) recheckTimer = setInterval(checkHealth, 60000);
}

// ---------- Turnstile (lazy, managed widget) ----------
let tsp = null;
export function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (tsp) return tsp;
  tsp = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile")));
    s.onerror = () => { tsp = null; reject(new Error("turnstile")); };
    document.head.appendChild(s);
  });
  return tsp;
}
// Renders a widget into el; returns {token(): Promise<string>, reset(), failed: bool}.
export function turnstileWidget(el, action, onInteractive) {
  let token = "";
  let waiters = [];
  let id = null;
  let failed = false;
  const settle = (val, err) => {
    const w = waiters;
    waiters = [];
    for (const x of w) err ? x.reject(err) : x.resolve(val);
  };
  const ready = loadTurnstile().then((ts) => {
    id = ts.render(el, {
      sitekey: CFG.turnstileKey,
      action,
      callback: (t) => { token = t; failed = false; settle(t); },
      "error-callback": () => { failed = true; settle(null, new Error("turnstile")); return true; },
      "expired-callback": () => { token = ""; },
      "before-interactive-callback": () => { if (onInteractive) onInteractive(); },
    });
  }).catch((e) => { failed = true; settle(null, e); throw e; });
  return {
    get failed() { return failed; },
    async token() {
      await ready;
      if (token) return token;
      if (failed) throw new Error("turnstile");
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    reset() {
      token = "";
      try { if (window.turnstile && id !== null) window.turnstile.reset(id); } catch (e) { /* ignore */ }
    },
  };
}

// ---------- unlock (holder) ----------
export function getUnlock() {
  const u = store.get("unlock", null);
  if (!u || typeof u !== "object" || !u.session_id) return null;
  return u;
}
export function isHolder(u = getUnlock()) {
  if (!u) return false;
  if (u.kind === "plan" || u.kind === "deep") return u.remaining === undefined || u.remaining > 0;
  return Number(u.remaining) > 0;
}
export function holderLabel(u) {
  const asOf = u.at && String(u.at).slice(0, 10) !== utcDay() ? " as of " + shortDate(u.at) : "";
  if (u.kind === "pack") return "Review with your pack (" + u.remaining + " left" + asOf + ")";
  if (u.kind === "plan") return "Review (plan: " + u.remaining + " left this month" + asOf + ")";
  if (u.kind === "deep") return "Deep review (plan: " + u.remaining + " left this month" + asOf + ")";
  return "Use your paid review";
}
export const SESSION_RE = /^cs_[A-Za-z0-9_]{6,80}$/;
// The only form of a checkout id that leaves the device in a bug report: "cs_..." + its last 8 characters.
export function maskSession(sid) {
  return sid ? "cs_..." + String(sid).slice(-8) : "";
}
// A pack or plan unlock that a different checkout replaced (finding 19): kept, and switched back to
// once the newer unlock has nothing left. Returns the kept one if it can still review, else null.
export function keptUnlock() {
  const p = store.get("unlockPrev", null);
  if (!p || typeof p !== "object" || !p.session_id) return null;
  const cur = getUnlock();
  if (cur && cur.session_id === p.session_id) { store.del("unlockPrev"); return null; }
  return p.kind === "pack" || p.kind === "plan" || p.kind === "deep" ? p : null;
}
export function settleUnlock() {
  const p = keptUnlock();
  if (!p || isHolder(getUnlock())) return false;
  store.set("unlock", Object.assign({}, p, { token: "", exp: 0 }));
  store.del("unlockPrev");
  return true;
}

// ---------- progress ----------
export function getProgress() {
  const p = store.get("progress", {});
  return p && typeof p === "object" ? p : {};
}
export function saveProgress(challengeId, review, thumb) {
  const p = getProgress();
  const cur = p[challengeId] || {};
  const grade = review.grade || {};
  const best = cur.best && cur.best.total >= (grade.total || 0) ? cur.best : { total: grade.total, letter: grade.letter, pass: !!grade.pass };
  const slim = Object.assign({}, review);
  delete slim.images_data;
  p[challengeId] = { best, last: slim, thumb: thumb || cur.thumb || "", date: new Date().toISOString() };
  if (!store.set("progress", p)) {
    p[challengeId].thumb = "";
    store.set("progress", p);
  }
  return p[challengeId];
}

export function newJobId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// Opens the footer bug panel, optionally prefilled (U9 [Report this failure]).
export function openBugPanel(prefill) {
  document.dispatchEvent(new CustomEvent("critpass:bug", { detail: { prefill } }));
}
