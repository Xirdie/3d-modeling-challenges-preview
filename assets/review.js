// CritPass paid review: POST /verify + POST /review, the 4-step progress, the U7 renderer
// (review.html, and inline for holders and owner-code reviews), .md / grade card / export downloads.
import {
  CFG, COPY, $, $$, esc, html, raw, setHTML, url, store, sess, idb, captureKey, getCatalog, getChallenge, announce,
  focusEl, goal, api, devHeaders, markProviderDown, getUnlock, captureUtm, saveProgress, downloadBlob, openBugPanel,
  copyButtonHTML, wireCopy, shortDate, getProgress, isHolder, keptUnlock, settleUnlock, maskSession,
} from "./core.js";
import { measuredTopology, measuredFrames, composite, passBar, letterFor, linePoints } from "./rubric.js";
import { exportProgress } from "./app.js";
import { checkout } from "./actions.js";

const STEP_TEXT = ["Payment confirmed", "Sending your {n} snapshots", "Reviewing against the rubric", "Scoring and writing your notes"];
const kindCopy = (k) => (k === "pack" ? "pack" : k === "plan" || k === "deep" ? "plan" : "one");

// ---------- the review page (U7) ----------
export async function runReviewPage() {
  const root = $("#review-root");
  const h1 = $("#page-h1");
  const params = new URLSearchParams(location.search);
  captureUtm(params);
  let sid = params.get("session_id") || "";
  const last = params.get("last") || "";
  if (!sid && last) return showSaved(root, h1, last);
  const u0 = getUnlock();
  if (!sid && u0 && u0.pending_challenge) sid = u0.session_id;
  if (!sid) {
    setHTML(root, await noReviewWaiting());
    return;
  }
  const flow = new Flow(root, { page: true, h1 });
  flow.sessionId = sid;
  await flow.verifyThenReview(params.get("resume") === "1");
}

// ---------- saved reviews (qa 16): the slim review saveProgress keeps, reopened from this browser ----------
function savedEntries() {
  const prog = getProgress();
  return Object.keys(prog)
    .filter((id) => prog[id] && prog[id].last && Array.isArray(prog[id].last.lines))
    .sort((a, b) => String(prog[b].date).localeCompare(String(prog[a].date)))
    .map((id) => ({ id, e: prog[id] }));
}
async function noReviewWaiting() {
  const list = savedEntries();
  const head = html`<p>No paid review is waiting in this browser. <a href="${url("index.html#challenges")}">(Open a challenge)</a></p>`;
  if (!list.length) return head;
  let cat = null;
  try { cat = await getCatalog(); } catch (e) { cat = null; }
  const title = (id) => { const c = cat && cat.challenges.find((x) => x.id === id); return c ? c.title : id; };
  return html`${head}<h2>Your saved reviews</h2><ul class="saved-reviews">${list.map(({ id, e }) => {
    const g = e.last.grade || e.best || {};
    return html`<li><a href="${url("review.html") + "?last=" + encodeURIComponent(id)}">${title(id)}</a> · ${g.letter || "-"} ${g.pass ? "PASS" : "NOT YET"} · ${shortDate(e.date)}</li>`;
  })}</ul>`;
}
async function showSaved(root, h1, id) {
  const e = getProgress()[id];
  let ch = null;
  try { ch = await getChallenge(id); } catch (err) { ch = null; }
  if (!e || !e.last || !Array.isArray(e.last.lines) || !ch) {
    setHTML(root, await noReviewWaiting());
    return;
  }
  root.innerHTML = "";
  const flow = new Flow(root, { page: true, h1, challenge: ch });
  flow.kind = "saved";
  await flow.showResult(e.last, { saved: true, label: "Saved review · " + shortDate(e.date) + " · kept in this browser", remaining: null });
}

// ---------- holders on a challenge page (U6 holder states) ----------
export async function runInlineReview(host, challenge, cap, opts = {}) {
  const u = getUnlock();
  if (!u) return;
  const flow = new Flow(host, { page: false, challenge, cap, onDone: opts.onDone });
  flow.sessionId = u.session_id;
  await flow.inline();
}

// ---------- owner-code result (U5): the /review body from /quick, rendered with the U7 layout ----------
export async function renderInlineResult(host, challenge, cap, data, opts) {
  const review = data.review || data;
  const flow = new Flow(host, { page: false, challenge, cap });
  flow.kind = "owner";
  await flow.showResult(review, { label: opts.label, remaining: null });
  goal("review_done", "owner");
}

class Flow {
  constructor(host, opts) {
    this.host = host;
    this.opts = opts;
    this.challenge = opts.challenge || null;
    this.cap = opts.cap || null;
    this.sessionId = "";
    this.kind = "one";
    this.reverified = false;
    this.stillTimer = null;
  }

