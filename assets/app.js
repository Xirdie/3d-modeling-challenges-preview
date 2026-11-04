// CritPass shell, loaded on every page. No three.js: the preview chunk is imported on the first file.
import {
  CFG, DEEP_ON, COPY, $, $$, esc, html, setHTML, url, store, sess, idb, captureKey, getCatalog, announce, focusEl,
  captureUtm, goal, checkHealth, onGate, health, emitGate, turnstileWidget, api, getUnlock, maskSession,
  getProgress, fmtSize, mb, wireCopy, downloadBlob, LS_KEYS, SESSION_RE, utcDay, settleUnlock,
} from "./core.js";

// ---------- X1: the Payment Link return lands on index.html?paid=1&session_id= ----------
(function forwardPaid() {
  const p = new URLSearchParams(location.search);
  if (p.get("paid") === "1" && p.get("session_id") && !/review\.html$/.test(location.pathname)) {
    const q = new URLSearchParams();
    q.set("session_id", p.get("session_id"));
    for (const k of ["utm_source", "utm_medium", "utm_campaign"]) if (p.get(k)) q.set(k, p.get(k));
    location.replace(url("review.html") + "?" + q.toString());
  }
})();

const page = document.body.dataset.page || "";
// A pack or plan kept aside by a later checkout comes back once the later one has nothing left (finding 19).
settleUnlock();

// ---------- Cloudflare Web Analytics beacon: only with a token, never on localhost ----------
if (CFG.analytics && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) && !document.querySelector("script[data-cf-beacon]")) {
  const s = document.createElement("script");
  s.defer = true;
  s.src = "https://static.cloudflareinsights.com/beacon.min.js";
  s.setAttribute("data-cf-beacon", JSON.stringify({ token: CFG.analytics }));
  document.head.appendChild(s);
}
captureUtm();

// ---------- Deep: hidden unless PAYMENT_LINKS.deep is a non-empty string ----------
for (const el of $$('[data-requires="deep"]')) el.hidden = !DEEP_ON;

// ---------- footer ----------
const portal = $("#portal-link");
if (portal && CFG.portal) portal.href = CFG.portal;

function setPanel(name, open) {
  for (const b of $$("[data-panel]")) {
    const isIt = b.dataset.panel === name;
    const panel = document.getElementById("panel-" + b.dataset.panel);
    const want = isIt ? open : false;
    b.setAttribute("aria-expanded", String(want));
    if (panel) {
      panel.hidden = !want;
      panel.dataset.state = want ? "open" : "closed";
    }
  }
  if (open) {
    const panel = document.getElementById("panel-" + name);
    if (panel) {
      panel.scrollIntoView({ block: "nearest" });
      if (name === "bug") onBugOpen();
      if (name === "code") renderCodePanel();
      if (name === "clear") resetClearPanel();
    }
  }
}
for (const b of $$("[data-panel]")) {
  b.addEventListener("click", () => setPanel(b.dataset.panel, b.getAttribute("aria-expanded") !== "true"));
}
// Fields scroll into view above the on-screen keyboard (U9).
for (const f of $$(".panel input, .panel textarea")) f.addEventListener("focus", () => setTimeout(() => f.scrollIntoView({ block: "center" }), 250));

