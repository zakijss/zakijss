#!/usr/bin/env node
// Contribution skyline for the GitHub profile README.
//
// A year of contributions drawn as GitHub's heat map that folds up into an
// isometric skyline: one camera swings from straight down to the corner view
// while each week's bars rise in a wave, oldest week first. It is the geometry
// of the ContributionSkyline React component (grid, levels, camera, projection),
// rendered here into SVG keyframes, because a README can't run scripts. The fold
// plays once per view; with reduced motion on, the finished skyline shows still.
//
//   GITHUB_TOKEN=... node skyline.mjs zakijss           # fetch, then write both SVGs
//   node skyline.mjs zakijss --data contributions.json   # from a saved [{date,count}]
//
// No dependencies; Node 20 or later.
import { writeFileSync, readFileSync } from "node:fs";

// ---- the component's maths, unchanged ------------------------------------------
const DAY_MS = 86400000;
const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOutCubic = (x) => { const t = clamp01(x); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
const easeOutCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const toKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v); return Date.UTC(+m[1], +m[2] - 1, +m[3]); };
const levelOf = (count, busy) => (count <= 0 ? 0 : busy <= 0 ? 4 : 1 + Math.min(3, Math.floor((count / busy) * 4)));

function buildGrid(data, endMs, weekStart = 0) {
  const counts = new Map();
  for (const d of data) if (d.count > 0) counts.set(toKey(dayMs(d.date)), (counts.get(toKey(dayMs(d.date))) ?? 0) + d.count);
  let start = endMs - 364 * DAY_MS;
  start -= ((new Date(start).getUTCDay() - weekStart + 7) % 7) * DAY_MS;
  const cells = [];
  for (let ms = start, i = 0; ms <= endMs; ms += DAY_MS, i++) {
    const date = toKey(ms);
    cells.push({ date, count: counts.get(date) ?? 0, level: 0, week: Math.floor(i / 7), day: i % 7 });
  }
  const nz = cells.map((c) => c.count).filter((c) => c > 0).sort((a, b) => a - b);
  const busy = nz.length ? nz[Math.floor(0.95 * (nz.length - 1))] : 0;
  for (const c of cells) c.level = levelOf(c.count, busy);
  return { cells, weeks: cells.length ? cells[cells.length - 1].week + 1 : 0, max: nz.length ? nz[nz.length - 1] : 0 };
}

function computeStats(cells) {
  let total = 0, best = 0, bestDate = null, run = 0, runStart = null;
  let longest = { days: 0, start: null, end: null };
  for (const c of cells) {
    total += c.count;
    if (c.count > best) { best = c.count; bestDate = c.date; }
    if (c.count > 0) {
      if (run === 0) runStart = c.date;
      run++;
      if (run > longest.days) longest = { days: run, start: runStart, end: c.date };
    } else run = 0;
  }
  let j = cells.length - 1;
  if (j >= 0 && cells[j].count === 0) j--;
  const endAt = j;
  while (j >= 0 && cells[j].count > 0) j--;
  return { total, busiest: { count: best, date: bestDate }, longest, current: { days: endAt - j } };
}

function monthLabels(cells, weeks) {
  const fmt = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
  const out = [];
  let prev = -1;
  for (let w = 0; w < weeks; w++) {
    const c = cells[w * 7];
    if (!c) break;
    const m = +c.date.slice(5, 7);
    if (m !== prev) out.push({ week: w, label: fmt.format(dayMs(c.date)) });
    prev = m;
  }
  if (out.length > 1 && out[1].week - out[0].week < 3) out.shift();
  return out;
}

const barHeight = (count, max) => (count > 0 && max > 0 ? 0.4 + Math.pow(count / max, 0.85) * 7.2 : 0.2);
const WAVE = 0.42;
const riseAt = (t, week, weeks, day) => easeOutCubic((t - ((weeks > 1 ? week / (weeks - 1) : 0) * 0.36 + (day / 6) * 0.06)) / (1 - WAVE));
const YAW_3D = Math.PI / 4, ELEV_3D = (34 * Math.PI) / 180;
function camera(e) {
  const yaw = lerp(0, YAW_3D, e), elev = lerp(Math.PI / 2, ELEV_3D, e);
  return { cs: Math.cos(yaw), sn: Math.sin(yaw), se: Math.sin(elev), ce: Math.cos(elev) };
}
const project = (c, x, y, z) => [x * c.cs - y * c.sn, (x * c.sn + y * c.cs) * c.se - z * c.ce];

