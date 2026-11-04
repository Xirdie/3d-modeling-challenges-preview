// The "clay" matcap (design.md P1), generated in the browser: 0 bytes shipped, deterministic,
// so the live preview, the capture and the polish renders match.
export function makeClayMatcap(size = 256) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const r = size / 2;
  g.fillStyle = "#6f6a63";
  g.fillRect(0, 0, size, size);
  const cx = r + -0.35 * r;
  const cy = r + -0.4 * r;
  const grad = g.createRadialGradient(cx, cy, 0, r, r, r);
  grad.addColorStop(0, "#f3eee6");
  grad.addColorStop(0.55, "#b9b2a8");
  grad.addColorStop(1, "#6f6a63");
  g.beginPath();
  g.arc(r, r, r, 0, Math.PI * 2);
  g.fillStyle = grad;
  g.fill();
  g.beginPath();
  g.arc(r, r, r * 0.96, 0, Math.PI * 2);
  g.lineWidth = 2;
  g.strokeStyle = "#cfc9bf";
  g.stroke();
  return c;
}

// The viewport background (P1): radial #3b3f45 centre to #24272b corners.
export function makeViewportBackground(size = 512) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size * 0.71);
  grad.addColorStop(0, "#3b3f45");
  grad.addColorStop(1, "#24272b");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}