// ---------- Report a problem (U9, POST /bug) ----------
let bugTs = null;
let bugSession = "";
function currentSession() {
  const u = getUnlock();
  return bugSession || (u && u.session_id) || "";
}
function onBugOpen() {
  const sid = currentSession();
  const also = $("#bug-also");
  if (also) {
    also.textContent = "We also send the page address, your browser name and version, and the last 8 characters of your checkout id if you have one" + (sid ? " (" + maskSession(sid) + ")" : "") + ". No files or snapshots.";
  }
  if (!bugTs && $("#bug-ts")) {
    bugTs = turnstileWidget($("#bug-ts"), "bug", () => announce("Complete the quick check above to continue."));
  }
}
document.addEventListener("critpass:bug", (e) => {
  const d = e.detail || {};
  if (d.session) bugSession = d.session;
  setPanel("bug", true);
  const ta = $("#bug-text");
  if (ta && d.prefill && !ta.value) ta.value = d.prefill;
  if (ta) focusEl(ta);
});
const bugText = $("#bug-text");
if (bugText) {
  bugText.addEventListener("input", () => {
    const c = $("#bug-count");
    const n = bugText.value.length;
    if (c) {
      c.hidden = n < 1800;
      c.textContent = n.toLocaleString("en-US") + " / 2,000";
    }
  });
}
const bugForm = $("#bug-form");
if (bugForm) {
  bugForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#bug-msg");
    const btn = bugForm.querySelector("button[type=submit]");
    const report = bugText.value.trim();
    const say = (h) => { setHTML(msg, h); msg.hidden = false; focusEl(msg); };
    msg.hidden = true;
    if (!report) return say(COPY.E48empty);
    if (!navigator.onLine) return say(networkFail(report));
    btn.setAttribute("aria-busy", "true");
    btn.disabled = true;
    try {
      let token;
      try {
        token = await (bugTs || (onBugOpen(), bugTs)).token();
      } catch (err) {
        return say(COPY.E20);
      }
      const body = {
        turnstile: token,
        report: report.slice(0, 2000),
        page: location.href.slice(0, 300),
        ua: navigator.userAgent.slice(0, 400),
      };
      const email = $("#bug-email").value.trim();
      if (email) body.email = email.slice(0, 200);
      const sid = currentSession();
      // Masked on the device (CTO 20:10): the full checkout id is a restore code and never goes into a report.
      if (sid) body.session = maskSession(sid);
      const r = await api("/bug", body, { timeout: 15000 });
      if (bugTs) bugTs.reset();
      if (r.ok && r.data && r.data.id) {
        const id = String(r.data.id);
        const done = $("#bug-done");
        setHTML(done, html`<p>Thanks, it's sent. Your report id is <strong class="mono">${id}</strong>. Quote it if you email ${CFG.email}. We read reports weekly; if you left an email, we reply there.</p>${{ __html: '<button type="button" class="btn btn--copy" data-state="idle" data-copy="' + esc(id) + '">Copy id</button>' }}`);
        done.hidden = false;
        bugForm.hidden = true;
        wireCopy(done);
        focusEl(done);
        announce("Report sent");
        goal("report_sent", "-");
        bugText.value = "";
        return;
      }
      const code = r.data && r.data.error;
      if (r.status === 429 || code === "bug_limit") return say(COPY.E48limit());
      if (r.status === 403 && code === "turnstile") return say(COPY.E20);
      if (code === "empty") return say(COPY.E48empty);
      return say(networkFail(report));
    } finally {
      btn.removeAttribute("aria-busy");
      btn.disabled = false;
    }
  });
}
function networkFail(report) {
  return html`${COPY.E48network()} ${{ __html: '<button type="button" class="btn btn--copy" data-state="idle" data-copy="' + esc(report) + '">Copy my report</button>' }}`;
}
document.addEventListener("click", (e) => {
  if (e.target.closest && e.target.closest("[data-copy]")) wireCopy(document);
}, true);

// ---------- Owner code (U5; the footer's "Have a code?" renamed, qa 39b) ----------
function renderCodePanel() {
  const has = !!store.get("ownerCode", "");
  $("#code-form").hidden = has;
  $("#code-saved").hidden = !has;
}
const codeSave = $("#code-save");
if (codeSave) {
  codeSave.addEventListener("click", () => {
    const v = $("#code-input").value.trim();
    if (!v) return;
    store.set("ownerCode", v);
    $("#code-input").value = "";
    renderCodePanel();
    announce("Code saved in this browser.");
    document.dispatchEvent(new CustomEvent("critpass:code"));
  });
  $("#code-remove").addEventListener("click", () => {
    store.del("ownerCode");
    renderCodePanel();
    announce("Code removed.");
    document.dispatchEvent(new CustomEvent("critpass:code"));
  });
  $("#code-show").addEventListener("click", (e) => {
    const i = $("#code-input");
    const show = i.type === "password";
    i.type = show ? "text" : "password";
    e.currentTarget.textContent = show ? "Hide" : "Show";
    e.currentTarget.setAttribute("aria-pressed", String(show));
  });
}