  // ----- markup helpers -----
  stepsHTML(n) {
    return html`<ol class="steps" aria-label="Review progress">${STEP_TEXT.map((t, i) => html`<li class="steps__item" data-state="${i === 0 ? "now" : "next"}"><span class="steps__label">${t.replace("{n}", n)}</span> <span class="steps__state">${i === 0 ? "now" : "next"}</span></li>`)}</ol>
      <p class="muted steps__wait">This can take up to a minute. Keep this tab open until your grade appears.</p>
      <p class="steps__still" hidden>Still working: long reviews can take up to two minutes.</p>`;
  }
  step(i, state) {
    const items = $$(".steps__item", this.host);
    const it = items[i];
    if (!it) return;
    it.dataset.state = state;
    $(".steps__state", it).textContent = state;
    if (state === "now") announce($(".steps__label", it).textContent);
  }
  msg(h, focus = true) {
    let box = $(".review-msg", this.host);
    if (!box) {
      box = document.createElement("div");
      box.className = "review-msg";
      this.host.appendChild(box);
    }
    box.className = "review-msg alert alert--error";
    box.setAttribute("role", "alert");
    setHTML(box, h);
    wireCopy(box);
    if (focus) focusEl(box);
    return box;
  }
  clearMsg() {
    const box = $(".review-msg", this.host);
    if (box) box.remove();
  }
  sidCopy() {
    return html`<span class="mono">${this.sessionId}</span> ${copyButtonHTML(this.sessionId)}`;
  }

  // ----- /verify -----
  async verify() {
    const r = await api("/verify", { session_id: this.sessionId }, { timeout: 15000, headers: devHeaders() });
    if (r.ok && r.data && r.data.token) {
      const d = r.data;
      const prev = getUnlock();
      // A different checkout's live pack or plan is kept aside, not overwritten (qa 19).
      if (prev && prev.session_id !== this.sessionId && (prev.kind === "pack" || prev.kind === "plan" || prev.kind === "deep") && isHolder(prev)) store.set("unlockPrev", prev);
      const pending = d.challenge_id || (prev && prev.session_id === this.sessionId && prev.pending_challenge) || store.get("challenge", "") || (sess.get("checkoutStarted", {}) || {}).challenge || null;
      const unlock = { session_id: this.sessionId, token: d.token, kind: d.kind, remaining: d.remaining, reset: d.reset || null, exp: d.exp, at: new Date().toISOString(), challenge_id: d.challenge_id || null, pending_challenge: pending };
      store.set("unlock", unlock);
      this.kind = d.kind;
      return { ok: true, unlock };
    }
    return { ok: false, r };
  }
  verifyError(r) {
    const code = r && r.data && r.data.error;
    if (!CFG.worker) return this.msg(html`<p>${COPY.E26}</p>`);
    if (code === "other_product") return this.msg(html`<p>${COPY.E47other}</p>`);
    if (code === "too_old") {
      const [a] = COPY.E41();
      return this.msg(html`<p>${a} ${this.sidCopy()}.</p>`);
    }
    if (r && r.network && !navigator.onLine) return this.msg(html`<p>${COPY.E29}</p>`);
    // unpaid, not_found, no_customer, stripe_error, bad_request (a malformed return id, qa 26), network: E31 with [Check again] (one call per press)
    const box = this.msg(html`<p>${COPY.E31a} ${this.sidCopy()}.</p><p>${COPY.E31b()}</p><button type="button" class="btn btn--primary" data-again>Check again</button>`);
    $("[data-again]", box).addEventListener("click", () => {
      this.clearMsg();
      this.verifyThenReview(false);
    }, { once: true });
  }

  async verifyThenReview(resume) {
    const h1 = this.opts.h1;
    let u = getUnlock();
    const tokenOk = u && u.session_id === this.sessionId && u.token && u.exp && u.exp * 1000 > Date.now() + 120000;
    if (!(resume && tokenOk)) {
      announce("Confirming your payment with Stripe...");
      setHTML(this.host, html`<p class="status-line" role="status">Confirming your payment with Stripe...</p>`);
      if (!CFG.worker) return this.verifyError(null);
      const v = await this.verify();
      if (!v.ok) {
        this.host.innerHTML = "";
        return this.verifyError(v.r);
      }
      u = v.unlock;
    } else {
      this.kind = u.kind;
    }
    // strip the id (and UTM) from the visible URL
    try { history.replaceState(null, "", location.pathname); } catch (e) { /* ignore */ }
    const cid = u.pending_challenge || u.challenge_id || store.get("challenge", "");
    this.challenge = cid ? await getChallenge(cid) : null;
    if (h1 && this.challenge) h1.textContent = "Your review: " + this.challenge.title;
    this.cap = this.challenge ? await idb.get(captureKey(this.challenge.id)) : null;
    // A spent one-off (/verify remaining 0) never gets E32's "safe and unused" (qa 4): E37 at once.
    // With a capture still here the Worker decides (409 done -> E37, running -> wait, tries -> E35).
    if (u.kind === "one" && Number(u.remaining) === 0 && !this.cap) return this.e37();
    if (!this.challenge) {
      setHTML(this.host, html`<p class="alert alert--error" role="alert">${COPY.E32}</p><p><a href="${url("index.html#challenges")}">(Open a challenge)</a></p>`);
      return;
    }
    if (!this.cap) return this.e32();
    await this.run();
  }

