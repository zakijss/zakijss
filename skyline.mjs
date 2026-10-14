#!/usr/bin/env node
// Draws a year of GitHub contributions as an isometric skyline for the profile
// README. The heat map starts flat, tilts into a corner view, and each week's
// bars rise in turn, oldest first. A README can't run scripts, so the motion is
// written out as SVG keyframes; with reduced motion the finished skyline shows.
//
//   GITHUB_TOKEN=... node skyline.mjs zakijss
//   node skyline.mjs zakijss --data days.json    # [{"date": "2026-01-31", "count": 4}, ...]
//
// Writes skyline-light.svg and skyline-dark.svg. Node 20 or later, no packages.

import { readFileSync, writeFileSync } from "node:fs";

const DAY_MS = 86_400_000;

const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3);

function easeInOutCubic(x) {
  const t = clamp01(x);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

const toKey = (ms) => new Date(ms).toISOString().slice(0, 10);

function dayMs(date) {
  const [, y, m, d] = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  return Date.UTC(+y, +m - 1, +d);
}

// --- Calendar ------------------------------------------------------------------

function buildGrid(days, endMs) {
  const counts = new Map();
  for (const { date, count } of days) {
    if (count <= 0) continue;
    const key = toKey(dayMs(date));
    counts.set(key, (counts.get(key) ?? 0) + count);
  }

  // A year back from the last day, starting on a Sunday as GitHub's calendar does.
  let start = endMs - 364 * DAY_MS;
  start -= new Date(start).getUTCDay() * DAY_MS;

  const cells = [];
  for (let ms = start, i = 0; ms <= endMs; ms += DAY_MS, i++) {
    const date = toKey(ms);
    cells.push({ date, count: counts.get(date) ?? 0, level: 0, week: Math.floor(i / 7), day: i % 7 });
  }

  // Shade levels are quarters of the 95th-percentile day, so one huge day
  // doesn't wash out the rest.
  const active = cells.map((c) => c.count).filter((c) => c > 0).sort((a, b) => a - b);
  const busy = active.length ? active[Math.floor(0.95 * (active.length - 1))] : 0;
  for (const cell of cells) {
    if (cell.count <= 0) cell.level = 0;
    else if (busy <= 0) cell.level = 4;
    else cell.level = 1 + Math.min(3, Math.floor((cell.count / busy) * 4));
  }

  return { cells, weeks: cells.length ? cells.at(-1).week + 1 : 0, max: active.at(-1) ?? 0 };
}

function computeStats(cells) {
  let total = 0;
  let busiest = { count: 0, date: null };
  let longest = 0;
  let run = 0;
  for (const cell of cells) {
    total += cell.count;
    if (cell.count > busiest.count) busiest = { count: cell.count, date: cell.date };
    run = cell.count > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }

  // Today isn't over, so a streak that ended yesterday still counts.
  let i = cells.length - 1;
  if (cells[i]?.count === 0) i--;
  let current = 0;
  while (i >= 0 && cells[i].count > 0) {
    current++;
    i--;
  }

  return { total, busiest, longest, current };
}

function monthLabels(cells, weeks) {
  const format = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
  const labels = [];
  let previous = -1;
  for (let week = 0; week < weeks; week++) {
    const cell = cells[week * 7];
    if (!cell) break;
    const month = Number(cell.date.slice(5, 7));
    if (month !== previous) labels.push({ week, label: format.format(dayMs(cell.date)) });
    previous = month;
  }
  // A first month with only a week or two would crowd the next label.
  if (labels.length > 1 && labels[1].week - labels[0].week < 3) labels.shift();
  return labels;
}

// --- Geometry ------------------------------------------------------------------

const barHeight = (count, max) => (count > 0 && max > 0 ? 0.4 + Math.pow(count / max, 0.85) * 7.2 : 0.2);

// Each bar starts a moment after the one before it: the weeks are spread over
// the first 36% of the animation and the days of a week over another 6%.
const STAGGER = 0.42;

function riseAt(t, week, weeks, day) {
  const delay = (weeks > 1 ? week / (weeks - 1) : 0) * 0.36 + (day / 6) * 0.06;
  return easeOutCubic((t - delay) / (1 - STAGGER));
}

// The camera turns from straight overhead to 45° round and 34° above the ground.
const YAW = Math.PI / 4;
const ELEVATION = (34 * Math.PI) / 180;

function camera(e) {
  const yaw = lerp(0, YAW, e);
  const elevation = lerp(Math.PI / 2, ELEVATION, e);
  return { cos: Math.cos(yaw), sin: Math.sin(yaw), sinEl: Math.sin(elevation), cosEl: Math.cos(elevation) };
}

const project = (cam, x, y, z) => [x * cam.cos - y * cam.sin, (x * cam.sin + y * cam.cos) * cam.sinEl - z * cam.cosEl];

// --- Rendering -----------------------------------------------------------------

const PALETTES = {
  light: { empty: "#ebedf0", levels: ["#9be9a8", "#40c463", "#30a14e", "#216e39"], fg: "#1f2328", muted: "#59636e" },
  dark: { empty: "#161b22", levels: ["#0e4429", "#006d32", "#26a641", "#39d353"], fg: "#e6edf3", muted: "#9198a1" },
};

const WIDTH = 900;
const TOP = 64; // title
const BOTTOM = 62; // stats line
const PAD = 18;
const KEYFRAMES = [0, 0.08, 0.16, 0.24, 0.32, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
const DURATION = 1.8; // seconds
const BEGIN = 0.7;

const round1 = (v) => Math.round(v * 10) / 10;
const points = (quad) => quad.map(([x, y]) => round1(x) + "," + round1(y)).join(" ");

function shade(hex, factor) {
  const n = parseInt(hex.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * factor));
  return "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
}

// One keyframe: every cell's top, left and right faces at time t (0 to 1).
function drawFrame(t, { cells, weeks, heights, box }) {
  const e = easeInOutCubic(t);
  const cam = camera(e);
  const size = lerp(0.78, 0.9, e);
  const inset = (1 - size) / 2;
  const z = cells.map((c, i) => riseAt(t, c.week, weeks, c.day) * heights[i]);

  // Fit the bars at their full height for this camera angle, so the view
  // doesn't jump as they rise.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const include = (x, y, h) => {
    const [px, py] = project(cam, x, y, h);
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px);
    minY = Math.min(minY, py);
    maxY = Math.max(maxY, py);
  };
  cells.forEach((c, i) => {
    const x = c.week + inset, y = c.day + inset;
    include(x, y, heights[i] * e);
    include(x + size, y, 0);
    include(x, y + size, 0);
    include(x + size, y + size, 0);
    include(x, y, 0);
  });

  // The flat map leaves a gutter for the weekday labels, closing as it tilts.
  const gutter = 34 * (1 - e);
  const left = box.x + gutter, width = box.w - gutter;
  const scale = Math.min(width / (maxX - minX), box.h / (maxY - minY));
  const originX = left + (width - (maxX - minX) * scale) / 2 - minX * scale;
  const originY = box.y + (box.h - (maxY - minY) * scale) / 2 - minY * scale;
  const toScreen = (x, y, h) => {
    const [px, py] = project(cam, x, y, h);
    return [originX + px * scale, originY + py * scale];
  };

  const faces = cells.map((c, i) => {
    const x0 = c.week + inset, y0 = c.day + inset, x1 = x0 + size, y1 = y0 + size, h = z[i];
    const top = [toScreen(x0, y0, h), toScreen(x1, y0, h), toScreen(x1, y1, h), toScreen(x0, y1, h)];
    const front = [toScreen(x0, y1, 0), toScreen(x1, y1, 0), toScreen(x1, y1, h), toScreen(x0, y1, h)];
    const side = [toScreen(x1, y0, 0), toScreen(x1, y1, 0), toScreen(x1, y1, h), toScreen(x1, y0, h)];
    return [top, front, side].map(points);
  });

  return { faces, cam, scale, originX, originY, inset };
}

