// Time-series math for the charts. Pure functions — no DOM, no Firebase.

/** Bucket sizes offered by the "who's winning" chart. */
export const BUCKETS = [
  { key: "1m", label: "Minute", ms: 60e3 },
  { key: "30m", label: "Half hour", ms: 30 * 60e3 },
  { key: "1h", label: "Hour", ms: 3600e3 },
  { key: "6h", label: "6 hours", ms: 6 * 3600e3 },
  { key: "1d", label: "Day", ms: 24 * 3600e3 },
];

/**
 * Settled claims as chart rows, newest last.
 * `mine` is what the bar chart colours by.
 */
export function claimRows(claims, meId) {
  return (claims || [])
    .filter((c) => c.status === "settled")
    .slice()
    .sort((a, b) => a.at - b.at)
    .map((c, i) => ({
      id: c.id,
      order: i + 1,
      at: c.at,
      by: c.by,
      mine: c.by === meId,
      seconds: c.seconds || 0,
      rawSeconds: c.rawSeconds || 0,
      multiplier: c.multiplier || 1,
      viaDuel: !!c.viaDuel,
    }));
}

/**
 * Collapse consecutive claims by the same player into one entry.
 *
 * A burst of clicks from one person reads as noise in the feed — this rolls each
 * run up into a single row carrying the combined total, with the individual
 * claims kept in `items` so the UI can expand them.
 *
 * @param rows chronological rows from claimRows
 */
export function groupRuns(rows) {
  const out = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.by === r.by) {
      last.items.push(r);
      last.seconds += r.seconds;
      last.rawSeconds += r.rawSeconds;
      last.to = r.at;
      last.count = last.items.length;
      if (r.multiplier > 1) last.anyDoubled = true;
      if (r.viaDuel) last.anyDuel = true;
    } else {
      out.push({
        by: r.by,
        mine: r.mine,
        items: [r],
        count: 1,
        seconds: r.seconds,
        rawSeconds: r.rawSeconds,
        from: r.at,
        to: r.at,
        anyDoubled: r.multiplier > 1,
        anyDuel: !!r.viaDuel,
      });
    }
  }
  return out;
}

/** @param mode "time" (as clicked) or "size" (biggest first) */
export function sortRows(rows, mode) {
  const out = rows.slice();
  if (mode === "size") out.sort((a, b) => b.seconds - a.seconds || a.at - b.at);
  return out;
}

/**
 * Running lead after every claim: positive means `meId` is ahead.
 *
 * Returns one point per claim plus a zero point at the start, so the line
 * always begins at "level".
 */
export function leadTimeline(claims, meId) {
  const rows = claimRows(claims, meId);
  if (!rows.length) return [];

  let mine = 0;
  let theirs = 0;
  // `origin` marks this as a synthetic anchor, not a real claim, so bucket
  // counts don't include it.
  const pts = [{ at: rows[0].at - 1, lead: 0, mine: 0, theirs: 0, origin: true }];
  for (const r of rows) {
    if (r.mine) mine += r.seconds;
    else theirs += r.seconds;
    pts.push({ at: r.at, lead: mine - theirs, mine, theirs });
  }
  return pts;
}

/** Lead value in effect at time `t` (step function — last point at or before t). */
function leadAt(pts, t) {
  if (!pts.length) return 0;
  let lo = 0;
  let hi = pts.length - 1;
  if (t < pts[0].at) return 0;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (pts[mid].at <= t) lo = mid;
    else hi = mid - 1;
  }
  return pts[lo].lead;
}

/**
 * Open/high/low/close of the lead, per time bucket — the candlestick data.
 *
 * Open is the lead carried in from the previous bucket, so candles are
 * continuous: each bucket's open equals the previous bucket's close. High and
 * low span every intermediate value the lead actually took inside the bucket,
 * not just the endpoints, so a big swing that reverses is still visible.
 *
 * @param limit max buckets to return (most recent kept)
 */
export function bucketOHLC(claims, meId, bucketMs, nowMs, limit = 60) {
  const pts = leadTimeline(claims, meId);
  if (!pts.length) return [];

  const first = pts[0].at;
  // Align buckets to epoch multiples so they don't shift as time passes.
  const start = Math.floor(first / bucketMs) * bucketMs;
  const end = Math.floor(nowMs / bucketMs) * bucketMs;

  const all = [];
  for (let t0 = start; t0 <= end; t0 += bucketMs) {
    const t1 = t0 + bucketMs;
    const open = leadAt(pts, t0);
    const inside = pts.filter((p) => !p.origin && p.at > t0 && p.at <= Math.min(t1, nowMs));
    const close = inside.length ? inside[inside.length - 1].lead : open;
    const values = [open, close, ...inside.map((p) => p.lead)];
    all.push({
      t0,
      t1,
      open,
      close,
      high: Math.max(...values),
      low: Math.min(...values),
      count: inside.length,
      up: close >= open,
    });
  }

  return all.length > limit ? all.slice(-limit) : all;
}

/**
 * Per-bucket totals for each side — the stacked/line view behind the candles.
 * @param limit max buckets to return (most recent kept)
 */
export function bucketTotals(claims, meId, bucketMs, nowMs, limit = 60) {
  const rows = claimRows(claims, meId);
  if (!rows.length) return [];

  const start = Math.floor(rows[0].at / bucketMs) * bucketMs;
  const end = Math.floor(nowMs / bucketMs) * bucketMs;

  const map = new Map();
  for (let t0 = start; t0 <= end; t0 += bucketMs) {
    map.set(t0, { t0, t1: t0 + bucketMs, mine: 0, theirs: 0 });
  }
  for (const r of rows) {
    const t0 = Math.floor(r.at / bucketMs) * bucketMs;
    const b = map.get(t0);
    if (!b) continue;
    if (r.mine) b.mine += r.seconds;
    else b.theirs += r.seconds;
  }

  const all = [...map.values()];
  return all.length > limit ? all.slice(-limit) : all;
}

/** Pick the bucket size that yields a sensible number of candles for a span. */
export function suggestBucket(spanMs) {
  const target = 40;
  let best = BUCKETS[0];
  let bestErr = Infinity;
  for (const b of BUCKETS) {
    const err = Math.abs(spanMs / b.ms - target);
    if (err < bestErr) {
      bestErr = err;
      best = b;
    }
  }
  return best;
}
