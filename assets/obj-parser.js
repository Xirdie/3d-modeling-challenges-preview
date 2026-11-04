// CritPass OBJ face parser. Pure ES module: no DOM, no imports.
// Used by obj-parser.worker.js in the browser and by the Worker's Node tests.
//
// parseObj(text) -> {counts, edges, positions, triangles, marks}
//   counts: {verts, faces, tris, quads, ngons, triEquivalent, edges, poles3, poles5,
//            nonManifoldEdges, boundaryEdges, bounds: {min: [x, y, z], max: [x, y, z]}}
//   edges: Uint32Array of vertex-index pairs, one pair per unique polygon edge (the wireframe)
//   positions: Float32Array xyz per OBJ vertex; triangles: Uint32Array (fan-triangulated, for shading)
//   marks: {ngons: [[x,y,z]...], poles5: [[x,y,z]...]} centroids, at most 200 each (Deep close-ups)
//
// Definitions (the fixtures' expected.json follows the same ones):
// - Only `v` and `f` lines are read; `vt`, `vn`, `l`, `o`, `g`, `s`, `usemtl`, `mtllib` are ignored.
// - A face corner is the first number of `i`, `i/t`, `i//n` or `i/t/n`; negative indices count back
//   from the last `v` read so far. Consecutive duplicate corners (and a last == first corner) are
//   dropped; a face left with < 3 corners, or with an index out of range, is skipped (not counted).
// - tris / quads / ngons: faces with 3 / 4 / >= 5 corners. triEquivalent = sum(corners - 2).
// - An edge is an unordered vertex pair on a face boundary; `edges` counts unique ones.
//   boundaryEdges: used by exactly 1 face. nonManifoldEdges: used by 3 or more faces.
// - Valence of a vertex = number of unique edges touching it. Poles are counted only on interior
//   vertices (no boundary or non-manifold edge touches them): poles3 = valence 3, poles5 = valence >= 5.
// - bounds: over every vertex used by at least one counted face.