  // E37: this checkout was already used; link the saved review when this browser has it.
  e37() {
    this.clearPending();
    settleUnlock();
    if (this.opts.page) this.host.innerHTML = "";
    const id = this.challenge && this.challenge.id;
    const e = id ? getProgress()[id] : null;
    const has = !!(e && e.last && Array.isArray(e.last.lines));
    return this.msg(html`<p>${COPY.E37}</p><p>${has ? html`<a href="${url("review.html") + "?last=" + encodeURIComponent(id)}">(Open your saved review)</a> ` : ""}<a href="${url("index.html#challenges")}">(Open a challenge)</a></p>`);
  }

  // E32: the capture is not on this device -> a drop zone; the review starts itself after the capture.
  async e32() {
    const ch = this.challenge;
    const anim = ch.kind === "animation";
    setHTML(this.host, html`<div class="alert alert--error" role="alert"><p>${COPY.E32}</p></div>
      <section class="dropzone-wrap" data-dropwrap data-noactions>
        <div class="dropzone" data-dropzone data-state="idle" data-challenge="${ch.id}" data-kind="${ch.kind}" data-mode="review" data-budget="${ch.spec.face_budget || ch.spec.tri_budget || ""}" data-range="1-${ch.spec.frames_max || 96}">
          <button type="button" class="btn btn--primary dropzone__button">${anim ? "Choose your MP4 or PNG frames" : "Choose your OBJ"}</button>
          <input type="file" hidden aria-label="${anim ? "Choose your MP4 or PNG frames" : "Choose your OBJ"}"${anim ? raw(" multiple") : raw("")}>
          <p class="dropzone__hint">or drop it here. Nothing is uploaded.</p>
        </div>
        <div class="dropzone__msg" hidden></div>
        <div class="preview-host"></div>
      </section>`);
    const zone = $("[data-dropzone]", this.host);
    zone._onCaptured = (cap) => {
      this.cap = cap;
      const wrap = $("[data-dropwrap]", this.host);
      const after = document.createElement("div");
      after.className = "review-run";
      wrap.after(after);
      this.runHost = after;
      this.run();
    };
    const app = await import("./app.js");
    app.wireZone(zone);
    focusEl($(".alert", this.host));
  }

  async inline() {
    let u = getUnlock();
    this.kind = u.kind;
    this.host.innerHTML = "";
    const fresh = u.token && u.exp && u.exp * 1000 > Date.now() + 120000;
    if (!fresh) {
      const v = await this.verify();
      if (!v.ok) return this.verifyError(v.r);
      u = v.unlock;
    } else {
      store.set("unlock", Object.assign({}, u, { pending_challenge: this.challenge.id }));
    }
    await this.run();
  }

  // ----- /review -----
  async run() {
    const host = this.runHost || this.host;
    const u = getUnlock();
    const deep = u && u.kind === "deep";
    const cap = this.cap;
    const images = cap.images.filter((i) => deep || !/^closeup_|^sheet_[4-6]$|^pose_[5-6]$/.test(i.view));
    if (!this.runHost) this.host.innerHTML = "";
    const stepsBox = document.createElement("div");
    stepsBox.className = "review-progress";
    setHTML(stepsBox, this.stepsHTML(images.length));
    host.appendChild(stepsBox);
    this.stepsRoot = stepsBox;
    const savedHost = this.host;
    this.host = host;
    this.step(0, "done");
    this.step(1, "now");
    const body = { token: u.token, challenge_id: cap.challenge_id, job: cap.job, images: images.map((i) => ({ view: i.view, data: i.data })) };
    if (cap.kind === "animation") body.frames = cap.frames;
    else {
      body.counts = cap.measured === false ? null : cap.counts;
      body.measured = cap.measured !== false;
    }
    const ctrl = new AbortController();
    // The Worker's worst case is a 60 s call plus a 60 s repair, so the page waits 130 s (qa 11; E45).
    const abortT = setTimeout(() => ctrl.abort(), 130000);
    this.stillTimer = setTimeout(() => { const s = $(".steps__still", host); if (s) s.hidden = false; }, 45000);
    const p = api("/review", body, { timeout: 130000, signal: ctrl.signal, headers: devHeaders() });
    this.step(1, "done");
    this.step(2, "now");
    const r = await p;
    clearTimeout(abortT);
    clearTimeout(this.stillTimer);
    this.host = savedHost;
    const d = r.data || {};
    if (r.ok && d.review) {
      this.hostRun = host;
      $$(".steps__item", host).forEach((it, i) => { if (i === 2) { it.dataset.state = "done"; $(".steps__state", it).textContent = "done"; } });
      const it4 = $$(".steps__item", host)[3];
      if (it4) { it4.dataset.state = "now"; $(".steps__state", it4).textContent = "now"; }
      await this.showResult(d.review, { remaining: d.remaining, reset: d.reset, host });
      if (it4) { it4.dataset.state = "done"; $(".steps__state", it4).textContent = "done"; }
      goal("review_done", u.kind || "one");
      if (this.opts.onDone) this.opts.onDone();
      return;
    }
    stepsBox.remove();
    this.host = host;
    await this.reviewError(r, ctrl.signal.aborted);
    this.host = savedHost;
  }

