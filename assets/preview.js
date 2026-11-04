// CritPass preview chunk: loaded on the first file. three.js is imported here, on demand.
// Modeling: parse (Web Worker) -> turntable, polygon-edge wireframe, silhouette, counts, topology score
// -> 7 (Deep 12) JPEG snapshots. Animation: frame sampling -> 3 (Deep 6) contact sheets + 4 (6) key poses.
// The capture goes to IndexedDB capture:<challenge id>. Nothing here talks to the Worker.
import {
  COPY, $, $$, esc, html, raw, setHTML, url, idb, captureKey, getChallenge, announce, focusEl, goal,
  fmtInt, fmtSize, reducedMotion, getUnlock, newJobId,
} from "./core.js";
import { measuredTopology, measuredFrames, isTriangulated, measuredLine } from "./rubric.js";
import { makeClayMatcap, makeViewportBackground } from "./matcap.js";

const V = (p) => url("vendor/three/" + p);
let threeP = null;
function loadThree() {
  if (!threeP) {
    threeP = Promise.all([import(V("three.module.js")), import(V("addons/controls/OrbitControls.js"))]).then(([T, O]) => ({ T, OrbitControls: O.OrbitControls }));
  }
  return threeP;
}

let refsP = null;
function refReady(challenge) {
  if (!challenge) return Promise.resolve(false);
  if (!refsP) refsP = fetch(url("assets/ref/available.json")).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  return refsP.then((list) => Array.isArray(list) && list.includes(challenge.id));
}

const MAX_IMG = 1024;
const MAX_BYTES = 200 * 1024;
const QUICK_PX = 768;
const VIEW_ALT = {
  matcap_front: "Matcap front view",
  matcap_34: "Matcap three-quarter view",
  matcap_side: "Matcap side view",
  matcap_top: "Matcap top view",
  wire_front: "Wireframe front view",
  wire_34: "Wireframe three-quarter view",
  silhouette: "Silhouette beside the reference",
};
const altFor = (view) => {
  if (VIEW_ALT[view]) return VIEW_ALT[view];
  let m = /^closeup_(\d)$/.exec(view);
  if (m) return "Close-up " + m[1];
  m = /^sheet_(\d)$/.exec(view);
  if (m) return "Contact sheet " + m[1];
  m = /^pose_(\d)$/.exec(view);
  if (m) return "Key pose " + m[1];
  return view;
};

// ---------- image helpers ----------
function canvasToBlob(canvas, q) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", q));
}
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).replace(/^data:[^,]*,/, ""));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}
function scaled(src, maxSide) {
  const w = src.width, h = src.height;
  const s = Math.min(1, maxSide / Math.max(w, h));
  if (s === 1 && src instanceof HTMLCanvasElement) return src;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  const g = c.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
// JPEG at <= maxSide px, quality stepped down from 0.85 until under 200 KB (CTO 14:04).
async function toJpeg(src, maxSide = MAX_IMG) {
  let c = scaled(src, maxSide);
  for (let attempt = 0; attempt < 4; attempt++) {
    let q = 0.85;
    let blob = await canvasToBlob(c, q);
    while (blob && blob.size >= MAX_BYTES && q > 0.35) {
      q = Math.round((q - 0.1) * 100) / 100;
      blob = await canvasToBlob(c, q);
    }
    if (blob && blob.size < MAX_BYTES) return { data: await blobToBase64(blob), w: c.width, h: c.height, bytes: blob.size };
    c = scaled(c, Math.round(Math.max(c.width, c.height) * 0.8));
  }
  throw new Error("jpeg");
}
const dataUrl = (img) => "data:image/jpeg;base64," + img.data;
function thumbDataUrl(src, side = 256) {
  const c = scaled(src, side);
  return c.toDataURL("image/jpeg", 0.8);
}
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const i = new Image();
    i.decoding = "async";
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("img"));
    i.src = src;
  });
}