function render(model, theme) {
  const { cells, weeks, max, months, stats } = model;
  const height = 330 + TOP + BOTTOM;
  const box = { x: PAD, y: TOP, w: WIDTH - 2 * PAD, h: height - TOP - BOTTOM };
  const heights = cells.map((c) => barHeight(c.count, max));

  const frames = KEYFRAMES.map((t) => drawFrame(t, { cells, weeks, heights, box }));
  const first = frames[0];
  const last = frames.at(-1);

  // Paint from the far corner of the finished view to the near one.
  const depth = (c) => (c.week + 0.5) * last.cam.sin + (c.day + 0.5) * last.cam.cos;
  const order = [...cells.keys()].sort((a, b) => depth(cells[a]) - depth(cells[b]));
  const keyTimes = KEYFRAMES.map((f) => f.toFixed(2)).join(";");

  const animated = [];
  const still = [];
  for (const i of order) {
    const c = cells[i];
    const color = c.level ? theme.levels[c.level - 1] : theme.empty;
    const fills = [color, shade(color, 0.84), shade(color, 0.68)];
    // Empty days stay flat tiles. Sides go down first so the top covers them.
    const drawn = c.count > 0 ? [2, 1, 0] : [0];
    for (const k of drawn) {
      const values = frames.map((f) => f.faces[i][k]).join(";");
      animated.push(`<polygon fill="${fills[k]}" points="${first.faces[i][k]}"><animate attributeName="points" values="${values}" keyTimes="${keyTimes}" dur="${DURATION}s" begin="${BEGIN}s" fill="freeze"/></polygon>`);
      still.push(`<polygon fill="${fills[k]}" points="${last.faces[i][k]}"/>`);
    }
  }

  // Month names along the top and Mon/Wed/Fri down the side, as on GitHub;
  // they fade out once the map starts to tilt.
  const labels = months.map((m) => {
    const x = first.originX + (m.week + first.inset) * first.scale;
    const y = first.originY - 0.3 * first.scale;
    return `<text x="${round1(x)}" y="${round1(y - 4)}">${m.label}</text>`;
  });
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });
  for (let d = 0; d < 7; d++) {
    const ms = dayMs(cells[d].date);
    if (![1, 3, 5].includes(new Date(ms).getUTCDay())) continue;
    const x = round1(first.originX - 6), y = round1(first.originY + (d + 0.5) * first.scale);
    labels.push(`<text x="${x}" y="${y}" text-anchor="end" dominant-baseline="middle">${weekday.format(ms)}</text>`);
  }

  const number = new Intl.NumberFormat("en-US");
  const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const count = (v, one, many) => `${number.format(v)} ${v === 1 ? one : many}`;
  const summary = [
    `Longest streak ${count(stats.longest, "day", "days")}`,
    stats.busiest.date && `Busiest day ${count(stats.busiest.count, "contribution", "contributions")}, ${monthDay.format(dayMs(stats.busiest.date))}`,
    `Current streak ${count(stats.current, "day", "days")}`,
  ].filter(Boolean).join("   ·   ");
  const title = `${count(stats.total, "contribution", "contributions")} in the last year`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}" role="img" aria-label="${title}. ${summary}">
