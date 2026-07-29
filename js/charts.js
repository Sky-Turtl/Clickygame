// SVG chart renderers. No libraries — these build markup strings that the app
// drops into the page, which keeps the site dependency-free and CSP-clean.
//
// Palette: the two-series categorical slots (blue = you, orange = opponent),
// validated against this site's card surface (#141824) for the dark band,
// chroma floor, CVD separation, normal-vision floor, and contrast.
//
// Colour follows the *entity*, not the rank: blue always means you, orange
// always means them — in the bars, in the area fill, and in the candle bodies
// (where "up" means your lead grew). Nothing repaints when a filter changes.

import { fmtDuration, fmtDurationShort, esc } from "./util.js";

export const C = {
  mine: "#3987e5",
  theirs: "#d95926",
  grid: "#262c3d",
  axis: "#66738f",
  text: "#93a0bb",
  textDim: "#66738f",
  zero: "#38405a",
};

const PAD = { top: 14, right: 10, bottom: 26, left: 46 };

const svgOpen = (w, h) =>
  `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" ` +
  `preserveAspectRatio="none" class="chart-svg">`;

function niceTicks(min, max, count = 4) {
  if (min === max) return [min];
  const span = max - min;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(v);
  return out;
}

const empty = (msg) => `<div class="chart-empty">${esc(msg)}</div>`;

// ---------------------------------------------------------------------------
// 1. Per-click bar chart
// ---------------------------------------------------------------------------

/**
 * One bar per claim, height = seconds banked.
 * @param rows from series.claimRows (already sorted by the caller)
 */
export function barChart(rows, { width = 640, height = 200, meName, oppName }) {
  if (!rows.length) return empty("No claims yet.");

  const w = width;
  const h = height;
  const plotW = w - PAD.left - PAD.right;
  const plotH = h - PAD.top - PAD.bottom;

  const max = Math.max(...rows.map((r) => r.seconds), 1);
  const ticks = niceTicks(0, max, 4);
  const yMax = Math.max(max, ticks[ticks.length - 1]);
  const y = (v) => PAD.top + plotH - (v / yMax) * plotH;

  // A 2px surface gap between neighbours; bars shrink to fit rather than scroll.
  const slot = plotW / rows.length;
  const barW = Math.max(1, Math.min(28, slot - (slot > 4 ? 2 : 0.5)));

  let out = svgOpen(w, h);

  // Grid + y labels
  for (const t of ticks) {
    out += `<line x1="${PAD.left}" y1="${y(t).toFixed(1)}" x2="${w - PAD.right}" y2="${y(t).toFixed(1)}" stroke="${C.grid}" stroke-width="1"/>`;
    out += `<text x="${PAD.left - 7}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="${C.textDim}">${esc(fmtDurationShort(t))}</text>`;
  }

  // Bars, with a 4px rounded top anchored to the baseline
  rows.forEach((r, i) => {
    const bx = PAD.left + i * slot + (slot - barW) / 2;
    const by = y(r.seconds);
    const bh = Math.max(1, PAD.top + plotH - by);
    const rad = Math.min(4, barW / 2, bh);
    const fill = r.mine ? C.mine : C.theirs;
    const label =
      `${r.mine ? meName : oppName} · ${fmtDuration(r.seconds)}` +
      (r.multiplier > 1 ? " · 2x" : "") +
      (r.viaDuel ? " · won duel" : "") +
      ` · #${r.order}`;
    out +=
      `<rect class="bar" x="${bx.toFixed(2)}" y="${by.toFixed(2)}" width="${barW.toFixed(2)}" height="${bh.toFixed(2)}" ` +
      `rx="${rad.toFixed(1)}" fill="${fill}"><title>${esc(label)}</title></rect>`;
    // 2x claims get a texture stripe so the bonus isn't colour-only.
    if (r.multiplier > 1 && barW >= 4) {
      out += `<rect x="${bx.toFixed(2)}" y="${by.toFixed(2)}" width="${barW.toFixed(2)}" height="${Math.min(3, bh).toFixed(2)}" rx="1.5" fill="#ffc94d" pointer-events="none"/>`;
    }
  });

  // Baseline
  out += `<line x1="${PAD.left}" y1="${PAD.top + plotH}" x2="${w - PAD.right}" y2="${PAD.top + plotH}" stroke="${C.axis}" stroke-width="1"/>`;
  out += `<text x="${PAD.left}" y="${h - 8}" font-size="10" fill="${C.textDim}">1</text>`;
  out += `<text x="${w - PAD.right}" y="${h - 8}" font-size="10" fill="${C.textDim}" text-anchor="end">${rows.length}</text>`;
  out += `</svg>`;
  return out;
}

