// CritPass shared scorer. Pure ES module: no DOM, no imports, no I/O.
// The browser and the Worker run this same file (tools/build.mjs copies it to
// worker/src/shared/rubric.js), so "Topology, measured", the weighted total, the
// letter and PASS / NOT YET are computed identically on both sides.

export const PASS_BAR = 80;

// Letter table. B (80) is the default pass bar; B- (77-79) is NOT YET.
export const LETTERS = [
  [97, "A+"], [93, "A"], [90, "A-"],
  [84, "B+"], [80, "B"], [77, "B-"],
  [74, "C+"], [70, "C"], [67, "C-"],
  [64, "D+"], [60, "D"], [55, "D-"],
  [0, "F"],
];
export const BANDS = LETTERS.map((l) => l[1]);

export function letterFor(total) {
  const t = Math.max(0, Math.min(100, Math.round(Number(total) || 0)));
  for (const [min, letter] of LETTERS) if (t >= min) return letter;
  return "F";
}

export function passBar(challenge) {
  const b = challenge && Number(challenge.pass_bar);
  return Number.isFinite(b) && b > 0 ? b : PASS_BAR;
}

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const fmt = (v) => n(v).toLocaleString("en-US");
const r2 = (v) => Math.round(n(v) * 100) / 100;

// Faces after triangulation (what a game engine counts as "tris").
export function triEquivalent(counts) {
  if (!counts) return 0;
  if (Number.isFinite(counts.triEquivalent)) return counts.triEquivalent;
  return n(counts.tris) + 2 * n(counts.quads);
}

// A modeling challenge with a quad-share spec cannot grade a fully triangulated OBJ.
export function isTriangulated(counts, spec) {
  if (!counts || !spec) return false;
  if (!(n(spec.quad_share_min) > 0)) return false;
  return n(counts.tris) > 0 && n(counts.quads) + n(counts.ngons) === 0;
}