const PALETTES = {
  light: { empty: "#ebedf0", levels: ["#9be9a8", "#40c463", "#30a14e", "#216e39"], fg: "#1f2328", muted: "#59636e" },
  dark: { empty: "#161b22", levels: ["#0e4429", "#006d32", "#26a641", "#39d353"], fg: "#e6edf3", muted: "#9198a1" },
};

// ---- rendering --------------------------------------------------------------
const W = 900, TOP = 64, BOTTOM = 62, PAD = 18;
const FRAMES = [0, 0.08, 0.16, 0.24, 0.32, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
const DUR = 1.8, BEGIN = 0.7;          // seconds
const r1 = (v) => Math.round(v * 10) / 10;

function scale(rgbHex, f) {
  const n = parseInt(rgbHex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * f));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}

function render(model, theme) {
  const { cells, weeks, max } = model;
  const n = cells.length;
  const hgt = cells.map((c) => barHeight(c.count, max));
  // The box fits the finished skyline; the flat map sits centred in it.
  const H = 330 + TOP + BOTTOM;
  const box = { x: PAD, y: TOP, w: W - 2 * PAD, h: H - TOP - BOTTOM };

  const frame = (t) => {
    const e = easeInOutCubic(t), cam = camera(e);
    const w = lerp(0.78, 0.9, e), off = (1 - w) / 2;
    const z = cells.map((c, i) => riseAt(t, c.week, weeks, c.day) * hgt[i]);
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    const add = (x, y, zz) => { const p = project(cam, x, y, zz); minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]); };
    // fit to the bars' full height at this camera, so the frame doesn't jump as they rise
    for (let i = 0; i < n; i++) {
      const x0 = cells[i].week + off, y0 = cells[i].day + off;
      add(x0, y0, hgt[i] * e); add(x0 + w, y0, 0); add(x0, y0 + w, 0); add(x0 + w, y0 + w, 0); add(x0, y0, 0);
    }
    // the flat map keeps a gutter for Mon/Wed/Fri, which closes as it tilts
    const gut = 34 * (1 - e), bx = box.x + gut, bw = box.w - gut;
    const s = Math.min(bw / (maxx - minx), box.h / (maxy - miny));
    const ox = bx + (bw - (maxx - minx) * s) / 2 - minx * s;
    const oy = box.y + (box.h - (maxy - miny) * s) / 2 - miny * s;
    const P = (x, y, zz) => { const p = project(cam, x, y, zz); return [ox + p[0] * s, oy + p[1] * s]; };
    const polys = cells.map((c, i) => {
      const x0 = c.week + off, y0 = c.day + off, x1 = x0 + w, y1 = y0 + w, zz = z[i];
      const top = [P(x0, y0, zz), P(x1, y0, zz), P(x1, y1, zz), P(x0, y1, zz)];
      const left = [P(x0, y1, 0), P(x1, y1, 0), P(x1, y1, zz), P(x0, y1, zz)];
      const right = [P(x1, y0, 0), P(x1, y1, 0), P(x1, y1, zz), P(x1, y0, zz)];
      return [top, left, right].map((q) => q.map(([a, b]) => r1(a) + "," + r1(b)).join(" "));
    });
    return { polys, cam, s, ox, oy, off };
  };

  const frames = FRAMES.map(frame);
  const last = frames[frames.length - 1];
  // painter's order of the finished view: far to near
  const order = [...cells.keys()].sort((a, b) =>
    (cells[a].week + 0.5) * last.cam.sn + (cells[a].day + 0.5) * last.cam.cs -
    ((cells[b].week + 0.5) * last.cam.sn + (cells[b].day + 0.5) * last.cam.cs));
  const color = (c) => (c.level ? theme.levels[c.level - 1] : theme.empty);
  const keyTimes = FRAMES.map((f) => f.toFixed(2)).join(";");

  const anim = [], still = [];
  for (const i of order) {
    const c = cells[i], col = color(c);
    const faces = c.count > 0 ? [0, 1, 2] : [0];   // empty days stay slabs; no sides worth drawing
    const fills = [col, scale(col, 0.84), scale(col, 0.68)];
    for (const k of [...faces].reverse()) {          // sides first, top last
      const vals = frames.map((f) => f.polys[i][k]).join(";");
      anim.push(`<polygon fill="${fills[k]}" points="${frames[0].polys[i][k]}"><animate attributeName="points" values="${vals}" keyTimes="${keyTimes}" dur="${DUR}s" begin="${BEGIN}s" fill="freeze"/></polygon>`);
      still.push(`<polygon fill="${fills[k]}" points="${last.polys[i][k]}"/>`);
    }
  }

  // Flat-view labels (months along the top, Mon/Wed/Fri down the side) fade as the map tilts.
  const f0 = frames[0];
  const lab = [];
  for (const m of model.months) {
    const [x, y] = [f0.ox + (m.week + f0.off) * f0.s, f0.oy - 0.3 * f0.s];
    lab.push(`<text x="${r1(x)}" y="${r1(y - 4)}">${m.label}</text>`);
  }
  const wd = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });
  for (let d = 0; d < 7; d++) {
    const dow = new Date(dayMs(cells[d].date)).getUTCDay();
    if (dow === 1 || dow === 3 || dow === 5)
      lab.push(`<text x="${r1(f0.ox - 6)}" y="${r1(f0.oy + (d + 0.5) * f0.s)}" text-anchor="end" dominant-baseline="middle">${wd.format(dayMs(cells[d].date))}</text>`);
  }

  const st = model.stats;
  const nf = new Intl.NumberFormat("en-US");
  const md = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const plural = (v, one, many) => `${nf.format(v)} ${v === 1 ? one : many}`;
  const stats = [
    `Longest streak ${plural(st.longest.days, "day", "days")}`,
    st.busiest.date ? `Busiest day ${plural(st.busiest.count, "contribution", "contributions")}, ${md.format(dayMs(st.busiest.date))}` : null,
    `Current streak ${plural(st.current.days, "day", "days")}`,
  ].filter(Boolean).join("   ·   ");
  const title = `${plural(st.total, "contribution", "contributions")} in the last year`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${title}. ${stats}">