// ---------- shared UI pieces ----------
function countsTable(checks, opts = {}) {
  const rows = checks.map((c) => html`<tr data-status="${c.status}"><th scope="row">${c.label}</th><td class="counts__value mono">${c.value}</td>${opts.noSpec ? raw("") : html`<td class="mono">${c.spec}</td>`}<td>${c.text}</td></tr>`);
  return html`<table class="counts"><caption class="visually-hidden">${opts.caption || "Measured counts"}</caption>
    <thead><tr><th scope="col">Item</th><th scope="col">Yours</th>${opts.noSpec ? raw("") : raw('<th scope="col">Spec</th>')}<th scope="col">Status</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}
function lockedRows(challenge) {
  const rows = (challenge.rubric || []).filter((l) => l.grader !== "measured").map((l) => l.grader === "observed"
    ? html`<li class="locked-row"><span>${l.title}</span> · <span class="chip chip--notscored">Noted, not scored</span></li>`
    : html`<li class="locked-row"><span>${l.title}</span> · weight ${l.weight} · <span class="chip chip--locked chip--ai">Graded by AI in the full review</span></li>`);
  return html`<section class="locked" aria-labelledby="rest-h"><h2 id="rest-h">Rest of the rubric</h2><ul class="locked-list">${rows}</ul></section>`;
}
function captureStrip(views, kind) {
  const items = views.map((v) => html`<li class="capture-strip__item" data-state="pending" data-view="${v}"><span class="visually-hidden">${altFor(v)}: pending</span></li>`);
  const n = views.length;
  const line = kind === "animation"
    ? "These " + n + " images and your frame facts are all we send."
    : "These " + n + " images and your counts are all we send. Your file stays here.";
  return html`<section class="capture" aria-labelledby="cap-h"><h3 id="cap-h">What a review sends</h3><ul class="capture-strip">${items}</ul><p class="muted">${line}</p></section>`;
}
function fillStrip(root, images) {
  for (const img of images) {
    const li = $('.capture-strip__item[data-view="' + img.view + '"]', root);
    if (!li) continue;
    setHTML(li, html`<a href="${dataUrl(img)}" target="_blank" rel="noopener"><img src="${dataUrl(img)}" alt="${altFor(img.view)}" width="${img.w}" height="${img.h}" decoding="async"></a>`);
    li.dataset.state = "ready";
  }
}
const isDeep = () => {
  const u = getUnlock();
  return !!(u && u.kind === "deep");
};

async function saveCapture(challengeId, rec) {
  if (!challengeId || challengeId === "checker") return;
  rec.created = new Date().toISOString();
  await idb.put(captureKey(challengeId), rec);
}

// ---------- entry points ----------
export async function startPreview(opts) {
  const { host, challengeId, mode, triage } = opts;
  const challenge = mode === "checker" ? null : await getChallenge(challengeId);
  if (mode !== "checker" && !challenge) throw new Error("challenge");
  host.innerHTML = "";
  if (triage.kind === "animation") return animationPreview(Object.assign({ challenge }, opts));
  return modelingPreview(Object.assign({ challenge }, opts));
}

// Restored from IndexedDB (U8, E30): the snapshots, counts and actions; no 3D (the file is gone).
export async function restorePreview(opts) {
  const { host, challengeId, capture, e30 } = opts;
  const challenge = await getChallenge(challengeId);
  if (!challenge) return;
  const kind = challenge.kind;
  const name = (capture.file && capture.file.name) || "your file";
  let table = raw("");
  let score = raw("");
  if (kind === "modeling") {
    if (capture.measured !== false && capture.counts) {
      const r = measuredTopology(capture.counts, challenge.spec);
      const line = measuredLine(challenge, { counts: capture.counts, measured: true });
      table = countsTable(r.checks);
      score = html`<p class="topology-score">Topology score: <strong>${line.points}</strong> / ${line.weight}</p>${r.misses.map((m) => html`<p class="miss">${m.text}</p>`)}`;
    } else {
      table = html`<p class="alert alert--tip">${COPY.E7row}</p>`;
    }
  } else if (capture.frames) {
    const r = measuredFrames(capture.frames, challenge.spec);
    table = countsTable(r.checks, { caption: "Frame facts" });
  }
  setHTML(host, html`<div class="preview preview--restored" data-kind="${kind}">
    ${e30 ? html`<p class="note" role="status">${e30}</p>` : raw("")}
    <h2 id="pv-h" tabindex="-1">Your file</h2>
    <p>Restored your last preview of ${name}. <button type="button" class="btn btn--text" data-act="choose">(Choose a different file)</button></p>
    <div class="preview__right">
      ${kind === "modeling" ? html`<section aria-labelledby="topo-h"><h2 id="topo-h">${kind === "modeling" ? "Topology, measured" : "Frame facts"} <span class="chip chip--measured">Measured by code · free</span></h2>${table}${score}</section>` : html`<section aria-labelledby="facts-h"><h2 id="facts-h">Frame facts <span class="chip chip--measured">Measured by code · free</span></h2>${table}</section>`}
      ${lockedRows(challenge)}
      ${captureStrip(capture.images.map((i) => i.view), kind)}
      <div class="actions"></div>
    </div>
  </div>`);
  fillStrip(host, capture.images);
  $('[data-act="choose"]', host).addEventListener("click", opts.chooseAgain);
  const tri = kind === "modeling" && capture.measured !== false && isTriangulated(capture.counts, challenge.spec);
  await mountActions(host, challenge, () => capture, { triangulated: tri, webgl: true, measured: capture.measured !== false, kind, steps: opts.steps });
  if (e30) focusEl($(".note", host));
}

async function mountActions(host, challenge, getCapture, flags) {
  const el = $(".actions", host);
  if (!el || !challenge || host.closest("[data-noactions]")) return null;
  const m = await import("./actions.js");
  return m.mountActions(el, challenge, getCapture, flags);
}

// ======================= MODELING =======================
async function parseObjInWorker(file, onProgress) {
  return new Promise((resolve) => {
    let w;
    try {
      w = new Worker(url("assets/obj-parser.worker.js"), { type: "module" });
    } catch (e) {
      resolve({ type: "error", code: "worker" });
      return;
    }
    w.onmessage = (ev) => {
      if (ev.data.type === "progress") { if (onProgress) onProgress(ev.data.text); return; }
      w.terminate();
      resolve(ev.data);
    };
    w.onerror = () => { w.terminate(); resolve({ type: "error", code: "worker" }); };
    w.postMessage({ file });
  });
}

async function modelingPreview(o) {
  const { host, challenge, triage, mode, onRefuse } = o;
  const file = triage.files[0];
  const checker = mode === "checker";
  const format = triage.format;
  let parsed = null;

  if (format === "obj") {
    announce("Counting faces...");
    const res = await parseObjInWorker(file);
    if (res.type === "error") {
      if (res.code === "too_many_faces") return onRefuse(esc(COPY.E11(res.faces, challenge && (challenge.spec.face_budget || challenge.spec.tri_budget))));
      return onRefuse(esc(COPY.E12));
    }
    parsed = res;
  }

  // three.js + WebGL
  let three = null;
  let webgl = true;
  try {
    three = await loadThree();
    const test = document.createElement("canvas");
    if (!(test.getContext("webgl2") || test.getContext("webgl"))) webgl = false;
  } catch (e) {
    webgl = false;
  }

  let object = null; // THREE.Object3D with the user's meshes
  let edgesGeom = null;
  if (webgl) {
    const { T } = three;
    try {
      if (parsed) {
        const geo = new T.BufferGeometry();
        geo.setAttribute("position", new T.BufferAttribute(parsed.positions, 3));
        geo.setIndex(new T.BufferAttribute(parsed.triangles, 1));
        geo.computeVertexNormals();
        object = new T.Mesh(geo);
        edgesGeom = new T.BufferGeometry();
        edgesGeom.setAttribute("position", new T.BufferAttribute(parsed.positions, 3));
        edgesGeom.setIndex(new T.BufferAttribute(parsed.edges, 1));
      } else {
        object = await loadOtherModel(T, file, format);
        if (object === "E8") return onRefuse(esc(COPY.E8));
        if (object === "E9") return onRefuse(esc(COPY.E9) + o.steps() + ".");
        if (!object) return onRefuse(esc(COPY.E12));
      }
    } catch (e) {
      if (format === "fbx") return onRefuse(esc(COPY.E9) + o.steps() + ".");
      if (format === "gltf" || format === "glb") return onRefuse(esc(COPY.E12));
      return onRefuse(esc(COPY.E12));
    }
  } else if (!parsed) {
    return onRefuse(esc(COPY.E13), { other: "Choose another file" });
  }

  const counts = parsed ? Object.assign({}, parsed.counts) : null;
  const spec = challenge ? challenge.spec : {};
  const dimSpec = challenge && Array.isArray(spec.dimensions) && spec.dimensions[0];
  const ext = (b) => (b ? [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]] : [0, 0, 0]);
  let bounds = counts ? counts.bounds : null;
  if (!bounds && object && three) {
    const box = new three.T.Box3().setFromObject(object);
    bounds = { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] };
  }
  const extents = ext(bounds);
  // units default from the bounds: whichever reading lands nearer the spec's middle (or < 5 units -> metres)
  let units = "m";
  if (dimSpec) {
    const axisIdx = { x: 0, y: 1, z: 2 }[dimSpec.axis] || 1;
    const mid = (dimSpec.min + dimSpec.max) / 2;
    const hv = extents[axisIdx];
    units = Math.abs(hv * 100 - mid) <= Math.abs(hv - mid) ? "m" : "cm";
  } else {
    units = Math.max(...extents) < 5 ? "m" : "cm";
  }
  const applyUnits = () => {
    if (!counts) return;
    const k = units === "m" ? 100 : 1;
    counts.units = units;
    counts.dims_cm = { x: Math.round(extents[0] * k * 100) / 100, y: Math.round(extents[1] * k * 100) / 100, z: Math.round(extents[2] * k * 100) / 100 };
  };
  applyUnits();
  const triangulated = !!(counts && challenge && isTriangulated(counts, spec));
  const measured = !!counts;
  const name = file.name;
  const views = checker ? [] : (challenge ? [...captureList(challenge, isDeep())] : []);

  const hasRef = await refReady(challenge);
  // ---- markup ----
  const notice = triage.notice ? html`<p class="alert alert--tip" role="status">${triage.notice}</p>` : raw("");
  const e7 = !checker && triage.notMeasured
    ? html`<div class="alert alert--tip" role="status"><p>${COPY.E7(format.toUpperCase())} ${raw(o.steps())}.</p></div>` : raw("");
  const e14 = triangulated ? html`<div class="alert alert--error" role="alert"><p>${COPY.E14} ${raw(o.steps())}.</p></div>` : raw("");
  const e13 = !webgl ? html`<div class="alert alert--error" role="alert"><p>${COPY.E13}</p></div>` : raw("");
  setHTML(host, html`<div class="preview" data-kind="modeling">
    <h2 id="pv-h" tabindex="-1">Your file</h2>
    <p class="preview__file">${name} · ${fmtSize(file.size)}</p>
    ${notice}${e13}${e7}${e14}
    <div class="preview__grid">
      <div class="preview__left">
        ${webgl ? html`<div class="viewport__controls">
          <div class="segmented" role="group" aria-label="View">
            <span class="segmented__thumb" aria-hidden="true"></span>
            <button type="button" class="segmented__btn" data-view="turntable" aria-pressed="true">Turntable</button>
            <button type="button" class="segmented__btn" data-view="wireframe" aria-pressed="false">Wireframe</button>
            ${checker ? raw("") : raw('<button type="button" class="segmented__btn" data-view="silhouette" aria-pressed="false">Silhouette</button>')}
          </div>
          <button type="button" class="btn btn--secondary btn--icon" data-act="pause">Pause</button>
          <button type="button" class="btn btn--secondary btn--icon" data-act="reset">Reset view</button>
        </div>
        <div class="viewport" data-view="turntable" data-state="loading">
          <div class="viewport__stage">
            <canvas class="viewport__canvas" tabindex="0" aria-label="3D preview of ${name}. Use the arrow keys to rotate."></canvas>
            <span class="viewport__caption viewport__caption--yours" hidden>Yours</span>
          </div>
          ${checker ? raw("") : html`<figure class="viewport__ref reference" hidden>${hasRef ? html`<img class="reference__img" src="${url(challenge.reference.svg)}" alt="${challenge.reference.alt}" width="${challenge.reference.width}" height="${challenge.reference.height}" decoding="async">` : html`<p class="muted">${challenge.reference.alt}</p>`}<figcaption class="viewport__caption">Reference</figcaption></figure>`}
        </div>` : raw("")}
      </div>
      <div class="preview__right">
        ${measured && !checker ? html`<p class="units"><label for="units-${challenge.id}">Units in your file</label>
          <select id="units-${challenge.id}" data-units>
            <option value="m"${units === "m" ? raw(" selected") : raw("")}>metres (Blender default)</option>
            <option value="cm"${units === "cm" ? raw(" selected") : raw("")}>centimetres (Maya default)</option>
          </select></p><p class="units__line" data-units-line></p>` : raw("")}
        ${checker && measured ? html`<p class="units"><label for="units-checker">Units in your file</label>
          <select id="units-checker" data-units>
            <option value="m"${units === "m" ? raw(" selected") : raw("")}>metres (Blender default)</option>
            <option value="cm"${units === "cm" ? raw(" selected") : raw("")}>centimetres (Maya default)</option>
          </select></p>` : raw("")}
        <section aria-labelledby="topo-h"><h2 id="topo-h">Topology, measured <span class="chip chip--measured">Measured by code · free</span></h2>
          <div data-counts></div>
        </section>
        ${checker ? html`<p><a class="btn btn--primary" href="${url("index.html#challenges")}">Pick a challenge</a> to get it graded against a brief.</p>` : lockedRows(challenge)}
        ${views.length && webgl ? captureStrip(views, "modeling") : raw("")}
        <p><button type="button" class="btn btn--text" data-act="choose">Choose a different file</button></p>
        <div class="actions"></div>
      </div>
    </div>
  </div>`);

  const root = $(".preview", host);
  $('[data-act="choose"]', root).addEventListener("click", o.chooseAgain);

  const renderCounts = () => {
    const box = $("[data-counts]", root);
    if (!counts) {
      setHTML(box, html`<table class="counts"><tbody><tr data-status="unmeasured"><th scope="row">Topology</th><td>${COPY.E7row}</td></tr></tbody></table>`);
      return;
    }
    if (checker) {
      const r = measuredTopology(counts, { max_nonmanifold: 0 });
      const size = html`<tr data-status="ok"><th scope="row">Size</th><td class="counts__value mono">${fmtDims(counts.dims_cm)}</td><td>Measured</td></tr>`;
      setHTML(box, html`${countsTable(r.checks, { noSpec: true })}`);
      $("tbody", box).insertAdjacentHTML("beforeend", size.__html);
      return;
    }
    const r = measuredTopology(counts, spec);
    const line = measuredLine(challenge, { counts, measured: true });
    const triNote = triangulated ? html`<p class="topology-score">Topology score: not scored (fully triangulated)</p>` : html`<p class="topology-score">Topology score: <strong>${line.points}</strong> / ${line.weight}</p>${r.misses.map((m) => html`<p class="miss">${m.text}</p>`)}`;
    setHTML(box, html`${countsTable(r.checks)}${triNote}`);
    const ul = $("[data-units-line]", root);
    if (ul && dimSpec) {
      const axisIdx = { x: 0, y: 1, z: 2 }[dimSpec.axis] || 1;
      const raw1 = Math.round(extents[axisIdx] * 1000) / 1000;
      ul.textContent = "Your model is " + raw1 + " units tall = " + counts.dims_cm[dimSpec.axis] + " cm. Spec: " + dimSpec.min + "-" + dimSpec.max + " " + (dimSpec.unit || "cm") + ".";
    }
  };
  renderCounts();

  let capture = null;
  const getCapture = () => capture;
  let viewer = null;
  if (webgl) {
    viewer = createViewer(three, root, object, edgesGeom, challenge, checker);
    host._dispose = () => viewer.dispose();
  }

  const unitsSel = $("[data-units]", root);
  if (unitsSel) {
    unitsSel.addEventListener("change", async () => {
      units = unitsSel.value;
      applyUnits();
      renderCounts();
      if (capture) {
        capture.counts = Object.assign({}, counts);
        await saveCapture(challenge && challenge.id, capture);
      }
    });
  }

  const faces = counts ? counts.faces : 0;
  focusEl($("#pv-h", root));
  if (counts) {
    const line = challenge ? measuredLine(challenge, { counts, measured: true }) : null;
    announce("Preview ready: " + fmtInt(faces) + " faces, " + fmtInt(counts.ngons) + " n-gons" + (line && line.points !== null && !triangulated ? ", topology " + line.points + " of " + line.weight : "") + ".");
  } else {
    announce("Preview ready.");
  }
  goal("preview", challenge ? challenge.id : "checker");

  if (checker || !webgl) {
    if (!checker) await mountActions(host, challenge, getCapture, { triangulated, webgl, measured, kind: "modeling", steps: o.steps });
    return;
  }

  // actions render at once (disabled until the capture is saved)
  const actions = mountActions(host, challenge, getCapture, { triangulated, webgl, measured, kind: "modeling", steps: o.steps, capturing: true });
  try {
    const deep = isDeep();
    const shots = await viewer.capture(views, deep ? (parsed ? parsed.marks : null) : null, (img) => fillStrip(root, [img]));
    const quick = [];
    for (const v of challenge ? captureListQuick(challenge) : []) {
      const src = shots.canvases[v];
      if (src) quick.push(Object.assign({ view: v }, await toJpeg(src, QUICK_PX)));
    }
    capture = {
      challenge_id: challenge.id,
      kind: "modeling",
      job: newJobId(),
      images: shots.images,
      quick,
      counts: counts ? Object.assign({}, counts) : null,
      measured,
      deep,
      thumb: shots.canvases.matcap_34 ? thumbDataUrl(shots.canvases.matcap_34) : "",
      file: { name, size: file.size },
    };
    await saveCapture(challenge.id, capture);
    const a = await actions;
    if (a && a.ready) a.ready();
    if (o.onCaptured) o.onCaptured(capture);
  } catch (e) {
    root.dataset.captureError = String((e && e.message) || e);
    const a = await actions;
    if (a && a.failed) a.failed(COPY.E13);
  }
}
function fmtDims(d) {
  if (!d) return "-";
  return d.x + " x " + d.y + " x " + d.z + " cm";
}
function captureList(challenge, deep) {
  const base = ["matcap_front", "matcap_34", "matcap_side", "matcap_top", "wire_front", "wire_34", "silhouette"];
  return deep ? base.concat(["closeup_1", "closeup_2", "closeup_3", "closeup_4", "closeup_5"]) : base;
}
function captureListQuick(challenge) {
  return challenge.kind === "animation" ? ["sheet_1", "sheet_2", "sheet_3"] : ["matcap_34", "wire_34", "silhouette"];
}

// GLB / glTF / FBX through the loaders (Draco / meshopt only when declared).
async function loadOtherModel(T, file, format) {
  const buf = await file.arrayBuffer();
  if (format === "fbx") {
    const { FBXLoader } = await import(V("addons/loaders/FBXLoader.js"));
    try {
      return new FBXLoader().parse(buf, "");
    } catch (e) {
      return "E9";
    }
  }
  const json = gltfJson(buf, format);
  if (!json) return null;
  if (format === "gltf") {
    const ext = (json.buffers || []).concat(json.images || []).some((b) => b.uri && !/^data:/.test(b.uri));
    if (ext) return "E8";
  }
  const used = json.extensionsUsed || [];
  const { GLTFLoader } = await import(V("addons/loaders/GLTFLoader.js"));
  const loader = new GLTFLoader();
  if (used.includes("KHR_draco_mesh_compression")) {
    const { DRACOLoader } = await import(V("addons/loaders/DRACOLoader.js"));
    const d = new DRACOLoader();
    d.setDecoderPath(V("addons/libs/draco/gltf/"));
    d.setDecoderConfig({ type: "wasm" });
    loader.setDRACOLoader(d);
  }
  if (used.includes("EXT_meshopt_compression")) {
    const { MeshoptDecoder } = await import(V("addons/libs/meshopt_decoder.module.js"));
    loader.setMeshoptDecoder(MeshoptDecoder);
  }
  const gltf = await new Promise((resolve, reject) => loader.parse(buf, "", resolve, reject));
  const root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
  if (root) root.userData.animations = gltf.animations || [];
  return root;
}
function gltfJson(buf, format) {
  try {
    if (format === "gltf") return JSON.parse(new TextDecoder().decode(buf));
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46546c67) return null;
    const len = dv.getUint32(12, true);
    return JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, len)));
  } catch (e) {
    return null;
  }
}

// ---------- the viewer: turntable, wireframe, silhouette; capture ----------
function createViewer(three, root, object, edgesGeom, challenge, checker) {
  const { T, OrbitControls } = three;
  const vp = $(".viewport", root);
  const canvas = $(".viewport__canvas", root);
  const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  const scene = new T.Scene();
  const bgTex = new T.CanvasTexture(makeViewportBackground(512));
  bgTex.colorSpace = T.SRGBColorSpace;
  const silBg = new T.Color("#eceae4");
  scene.background = bgTex;
  const matcapTex = new T.CanvasTexture(makeClayMatcap(256));
  matcapTex.colorSpace = T.SRGBColorSpace;
  const clay = new T.MeshMatcapMaterial({ matcap: matcapTex, side: T.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const wireBody = new T.MeshMatcapMaterial({ matcap: matcapTex, side: T.DoubleSide, color: new T.Color("#ffffff").lerp(new T.Color("#50555d"), 0.6), polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const silMat = new T.MeshBasicMaterial({ color: "#16181b", side: T.DoubleSide });

  // normalise: centre on the bounds, longest side = 2
  const pivot = new T.Group();
  const holder = new T.Group();
  pivot.add(holder);
  holder.add(object);
  const box = new T.Box3().setFromObject(object);
  const size = new T.Vector3();
  box.getSize(size);
  const center = new T.Vector3();
  box.getCenter(center);
  const k = 2 / Math.max(size.x, size.y, size.z, 1e-9);
  holder.scale.setScalar(k);
  holder.position.copy(center).multiplyScalar(-k);
  scene.add(pivot);
  const meshes = [];
  object.traverse((n) => { if (n.isMesh) meshes.push(n); });
  for (const m of meshes) m.material = clay;

  // polygon edges: from the OBJ parser (quads stay quads); EdgesGeometry for GLB / glTF / FBX
  const edgeObjs = [];
  const lineMat = new T.LineBasicMaterial({ color: "#eef1f5", transparent: true, opacity: 0.9 });
  if (edgesGeom) {
    const ls = new T.LineSegments(edgesGeom, lineMat);
    object.add(ls);
    edgeObjs.push(ls);
  } else {
    for (const m of meshes) {
      const ls = new T.LineSegments(new T.EdgesGeometry(m.geometry, 20), lineMat);
      m.add(ls);
      edgeObjs.push(ls);
    }
  }
  const edges = {
    get visible() { return edgeObjs.length ? edgeObjs[0].visible : false; },
    set visible(v) { for (const e of edgeObjs) e.visible = v; },
  };
  edges.visible = false;

  const sphereR = Math.sqrt((size.x * k) ** 2 + (size.y * k) ** 2 + (size.z * k) ** 2) / 2;
  const camera = new T.PerspectiveCamera(35, 1, 0.01, 100);
  const dist = (sphereR / Math.sin(T.MathUtils.degToRad(35 / 2))) * 1.08;
  const controls = new OrbitControls(camera, canvas);
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.enableDamping = false;
  canvas.style.touchAction = "pan-y";

  const setDir = (cam, az, el, d) => {
    const a = T.MathUtils.degToRad(az), e = T.MathUtils.degToRad(el);
    cam.position.set(Math.sin(a) * Math.cos(e) * d, Math.sin(e) * d, Math.cos(a) * Math.cos(e) * d);
    cam.up.set(0, 1, 0);
    if (Math.abs(el) > 89) cam.up.set(0, 0, -1);
    cam.lookAt(0, 0, 0);
  };
  const reset = () => {
    setDir(camera, 45, 20, dist);
    controls.target.set(0, 0, 0);
    controls.update();
    pivot.rotation.y = 0;
  };
  reset();

  let view = "turntable";
  const applyView = (v) => {
    view = v;
    vp.dataset.view = v;
    for (const b of $$(".segmented__btn", root)) b.setAttribute("aria-pressed", String(b.dataset.view === v));
    const ref = $(".viewport__ref", root);
    const yours = $(".viewport__caption--yours", root);
    if (v === "silhouette") {
      for (const m of meshes) m.material = silMat;
      edges.visible = false;
      scene.background = silBg;
      setDir(camera, 0, 0, dist);
      controls.update();
      pivot.rotation.y = 0;
      setPlaying(false, true);
      if (ref) ref.hidden = false;
      if (yours) yours.hidden = false;
    } else {
      for (const m of meshes) m.material = v === "wireframe" ? wireBody : clay;
      edges.visible = v === "wireframe";
      scene.background = bgTex;
      if (ref) ref.hidden = true;
      if (yours) yours.hidden = true;
    }
    resize();
    render();
  };
  for (const b of $$(".segmented__btn", root)) b.addEventListener("click", () => applyView(b.dataset.view));

  // turntable: 30 deg/s, spin-up 800 ms, resume 1.5 s after a drag
  let playing = false;
  let speed = 0;
  let spinStart = 0;
  let last = 0;
  let idleTimer = null;
  let dragging = false;
  const pauseBtn = $('[data-act="pause"]', root);
  const loop = (t) => {
    const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
    last = t;
    if (playing && !dragging) {
      const ramp = reducedMotion() ? 1 : Math.min(1, (t - spinStart) / 800);
      speed = T.MathUtils.degToRad(30) * (1 - Math.pow(1 - ramp, 3));
      pivot.rotation.y += speed * dt;
    }
    renderer.render(scene, camera);
  };
  function setPlaying(p, silent) {
    playing = p;
    vp.dataset.state = p ? "playing" : "paused";
    if (pauseBtn) pauseBtn.textContent = p ? "Pause" : "Play";
    if (p) {
      spinStart = performance.now();
      last = 0;
      renderer.setAnimationLoop(loop);
    } else {
      renderer.setAnimationLoop(null);
      render();
    }
    if (!silent) announce(p ? "Turntable playing" : "Turntable paused");
  }
  if (pauseBtn) pauseBtn.addEventListener("click", () => {
    if (view === "silhouette" && !playing) applyView("turntable");
    setPlaying(!playing);
  });
  $('[data-act="reset"]', root).addEventListener("click", () => { reset(); render(); });
  let wasPlaying = false;
  controls.addEventListener("start", () => {
    dragging = true;
    wasPlaying = playing;
    if (idleTimer) clearTimeout(idleTimer);
    if (!playing) renderer.setAnimationLoop(loop);
  });
  controls.addEventListener("end", () => {
    dragging = false;
    if (!playing) renderer.setAnimationLoop(null);
    if (wasPlaying && !reducedMotion()) idleTimer = setTimeout(() => { if (playing) spinStart = performance.now(); }, 1500);
    render();
  });
  controls.addEventListener("change", () => { if (!playing) render(); });
  canvas.addEventListener("keydown", (e) => {
    const off = camera.position.clone().sub(controls.target);
    const sph = new T.Spherical().setFromVector3(off);
    let used = true;
    if (e.key === "ArrowLeft") sph.theta -= 0.15;
    else if (e.key === "ArrowRight") sph.theta += 0.15;
    else if (e.key === "ArrowUp") sph.phi = Math.max(0.1, sph.phi - 0.15);
    else if (e.key === "ArrowDown") sph.phi = Math.min(Math.PI - 0.1, sph.phi + 0.15);
    else if (e.key === "+" || e.key === "=") sph.radius = Math.max(dist * 0.35, sph.radius * 0.9);
    else if (e.key === "-" || e.key === "_") sph.radius = Math.min(dist * 2.5, sph.radius * 1.1);
    else used = false;
    if (used) {
      e.preventDefault();
      camera.position.setFromSpherical(sph).add(controls.target);
      camera.lookAt(controls.target);
      controls.update();
      render();
    }
  });

  function render() { renderer.render(scene, camera); }
  function resize() {
    const stage = $(".viewport__stage", root);
    const w = Math.max(1, stage.clientWidth);
    const h = Math.max(1, stage.clientHeight || w);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  }
  const ro = new ResizeObserver(resize);
  ro.observe($(".viewport__stage", root));
  resize();
  vp.dataset.state = "ready";
  setPlaying(!reducedMotion(), true);
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  const onMq = () => { if (mq.matches && playing) setPlaying(false, true); };
  if (mq.addEventListener) mq.addEventListener("change", onMq);

  // ---- capture: 7 (Deep 12) JPEGs at 1024 px ----
  async function capture(viewList, marks, onEach) {
    const c = document.createElement("canvas");
    c.width = c.height = MAX_IMG;
    const r2 = new T.WebGLRenderer({ canvas: c, antialias: true, preserveDrawingBuffer: true });
    r2.setPixelRatio(1);
    r2.setSize(MAX_IMG, MAX_IMG, false);
    const cam = new T.PerspectiveCamera(35, 1, 0.01, 100);
    const savedRot = pivot.rotation.y;
    const savedMats = meshes.map((m) => m.material);
    const savedEdges = edges.visible;
    const savedBg = scene.background;
    pivot.rotation.y = 0;
    const images = [];
    const canvases = {};
    const shot = (setup) => {
      setup();
      r2.render(scene, cam);
      const out = document.createElement("canvas");
      out.width = c.width;
      out.height = c.height;
      out.getContext("2d").drawImage(c, 0, 0);
      return out;
    };
    const look = (mat, showEdges, bg) => () => {
      for (const m of meshes) m.material = mat;
      edges.visible = showEdges;
      scene.background = bg;
    };
    const closeups = marks ? pickCloseups(T, marks, holder) : [];
    try {
      for (const v of viewList) {
        let cv = null;
        if (v === "matcap_front") cv = shot(() => { look(clay, false, bgTex)(); setDir(cam, 0, 0, dist); });
        else if (v === "matcap_34") cv = shot(() => { look(clay, false, bgTex)(); setDir(cam, 45, 20, dist); });
        else if (v === "matcap_side") cv = shot(() => { look(clay, false, bgTex)(); setDir(cam, 90, 0, dist); });
        else if (v === "matcap_top") cv = shot(() => { look(clay, false, bgTex)(); setDir(cam, 0, 90, dist); });
        else if (v === "wire_front") cv = shot(() => { look(wireBody, true, bgTex)(); setDir(cam, 0, 0, dist); });
        else if (v === "wire_34") cv = shot(() => { look(wireBody, true, bgTex)(); setDir(cam, 45, 20, dist); });
        else if (v === "silhouette") {
          const sil = shot(() => { look(silMat, false, silBg)(); setDir(cam, 0, 0, dist); });
          cv = await silhouetteSheet(sil, challenge);
        } else if (/^closeup_/.test(v)) {
          const i = parseInt(v.split("_")[1], 10) - 1;
          const target = closeups[i] || closeups[0] || new T.Vector3();
          cv = shot(() => {
            look(wireBody, true, bgTex)();
            const dir = target.clone().normalize();
            if (dir.lengthSq() < 1e-6) dir.set(0.5, 0.4, 1).normalize();
            cam.position.copy(target).add(dir.multiplyScalar(dist * 0.35));
            cam.up.set(0, 1, 0);
            cam.lookAt(target);
          });
        }
        if (!cv) continue;
        canvases[v] = cv;
        const img = Object.assign({ view: v }, await toJpeg(cv, MAX_IMG));
        images.push(img);
        if (onEach) onEach(img);
      }
    } finally {
      meshes.forEach((m, i) => { m.material = savedMats[i]; });
      edges.visible = savedEdges;
      scene.background = savedBg;
      pivot.rotation.y = savedRot;
      r2.dispose();
      render();
    }
    return { images, canvases };
  }

  return {
    capture,
    dispose() {
      renderer.setAnimationLoop(null);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      if (mq.removeEventListener) mq.removeEventListener("change", onMq);
    },
  };
}

// Close-up targets for Deep: n-gon and pole clusters first, then spread vertices (in holder space -> world).
function pickCloseups(T, marks, holder) {
  const pts = [];
  holder.updateMatrixWorld(true);
  const toWorld = (p) => new T.Vector3(p[0], p[1], p[2]).applyMatrix4(holder.matrixWorld);
  for (const p of (marks.ngons || []).concat(marks.poles5 || [])) pts.push(toWorld(p));
  const chosen = [];
  for (const p of pts) {
    if (chosen.length >= 5) break;
    if (chosen.every((c) => c.distanceTo(p) > 0.35)) chosen.push(p);
  }
  const fallback = [[0.6, 0.3, 0.6], [-0.6, 0.3, 0.6], [0, -0.6, 0.7], [0.7, 0, -0.5], [-0.5, 0.6, -0.5]];
  for (const f of fallback) {
    if (chosen.length >= 5) break;
    chosen.push(new T.Vector3(f[0], f[1], f[2]));
  }
  return chosen;
}

// Capture image 7: the user's silhouette beside the reference drawing, captioned, 1024 x 512.
async function silhouetteSheet(sil, challenge) {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 512;
  const g = c.getContext("2d");
  g.fillStyle = "#eceae4";
  g.fillRect(0, 0, 1024, 512);
  g.drawImage(sil, 0, 0, sil.width, sil.height, 0, 0, 512, 512);
  let drew = false;
  if (challenge && challenge.reference && challenge.reference.svg && (await refReady(challenge))) {
    try {
      const img = await loadImage(url(challenge.reference.svg));
      const s = Math.min(472 / (img.naturalWidth || 472), 472 / (img.naturalHeight || 472));
      const w = (img.naturalWidth || 472) * s, h = (img.naturalHeight || 472) * s;
      g.drawImage(img, 512 + (512 - w) / 2, (512 - h) / 2, w, h);
      drew = true;
    } catch (e) { drew = false; }
  }
  if (!drew) {
    g.fillStyle = "#57606a";
    g.font = "24px system-ui, sans-serif";
    g.textAlign = "center";
    g.fillText("Reference: see the brief", 768, 256);
  }
  g.strokeStyle = "#c9c6bf";
  g.beginPath();
  g.moveTo(512, 16);
  g.lineTo(512, 496);
  g.stroke();
  caption(g, "Yours", 12, 12);
  caption(g, "Reference", 524, 12);
  return c;
}
function caption(g, text, x, y) {
  g.font = "600 22px system-ui, -apple-system, Segoe UI, sans-serif";
  const w = g.measureText(text).width + 16;
  g.fillStyle = "rgba(27,29,33,0.92)";
  g.fillRect(x, y, w, 34);
  g.fillStyle = "#ffffff";
  g.textAlign = "left";
  g.textBaseline = "middle";
  g.fillText(text, x + 8, y + 17);
}

// ======================= ANIMATION =======================
const COMMON_FPS = [12, 15, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
const snapFps = (f) => {
  let best = f, d = Infinity;
  for (const c of COMMON_FPS) {
    const dd = Math.abs(c - f) / c;
    if (dd < d) { d = dd; best = c; }
  }
  return d < 0.04 ? best : Math.round(f * 100) / 100;
};

function sampleFrames(total, keyFrames, n) {
  n = Math.min(n, total);
  const set = new Set();
  for (const f of keyFrames) set.add(Math.max(1, Math.min(total, Math.round(f))));
  const list = [...set].slice(0, n);
  const out = new Set(list);
  for (let k = 0; out.size < n && k < n * 4; k++) {
    const steps = n + k;
    for (let i = 0; i < steps && out.size < n; i++) {
      const f = Math.round(1 + (i * (total - 1)) / Math.max(1, steps - 1));
      out.add(f);
    }
  }
  return [...out].sort((a, b) => a - b);
}

async function animationPreview(o) {
  const { host, challenge, triage, onRefuse } = o;
  const spec = challenge.spec;
  const deep = isDeep();
  const nSample = deep ? 24 : 12;
  const nKeys = deep ? 6 : 4;
  const files = triage.files;
  const name = files.length > 1 ? files[0].name + " and " + (files.length - 1) + " more frames" : files[0].name;
  const range = "1-" + spec.frames_max;

  // ---- open the source ----
  let src;
  try {
    if (triage.format === "video") src = await openVideo(files[0], spec);
    else if (triage.format === "sequence") src = await openSequence(files, spec);
    else src = await openClip(files[0], triage.format, spec);
  } catch (e) {
    const code = e && e.message;
    if (code === "E17") return onRefuse(esc(COPY.E17len(Math.round(e.secs), range)));
    if (code === "E15") return onRefuse(esc(COPY.E15anim) + ' <a href="' + esc(url("challenges/low-poly-mug.html")) + '">(Open a modeling challenge)</a>');
    if (code === "E9") return onRefuse(esc(COPY.E9) + o.steps() + ".");
    if (code === "E8") return onRefuse(esc(COPY.E8));
    if (code === "E13") return onRefuse(esc(COPY.E13));
    if (code === "E18") return onRefuse(esc(COPY.E18sort), { other: "Choose other files" });
    return onRefuse(esc(COPY.E16) + o.steps() + ".");
  }
  announce("Sampling " + nSample + " frames...");

  let fps = src.fps;
  let fpsAssumed = src.fpsAssumed;
  const keyDefs = (spec.key_pose_times || []).slice(0, nKeys);
  let state = null; // {total, frames: [{f, t, canvas}], keys: [indices into frames]}

  const computeTotal = () => (src.kind === "sequence" ? src.count : Math.max(1, Math.round(src.duration * fps)));
  async function sample() {
    const total = computeTotal();
    const list = sampleFrames(total, keyDefs.map((k) => k.frame), nSample);
    const frames = [];
    let i = 0;
    for (const f of list) {
      i++;
      announce("Sampling frame " + i + " of " + list.length);
      const t = (f - 1) / fps;
      const canvas = await src.frameAt(f, t);
      frames.push({ f, t, canvas });
    }
    const keys = [];
    for (const k of keyDefs) {
      const target = Math.max(1, Math.min(total, k.frame));
      let bi = 0, bd = Infinity;
      frames.forEach((fr, idx) => {
        const d = Math.abs(fr.f - target);
        if (d < bd && !keys.includes(idx)) { bd = d; bi = idx; }
      });
      keys.push(bi);
    }
    while (keys.length < nKeys && keys.length < frames.length) {
      const idx = frames.findIndex((_, j) => !keys.includes(j));
      keys.push(idx);
    }
    state = { total, frames, keys };
  }
  try {
    await sample();
  } catch (e) {
    return onRefuse(esc(COPY.E16) + o.steps() + ".");
  }
  if (src.duration > 30.05) return onRefuse(esc(COPY.E17len(Math.round(src.duration), range)));

  const facts = () => ({
    source: src.kind,
    duration: Math.round((src.kind === "sequence" ? state.total / fps : src.duration) * 1000) / 1000,
    fps,
    fps_assumed: !!fpsAssumed,
    frames: state.total,
    width: src.width,
    height: src.height,
    sampled: state.frames.map((x) => x.f),
    keys: state.keys.map((i) => state.frames[i].f),
  });

  const nSheets = deep ? 6 : 3;
  const views = [];
  for (let i = 1; i <= nSheets; i++) views.push("sheet_" + i);
  for (let i = 1; i <= nKeys; i++) views.push("pose_" + i);

  setHTML(host, html`<div class="preview" data-kind="animation">
    <h2 id="pv-h" tabindex="-1">Your file</h2>
    <p class="preview__file">${name}</p>
    ${triage.notice ? html`<p class="alert alert--tip" role="status">${triage.notice}</p>` : raw("")}
    <section aria-labelledby="facts-h"><h2 id="facts-h">Frame facts <span class="chip chip--measured">Measured by code · free</span></h2>
      <div data-facts></div>
      <p class="units"><label for="fps-${challenge.id}">Frame rate${fpsAssumed ? " (we couldn't read it from the file; set yours)" : ""}</label>
        <select id="fps-${challenge.id}" data-fps>${COMMON_FPS.map((f) => html`<option value="${f}"${Math.abs(f - fps) < 0.01 ? raw(" selected") : raw("")}>${f} fps</option>`)}${COMMON_FPS.some((f) => Math.abs(f - fps) < 0.01) ? raw("") : html`<option value="${fps}" selected>${fps} fps</option>`}</select></p>
    </section>
    <section aria-labelledby="spacing-h"><h3 id="spacing-h">Spacing</h3><div class="spacing-strip" tabindex="0" role="group" aria-label="Spacing strip: ${nSample} sampled frames"></div></section>
    <section aria-labelledby="keys-h"><h3 id="keys-h">Key poses (sent full size)</h3><div class="keyposes"></div><div class="keypose-picker" hidden></div></section>
    <section aria-labelledby="sheets-h"><h3 id="sheets-h">Contact sheets</h3><div class="contact-sheets"></div></section>
    ${captureStrip(views, "animation")}
    ${lockedRows(challenge)}
    <p><button type="button" class="btn btn--text" data-act="choose">Choose a different file</button></p>
    <div class="actions"></div>
  </div>`);
  const root = $(".preview", host);
  $('[data-act="choose"]', root).addEventListener("click", o.chooseAgain);

  const renderFacts = () => {
    const r = measuredFrames(facts(), spec);
    setHTML($("[data-facts]", root), countsTable(r.checks, { caption: "Frame facts" }));
    const specLine = document.createElement("p");
    specLine.textContent = "Spec: " + spec.frames_min + "-" + spec.frames_max + " frames at " + spec.fps + " fps.";
    $("[data-facts]", root).appendChild(specLine);
    for (const m of r.misses) {
      const p = document.createElement("p");
      p.className = "miss";
      p.textContent = m.text;
      $("[data-facts]", root).appendChild(p);
    }
  };
  const fmtT = (t) => (Math.round(t * 100) / 100).toFixed(2);
  const thumbs = new Map();
  const thumbOf = (fr) => {
    if (!thumbs.has(fr)) thumbs.set(fr, scaled(fr.canvas, 160).toDataURL("image/jpeg", 0.7));
    return thumbs.get(fr);
  };
  const renderStrip = () => {
    const strip = $(".spacing-strip", root);
    setHTML(strip, html`${state.frames.map((fr) => html`<figure class="spacing-strip__item"><img src="${thumbOf(fr)}" alt="Frame ${fr.f}, ${fmtT(fr.t)} s" width="160" height="${Math.round(160 * fr.canvas.height / fr.canvas.width)}"><figcaption class="mono">${fr.f} · ${fmtT(fr.t)} s</figcaption></figure>`)}`);
  };
  let picking = -1;
  const renderKeys = () => {
    const box = $(".keyposes", root);
    setHTML(box, html`${state.keys.map((idx, i) => {
      const fr = state.frames[idx];
      return html`<button type="button" class="keypose" data-slot="${i}" aria-haspopup="listbox" aria-expanded="${picking === i ? "true" : "false"}"><img src="${thumbOf(fr)}" alt="" width="160" height="${Math.round(160 * fr.canvas.height / fr.canvas.width)}"><span>Key pose ${i + 1}: frame ${fr.f} (${fmtT(fr.t)} s). Change</span></button>`;
    })}`);
    for (const b of $$(".keypose", box)) b.addEventListener("click", () => openPicker(parseInt(b.dataset.slot, 10)));
  };
  const openPicker = (slot) => {
    picking = slot;
    const pk = $(".keypose-picker", root);
    const cur = state.keys[slot];
    setHTML(pk, html`<p id="pick-l">Choose the frame for key pose ${slot + 1}</p><ul role="listbox" tabindex="0" aria-labelledby="pick-l" aria-activedescendant="opt-${cur}">${state.frames.map((fr, i) => html`<li role="option" id="opt-${i}" class="keypose-option" data-i="${i}" aria-selected="${i === cur ? "true" : "false"}"><img src="${thumbOf(fr)}" alt="" width="96" height="${Math.round(96 * fr.canvas.height / fr.canvas.width)}"><span>Frame ${fr.f}, ${fmtT(fr.t)} s</span></li>`)}</ul>`);
    pk.hidden = false;
    renderKeys();
    const lb = $("[role=listbox]", pk);
    let active = cur;
    const setActive = (i) => {
      active = (i + state.frames.length) % state.frames.length;
      lb.setAttribute("aria-activedescendant", "opt-" + active);
      for (const li of $$("[role=option]", lb)) li.classList.toggle("is-active", parseInt(li.dataset.i, 10) === active);
      const li = $("#opt-" + active, lb);
      if (li) li.scrollIntoView({ block: "nearest", inline: "nearest" });
    };
    setActive(cur);
    lb.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
      else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(active); }
      else if (e.key === "Escape") { e.preventDefault(); closePicker(); }
    });
    for (const li of $$("[role=option]", lb)) li.addEventListener("click", () => choose(parseInt(li.dataset.i, 10)));
    lb.focus();
  };
  const closePicker = () => {
    const slot = picking;
    picking = -1;
    $(".keypose-picker", root).hidden = true;
    renderKeys();
    const b = $('.keypose[data-slot="' + slot + '"]', root);
    if (b) b.focus();
  };
  const choose = async (i) => {
    const slot = picking;
    const other = state.keys.indexOf(i);
    if (other !== -1 && other !== slot) state.keys[other] = state.keys[slot];
    state.keys[slot] = i;
    closePicker();
    await recapture();
  };

  let capture = null;
  const getCapture = () => capture;
  let actions = null;
  async function recapture() {
    for (const li of $$(".capture-strip__item", root)) { li.dataset.state = "pending"; li.innerHTML = '<span class="visually-hidden">pending</span>'; }
    const sheets = buildSheets(state, nSheets);
    const sheetBox = $(".contact-sheets", root);
    setHTML(sheetBox, html`${sheets.map((s, i) => {
      const a = state.frames.slice(i * 4, i * 4 + 4).map((x) => x.f);
      return html`<img class="contact-sheet" src="${s.toDataURL("image/jpeg", 0.8)}" alt="Contact sheet ${i + 1} of ${nSheets}: frames ${a.length ? a[0] + "-" + a[a.length - 1] : ""}" width="${s.width}" height="${s.height}">`;
    })}`);
    const images = [];
    const canv = {};
    for (let i = 0; i < sheets.length; i++) {
      const v = "sheet_" + (i + 1);
      canv[v] = sheets[i];
      const img = Object.assign({ view: v }, await toJpeg(sheets[i], MAX_IMG));
      images.push(img);
      fillStrip(root, [img]);
    }
    for (let i = 0; i < state.keys.length; i++) {
      const v = "pose_" + (i + 1);
      const img = Object.assign({ view: v }, await toJpeg(state.frames[state.keys[i]].canvas, MAX_IMG));
      images.push(img);
      fillStrip(root, [img]);
    }
    const quick = [];
    for (const v of ["sheet_1", "sheet_2", "sheet_3"]) if (canv[v]) quick.push(Object.assign({ view: v }, await toJpeg(canv[v], QUICK_PX)));
    capture = {
      challenge_id: challenge.id,
      kind: "animation",
      job: newJobId(),
      images,
      quick,
      frames: facts(),
      measured: true,
      deep,
      thumb: thumbDataUrl(state.frames[state.keys[0]].canvas),
      file: { name, size: files.reduce((s, f) => s + f.size, 0) },
    };
    await saveCapture(challenge.id, capture);
    if (actions && actions.ready) actions.ready();
    if (o.onCaptured) o.onCaptured(capture);
  }

  $("[data-fps]", root).addEventListener("change", async (e) => {
    fps = parseFloat(e.target.value) || spec.fps;
    fpsAssumed = true;
    try { await sample(); } catch (err) { return; }
    thumbs.clear();
    renderFacts();
    renderStrip();
    renderKeys();
    await recapture();
  });

  renderFacts();
  renderStrip();
  renderKeys();
  focusEl($("#pv-h", root));
  announce("Preview ready: " + state.total + " frames at " + fps + " fps.");
  goal("preview", challenge.id);
  actions = await mountActions(host, challenge, getCapture, { triangulated: false, webgl: true, measured: true, kind: "animation", steps: o.steps, capturing: true });
  try {
    await recapture();
  } catch (e) {
    if (actions && actions.failed) actions.failed(COPY.E16);
  }
  host._dispose = () => { if (src.dispose) src.dispose(); };
}

// 2 x 2 contact sheets, 512 px cells, frame number and time stamped; key poses outlined.
function buildSheets(state, nSheets) {
  const out = [];
  const fr0 = state.frames[0].canvas;
  const cellW = 512;
  const cellH = Math.max(1, Math.round((cellW * fr0.height) / fr0.width));
  for (let s = 0; s < nSheets; s++) {
    const c = document.createElement("canvas");
    c.width = cellW * 2;
    c.height = cellH * 2;
    const g = c.getContext("2d");
    g.fillStyle = "#24272b";
    g.fillRect(0, 0, c.width, c.height);
    for (let k = 0; k < 4; k++) {
      const idx = s * 4 + k;
      const fr = state.frames[idx];
      if (!fr) continue;
      const x = (k % 2) * cellW, y = Math.floor(k / 2) * cellH;
      g.drawImage(fr.canvas, x, y, cellW, cellH);
      const label = "f" + fr.f + " · " + (Math.round(fr.t * 100) / 100).toFixed(2) + " s";
      g.font = "600 20px ui-monospace, Consolas, Menlo, monospace";
      const w = g.measureText(label).width + 14;
      g.fillStyle = "rgba(27,29,33,0.92)";
      g.fillRect(x + 6, y + cellH - 36, w, 30);
      g.fillStyle = "#ffffff";
      g.textBaseline = "middle";
      g.fillText(label, x + 13, y + cellH - 21);
      if (state.keys.includes(idx)) {
        g.strokeStyle = "#93a8ff";
        g.lineWidth = 4;
        g.strokeRect(x + 2, y + 2, cellW - 4, cellH - 4);
      }
    }
    out.push(c);
  }
  return out;
}

function frameCanvas(w, h) {
  const s = Math.min(1, MAX_IMG / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  return c;
}

async function openVideo(file, spec) {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  const src = URL.createObjectURL(file);
  v.src = src;
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("E16")), 10000);
    v.onloadeddata = () => { clearTimeout(t); resolve(); };
    v.onerror = () => { clearTimeout(t); reject(new Error("E16")); };
  });
  if (!v.videoWidth || !v.videoHeight || !isFinite(v.duration)) throw new Error("E16");
  if (v.duration > 30.05) {
    const e = new Error("E17");
    e.secs = v.duration;
    throw e;
  }
  // frame rate from requestVideoFrameCallback while playing a moment, else the spec's (user can change it)
  let fps = 0;
  if ("requestVideoFrameCallback" in v) {
    fps = await new Promise((resolve) => {
      const times = [];
      let done = false;
      const finish = (val) => { if (!done) { done = true; v.pause(); resolve(val); } };
      const t = setTimeout(() => finish(0), 1500);
      const cb = (_now, meta) => {
        times.push(meta.mediaTime);
        if (times.length >= 10) {
          clearTimeout(t);
          const d = [];
          for (let i = 1; i < times.length; i++) if (times[i] > times[i - 1]) d.push(times[i] - times[i - 1]);
          d.sort((a, b) => a - b);
          const med = d[Math.floor(d.length / 2)];
          finish(med ? 1 / med : 0);
        } else v.requestVideoFrameCallback(cb);
      };
      v.requestVideoFrameCallback(cb);
      v.play().catch(() => finish(0));
    });
  }
  const assumed = !(fps > 5 && fps < 121);
  fps = assumed ? spec.fps : snapFps(fps);
  const seek = (t) => new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("E16")), 5000);
    v.onseeked = () => { clearTimeout(to); resolve(); };
    v.currentTime = t;
  });
  return {
    kind: "video",
    duration: v.duration,
    fps,
    fpsAssumed: assumed,
    width: v.videoWidth,
    height: v.videoHeight,
    async frameAt(f, t) {
      const tt = Math.min(Math.max(0, t + 0.5 / fps), Math.max(0, v.duration - 0.001));
      await seek(tt);
      const c = frameCanvas(v.videoWidth, v.videoHeight);
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      return c;
    },
    dispose() { URL.revokeObjectURL(src); v.removeAttribute("src"); v.load(); },
  };
}

async function openSequence(files, spec) {
  let first;
  try {
    first = await createImageBitmap(files[0]);
  } catch (e) {
    throw new Error("E18");
  }
  const w = first.width, h = first.height;
  first.close && first.close();
  return {
    kind: "sequence",
    count: files.length,
    duration: files.length / spec.fps,
    fps: spec.fps,
    fpsAssumed: true,
    width: w,
    height: h,
    async frameAt(f) {
      const bmp = await createImageBitmap(files[Math.max(0, Math.min(files.length - 1, f - 1))]);
      const c = frameCanvas(w, h);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close && bmp.close();
      return c;
    },
  };
}

// glTF / GLB / FBX animation clips: AnimationMixer, fixed side camera, rendered at <= 1024 px.
async function openClip(file, format, spec) {
  let three;
  try {
    three = await loadThree();
  } catch (e) {
    throw new Error("E13");
  }
  const { T } = three;
  const test = document.createElement("canvas");
  if (!(test.getContext("webgl2") || test.getContext("webgl"))) throw new Error("E13");
  let root;
  try {
    root = await loadOtherModel(T, file, format);
  } catch (e) {
    throw new Error(format === "fbx" ? "E9" : "E16");
  }
  if (root === "E8" || root === "E9") throw new Error(root);
  const clips = (root && (root.animations && root.animations.length ? root.animations : root.userData.animations)) || [];
  if (!root || !clips.length) throw new Error("E15");
  const clip = clips[0];
  const duration = clip.duration;
  if (duration > 30.05) {
    const e = new Error("E17");
    e.secs = duration;
    throw e;
  }
  const scene = new T.Scene();
  scene.background = new T.CanvasTexture(makeViewportBackground(512));
  scene.background.colorSpace = T.SRGBColorSpace;
  const tex = new T.CanvasTexture(makeClayMatcap(256));
  tex.colorSpace = T.SRGBColorSpace;
  const mat = new T.MeshMatcapMaterial({ matcap: tex, side: T.DoubleSide });
  root.traverse((n) => { if (n.isMesh) n.material = mat; });
  scene.add(root);
  const mixer = new T.AnimationMixer(root);
  mixer.clipAction(clip).play();
  // frame the whole motion: union of bounds at 8 times
  const box = new T.Box3();
  for (let i = 0; i <= 8; i++) {
    mixer.setTime((duration * i) / 8);
    root.updateMatrixWorld(true);
    box.union(new T.Box3().setFromObject(root));
  }
  const size = new T.Vector3();
  box.getSize(size);
  const center = new T.Vector3();
  box.getCenter(center);
  const w = 1024, h = 576;
  const cam = new T.PerspectiveCamera(35, w / h, 0.01, 1000);
  const span = Math.max(size.x / (w / h), size.y) * 1.25;
  const d = span / 2 / Math.tan(T.MathUtils.degToRad(35 / 2)) + size.z;
  cam.position.set(center.x, center.y, center.z + d);
  cam.lookAt(center);
  cam.near = d / 100;
  cam.far = d * 10;
  cam.updateProjectionMatrix();
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const r = new T.WebGLRenderer({ canvas: c, antialias: true, preserveDrawingBuffer: true });
  r.setPixelRatio(1);
  r.setSize(w, h, false);
  return {
    kind: "clip",
    duration,
    fps: spec.fps,
    fpsAssumed: true,
    width: w,
    height: h,
    async frameAt(f, t) {
      mixer.setTime(Math.min(t, duration));
      r.render(scene, cam);
      const out = document.createElement("canvas");
      out.width = w;
      out.height = h;
      out.getContext("2d").drawImage(c, 0, 0);
      return out;
    },
    dispose() { r.dispose(); },
  };
}