// counts: the parser's output, plus dims_cm {x, y, z} from the page's units picker.
// spec: catalog challenge.spec (modeling).
// Returns {score 0-10 | null, max 10, misses[{id, text}], checks[{id, label, value, spec, status, text}], measured}.
// status is one of ok | over | notzero | unmeasured (the P6 data-status values).
export function measuredTopology(counts, spec) {
  const checks = [];
  const misses = [];
  if (!counts || !spec) return { score: null, max: 10, misses, checks, measured: false };
  let score = 10;
  const faces = n(counts.faces);
  const check = (id, label, value, specText, ok, badStatus, badText, deduct, missText) => {
    checks.push({ id, label, value, spec: specText, status: ok ? "ok" : badStatus, text: ok ? "OK" : badText });
    if (!ok) {
      score -= deduct;
      misses.push({ id, text: missText });
    }
  };
  const info = (id, label, value, specText) => checks.push({ id, label, value, spec: specText || "-", status: "ok", text: "Counted" });

  if (n(spec.face_budget) > 0) {
    const b = n(spec.face_budget);
    check("faces", "Faces", fmt(faces), "<= " + fmt(b), faces <= b, "over", "Over budget", 2,
      fmt(faces) + " faces: the budget is " + fmt(b) + ". Remove loops that don't change the silhouette (Blender: Alt+click an edge loop, then X > Dissolve Edges).");
  } else {
    info("faces", "Faces", fmt(faces));
  }
  if (n(spec.tri_budget) > 0) {
    const b = n(spec.tri_budget);
    const t = triEquivalent(counts);
    check("tris_equiv", "Triangles once triangulated", fmt(t), "<= " + fmt(b), t <= b, "over", "Over budget", 2,
      fmt(t) + " triangles once triangulated: the budget is " + fmt(b) + ". Dissolve edges on flat areas and use fewer segments on round parts that read the same from a distance.");
  }
  info("tris", "Tris", fmt(counts.tris));
  if (n(spec.quad_share_min) > 0) {
    const share = faces > 0 ? n(counts.quads) / faces : 0;
    const min = n(spec.quad_share_min);
    const pct = Math.round(share * 100);
    check("quads", "Quads", fmt(counts.quads) + " (" + pct + "%)", ">= " + Math.round(min * 100) + "% of faces", share + 1e-9 >= min, "over", "Below " + Math.round(min * 100) + "%", 2,
      pct + "% of faces are quads: the spec is at least " + Math.round(min * 100) + "%. Rebuild triangle areas as quads (Blender: select the triangles, then Face > Tris to Quads, Alt+J).");
  } else {
    info("quads", "Quads", fmt(counts.quads));
  }
  if (spec.max_ngons !== undefined && spec.max_ngons !== null) {
    const m = n(spec.max_ngons);
    const g = n(counts.ngons);
    check("ngons", "N-gons", fmt(g), m === 0 ? "0" : "<= " + fmt(m), g <= m, m === 0 ? "notzero" : "over", m === 0 ? "Not 0" : "Over budget", 3,
      fmt(g) + " n-gon" + (g === 1 ? "" : "s") + ": the spec is " + (m === 0 ? "0" : "at most " + fmt(m)) + ". Find them in Blender with Select > Select All by Trait > Faces by Sides, more than 4.");
  } else {
    info("ngons", "N-gons", fmt(counts.ngons));
  }
  info("poles3", "Poles (3)", fmt(counts.poles3));
  if (spec.max_poles5 !== undefined && spec.max_poles5 !== null) {
    const m = n(spec.max_poles5);
    const p = n(counts.poles5);
    check("poles5", "Poles (5+)", fmt(p), "<= " + fmt(m), p <= m, "over", "Over budget", 1,
      fmt(p) + " vertices join 5 or more edges: the spec allows " + fmt(m) + ". Move them to flat areas or reroute the loops so fewer edges meet at one point.");
  } else {
    info("poles5", "Poles (5+)", fmt(counts.poles5));
  }
  {
    const m = spec.max_nonmanifold === undefined || spec.max_nonmanifold === null ? 0 : n(spec.max_nonmanifold);
    const v = n(counts.nonManifoldEdges);
    check("nonmanifold", "Non-manifold edges", fmt(v), m === 0 ? "0" : "<= " + fmt(m), v <= m, m === 0 ? "notzero" : "over", m === 0 ? "Not 0" : "Over budget", 2,
      fmt(v) + " edge" + (v === 1 ? " is" : "s are") + " shared by more than two faces. Find them in Blender with Select > Select All by Trait > Non Manifold, then delete the extra faces.");
  }
  if (spec.max_boundary !== undefined && spec.max_boundary !== null) {
    const m = n(spec.max_boundary);
    const v = n(counts.boundaryEdges);
    check("boundary", "Open edges", fmt(v), m === 0 ? "0" : "<= " + fmt(m), v <= m, m === 0 ? "notzero" : "over", m === 0 ? "Not 0" : "Over budget", 1,
      fmt(v) + " open edge" + (v === 1 ? "" : "s") + ": the spec is " + (m === 0 ? "a closed mesh" : "at most " + fmt(m)) + ". Fill the holes (Blender: select the open loop, then F or Face > Grid Fill).");
  } else {
    info("boundary", "Open edges", fmt(counts.boundaryEdges));
  }
  if (Array.isArray(spec.dimensions) && spec.dimensions.length) {
    const dims = counts.dims_cm;
    let sizeMissed = false;
    for (const d of spec.dimensions) {
      const label = d.label || "Size";
      const specText = d.min + "-" + d.max + " " + (d.unit || "cm");
      if (!dims || !Number.isFinite(Number(dims[d.axis]))) {
        checks.push({ id: "size_" + d.axis, label, value: "-", spec: specText, status: "unmeasured", text: "Not measured" });
        continue;
      }
      const v = Math.round(Number(dims[d.axis]) * 10) / 10;
      const ok = v >= n(d.min) && v <= n(d.max);
      checks.push({ id: "size_" + d.axis, label, value: v + " cm", spec: specText, status: ok ? "ok" : "over", text: ok ? "OK" : "Out of range" });
      if (!ok) {
        if (!sizeMissed) score -= 2;
        sizeMissed = true;
        misses.push({ id: "size_" + d.axis, text: label + " is " + v + " cm: the spec is " + specText + ". Check the units picker first; then scale the model (Blender: S, type the factor, then Ctrl+A > Scale)." });
      }
    }
  }
  score = Math.max(0, Math.min(10, score));
  return { score, max: 10, misses, checks, measured: true };
}