<title>${title}</title>
<style>
  text { font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; fill: ${theme.muted}; }
  .title { font-size: 17px; font-weight: 600; fill: ${theme.fg}; }
  #still { display: none; }
  @media (prefers-reduced-motion: reduce) { #anim, #labels { display: none; } #still { display: inline; } }
</style>
<text class="title" x="${PAD}" y="30">${title}</text>
<g id="labels"><animate attributeName="opacity" values="1;0" dur="${(DURATION * 0.4).toFixed(2)}s" begin="${BEGIN}s" fill="freeze"/>${labels.join("")}</g>
<g id="anim">${animated.join("")}</g>
<g id="still">${still.join("")}</g>
<text x="${PAD}" y="${height - 22}">${summary}</text>
</svg>
`;
}

// --- Data ----------------------------------------------------------------------

async function fetchDays(login) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const query = `query($login: String!) {
    user(login: $login) {
      contributionsCollection { contributionCalendar { weeks { contributionDays { date contributionCount } } } }
    }
  }`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "contribution-skyline" },
    body: JSON.stringify({ query, variables: { login } }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) {
    throw new Error(`GitHub GraphQL ${res.status}: ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
  }
  return body.data.user.contributionsCollection.contributionCalendar.weeks
    .flatMap((w) => w.contributionDays)
    .map((d) => ({ date: d.date, count: d.contributionCount }));
}

const login = process.argv[2] || "zakijss";
const dataArg = process.argv.indexOf("--data");
const days = dataArg > 0 ? JSON.parse(readFileSync(process.argv[dataArg + 1], "utf8")) : await fetchDays(login);
const end = Math.max(...days.map((d) => dayMs(d.date)));
const grid = buildGrid(days, end);
const model = { ...grid, stats: computeStats(grid.cells), months: monthLabels(grid.cells, grid.weeks) };

for (const [name, theme] of Object.entries(PALETTES)) {
  const svg = render(model, theme);
  writeFileSync(`skyline-${name}.svg`, svg);
  console.log(`skyline-${name}.svg  ${(svg.length / 1024).toFixed(0)} KB`);
}
console.log(`${model.stats.total} contributions, ${grid.cells.length} days, through ${toKey(end)}`);
