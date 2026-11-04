// CritPass actions under the preview: the free quick review / owner code (U5) and the pay block (U6).
import {
  CFG, DEEP_ON, COPY, $, $$, esc, html, raw, setHTML, url, store, sess, idb, captureKey, announce, focusEl, goal,
  api, devHeaders, onGate, gateReason, health, markProviderDown, checkHealth, turnstileWidget, getUnlock, isHolder,
  holderLabel, utcDay, utmQuery, saveProgress,
} from "./core.js";
import { measuredLine } from "./rubric.js";

const PAY = [
  { kind: "one_off", label: "Full review $9", sub: "one-time · every rubric line · 7 full-res views · Claude Sonnet 5.5", cls: "btn--primary" },
  { kind: "pack", label: "5 reviews $29", sub: "$5.80 each · never expire · resubmit after you fix things", cls: "btn--secondary" },
  { kind: "monthly", label: "Monthly $19/mo", sub: "up to 60 reviews a month · renews monthly until you cancel · cancel any time from Manage subscription", cls: "btn--secondary" },
];

// Payment Link hop: the UTM goal first (integrations.md W2), the E30 flag, then Stripe.
export async function checkout(kind, challengeId) {
  const link = CFG.links[kind];
  if (!link) return false;
  goal("checkout_click", kind);
  sess.set("checkoutStarted", { kind, challenge: challengeId, t: Date.now() });
  await new Promise((r) => setTimeout(r, 150));
  const sep = link.indexOf("?") === -1 ? "?" : "&";
  location.href = link + sep + "client_reference_id=" + encodeURIComponent(challengeId) + utmQuery();
  return true;
}