// ---------- Restore purchase (U8) ----------
const restoreGo = $("#restore-go");
if (restoreGo) {
  restoreGo.addEventListener("click", async () => {
    const input = $("#restore-id");
    const out = $("#restore-msg");
    const sid = input.value.trim();
    const say = (text, isErr) => {
      out.className = isErr ? "alert alert--error" : "note";
      out.setAttribute("role", isErr ? "alert" : "status");
      out.textContent = text;
      out.hidden = false;
      if (isErr) focusEl(out);
    };
    if (!SESSION_RE.test(sid) || sid.length > 80) return say(COPY.E47format, true);
    if (!CFG.worker || !navigator.onLine) return say(navigator.onLine ? COPY.E26 : COPY.E29, true);
    restoreGo.setAttribute("aria-busy", "true");
    restoreGo.disabled = true;
    const r = await api("/verify", { session_id: sid }, { timeout: 15000 });
    restoreGo.removeAttribute("aria-busy");
    restoreGo.disabled = false;
    if (r.ok && r.data && r.data.token) {
      const d = r.data;
      store.set("unlock", { session_id: sid, token: d.token, kind: d.kind, remaining: d.remaining, reset: d.reset || null, exp: d.exp, at: new Date().toISOString(), challenge_id: d.challenge_id || null });
      if (d.kind === "pack") say("Restored: 5-pack, " + d.remaining + " reviews left. Open any challenge and drop your file.");
      else if (d.kind === "plan" || d.kind === "deep") say("Restored: monthly plan, " + d.remaining + " reviews left this month.");
      else say("Restored: 1 review, ready to use if it hasn't been used yet.");
      document.dispatchEvent(new CustomEvent("critpass:unlock"));
      return;
    }
    const code = r.data && r.data.error;
    if (code === "other_product") return say(COPY.E47other, true);
    if (code === "bad_request") return say(COPY.E47format, true);
    if (code === "not_found" || code === "unpaid" || code === "too_old" || code === "no_customer") return say(COPY.E47missing(), true);
    if (r.network) return say(navigator.onLine ? COPY.E26 : COPY.E29, true);
    return say(COPY.E47missing(), true);
  });
}

// ---------- Clear my data, export / import progress (U8) ----------
export function exportProgress() {
  const u = getUnlock();
  const data = {
    product: "CritPass",
    kind: "progress-export",
    version: 1,
    exported: new Date().toISOString(),
    progress: getProgress(),
    unlock: u ? { session_id: u.session_id, kind: u.kind, remaining: u.remaining, reset: u.reset || null, at: u.at } : null,
  };
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), "critpass-progress-" + utcDay() + ".json");
  goal("download", "export");
}
function resetClearPanel() {
  const d = $("#clear-done");
  if (d) d.hidden = true;
}
const clearExport = $("#clear-export");
if (clearExport) {
  clearExport.addEventListener("click", exportProgress);
  $("#clear-delete").addEventListener("click", async () => {
    for (const k of LS_KEYS) store.del(k);
    try { sessionStorage.clear(); } catch (e) { /* ignore */ }
    await idb.clear();
    const d = $("#clear-done");
    d.hidden = false;
    focusEl(d);
    announce("Done: this browser holds nothing from CritPass.");
    renderLadder();
    renderResume();
  });
  $("#import-file").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    const out = $("#import-msg");
    out.hidden = false;
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data || data.product !== "CritPass" || data.kind !== "progress-export" || typeof data.progress !== "object") throw new Error("bad");
      const cur = getProgress();
      let n = 0;
      for (const [id, entry] of Object.entries(data.progress)) {
        if (!entry || typeof entry !== "object") continue;
        n++;
        const mine = cur[id];
        if (!mine || ((entry.best && entry.best.total) || 0) > ((mine.best && mine.best.total) || 0)) cur[id] = entry;
      }
      store.set("progress", cur);
      let codeTxt = "";
      if (data.unlock && data.unlock.session_id && !getUnlock()) {
        store.set("unlock", Object.assign({}, data.unlock, { token: "", exp: 0 }));
        codeTxt = " and your restore code";
      }
      out.className = "note";
      out.setAttribute("role", "status");
      out.textContent = "Imported " + n + " challenges" + codeTxt + ".";
      renderLadder();
    } catch (err) {
      out.className = "alert alert--error";
      out.setAttribute("role", "alert");
      out.textContent = COPY.E49;
    }
    e.target.value = "";
  });
}