<title>${title}</title>
<style>
  text { font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; fill: ${theme.muted}; }
  .title { font-size: 17px; font-weight: 600; fill: ${theme.fg}; }
  #still { display: none; }
  @media (prefers-reduced-motion: reduce) { #anim, #labels { display: none; } #still { display: inline; } }
</style>
<text class="title" x="${PAD}" y="30">${title}</text>
<g id="labels"><animate attributeName="opacity" values="1;0" dur="${(DUR * 0.4).toFixed(2)}s" begin="${BEGIN}s" fill="freeze"/>${lab.join("")}</g>
<g id="anim">${anim.join("")}</g>
<g id="still">${still.join("")}</g>
<text x="${PAD}" y="${H - 22}">${stats}</text>
</svg>
`;
}

// ---- data --------------------------------------------------------------------
async function fetchDays(login) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const query = `query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{weeks{contributionDays{date contributionCount}}}}}}`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "contribution-skyline" },
    body: JSON.stringify({ query, variables: { login } }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) throw new Error(`GitHub GraphQL: ${res.status} ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
  return body.data.user.contributionsCollection.contributionCalendar.weeks
    .flatMap((w) => w.contributionDays).map((d) => ({ date: d.date, count: d.contributionCount }));
}

const login = process.argv[2] || "zakijss";
const dataAt = process.argv.indexOf("--data");
const days = dataAt > 0 ? JSON.parse(readFileSync(process.argv[dataAt + 1], "utf8")) : await fetchDays(login);
const end = Math.max(...days.map((d) => dayMs(d.date)));
const grid = buildGrid(days, end);
const model = { ...grid, stats: computeStats(grid.cells), months: monthLabels(grid.cells, grid.weeks) };
for (const [name, theme] of Object.entries(PALETTES)) {
  const svg = render(model, theme);
  writeFileSync(`skyline-${name}.svg`, svg);
  console.log(`skyline-${name}.svg  ${(svg.length / 1024).toFixed(0)} KB`);
}
console.log(`${model.stats.total} contributions, ${grid.cells.length} days, through ${toKey(end)}`);
