// CritPass media (design.md P2/P3, polish pass). Presentation only: no storage, no network beyond the
// two local video files, no analytics.
// - Hero loop (landing, >= 720 px): sources are attached after `load` + idle; under
//   prefers-reduced-motion it is never fetched until [Play] is pressed. [Pause] / [Play] always works.
// - Demo videos: the poster is set when the video nears the viewport; preload="none" stays.
const mqWide = window.matchMedia("(min-width: 720px)");
const mqReduce = window.matchMedia("(prefers-reduced-motion: reduce)");

function setupHero(hero) {
  const video = hero.querySelector(".hero__loop");
  const btn = hero.querySelector(".hero__toggle");
  if (!video || !btn) return;
  let attached = false;
  const label = (playing) => {
    btn.textContent = playing ? "Pause" : "Play";
    btn.setAttribute("aria-label", playing ? "Pause demo loop" : "Play demo loop");
  };
  const attach = () => {
    if (attached) return;
    attached = true;
    for (const [attr, type] of [["data-webm", "video/webm"], ["data-mp4", "video/mp4"]]) {
      const src = video.getAttribute(attr);
      if (!src) continue;
      const s = document.createElement("source");
      s.src = src;
      s.type = type;
      video.appendChild(s);
    }
    video.load();
  };
  const play = () => {
    attach();
    const p = video.play();
    if (p && p.catch) p.catch(() => { hero.dataset.state = attached && video.dataset.started ? "paused" : "poster"; label(false); });
    label(true);
  };
  const pause = () => {
    video.pause();
    hero.dataset.state = video.dataset.started ? "paused" : "poster";
    label(false);
  };
  video.addEventListener("playing", () => { video.dataset.started = "1"; hero.dataset.state = "playing"; label(true); });
  btn.addEventListener("click", () => (hero.dataset.state === "playing" || (!video.paused && attached) ? pause() : play()));
  btn.hidden = false;
  label(false);
  if (!mqReduce.matches) {
    label(true);
    const go = () => { if (mqWide.matches && !mqReduce.matches) play(); };
    const idle = () => ("requestIdleCallback" in window ? requestIdleCallback(go, { timeout: 2000 }) : setTimeout(go, 200));
    if (document.readyState === "complete") idle(); else window.addEventListener("load", idle, { once: true });
  }
  mqReduce.addEventListener("change", (e) => { if (e.matches) pause(); });
  mqWide.addEventListener("change", (e) => { if (!e.matches && attached) pause(); });
}

function setupDemos() {
  const vids = [...document.querySelectorAll("video.demo__video[data-poster]")];
  if (!vids.length) return;
  const set = (v) => { if (!v.poster) v.poster = v.getAttribute("data-poster"); };
  if (!("IntersectionObserver" in window)) return vids.forEach(set);
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { set(e.target); io.unobserve(e.target); }
  }, { rootMargin: "200px 0px" });
  vids.forEach((v) => io.observe(v));
}

const hero = document.querySelector(".hero[data-state]");
if (hero && mqWide.matches) setupHero(hero);
else if (hero) mqWide.addEventListener("change", function once(e) { if (e.matches) { mqWide.removeEventListener("change", once); setupHero(hero); } });
setupDemos();