// ---------- banners: E26 status, resume (U0) ----------
function renderStatusBanner() {
  const host = $("#banners");
  if (!host) return;
  let b = $(".banner--status", host);
  const showDown = health.checked && !health.up && health.online;
  const showOff = !health.online;
  if (showDown || showOff) {
    if (!b) {
      b = document.createElement("div");
      b.className = "banner banner--status";
      b.setAttribute("role", "status");
      host.prepend(b);
    }
    b.textContent = showOff ? COPY.E29 : COPY.E26;
  } else if (b) {
    b.remove();
  }
}
onGate(renderStatusBanner);
window.addEventListener("online", () => { health.online = true; emitGate(); checkHealth(); });
window.addEventListener("offline", () => { health.online = false; emitGate(); });
window.addEventListener("focus", () => { if (!health.up && CFG.worker) checkHealth(); });
checkHealth();

async function renderResume() {
  const host = $("#banners");
  if (!host || page === "review") return;
  const old = $(".banner--resume", host);
  if (old) old.remove();
  const u = getUnlock();
  if (!u || !u.pending_challenge) return;
  const cap = await idb.get(captureKey(u.pending_challenge));
  if (!cap) return;
  const prog = getProgress()[u.pending_challenge];
  if (prog && prog.date && cap.created && prog.date > cap.created) return;
  let title = u.pending_challenge;
  try {
    const cat = await getCatalog();
    const c = cat.challenges.find((x) => x.id === u.pending_challenge);
    if (c) title = c.title;
  } catch (e) { /* ignore */ }
  const b = document.createElement("div");
  b.className = "banner banner--resume";
  setHTML(b, html`You have a paid review waiting for ${title}. <a href="${url("review.html") + "?session_id=" + encodeURIComponent(u.session_id) + "&resume=1"}">(Resume it)</a>`);
  host.appendChild(b);
}
renderResume();
document.addEventListener("critpass:unlock", renderResume);

// ---------- progress ladder, grid best grades, Today's challenge (U1, U8) ----------
async function renderLadder() {
  const prog = getProgress();
  const ids = Object.keys(prog);
  for (const card of $$(".grid-card")) {
    const id = card.dataset.id;
    const best = $(".grid-card__best", card);
    const e = prog[id];
    if (best) {
      if (e && e.best && e.best.letter) {
        best.textContent = "Your best: " + e.best.letter + " " + (e.best.pass ? "PASS" : "NOT YET");
        best.hidden = false;
        card.dataset.verdict = e.best.pass ? "pass" : "notyet";
      } else {
        best.hidden = true;
        delete card.dataset.verdict;
      }
    }
  }
  const strip = $("#ladder");
  if (!strip) return;
  if (!ids.length) {
    strip.hidden = true;
    return;
  }
  let cat;
  try { cat = await getCatalog(); } catch (e) { return; }
  const passed = ids.filter((id) => prog[id].best && prog[id].best.pass).length;
  const total = cat.challenges.length;
  const last = ids.sort((a, b) => String(prog[b].date).localeCompare(String(prog[a].date)))[0];
  const lc = cat.challenges.find((c) => c.id === last);
  const le = prog[last];
  const lastGrade = le.last && le.last.grade ? le.last.grade : le.best;
  const savedReview = le.last && Array.isArray(le.last.lines);
  setHTML(strip, html`<p class="ladder__label" id="ladder-label">${passed} of ${total} passed</p>
    <progress class="ladder__bar" max="${total}" value="${passed}" aria-labelledby="ladder-label">${passed} of ${total} passed</progress>
    <p>Continue: <a href="${url("challenges/" + last + ".html")}">${lc ? lc.title : last}</a> (last grade ${lastGrade ? lastGrade.letter : "-"}, ${lastGrade && lastGrade.pass ? "PASS" : "NOT YET"})${savedReview ? html` <a href="${url("review.html") + "?last=" + encodeURIComponent(last)}">(Open your last review)</a>` : ""}</p>`);
  strip.hidden = false;
}
renderLadder();