  async reviewError(r, aborted) {
    const d = r.data || {};
    const code = d.error;
    const k = kindCopy(this.kind);
    const sid = d.session_id || this.sessionId;
    if (sid) this.sessionId = sid;
    const reportBtn = (reason) => html`<button type="button" class="btn btn--secondary" data-report="${reason}">Report this failure</button>`;
    const wireReport = (box) => {
      for (const b of $$("[data-report]", box)) b.addEventListener("click", () => {
        document.dispatchEvent(new CustomEvent("critpass:bug", { detail: { prefill: "My paid review failed (" + b.dataset.report + ").", session: this.sessionId } }));
      });
    };
    const tryAgain = (box, waitSecs) => {
      const b = $("[data-try]", box);
      if (!b) return;
      if (waitSecs > 0) {
        b.setAttribute("aria-disabled", "true");
        b.disabled = true;
        setTimeout(() => { b.disabled = false; b.removeAttribute("aria-disabled"); announce(COPY.E34ready); }, waitSecs * 1000);
      }
      b.addEventListener("click", () => { this.clearMsg(); this.run(); }, { once: true });
    };
    // expired token: one silent re-verify, then the request once more
    if ((code === "expired" || code === "bad_token") && !this.reverified) {
      this.reverified = true;
      const v = await this.verify();
      if (v.ok) return this.run();
      return this.verifyError(v.r);
    }
    if (code === "expired" || code === "bad_token") return this.verifyError(r);
    if (aborted || (r.network && navigator.onLine)) {
      const box = this.msg(html`<p>${aborted ? COPY.E45lead + " " : ""}${COPY.E34first[k]} ${COPY.E34session} ${this.sidCopy()}. ${COPY.E34tail()}</p>
        <button type="button" class="btn btn--primary" data-try>Try again</button> ${reportBtn(aborted ? "timeout" : "network")}`);
      wireReport(box);
      return tryAgain(box, 0);
    }
    if (r.network) return this.msg(html`<p>${COPY.E29}</p>`);
    if (code === "review_failed") {
      if (d.retry === false) return this.e35(reportBtn, wireReport, d.reason);
      const box = this.msg(html`<p>${COPY.E34first[k]} ${COPY.E34session} ${this.sidCopy()}. ${COPY.E34tail()}</p>
        <button type="button" class="btn btn--primary" data-try>Try again</button> ${reportBtn(d.reason || "review_failed")}`);
      wireReport(box);
      return tryAgain(box, 0);
    }
    if (code === "running") {
      const secs = Math.max(1, Math.round(Number(d.retry_after) || 60));
      const box = this.msg(html`<p>${COPY.E34first[k]} ${COPY.E34session} ${this.sidCopy()}. ${COPY.E34tail()}</p><p>${COPY.E34wait(secs)}</p>
        <button type="button" class="btn btn--primary" data-try>Try again</button> ${reportBtn("running")}`);
      wireReport(box);
      return tryAgain(box, secs);
    }
    if (code === "tries_exhausted") return this.e35(reportBtn, wireReport, "tries_exhausted");
    if (code === "declined") {
      const [a, b] = COPY.E36();
      return this.msg(html`<p>${a} ${this.sidCopy()}. ${b}</p>`);
    }
    if (code === "done") return this.e37();
    if (code === "inactive") {
      const box = this.msg(html`<p>${COPY.E38[0]} <a href="${CFG.portal}" rel="noopener">(Manage subscription)</a> ${COPY.E38[1]}</p>${this.buyRow([["one_off", "Full review $9"]])}`);
      return this.wireBuy(box);
    }
    if (code === "cap") {
      const box = this.msg(html`<p>${COPY.E39(d.reset)}</p>${this.buyRow([["pack", "5 reviews $29"]])}`);
      return this.wireBuy(box);
    }
    if (code === "pack_empty") {
      this.updateUnlock({ remaining: 0 });
      const box = this.msg(html`<p>${COPY.E40}</p>${this.buyRow([["pack", "5 reviews $29"], ["one_off", "Full review $9"]])}`);
      return this.wireBuy(box);
    }
    if (code === "provider_down" || code === "misconfigured") {
      markProviderDown();
      const box = this.msg(html`<p>${COPY.E44}</p><button type="button" class="btn btn--primary" data-try>Try again</button>`);
      return tryAgain(box, 0);
    }
    if (code === "triangulated") {
      return this.msg(html`<p>${COPY.E14} <a href="${url("challenges/" + this.cap.challenge_id + ".html")}#export">(steps)</a>. ${COPY.E43tail}</p><p><a href="${url("challenges/" + this.cap.challenge_id + ".html")}#check">(Open the challenge and drop a new file)</a></p>`);
    }
    if (code === "origin") return this.msg(html`<p>${COPY.E26}</p>`);
    // caps and bad requests (E42)
    const box = this.msg(html`<p>${COPY.E42} <button type="button" class="btn btn--text" data-report="${code || r.status}">(Report a problem)</button>.</p>${reportBtn(code || String(r.status))}`);
    wireReport(box);
  }
  e35(reportBtn, wireReport, reason) {
    const k = kindCopy(this.kind);
    const [a, b] = k === "one" ? COPY.E35one() : COPY.E35multi();
    const box = this.msg(html`<p>${a} ${this.sidCopy()} ${b}</p>${reportBtn(reason || "review_failed")}`);
    wireReport(box);
  }
  // Buy buttons with the preview reason once, above them (U6; qa 30), when any link is empty.
  buyRow(items) {
    const missing = items.some(([k]) => !CFG.links[k]);
    return html`${missing ? html`<p class="reason">${COPY.previewNoBuy}</p>` : raw("")}<p class="btn-row">${items.map(([k, label]) => html`<button type="button" class="btn btn--secondary" data-buy="${k}" aria-disabled="${CFG.links[k] ? "false" : "true"}">${label}</button> `)}</p>`;
  }
  wireBuy(box) {
    const cid = (this.cap && this.cap.challenge_id) || (this.challenge && this.challenge.id) || "";
    for (const b of $$("[data-buy]", box)) b.addEventListener("click", () => { if (b.getAttribute("aria-disabled") !== "true") checkout(b.dataset.buy, cid); });
  }
  updateUnlock(patch) {
    const u = getUnlock();
    if (u) store.set("unlock", Object.assign({}, u, patch));
  }
  clearPending() {
    const u = getUnlock();
    if (u) { delete u.pending_challenge; store.set("unlock", u); }
  }