export function mountActions(el, challenge, getCapture, flags) {
  const id = challenge.id;
  let capturing = !!flags.capturing;
  let captureFailed = "";
  let showAllPay = false;
  let quickState = "idle";
  let ts = null;
  let busy = false;

  setHTML(el, html`
    <section class="quick" data-state="idle" aria-labelledby="quick-h-${id}">
      <h2 id="quick-h-${id}" class="visually-hidden">Quick review</h2>
      <p class="reason" data-q-reason hidden></p>
      <div class="turnstile" data-q-ts></div>
      <div data-q-buttons></div>
      <div class="quick__msg" data-q-msg hidden></div>
      <div data-q-result></div>
    </section>
    <section class="pay" data-state="ready" aria-labelledby="pay-h-${id}">
      <h2 id="pay-h-${id}">Get the full review</h2>
      ${flags.kind === "modeling" && flags.measured === false ? html`<p>This file gets every line except 'Topology, measured' (that needs an OBJ).</p>` : raw("")}
      <p class="reason" data-p-reason hidden></p>
      <div data-p-holder></div>
      <div class="pay__options" data-p-options></div>
      <p data-requires="deep"${DEEP_ON ? raw("") : raw(" hidden")}><button type="button" class="btn btn--text" data-kind="deep">(Deep monthly $39/mo: 24 frames or 12 views per review, longer notes)</button></p>
      <p class="muted">Secure checkout by Stripe. Your review starts by itself when you come back.</p>
      <div class="inline-review" data-inline></div>
    </section>`);
  const quickEl = $(".quick", el);
  const payEl = $(".pay", el);

  // ----- file-level reason (E13 / E14 / snapshots pending) -----
  const fileReason = () => {
    if (!flags.webgl) return COPY.E13;
    if (flags.triangulated) return COPY.E14above;
    if (captureFailed) return captureFailed;
    if (capturing) return "Taking your snapshots...";
    return "";
  };

  // ----- quick review block -----
  const ownerCode = () => String(store.get("ownerCode", "") || "").trim();
  const usedToday = () => store.get("quickUsed", "") === utcDay();
  function renderQuick() {
    const reason = fileReason() || gateReason();
    const r = $("[data-q-reason]", quickEl);
    const box = $("[data-q-buttons]", quickEl);
    const code = ownerCode();
    const limited = !code && usedToday();
    r.hidden = !reason || limited;
    r.textContent = reason;
    const dis = !!reason || busy;
    if (limited) {
      if (quickState === "done") { box.innerHTML = ""; return; }
      quickEl.dataset.state = "limited";
      setHTML(box, html`<p class="note">${COPY.E21()}</p>`);
      return;
    }
    if (quickState !== "running" && quickState !== "done" && quickState !== "error") quickEl.dataset.state = "idle";
    if (code) {
      setHTML(box, html`<button type="button" class="btn btn--secondary quick__btn" data-q="owner" aria-disabled="${dis ? "true" : "false"}">${busy ? "Reviewing..." : "Full review with your code"}</button>
        <p class="muted quick__sub">Claude Sonnet 5.5 · 7 full-res views · 3 a day</p>
        ${usedToday() ? raw("") : html`<p><button type="button" class="btn btn--text" data-q="free" aria-disabled="${dis ? "true" : "false"}">(Use the free quick review instead)</button></p>`}`);
    } else {
      setHTML(box, html`<button type="button" class="btn btn--secondary quick__btn" data-q="free" aria-disabled="${dis ? "true" : "false"}">${busy ? "Reviewing..." : "Get a free quick review"}</button>
        <p class="muted quick__sub">Grade band, 2 strengths and the one biggest fix · from 3 low-res views · AI (Claude Haiku 5.5) · 1 a day</p>`);
    }
    for (const b of $$("[data-q]", box)) {
      if (busy) b.setAttribute("aria-busy", "true");
      b.addEventListener("click", () => runQuick(b.dataset.q === "owner"));
    }
    // Turnstile loads with the block, once reviews are possible.
    if (!ts && !reason && CFG.worker) {
      ts = turnstileWidget($("[data-q-ts]", quickEl), "quick", () => announce("Complete the quick check above to continue."));
    }
  }
  const qmsg = (h, opts = {}) => {
    const m = $("[data-q-msg]", quickEl);
    m.className = "quick__msg alert " + (opts.note ? "note" : "alert--error");
    m.setAttribute("role", opts.note ? "status" : "alert");
    setHTML(m, h);
    m.hidden = false;
    for (const b of $$("[data-retry]", m)) b.addEventListener("click", () => { m.hidden = true; runQuick(b.dataset.retry === "owner"); });
    if (!opts.nofocus) focusEl(m);
  };

  async function runQuick(owner) {
    if (busy) return;
    if (fileReason() || gateReason()) return;
    const cap = getCapture();
    if (!cap) return;
    if (!owner && usedToday()) return renderQuick();
    $("[data-q-msg]", quickEl).hidden = true;
    busy = true;
    quickState = "running";
    quickEl.dataset.state = "running";
    renderQuick();
    announce(owner ? "Sending 7 snapshots for a full review. This can take up to a minute." : "Sending 3 snapshots for a quick review. This usually takes a few seconds.");
    let token;
    try {
      if (!ts) ts = turnstileWidget($("[data-q-ts]", quickEl), "quick", () => announce("Complete the quick check above to continue."));
      token = await ts.token();
    } catch (e) {
      busy = false;
      quickState = "error";
      quickEl.dataset.state = "error";
      renderQuick();
      return qmsg(html`<p>${COPY.E20}</p><button type="button" class="btn btn--secondary" data-retry="${owner ? "owner" : "free"}">Try again</button>`);
    }
    const body = { turnstile: token, challenge_id: cap.challenge_id };
    const standard = cap.images.filter((i) => !/^closeup_|^sheet_[4-6]$|^pose_[5-6]$/.test(i.view));
    body.images = (owner ? standard : cap.quick).map((i) => ({ view: i.view, data: i.data }));
    if (cap.kind === "animation") body.frames = cap.frames;
    else {
      body.counts = cap.measured === false ? null : cap.counts;
      body.measured = cap.measured !== false;
    }
    if (owner) body.code = ownerCode();
    // owner reviews use the /review path on the Worker: 60 s + a 60 s repair at worst, so 130 s (qa 11)
    const r = await api("/quick", body, { timeout: owner ? 130000 : 30000, headers: devHeaders() });
    if (ts) ts.reset();
    busy = false;
    const d = r.data || {};
    const err = d.error;
    if (r.ok) {
      quickState = "done";
      quickEl.dataset.state = "done";
      if (owner || d.review) {
        renderQuick();
        const rv = await import("./review.js");
        await rv.renderInlineResult($("[data-q-result]", quickEl), challenge, cap, d, { label: "Full review · owner code", kind: "owner" });
        return;
      }
      store.set("quickUsed", utcDay());
      renderQuick();
      renderQuickResult(d, cap);
      goal("quick_review", id);
      return;
    }
    quickState = "error";
    quickEl.dataset.state = "error";
    if (err === "turnstile") { renderQuick(); return qmsg(html`<p>${COPY.E20}</p><button type="button" class="btn btn--secondary" data-retry="${owner ? "owner" : "free"}">Try again</button>`); }
    if (err === "ip_limit") {
      // E21 once (qa 12): renderQuick's limited state already shows it in place of the button.
      store.set("quickUsed", utcDay());
      renderQuick();
      const note = $("[data-q-buttons] .note", quickEl);
      if (note) focusEl(note);
      return;
    }
    if (err === "daily_cap") { renderQuick(); quickEl.dataset.state = "limited"; return qmsg(html`<p>${COPY.E22(d.reset)}</p>`, { note: true }); }
    if (err === "bad_code") { renderQuick(); return qmsg(html`<p>${COPY.E23}</p><button type="button" class="btn btn--secondary" data-retry="free">Use the free quick review</button>`); }
    if (err === "code_limit") { renderQuick(); return qmsg(html`<p>${COPY.E24}</p><button type="button" class="btn btn--secondary" data-retry="free">Use the free quick review</button>`); }
    if (err === "owner_cap") { renderQuick(); return qmsg(html`<p>${COPY.E25(d.reset)}</p><button type="button" class="btn btn--secondary" data-retry="free">Use the free quick review</button>`); }
    if (err === "provider_error") { markProviderDown(); renderQuick(); return qmsg(html`<p>${COPY.E27(!!d.free_restored)}</p>`); }
    if (err === "provider_down" || err === "misconfigured") { markProviderDown(); renderQuick(); return qmsg(html`<p>${COPY.E26}</p>`); }
    if (err === "declined") { if (!owner) store.set("quickUsed", utcDay()); renderQuick(); return qmsg(html`<p>${COPY.E28}</p>`); }
    if (err === "triangulated") { renderQuick(); return qmsg(html`<p>${COPY.E14}${raw(flags.steps ? flags.steps() : "")}.</p>`); }
    if (r.network) {
      renderQuick();
      if (!navigator.onLine) { health.online = false; return qmsg(html`<p>${COPY.E29}</p>`); }
      checkHealth();
      return qmsg(html`<p>${COPY.E26}</p>`);
    }
    renderQuick();
    return qmsg(html`<p>${COPY.E42quick} <button type="button" class="btn btn--text" data-bug>(Report a problem)</button>.</p>`);
  }

  function renderQuickResult(d, cap) {
    const box = $("[data-q-result]", quickEl);
    const line = measuredLine(challenge, cap.kind === "animation" ? { frames: cap.frames } : { counts: cap.counts, measured: cap.measured !== false });
    let measuredText = "";
    if (typeof d.measured === "string") measuredText = d.measured;
    else if (line) measuredText = line.title + ": " + (line.points === null ? "not measured (needs OBJ)" : line.points + " / " + line.weight + ", measured by code");
    const works = Array.isArray(d.works) ? d.works.slice(0, 2) : [];
    setHTML(box, html`<section class="quick__result" aria-labelledby="qr-h-${id}">
      <h3 id="qr-h-${id}" tabindex="-1">Quick review</h3>
      <p class="chip chip--ai quick__badge">${COPY.quickBadge}</p>
      ${d.dry ? html`<p class="chip chip--notscored">DRY RUN: no model call</p>` : raw("")}
      <p class="quick__band">Around a ${d.band || "-"}</p>
      <h4>What works</h4>
      <ul>${works.map((w) => html`<li>${w}</li>`)}</ul>
      <h4>The biggest fix</h4>
      <p>${d.biggest_fix || ""}</p>
      <p class="mono">${measuredText}</p>
      <p>The full review grades every rubric line from 7 full-res views and gives you the steps to move each one up: $9.</p>
    </section>`);
    focusEl($("h3", box));
    announce("Quick review ready: around a " + (d.band || "-") + ".");
  }

  // ----- pay block -----
  function renderPay() {
    const reason = fileReason() || gateReason();
    const r = $("[data-p-reason]", payEl);
    // The preview build's empty links: the reason once, above the buttons (U6; qa 30).
    const u = getUnlock();
    const holder = isHolder(u);
    const noLinks = (!holder || showAllPay) && PAY.some((p) => !CFG.links[p.kind]);
    const shown = reason || (noLinks ? COPY.previewNoBuy : "");
    r.hidden = !shown;
    r.textContent = shown;
    const hBox = $("[data-p-holder]", payEl);
    const opts = $("[data-p-options]", payEl);
    payEl.dataset.state = reason ? "disabled" : holder ? "holder" : "ready";
    if (holder) {
      setHTML(hBox, html`<button type="button" class="btn btn--primary" data-holder aria-disabled="${reason ? "true" : "false"}">${holderLabel(u)}</button>
        ${showAllPay ? raw("") : html`<p><button type="button" class="btn btn--text" data-buy-other aria-expanded="false">(Buy something else)</button></p>`}`);
      $("[data-holder]", hBox).addEventListener("click", runHolder);
      const other = $("[data-buy-other]", hBox);
      if (other) other.addEventListener("click", () => { showAllPay = true; renderPay(); const f = $("[data-kind]", opts); if (f) f.focus(); });
    } else {
      hBox.innerHTML = "";
    }
    if (!holder || showAllPay) {
      setHTML(opts, html`${PAY.map((p) => {
        const missing = !CFG.links[p.kind];
        const dis = !!reason || missing;
        return html`<div class="pay__opt"><button type="button" class="btn ${p.cls}" data-kind="${p.kind}" aria-disabled="${dis ? "true" : "false"}">${p.label}</button>
          <p class="muted pay__sub">${p.sub}</p></div>`;
      })}`);
    } else {
      opts.innerHTML = "";
    }
    const deepBtn = $('[data-kind="deep"]', payEl);
    if (deepBtn) deepBtn.setAttribute("aria-disabled", reason || !CFG.links.deep ? "true" : "false");
  }
  payEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-kind]");
    if (!b || b.getAttribute("aria-disabled") === "true") return;
    checkout(b.dataset.kind, id);
  });
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-bug]");
    if (b) import("./core.js").then((c) => c.openBugPanel(""));
  });

  async function runHolder() {
    if (fileReason() || gateReason() || busy) return;
    const cap = getCapture();
    if (!cap) return;
    const rv = await import("./review.js");
    await rv.runInlineReview($("[data-inline]", payEl), challenge, cap, { onDone: () => renderPay() });
  }

  const rerender = () => { renderQuick(); renderPay(); };
  const off = onGate(rerender);
  document.addEventListener("critpass:code", rerender);
  document.addEventListener("critpass:unlock", rerender);
  rerender();

  return {
    ready() {
      capturing = false;
      captureFailed = "";
      rerender();
    },
    failed(msg) {
      capturing = false;
      captureFailed = msg;
      rerender();
    },
    dispose() {
      off();
      document.removeEventListener("critpass:code", rerender);
      document.removeEventListener("critpass:unlock", rerender);
    },
  };
}