function todayIndex(n) {
  return Math.floor(Date.now() / 86400000) % n;
}
// Today's card draws from the Beginner pool only (tech-lead ruling 20:19); the drop zone follows its kind.
async function renderToday() {
  const host = $("#today");
  if (!host) return;
  const openLink = $(".today__open", host);
  const ph = $(".preview-host", host);
  if (openLink && ph) {
    // "(Open the full challenge page)" shows only with the in-card preview (U1).
    const sync = () => { openLink.hidden = !ph.childElementCount; };
    sync();
    new MutationObserver(sync).observe(ph, { childList: true });
  }
  let lite = [];
  try { lite = JSON.parse(($("#catalog-lite") || {}).textContent || "[]"); } catch (e) { lite = []; }
  const pool = lite.filter((x) => x.difficulty === "Beginner");
  const list = pool.length ? pool : lite;
  if (!list.length) { host.dataset.state = "ready"; return; }
  const c = list[todayIndex(list.length)];
  const fmt = c.kind === "modeling" ? "OBJ required" : "MP4 / PNG sequence";
  $(".today__title", host).textContent = c.title;
  $(".today__spec", host).textContent = c.summary;
  setHTML($(".today__chips", host), html`<span class="chip chip--difficulty">${c.difficulty}</span> <span class="chip chip--format">${fmt}</span>`);
  $(".today__brief", host).href = url("challenges/" + c.id + ".html");
  $(".today__open", host).href = url("challenges/" + c.id + ".html");
  const zone = $("[data-dropzone]", host);
  zone.dataset.challenge = c.id;
  zone.dataset.kind = c.kind;
  const btn = $(".dropzone__button", zone);
  btn.textContent = c.kind === "modeling" ? "Choose your OBJ" : "Choose your MP4 or PNG frames";
  const input = $("input[type=file]", zone);
  input.setAttribute("aria-label", btn.textContent);
  input.multiple = c.kind === "animation";
  zone.hidden = false;
  host.dataset.state = "ready";
}
renderToday();

// ---------- export tabs (U2: ARIA tabs, arrows, remembered) ----------
for (const list of $$('[role="tablist"]')) {
  const tabs = $$('[role="tab"]', list);
  const select = (tab, focus) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute("aria-controls"));
      if (panel) panel.hidden = !on;
    }
    if (focus) tab.focus();
    store.set("exportTab", tab.dataset.tab);
  };
  list.closest(".export").classList.add("export--tabs");
  const saved = store.get("exportTab", "");
  select(tabs.find((t) => t.dataset.tab === saved) || tabs[0], false);
  for (const t of tabs) {
    t.addEventListener("click", () => select(t, false));
    t.addEventListener("keydown", (e) => {
      const i = tabs.indexOf(t);
      let j = null;
      if (e.key === "ArrowRight") j = (i + 1) % tabs.length;
      else if (e.key === "ArrowLeft") j = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") j = 0;
      else if (e.key === "End") j = tabs.length - 1;
      if (j !== null) {
        e.preventDefault();
        select(tabs[j], true);
      }
    });
  }
}
// "(steps)" links open the How to export tab last chosen.
document.addEventListener("click", (e) => {
  const a = e.target.closest && e.target.closest("a[data-steps]");
  if (!a) return;
  const exp = $("#export");
  if (exp) {
    e.preventDefault();
    const tab = $('[role="tab"][aria-selected="true"]', exp) || $('[role="tab"]', exp);
    exp.scrollIntoView({ block: "start" });
    if (tab) tab.focus();
  }
});