  // ----- result (U7) -----
  async showResult(review, ctx) {
    const host = ctx.host || this.host;
    const ch = this.challenge || (await getChallenge(review.challenge_id));
    this.challenge = ch;
    const cap = this.cap;
    const page = !!this.opts.page;
    const grade = review.grade || composite(review.lines || [], passBar(ch));
    const verdict = grade.pass ? "PASS" : "NOT YET";
    const bar = grade.bar || passBar(ch);
    const lines = review.lines || [];
    const scored = lines.filter((l) => l.weight > 0 && l.score !== null && l.score !== undefined);
    const fix = scored.filter((l) => (l.improve || []).length).slice().sort((a, b) => a.score - b.score || b.weight - a.weight).slice(0, 3);
    const observedLine = (ch.rubric || []).find((l) => l.grader === "observed");
    const u = getUnlock();
    const kind = this.kind === "owner" || this.kind === "saved" ? this.kind : (u && u.kind) || "one";
    const remaining = ctx.remaining;
    const next = await nextChallenge(ch);
    const label = ctx.label || "";
    const isDry = !!review.dry || review.label === "DRY RUN";
    const uid = "r" + Math.random().toString(36).slice(2, 8);
    const H = page ? "h1" : "h2";

    const lineCard = (l) => {
      const def = (ch.rubric || []).find((x) => x.id === l.id) || {};
      const isMeasured = def.grader === "measured" || l.measured;
      let measuredTable = raw("");
      if (isMeasured && cap) {
        const r = ch.kind === "animation" ? measuredFrames(cap.frames, ch.spec) : (cap.measured === false ? null : measuredTopology(cap.counts, ch.spec));
        if (r) measuredTable = html`<table class="counts"><caption class="visually-hidden">Measured counts</caption><thead><tr><th scope="col">Item</th><th scope="col">Yours</th><th scope="col">Spec</th><th scope="col">Status</th></tr></thead><tbody>${r.checks.map((c) => html`<tr data-status="${c.status}"><th scope="row">${c.label}</th><td class="counts__value mono">${c.value}</td><td class="mono">${c.spec}</td><td>${c.text}</td></tr>`)}</tbody></table>`;
      }
      const sc = l.score === null || l.score === undefined ? null : l.score;
      // one scale per line (qa 38): points out of the line's weight, as the preview and quick review show
      const pts = sc === null ? undefined : linePoints({ weight: l.weight, score: sc });
      const list = (title, items, cls, ordered) => items && items.length
        ? html`<h4>${title}</h4>${ordered ? html`<ol class="${cls}">${items.map((x) => html`<li>${x}</li>`)}</ol>` : html`<ul class="${cls}">${items.map((x) => html`<li>${x}</li>`)}</ul>`}` : raw("");
      return html`<article class="line-card" id="${uid}-line-${l.id}" tabindex="-1">
        <h3>${l.title || def.title || l.id}</h3>
        ${isMeasured ? html`<p class="chip chip--measured">${ch.kind === "animation" ? "Measured by code from your frames, not by AI" : "Topology, measured · computed from your counts, not by AI"}</p>` : raw("")}
        <p class="mono">${pts === undefined ? "Not measured (needs OBJ)" : pts === null ? "Noted, not scored" : pts + " / " + l.weight}</p>
        <div class="line-card__bar" style="--score:${sc === null ? 0 : Math.max(0, Math.min(1, sc / 10))}" aria-hidden="true"></div>
        ${measuredTable}
        ${list("Met the brief", l.met, "line-card__met")}
        ${list("Missed", l.missed, "line-card__missed")}
        ${list("How to improve", l.improve, "line-card__improve", true)}
      </article>`;
    };

    const snapshots = cap && cap.images ? cap.images : [];
    const cardAlt = "Grade card: " + ch.title + ", " + grade.letter + ", " + grade.total + "/100, " + verdict + ", AI-graded, CritPass";
    const restore = (kind === "pack" || kind === "plan" || kind === "deep") && u ? html`<section class="restore-code" aria-label="Restore code">
        <p>Restore code: <span class="mono">${u.session_id}</span> ${copyButtonHTML(u.session_id)}</p>
        <p>Paste it under 'Restore purchase' to use your ${kind === "pack" ? "pack" : "plan"} on another device or browser. Save it now: it is not in Stripe's receipt email.</p>
        ${remaining !== null && remaining !== undefined ? html`<p>${kind === "pack" ? remaining + " reviews left on this pack" : remaining + " reviews left this month"}</p>` : raw("")}
      </section>` : raw("");
    const nextBlock = kind === "one"
      ? html`${this.buyRow([["pack", "Fix it and resubmit: 5 reviews for $29"]])} ${next ? html`<a href="${url("challenges/" + next.id + ".html")}">(Next challenge: ${next.title})</a>` : raw("")}`
      : html`<a class="btn btn--primary" href="${url("challenges/" + ch.id + ".html")}#check">Resubmit this challenge</a> ${next ? html`<a href="${url("challenges/" + next.id + ".html")}">(Next challenge: ${next.title})</a>` : raw("")}`;

    const out = document.createElement("section");
    out.className = "review";
    out.setAttribute("aria-label", "Your review");
    setHTML(out, html`
      ${label ? html`<p class="chip chip--ai">${label}</p>` : raw("")}
      ${isDry ? html`<p class="chip chip--notscored">DRY RUN: no model call</p>` : raw("")}
      <div class="grade" data-verdict="${grade.pass ? "pass" : "notyet"}" data-state="pending">
        ${page ? raw("") : html`<${raw(H)} class="grade__heading" id="${uid}-grade" tabindex="-1">Your grade: ${grade.letter}</${raw(H)}>`}
        <p class="grade__letter" aria-hidden="true">${grade.letter}</p>
        <p class="grade__score mono">${grade.total} / 100</p>
        <p class="grade__verdict"><span class="chip ${grade.pass ? "chip--pass" : "chip--notyet"}">${verdict}</span></p>
        <p class="muted">Pass bar: ${letterFor(bar)} (${bar})</p>
        ${grade.pass ? raw("") : html`<p>Fix the top items below and resubmit.</p>`}
      </div>
      <p class="ai-label">${COPY.aiLabel}</p>
      <details class="ai-details"><summary>(How this review was made)</summary><p>${COPY.aiDisclosure}</p></details>
      <section aria-labelledby="${uid}-sum"><h2 id="${uid}-sum">Summary</h2><p>${review.summary || ""}</p></section>
      ${fix.length ? html`<section aria-labelledby="${uid}-fix"><h2 id="${uid}-fix">Fix these first</h2><ol class="fix-first">${fix.map((l) => html`<li><a href="#${uid}-line-${l.id}" data-jump="${uid}-line-${l.id}">${l.title}: ${l.improve[0]}</a></li>`)}</ol></section>` : raw("")}
      <section aria-labelledby="${uid}-lines"><h2 id="${uid}-lines">Every rubric line</h2>${lines.filter((l) => l.weight > 0 || l.measured).map(lineCard)}</section>
      <section aria-labelledby="${uid}-obs"><h2 id="${uid}-obs">${observedLine ? observedLine.title : "Observations"} · noted, not scored</h2>
        ${(review.observations || []).length ? html`<ul>${review.observations.map((x) => html`<li>${x}</li>`)}</ul>` : html`<p class="muted">No observations.</p>`}</section>
      ${snapshots.length ? html`<section aria-labelledby="${uid}-snap"><h2 id="${uid}-snap">The snapshots this was graded from</h2><ul class="capture-strip capture-strip--review">${snapshots.map((i) => html`<li class="capture-strip__item" data-state="ready"><a href="data:image/jpeg;base64,${i.data}" target="_blank" rel="noopener"><img src="data:image/jpeg;base64,${i.data}" alt="${altOf(i.view)}" width="${i.w}" height="${i.h}" loading="lazy" decoding="async"></a></li>`)}</ul></section>` : raw("")}
      <section aria-labelledby="${uid}-next" class="review-next"><h2 id="${uid}-next">Next</h2><div>${nextBlock}</div></section>
      <section aria-labelledby="${uid}-save" class="review-save"><h2 id="${uid}-save">Save</h2>
        <p>Your progress is saved in this browser; come back any time.</p>
        <p class="btn-row"><button type="button" class="btn btn--secondary" data-dl="md">Download review (.md)</button>
        <button type="button" class="btn btn--secondary" data-dl="card">Download grade card (.png)</button>
        <button type="button" class="btn btn--secondary" data-dl="export">Export my progress (.json)</button></p>
        <img class="grade-card" alt="${cardAlt}" width="600" height="315" decoding="async">
      </section>
      ${restore}`);
    if (ctx.host && ctx.host !== this.host) host.appendChild(out);
    else host.appendChild(out);
    wireCopy(out);
    this.wireBuy(out);
    const card = drawGradeCard(ch, grade);
    $(".grade-card", out).src = card.toDataURL("image/png");
    for (const a of $$("[data-jump]", out)) a.addEventListener("click", (e) => {
      e.preventDefault();
      const t = document.getElementById(a.dataset.jump);
      if (!t) return;
      t.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      t.dataset.flash = "";
      setTimeout(() => delete t.dataset.flash, 800);
      focusEl(t);
    });
    for (const b of $$("[data-dl]", out)) b.addEventListener("click", () => {
      const k = b.dataset.dl;
      if (k === "md") {
        downloadBlob(new Blob([reviewMarkdown(ch, review, grade)], { type: "text/markdown" }), "critpass-" + ch.id + "-review.md");
        goal("download", "md");
      } else if (k === "card") {
        card.toBlob((blob) => { if (blob) downloadBlob(blob, "critpass-" + ch.id + "-grade.png"); }, "image/png");
        goal("download", "card");
      } else exportProgress();
    });

    // the in-progress lines go once the grade is here (qa 15)
    clearTimeout(this.stillTimer);
    if (this.stepsRoot) for (const el of $$(".steps__wait, .steps__still", this.stepsRoot)) el.hidden = true;
    // save: progress, then delete the capture; remaining from the response (a reopened saved review changes nothing)
    if (!ctx.saved) {
      saveProgress(ch.id, review, cap && cap.thumb);
      await idb.del(captureKey(ch.id));
    }
    if (u && !ctx.saved && this.kind !== "owner") {
      const patch = { at: new Date().toISOString() };
      if (remaining !== null && remaining !== undefined) patch.remaining = remaining;
      if (ctx.reset) patch.reset = ctx.reset;
      const nu = Object.assign({}, u, patch);
      delete nu.pending_challenge;
      store.set("unlock", nu);
      settleUnlock();
      const kept = keptUnlock();
      if (kept) {
        const note = document.createElement("p");
        note.className = "note";
        setHTML(note, html`Your earlier ${kept.kind === "pack" ? "pack" : "plan"} (${maskSession(kept.session_id)}) is still saved in this browser. <button type="button" class="btn btn--text" data-switch>(Switch back to it)</button>`);
        out.appendChild(note);
        $("[data-switch]", note).addEventListener("click", () => {
          const cur = getUnlock();
          if (cur) store.set("unlockPrev", cur);
          store.set("unlock", Object.assign({}, kept, { token: "", exp: 0 }));
          note.textContent = "Switched back to your earlier " + (kept.kind === "pack" ? "pack" : "plan") + ".";
          announce(note.textContent);
          document.dispatchEvent(new CustomEvent("critpass:unlock"));
        }, { once: true });
      }
    }
    requestAnimationFrame(() => { $(".grade", out).dataset.state = "revealed"; });
    const h1 = this.opts.h1;
    const focusTarget = page && h1 ? h1 : $(".grade__heading", out);
    if (page && h1) h1.textContent = "Your grade: " + grade.letter;
    focusEl(focusTarget);
    announce("Review ready: " + grade.letter + ", " + grade.total + " out of 100, " + verdict + ".");
    document.dispatchEvent(new CustomEvent("critpass:unlock"));
  }
}