// ---------------------------------------------------------------------------
// 2. Lead over time — area
// ---------------------------------------------------------------------------

/**
 * Cumulative lead as a diverging area around zero. Above the line is blue
 * (you ahead), below is orange (them ahead) — the same two hues as everywhere
 * else, so the reading carries over without a new legend.
 */
export function leadArea(buckets, { width = 640, height = 210, meName, oppName }) {
  if (!buckets.length) return empty("Not enough history yet.");

  const w = width;
  const h = height;
  const plotW = w - PAD.left - PAD.right;
  const plotH = h - PAD.top - PAD.bottom;

  const vals = buckets.flatMap((b) => [b.high, b.low, b.close, b.open]);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const span = hi - lo || 1;
  const y = (v) => PAD.top + plotH - ((v - lo) / span) * plotH;
  const x = (i) => PAD.left + (buckets.length === 1 ? plotW / 2 : (i / (buckets.length - 1)) * plotW);

  let out = svgOpen(w, h);

  for (const t of niceTicks(lo, hi, 4)) {
    out += `<line x1="${PAD.left}" y1="${y(t).toFixed(1)}" x2="${w - PAD.right}" y2="${y(t).toFixed(1)}" stroke="${C.grid}" stroke-width="1"/>`;
    out += `<text x="${PAD.left - 7}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="${C.textDim}">${esc((t >= 0 ? "+" : "−") + fmtDurationShort(Math.abs(t)))}</text>`;
  }

  const zeroY = y(0);
  const clipUp = `<clipPath id="clipUp"><rect x="${PAD.left}" y="${PAD.top}" width="${plotW}" height="${Math.max(0, zeroY - PAD.top)}"/></clipPath>`;
  const clipDn = `<clipPath id="clipDn"><rect x="${PAD.left}" y="${zeroY}" width="${plotW}" height="${Math.max(0, PAD.top + plotH - zeroY)}"/></clipPath>`;
  out += `<defs>${clipUp}${clipDn}</defs>`;

  const line = buckets.map((b, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(b.close).toFixed(2)}`).join(" ");
  const area = `${line} L${x(buckets.length - 1).toFixed(2)},${zeroY.toFixed(2)} L${x(0).toFixed(2)},${zeroY.toFixed(2)} Z`;

  out += `<path d="${area}" fill="${C.mine}" opacity="0.20" clip-path="url(#clipUp)"/>`;
  out += `<path d="${area}" fill="${C.theirs}" opacity="0.20" clip-path="url(#clipDn)"/>`;
  out += `<line x1="${PAD.left}" y1="${zeroY.toFixed(1)}" x2="${w - PAD.right}" y2="${zeroY.toFixed(1)}" stroke="${C.zero}" stroke-width="1.5" stroke-dasharray="3 3"/>`;
  out += `<path d="${line}" fill="none" stroke="${C.mine}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" clip-path="url(#clipUp)"/>`;
  out += `<path d="${line}" fill="none" stroke="${C.theirs}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" clip-path="url(#clipDn)"/>`;

  // Invisible hit targets, wider than the marks — also the click-to-zoom targets.
  buckets.forEach((b, i) => {
    const lead = b.close;
    const who = lead > 0 ? `${meName} ahead` : lead < 0 ? `${oppName} ahead` : "level";
    out +=
      `<rect class="chart-zoom-target" data-t0="${b.t0}" data-t1="${b.t1}" ` +
      `x="${(x(i) - plotW / buckets.length / 2).toFixed(2)}" y="${PAD.top}" ` +
      `width="${(plotW / buckets.length).toFixed(2)}" height="${plotH}" fill="transparent">` +
      `<title>${esc(`${fmtTime(b.t0)} — ${who} by ${fmtDuration(Math.abs(lead))} — tap to zoom in`)}</title></rect>`;
  });

  out += axisTimeLabels(buckets, x, h);
  out += `</svg>`;
  return out;
}

// ---------------------------------------------------------------------------
// 3. Lead over time — candlesticks
// ---------------------------------------------------------------------------

/**
 * OHLC candles of the lead. Body spans open→close, wick spans low→high.
 * Blue body = your lead grew over that bucket, orange = it shrank. Direction is
 * also readable from the body's position against the wick, so it is never
 * colour-alone.
 */
export function candleChart(buckets, { width = 640, height = 210, meName, oppName }) {
  if (!buckets.length) return empty("Not enough history yet.");

  const w = width;
  const h = height;
  const plotW = w - PAD.left - PAD.right;
  const plotH = h - PAD.top - PAD.bottom;

  const vals = buckets.flatMap((b) => [b.high, b.low]);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const span = hi - lo || 1;
  const y = (v) => PAD.top + plotH - ((v - lo) / span) * plotH;

  const slot = plotW / buckets.length;
  const bodyW = Math.max(1.5, Math.min(16, slot - 2));

  let out = svgOpen(w, h);

  for (const t of niceTicks(lo, hi, 4)) {
    out += `<line x1="${PAD.left}" y1="${y(t).toFixed(1)}" x2="${w - PAD.right}" y2="${y(t).toFixed(1)}" stroke="${C.grid}" stroke-width="1"/>`;
    out += `<text x="${PAD.left - 7}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="${C.textDim}">${esc((t >= 0 ? "+" : "−") + fmtDurationShort(Math.abs(t)))}</text>`;
  }

  const zeroY = y(0);
  out += `<line x1="${PAD.left}" y1="${zeroY.toFixed(1)}" x2="${w - PAD.right}" y2="${zeroY.toFixed(1)}" stroke="${C.zero}" stroke-width="1.5" stroke-dasharray="3 3"/>`;

  buckets.forEach((b, i) => {
    const cx = PAD.left + i * slot + slot / 2;
    const col = b.up ? C.mine : C.theirs;
    const yo = y(b.open);
    const yc = y(b.close);
    const top = Math.min(yo, yc);
    const bh = Math.max(1.5, Math.abs(yc - yo));

    const who = b.close > 0 ? `${meName} ahead` : b.close < 0 ? `${oppName} ahead` : "level";
    const tip =
      `${fmtTime(b.t0)}\n` +
      `${who} by ${fmtDuration(Math.abs(b.close))}\n` +
      `open ${sign(b.open)} → close ${sign(b.close)}\n` +
      `range ${sign(b.low)} … ${sign(b.high)}\n` +
      `${b.count} claim${b.count === 1 ? "" : "s"}`;

    out += `<g class="candle chart-zoom-target" data-t0="${b.t0}" data-t1="${b.t1}"><title>${esc(tip + "\ntap to zoom in")}</title>`;
    out += `<line x1="${cx.toFixed(2)}" y1="${y(b.high).toFixed(2)}" x2="${cx.toFixed(2)}" y2="${y(b.low).toFixed(2)}" stroke="${col}" stroke-width="1.5"/>`;
    out += `<rect x="${(cx - bodyW / 2).toFixed(2)}" y="${top.toFixed(2)}" width="${bodyW.toFixed(2)}" height="${bh.toFixed(2)}" rx="1.5" fill="${col}"/>`;
    // Hit target wider than the mark
    out += `<rect x="${(cx - slot / 2).toFixed(2)}" y="${PAD.top}" width="${slot.toFixed(2)}" height="${plotH}" fill="transparent"/>`;
    out += `</g>`;
  });

  out += axisTimeLabels(buckets, (i) => PAD.left + i * slot + slot / 2, h);
  out += `</svg>`;
  return out;
}