// ---------- challenge memory ----------
const pageChallenge = document.body.dataset.challenge || "";
if (pageChallenge) store.set("challenge", pageChallenge);

// ---------- drop zones and file triage (U2, U3, E1-E19) ----------
const MODEL_EXT = ["obj", "glb", "gltf", "fbx"];
const VIDEO_EXT = ["mp4", "webm", "m4v", "mov"];
const IMAGE_EXT = ["png", "jpg", "jpeg"];
const extOf = (name) => {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || "");
  return m ? m[1].toLowerCase() : "";
};
const stepsLink = (zone) => {
  if ($("#export")) return ' <a href="#export" data-steps>(steps)</a>';
  const id = zone.dataset.challenge;
  if (id && id !== "checker") return ' <a href="' + esc(url("challenges/" + id + ".html")) + '#export">(steps)</a>';
  return ' <a href="' + esc(url("guides/export-to-obj.html")) + '">(steps)</a>';
};
function refusal(zone, text, opts = {}) {
  const tail = opts.steps ? stepsLink(zone) : "";
  const period = opts.steps && opts.period ? "." : "";
  return { error: true, tip: !!opts.tip, html: esc(text) + tail + period + (opts.extra || ""), other: opts.other || "Choose another file" };
}
export function triage(zone, fileList) {
  const files = Array.from(fileList || []);
  const kind = zone.dataset.kind || "modeling";
  const checker = zone.dataset.challenge === "checker";
  const budget = Number(zone.dataset.budget || 0) || 0;
  if (!files.length) return null;
  const isAnim = kind === "animation";
  const exts = files.map((f) => extOf(f.name));
  // Several files at once
  if (files.length > 1) {
    if (!isAnim) {
      const models = files.filter((f) => MODEL_EXT.includes(extOf(f.name)));
      const objs = models.filter((f) => extOf(f.name) === "obj");
      const pick = objs.length === 1 ? objs[0] : models.length === 1 ? models[0] : null;
      if (!pick) return refusal(zone, COPY.E19);
      const r = triage(zone, [pick]);
      if (r && !r.error) r.notice = COPY.E19;
      return r;
    }
    const images = files.filter((f) => IMAGE_EXT.includes(extOf(f.name)));
    const videos = files.filter((f) => VIDEO_EXT.includes(extOf(f.name)));
    if (images.length >= 2) return triageSequence(zone, images);
    if (videos.length === 1) return triage(zone, videos);
    return refusal(zone, COPY.E18sort, { other: "Choose other files" });
  }
  const f = files[0];
  const ext = exts[0];
  if (f.size === 0) return refusal(zone, COPY.E2);
  if (ext === "blend") return refusal(zone, isAnim ? COPY.E3a : COPY.E3, { tip: true, steps: true });
  if (ext === "ma" || ext === "mb") return refusal(zone, isAnim ? COPY.E4a : COPY.E4m, { tip: true, steps: true });
  if (ext === "max") return refusal(zone, isAnim ? COPY.E5a : COPY.E5m, { tip: true, steps: true });
  if (ext === "ztl" || ext === "zpr") return refusal(zone, COPY.E6, { tip: true, steps: true });
  if (ext === "avi") return isAnim ? refusal(zone, COPY.E16, { steps: true, period: true }) : wrongKind(zone, isAnim);
  if (!isAnim) {
    if (ext === "obj") {
      if (f.size > 50 * 1048576) return refusal(zone, COPY.E10(mb(f.size), 50, budget));
      return { files: [f], format: "obj", kind };
    }
    if (ext === "glb" || ext === "gltf" || ext === "fbx") {
      if (f.size > 100 * 1048576) return refusal(zone, COPY.E10(mb(f.size), 100, budget));
      return { files: [f], format: ext, kind, notMeasured: true };
    }
    if (VIDEO_EXT.includes(ext) || IMAGE_EXT.includes(ext)) return checker ? refusal(zone, COPY.E1(ext)) : wrongKind(zone, isAnim);
    return refusal(zone, COPY.E1(ext));
  }
  if (VIDEO_EXT.includes(ext)) {
    if (f.size > 200 * 1048576) return refusal(zone, COPY.E17size(mb(f.size)));
    return { files: [f], format: "video", kind };
  }
  if (IMAGE_EXT.includes(ext)) return refusal(zone, COPY.E18sort, { other: "Choose other files" });
  if (ext === "glb" || ext === "gltf" || ext === "fbx") {
    if (f.size > 100 * 1048576) return refusal(zone, COPY.E10(mb(f.size), 100, 0));
    return { files: [f], format: ext, kind, clip: true };
  }
  if (ext === "obj") return wrongKind(zone, isAnim);
  return refusal(zone, COPY.E1(ext));
}
function wrongKind(zone, isAnim) {
  const link = isAnim
    ? ' <a href="' + esc(url("challenges/low-poly-mug.html")) + '">(Open a modeling challenge)</a>'
    : ' <a href="' + esc(url("challenges/bouncing-ball.html")) + '">(Open an animation challenge)</a>';
  return { error: true, html: esc(isAnim ? COPY.E15anim : COPY.E15model) + link, other: "Choose another file" };
}
function triageSequence(zone, images) {
  const range = zone.dataset.range || "1-96";
  if (images.length > 300) return refusal(zone, COPY.E18count(images.length, range), { other: "Choose other files" });
  const re = /^(.*?)(\d+)\.(png|jpe?g)$/i;
  let prefix = null;
  const items = [];
  for (const f of images) {
    const m = re.exec(f.name);
    if (!m) return refusal(zone, COPY.E18sort, { other: "Choose other files" });
    const pre = m[1].toLowerCase();
    if (prefix === null) prefix = pre;
    else if (pre !== prefix) return refusal(zone, COPY.E18sort, { other: "Choose other files" });
    items.push({ f, n: parseInt(m[2], 10) });
  }
  items.sort((a, b) => a.n - b.n);
  for (let i = 1; i < items.length; i++) if (items[i].n === items[i - 1].n) return refusal(zone, COPY.E18sort, { other: "Choose other files" });
  return { files: items.map((x) => x.f), format: "sequence", kind: "animation" };
}