function altOf(view) {
  const m = {
    matcap_front: "Matcap front view", matcap_34: "Matcap three-quarter view", matcap_side: "Matcap side view",
    matcap_top: "Matcap top view", wire_front: "Wireframe front view", wire_34: "Wireframe three-quarter view",
    silhouette: "Silhouette beside the reference",
  };
  if (m[view]) return m[view];
  const p = view.split("_");
  if (p[0] === "sheet") return "Contact sheet " + p[1];
  if (p[0] === "pose") return "Key pose " + p[1];
  if (p[0] === "closeup") return "Close-up " + p[1];
  return view;
}

async function nextChallenge(ch) {
  try {
    const cat = await getCatalog();
    const list = cat.challenges.slice().sort((a, b) => a.order - b.order);
    const i = list.findIndex((c) => c.id === ch.id);
    return list[(i + 1) % list.length] || null;
  } catch (e) {
    return null;
  }
}

function reviewMarkdown(ch, review, grade) {
  const L = [];
  L.push("> " + COPY.aiDisclosure);
  L.push("");
  L.push("# CritPass review: " + ch.title);
  L.push("");
  L.push("**Grade: " + grade.letter + " (" + grade.total + " / 100), " + (grade.pass ? "PASS" : "NOT YET") + "** · pass bar " + letterFor(grade.bar || 80) + " (" + (grade.bar || 80) + ")");
  if (review.dry || review.label === "DRY RUN") L.push("", "_DRY RUN: no model call._");
  L.push("", "## Summary", "", review.summary || "");
  for (const l of review.lines || []) {
    const pts = l.score === null || l.score === undefined ? null : linePoints({ weight: l.weight, score: l.score });
    L.push("", "## " + (l.title || l.id) + " (" + (l.score === null || l.score === undefined ? "not measured" : pts === null ? "noted, not scored" : pts + " / " + l.weight) + ")");
    if (l.measured) L.push("", "_Measured by code, not by AI._");
    const sec = (t, a, ord) => { if (a && a.length) { L.push("", "**" + t + "**", ""); a.forEach((x, i) => L.push((ord ? i + 1 + "." : "-") + " " + x)); } };
    sec("Met the brief", l.met);
    sec("Missed", l.missed);
    sec("How to improve", l.improve, true);
  }
  if ((review.observations || []).length) {
    L.push("", "## Observations (noted, not scored)", "");
    review.observations.forEach((x) => L.push("- " + x));
  }
  L.push("", "---", "CritPass · https://tools.xirdie.com/3d-modeling-challenges-preview/challenges/" + ch.id + ".html · " + new Date().toISOString().slice(0, 10));
  return L.join("\n") + "\n";
}