// ---------------------------------------------------------------------------

function sign(v) {
  return (v >= 0 ? "+" : "−") + fmtDurationShort(Math.abs(v));
}

function fmtTime(ms) {
  const d = new Date(ms);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** First / middle / last time labels only — never one per bucket. */
function axisTimeLabels(buckets, x, h) {
  if (!buckets.length) return "";
  const picks = [0];
  if (buckets.length > 2) picks.push(Math.floor((buckets.length - 1) / 2));
  if (buckets.length > 1) picks.push(buckets.length - 1);

  return picks
    .map((i, n) => {
      const anchor = n === 0 ? "start" : n === picks.length - 1 ? "end" : "middle";
      return `<text x="${x(i).toFixed(1)}" y="${h - 8}" font-size="10" fill="${C.textDim}" text-anchor="${anchor}">${esc(fmtTime(buckets[i].t0))}</text>`;
    })
    .join("");
}

/** Legend markup — identity is never carried by colour alone. */
export function legend(meName, oppName) {
  return (
    `<div class="chart-legend">` +
    `<span class="lg"><span class="sw" style="background:${C.mine}"></span>${esc(meName)}</span>` +
    `<span class="lg"><span class="sw" style="background:${C.theirs}"></span>${esc(oppName)}</span>` +
    `</div>`
  );
}