function zoneParts(zone) {
  const wrap = zone.closest("[data-dropwrap]") || zone.parentElement;
  return { wrap, msg: $(".dropzone__msg", wrap), host: $(".preview-host", wrap) };
}
function showRefusal(zone, r) {
  const { msg } = zoneParts(zone);
  zone.dataset.state = "refused";
  zone.hidden = false;
  msg.className = "dropzone__msg alert " + (r.tip ? "alert--tip" : "alert--error");
  msg.setAttribute("role", "alert");
  setHTML(msg, html`<p>${{ __html: r.html }}</p><button type="button" class="btn btn--secondary" data-choose>${r.other || "Choose another file"}</button>`);
  msg.hidden = false;
  $("[data-choose]", msg).addEventListener("click", () => $("input[type=file]", zone).click());
  focusEl(msg);
}
export function clearPreview(zone) {
  const { msg, host } = zoneParts(zone);
  if (host && host._dispose) { try { host._dispose(); } catch (e) { /* ignore */ } }
  if (host) { host.innerHTML = ""; host._dispose = null; }
  if (msg) { msg.hidden = true; msg.innerHTML = ""; }
  zone.hidden = false;
  zone.dataset.state = "idle";
}

async function handleFiles(zone, fileList) {
  const r = triage(zone, fileList);
  if (!r) return;
  if (r.error) return showRefusal(zone, r);
  const { msg, host } = zoneParts(zone);
  if (host && host._dispose) { try { host._dispose(); } catch (e) { /* ignore */ } host._dispose = null; }
  msg.hidden = true;
  zone.dataset.state = "reading";
  const first = r.files[0];
  const total = r.files.reduce((s, f) => s + f.size, 0);
  announce("Reading " + (r.files.length > 1 ? r.files.length + " frames" : first.name) + " (" + fmtSize(total) + ")...");
  store.set("lastFile", { name: r.files.length > 1 ? first.name + " +" + (r.files.length - 1) : first.name, at: Date.now() });
  try {
    const mod = await import("./preview.js");
    zone.dataset.state = "accepted";
    zone.hidden = true;
    await mod.startPreview({
      zone,
      host,
      challengeId: zone.dataset.challenge,
      mode: zone.dataset.mode || (zone.dataset.challenge === "checker" ? "checker" : "challenge"),
      triage: r,
      onRefuse: (h, opts = {}) => {
        if (host) host.innerHTML = "";
        showRefusal(zone, { html: h, tip: !!opts.tip, other: opts.other });
      },
      steps: () => stepsLink(zone),
      chooseAgain: () => { clearPreview(zone); $("input[type=file]", zone).click(); },
      onCaptured: zone._onCaptured || null,
    });
  } catch (e) {
    showRefusal(zone, { html: esc(COPY.E13), other: "Choose another file" });
  }
}