// 1200 x 630 grade card (P2), light palette, "AI-graded" under the grade.
function drawGradeCard(ch, grade) {
  const c = document.createElement("canvas");
  c.width = 1200;
  c.height = 630;
  const g = c.getContext("2d");
  const font = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, 1200, 630);
  g.strokeStyle = "#e2e0da";
  g.lineWidth = 2;
  g.strokeRect(1, 1, 1198, 628);
  // mark: isometric cube, top face in the accent
  const mx = 64, my = 56, s = 22;
  g.fillStyle = "#2c4bc7";
  g.beginPath();
  g.moveTo(mx, my); g.lineTo(mx + s, my - s * 0.55); g.lineTo(mx + 2 * s, my); g.lineTo(mx + s, my + s * 0.55); g.closePath();
  g.fill();
  g.strokeStyle = "#1f2328";
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(mx, my); g.lineTo(mx + s, my - s * 0.55); g.lineTo(mx + 2 * s, my); g.lineTo(mx + s, my + s * 0.55); g.closePath();
  g.moveTo(mx, my); g.lineTo(mx, my + s * 1.1); g.lineTo(mx + s, my + s * 1.65); g.lineTo(mx + 2 * s, my + s * 1.1); g.lineTo(mx + 2 * s, my);
  g.moveTo(mx + s, my + s * 0.55); g.lineTo(mx + s, my + s * 1.65);
  g.stroke();
  g.textBaseline = "alphabetic";
  g.font = "750 40px " + font;
  g.fillStyle = "#1f2328";
  g.fillText("Crit", 124, 80);
  const w = g.measureText("Crit").width;
  g.fillStyle = "#2c4bc7";
  g.fillText("Pass", 124 + w, 80);
  g.fillStyle = "#1f2328";
  g.font = "650 52px " + font;
  g.fillText(ch.title, 64, 170);
  g.font = "800 220px " + font;
  g.fillText(grade.letter, 64, 410);
  const lw = g.measureText(grade.letter).width;
  g.font = "700 56px " + font;
  g.fillText(grade.total + " / 100", 64 + lw + 48, 330);
  const pass = !!grade.pass;
  const chip = pass ? "PASS" : "NOT YET";
  g.font = "700 40px " + font;
  const cw = g.measureText(chip).width + 40;
  g.fillStyle = pass ? "#e6f4ea" : "#fbf1d9";
  g.fillRect(64 + lw + 48, 356, cw, 60);
  g.fillStyle = pass ? "#116329" : "#7d4e00";
  g.fillText(chip, 64 + lw + 68, 400);
  g.fillStyle = "#57606a";
  g.font = "28px " + font;
  g.fillText("AI-graded", 64, 462);
  g.font = "26px " + font;
  g.fillText("tools.xirdie.com/3d-modeling-challenges", 64, 580);
  return c;
}
