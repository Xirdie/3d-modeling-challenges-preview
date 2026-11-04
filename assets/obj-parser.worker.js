// Web Worker wrapper around obj-parser.js. Message in: {file: File}. Messages out:
// {type: "progress", text} | {type: "error", code: "too_many_faces", faces} | {type: "error", code: "no_faces"}
// | {type: "done", counts, edges, positions, triangles, marks} (typed arrays transferred).
import { parseObj, countFaceLines } from "./obj-parser.js";

const MAX_FACES = 500000;

self.onmessage = async (ev) => {
  try {
    const file = ev.data && ev.data.file;
    const text = typeof ev.data.text === "string" ? ev.data.text : await file.text();
    const quick = countFaceLines(text);
    if (quick > MAX_FACES) {
      self.postMessage({ type: "error", code: "too_many_faces", faces: quick });
      return;
    }
    const r = parseObj(text);
    if (r.counts.faces === 0) {
      self.postMessage({ type: "error", code: "no_faces" });
      return;
    }
    if (r.counts.faces > MAX_FACES) {
      self.postMessage({ type: "error", code: "too_many_faces", faces: r.counts.faces });
      return;
    }
    self.postMessage(
      { type: "done", counts: r.counts, edges: r.edges, positions: r.positions, triangles: r.triangles, marks: r.marks },
      [r.edges.buffer, r.positions.buffer, r.triangles.buffer]
    );
  } catch (e) {
    self.postMessage({ type: "error", code: "no_faces" });
  }
};