export function wireZone(zone) {
  if (zone.dataset.wired) return;
  zone.dataset.wired = "1";
  const input = $("input[type=file]", zone);
  const btn = $(".dropzone__button", zone);
  btn.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    if (input.files && input.files.length) handleFiles(zone, input.files);
    input.value = "";
  });
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (zone.dataset.state !== "reading") zone.dataset.state = "dragover";
  });
  zone.addEventListener("dragleave", () => {
    if (zone.dataset.state === "dragover") zone.dataset.state = "idle";
  });
  zone.addEventListener("drop", async (e) => {
    e.preventDefault();
    zone.dataset.state = "idle";
    const files = await filesFromDrop(e.dataTransfer);
    if (files.length) handleFiles(zone, files);
  });
}
// Folder drops (PNG sequences) read through webkitGetAsEntry.
async function filesFromDrop(dt) {
  const items = dt.items ? Array.from(dt.items) : [];
  const entries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
  if (!entries.some((en) => en.isDirectory)) return Array.from(dt.files || []);
  const out = [];
  const readDir = (dir) => new Promise((resolve) => {
    const reader = dir.createReader();
    const all = [];
    const next = () => reader.readEntries((batch) => {
      if (!batch.length) return resolve(all);
      all.push(...batch);
      next();
    }, () => resolve(all));
    next();
  });
  const walk = async (en) => {
    if (en.isFile) await new Promise((res) => en.file((f) => { out.push(f); res(); }, () => res()));
    else if (en.isDirectory) for (const c of await readDir(en)) await walk(c);
  };
  for (const en of entries) await walk(en);
  return out;
}
for (const zone of $$("[data-dropzone]")) wireZone(zone);
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

// ---------- restore the last preview on a challenge page; E30 after Back from Stripe ----------
async function restoreLast(showE30) {
  const zone = $("[data-dropzone]");
  if (!zone || !pageChallenge && page !== "index") return;
  const id = zone.dataset.challenge;
  if (!id || id === "checker") return;
  const cap = await idb.get(captureKey(id));
  if (!cap) {
    if (showE30) {
      const { msg } = zoneParts(zone);
      msg.className = "dropzone__msg note";
      msg.setAttribute("role", "status");
      msg.textContent = COPY.E30;
      msg.hidden = false;
    }
    return;
  }
  const { host } = zoneParts(zone);
  if (host && host.childElementCount) return;
  const mod = await import("./preview.js");
  zone.hidden = true;
  await mod.restorePreview({
    zone,
    host,
    challengeId: id,
    capture: cap,
    e30: showE30 ? COPY.E30 : "",
    chooseAgain: () => { clearPreview(zone); $("input[type=file]", zone).click(); },
    steps: () => stepsLink(zone),
  });
}
window.addEventListener("pageshow", () => {
  const started = sess.get("checkoutStarted", null);
  if (started && Date.now() - (started.t || 0) < 6 * 3600 * 1000) {
    sess.del("checkoutStarted");
    restoreLast(true);
  } else if (pageChallenge) {
    restoreLast(false);
  }
});

// ---------- review page ----------
if (page === "review") {
  import("./review.js").then((m) => m.runReviewPage()).catch(() => {
    const out = $("#review-root");
    if (out) out.textContent = COPY.E26;
  });
}