export function parseObj(text) {
  if (typeof text !== "string") text = String(text || "");
  let pos = new Float32Array(1 << 12);
  let nv = 0;
  // faces stored flat: faceStart[i] .. faceStart[i+1] into corners
  let corners = new Uint32Array(1 << 14);
  let nc = 0;
  let faceStart = new Uint32Array(1 << 12);
  let nf = 0;
  const tmp = [];

  const len = text.length;
  let i = 0;
  while (i < len) {
    let end = text.indexOf("\n", i);
    if (end === -1) end = len;
    // skip leading spaces
    let s = i;
    while (s < end && (text.charCodeAt(s) === 32 || text.charCodeAt(s) === 9)) s++;
    const c0 = text.charCodeAt(s);
    const c1 = text.charCodeAt(s + 1);
    if (c0 === 118 /* v */ && (c1 === 32 || c1 === 9)) {
      const parts = text.slice(s + 2, end).trim().split(/\s+/);
      if (nv * 3 + 3 > pos.length) {
        const g = new Float32Array(pos.length * 2);
        g.set(pos);
        pos = g;
      }
      pos[nv * 3] = parseFloat(parts[0]) || 0;
      pos[nv * 3 + 1] = parseFloat(parts[1]) || 0;
      pos[nv * 3 + 2] = parseFloat(parts[2]) || 0;
      nv++;
    } else if (c0 === 102 /* f */ && (c1 === 32 || c1 === 9)) {
      const parts = text.slice(s + 2, end).trim().split(/\s+/);
      tmp.length = 0;
      let bad = false;
      for (let k = 0; k < parts.length; k++) {
        const p = parts[k];
        if (!p) continue;
        const slash = p.indexOf("/");
        let idx = parseInt(slash === -1 ? p : p.slice(0, slash), 10);
        if (!Number.isFinite(idx) || idx === 0) { bad = true; break; }
        idx = idx < 0 ? nv + idx : idx - 1;
        if (idx < 0 || idx >= nv) { bad = true; break; }
        if (tmp.length && tmp[tmp.length - 1] === idx) continue;
        tmp.push(idx);
      }
      if (!bad && tmp.length > 1 && tmp[0] === tmp[tmp.length - 1]) tmp.pop();
      if (!bad && tmp.length >= 3) {
        if (nc + tmp.length > corners.length) {
          const g = new Uint32Array(Math.max(corners.length * 2, nc + tmp.length));
          g.set(corners);
          corners = g;
        }
        if (nf + 2 > faceStart.length) {
          const g = new Uint32Array(faceStart.length * 2);
          g.set(faceStart);
          faceStart = g;
        }
        faceStart[nf] = nc;
        for (let k = 0; k < tmp.length; k++) corners[nc++] = tmp[k];
        nf++;
      }
    }
    i = end + 1;
  }
  faceStart[nf] = nc;

  let tris = 0, quads = 0, ngons = 0, triEq = 0;
  // unique edges with face-use counts
  const edgeIndex = new Map();
  let edgeA = new Uint32Array(1 << 14);
  let edgeB = new Uint32Array(1 << 14);
  let edgeUse = new Uint32Array(1 << 14);
  let ne = 0;
  const used = new Uint8Array(nv);
  const ngonMarks = [];
  for (let f = 0; f < nf; f++) {
    const a = faceStart[f], b = faceStart[f + 1];
    const k = b - a;
    if (k === 3) tris++;
    else if (k === 4) quads++;
    else ngons++;
    triEq += k - 2;
    if (k >= 5 && ngonMarks.length < 200) {
      let x = 0, y = 0, z = 0;
      for (let j = a; j < b; j++) { const v = corners[j] * 3; x += pos[v]; y += pos[v + 1]; z += pos[v + 2]; }
      ngonMarks.push([x / k, y / k, z / k]);
    }
    for (let j = a; j < b; j++) {
      const u = corners[j];
      const w = corners[j + 1 < b ? j + 1 : a];
      used[u] = 1;
      if (u === w) continue;
      const lo = u < w ? u : w, hi = u < w ? w : u;
      const key = lo * nv + hi;
      let e = edgeIndex.get(key);
      if (e === undefined) {
        if (ne >= edgeA.length) {
          const n2 = edgeA.length * 2;
          const ga = new Uint32Array(n2); ga.set(edgeA); edgeA = ga;
          const gb = new Uint32Array(n2); gb.set(edgeB); edgeB = gb;
          const gu = new Uint32Array(n2); gu.set(edgeUse); edgeUse = gu;
        }
        e = ne++;
        edgeIndex.set(key, e);
        edgeA[e] = lo;
        edgeB[e] = hi;
      }
      edgeUse[e]++;
    }
  }

  const valence = new Uint32Array(nv);
  const edgeOfOpen = new Uint8Array(nv);
  let boundaryEdges = 0, nonManifoldEdges = 0;
  const edges = new Uint32Array(ne * 2);
  for (let e = 0; e < ne; e++) {
    const a = edgeA[e], b = edgeB[e];
    edges[e * 2] = a;
    edges[e * 2 + 1] = b;
    valence[a]++;
    valence[b]++;
    if (edgeUse[e] === 1) { boundaryEdges++; edgeOfOpen[a] = 1; edgeOfOpen[b] = 1; }
    else if (edgeUse[e] >= 3) { nonManifoldEdges++; edgeOfOpen[a] = 1; edgeOfOpen[b] = 1; }
  }
  let poles3 = 0, poles5 = 0;
  const poleMarks = [];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < nv; v++) {
    if (!used[v]) continue;
    for (let d = 0; d < 3; d++) {
      const c = pos[v * 3 + d];
      if (c < min[d]) min[d] = c;
      if (c > max[d]) max[d] = c;
    }
    if (edgeOfOpen[v]) continue;
    if (valence[v] === 3) poles3++;
    else if (valence[v] >= 5) {
      poles5++;
      if (poleMarks.length < 200) poleMarks.push([pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]);
    }
  }
  if (nf === 0) { min[0] = min[1] = min[2] = 0; max[0] = max[1] = max[2] = 0; }

  // fan triangulation for shading
  const triangles = new Uint32Array(triEq * 3);
  let t = 0;
  for (let f = 0; f < nf; f++) {
    const a = faceStart[f], b = faceStart[f + 1];
    for (let j = a + 1; j < b - 1; j++) {
      triangles[t++] = corners[a];
      triangles[t++] = corners[j];
      triangles[t++] = corners[j + 1];
    }
  }

  const round = (x) => Math.round(x * 1e6) / 1e6;
  return {
    counts: {
      verts: nv,
      faces: nf,
      tris,
      quads,
      ngons,
      triEquivalent: triEq,
      edges: ne,
      poles3,
      poles5,
      nonManifoldEdges,
      boundaryEdges,
      bounds: { min: min.map(round), max: max.map(round) },
    },
    edges,
    positions: pos.slice(0, nv * 3),
    triangles,
    marks: { ngons: ngonMarks, poles5: poleMarks },
  };
}

// Count `f` lines cheaply (for the 500,000-face cap before a full parse).
export function countFaceLines(text) {
  let count = 0;
  let i = 0;
  if (text.startsWith("f ")) count++;
  while ((i = text.indexOf("\nf ", i)) !== -1) { count++; i += 3; }
  return count;
}