// frames: the page's frame facts {duration, fps, frames, fps_assumed?}; spec: animation spec.
export function measuredFrames(frames, spec) {
  const checks = [];
  const misses = [];
  if (!frames || !spec) return { score: null, max: 10, misses, checks, measured: false };
  let score = 10;
  const count = n(frames.frames);
  const fps = n(frames.fps);
  const sfps = n(spec.fps) || 24;
  const fmin = n(spec.frames_min), fmax = n(spec.frames_max);
  const okFrames = count >= fmin && count <= fmax;
  checks.push({ id: "frames", label: "Frames", value: fmt(count), spec: fmin + "-" + fmax, status: okFrames ? "ok" : "over", text: okFrames ? "OK" : "Out of range" });
  if (!okFrames) {
    score -= 4;
    misses.push({ id: "frames", text: fmt(count) + " frames: the spec is " + fmin + "-" + fmax + " frames at " + sfps + " fps. Set the frame range to the shot and playblast again." });
  }
  const okFps = Math.abs(fps - sfps) <= 0.6;
  checks.push({ id: "fps", label: "Frame rate", value: r2(fps) + " fps" + (frames.fps_assumed ? " (as set)" : ""), spec: sfps + " fps", status: okFps ? "ok" : "over", text: okFps ? "OK" : "Different" });
  if (!okFps) {
    score -= 3;
    misses.push({ id: "fps", text: "The clip runs at " + r2(fps) + " fps: the spec is " + sfps + " fps. Set the scene frame rate to " + sfps + " before you animate, so the timing is judged as you meant it." });
  }
  checks.push({ id: "duration", label: "Duration", value: r2(frames.duration) + " s", spec: r2(fmin / sfps) + "-" + r2(fmax / sfps) + " s", status: okFrames ? "ok" : "over", text: okFrames ? "OK" : "Out of range" });
  score = Math.max(0, Math.min(10, score));
  return { score, max: 10, misses, checks, measured: true };
}

// The measured rubric line of a challenge (the rubric entry with grader "measured"),
// from the counts (modeling) or the frame facts (animation).
// payload: {counts?, frames?, measured?}. measured === false or counts null -> not measured.
export function measuredLine(challenge, payload) {
  const line = (challenge && challenge.rubric || []).find((l) => l.grader === "measured");
  if (!line) return null;
  const p = payload || {};
  let r;
  if (challenge.kind === "animation") r = measuredFrames(p.frames, challenge.spec);
  else if (p.measured === false || !p.counts) r = { score: null, max: 10, misses: [], checks: [], measured: false };
  else r = measuredTopology(p.counts, challenge.spec);
  return {
    id: line.id,
    title: line.title,
    weight: line.weight,
    score: r.score,
    points: linePoints({ weight: line.weight, score: r.score }),
    measured: r.measured,
    misses: r.misses,
    checks: r.checks,
  };
}

// Points a line contributes (score / 10 x weight), null when not scored.
export function linePoints(line) {
  if (!line || line.score === null || line.score === undefined || !(n(line.weight) > 0)) return null;
  return Math.round((Math.max(0, Math.min(10, n(line.score))) / 10) * n(line.weight) * 10) / 10;
}

// lines: [{weight, score 0-10 or null}]. A null score (topology not measured on a GLB)
// drops that line and the rest are scaled to 100. Weight 0 lines (edge flow) never count.
export function composite(lines, bar) {
  let pts = 0, w = 0;
  for (const l of lines || []) {
    const weight = n(l && l.weight);
    if (weight <= 0 || l.score === null || l.score === undefined) continue;
    pts += (Math.max(0, Math.min(10, n(l.score))) / 10) * weight;
    w += weight;
  }
  const total = w > 0 ? Math.round((pts / w) * 100) : 0;
  const b = Number.isFinite(Number(bar)) && Number(bar) > 0 ? Number(bar) : PASS_BAR;
  return { total, letter: letterFor(total), pass: total >= b, bar: b };
}
