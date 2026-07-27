// Parsing pasted data so a new game can start from existing totals.
//
// Two accepted shapes:
//
//   1. Plain totals, one player per line — the format you'd type by hand:
//        Will: 3h 20m
//        Sam = 2h 05m 30s
//        Alex  5400          (bare number = seconds)
//
//   2. A JSON export from this app (the Export button on a game's page), which
//      round-trips the full claim history rather than just the totals.
//
// The first player listed is always *you* (whoever is creating the game); the
// second is held aside and applied when your opponent joins, since they have no
// player id until then.

/** "3h 20m", "90m", "1:30:00", "5400s", "5400" -> seconds. NaN if unparseable. */
export function parseDuration(input) {
  const s = String(input).trim().toLowerCase();
  if (!s) return NaN;

  // Clock form: 1:30:00 or 30:00
  if (/^\d+(:\d{1,2}){1,2}$/.test(s)) {
    const parts = s.split(":").map(Number);
    return parts.length === 3
      ? parts[0] * 3600 + parts[1] * 60 + parts[2]
      : parts[0] * 60 + parts[1];
  }

  // Unit form: 3h 20m 5s / 3h20m / 90m
  const unit = /(\d+(?:\.\d+)?)\s*(d|h|m|s)/g;
  let total = 0;
  let found = false;
  let m;
  while ((m = unit.exec(s))) {
    found = true;
    const n = parseFloat(m[1]);
    total += n * { d: 86400, h: 3600, m: 60, s: 1 }[m[2]];
  }
  if (found) return total;

  // Bare number = seconds
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  return NaN;
}

/**
 * @returns {{ok:true, kind:'totals'|'json', players:[{name,seconds}], claims?:Array, gameName?:string}}
 *        | {ok:false, error:string}
 */
export function parseImport(text) {
  const raw = String(text || "").trim();
  if (!raw) return { ok: false, error: "Nothing to import." };

  if (raw.startsWith("{") || raw.startsWith("[")) return parseJson(raw);
  if (looksLikeCountdown(raw)) return parseCountdown(raw);

  // --- totals form ---
  const players = [];
  const problems = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("//")) continue;

    const m = t.match(/^(.+?)\s*[:=]\s*(.+)$/) || t.match(/^(\S+)\s+(.+)$/);
    if (!m) {
      problems.push(`Couldn't read "${t}" — use "Name: 1h 30m".`);
      continue;
    }
    const name = m[1].trim();
    const seconds = parseDuration(m[2]);
    if (!Number.isFinite(seconds)) {
      problems.push(`Couldn't read the time in "${t}".`);
      continue;
    }
    if (seconds < 0) {
      problems.push(`"${name}" has a negative time.`);
      continue;
    }
    if (!name) {
      problems.push(`Missing a name in "${t}".`);
      continue;
    }
    players.push({ name: name.slice(0, 24), seconds });
  }

  if (problems.length) return { ok: false, error: problems[0] };
  if (!players.length) return { ok: false, error: "No players found." };
  if (players.length > 2) return { ok: false, error: "A game holds two players; found " + players.length + "." };

  return { ok: true, kind: "totals", players };
}

// ---------------------------------------------------------------------------
// Countdown log
//
// A row per click, in any column order: time remaining until the deadline, the
// percentage of total time elapsed, and who clicked. Tab, comma, or multi-space
// separated — i.e. straight out of a spreadsheet.
//
//   3600    0%      Will
//   3500    2.8%    Sam
//
// The claim for each click is the DROP in remaining since the previous click,
// which is exactly the elapsed-time mechanic this game runs on. The percentage
// column recovers the original total, which is what pins down the first click's
// claim — without it, there's no way to know how much time preceded row one.
// ---------------------------------------------------------------------------

const splitRow = (line) => line.split(/\t|,|\s{2,}/).map((f) => f.trim()).filter(Boolean);

function looksLikeCountdown(raw) {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  let tabular = 0;
  for (const l of lines) {
    const f = splitRow(l);
    if (f.length >= 2 && (Number.isFinite(parseDuration(f[0])) || /%/.test(l))) tabular++;
  }
  return tabular >= Math.max(2, Math.floor(lines.length * 0.6));
}

/** "2.8%" -> 0.028; "0.028" -> 0.028; "2.8" -> 0.028. NaN if not a percentage. */
function parsePercent(field) {
  const s = String(field).trim();
  const hasSign = /%/.test(s);
  const n = parseFloat(s.replace(/%/g, ""));
  if (!Number.isFinite(n)) return NaN;
  if (hasSign) return n / 100;
  if (n >= 0 && n <= 1) return n;
  if (n > 1 && n <= 100) return n / 100;
  return NaN;
}

function parseCountdown(raw) {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows = [];
  let skippedHeader = false;

  for (const line of lines) {
    if (line.startsWith("#") || line.startsWith("//")) continue;
    const fields = splitRow(line);
    if (fields.length < 2) continue;

    let remaining = NaN;
    let pct = NaN;
    let who = "";

    for (const f of fields) {
      if (/%/.test(f) && !Number.isFinite(pct)) {
        pct = parsePercent(f);
        continue;
      }
      const d = parseDuration(f);
      if (Number.isFinite(d) && !Number.isFinite(remaining)) {
        remaining = d;
        continue;
      }
      // A bare number after remaining is taken as the percentage column.
      if (Number.isFinite(d) && !Number.isFinite(pct)) {
        pct = parsePercent(f);
        continue;
      }
      if (!who && !/^[\d.:%\s-]+$/.test(f)) who = f;
    }

    if (!Number.isFinite(remaining) || !who) {
      // Almost certainly the header row.
      if (!skippedHeader && !rows.length) {
        skippedHeader = true;
        continue;
      }
      continue;
    }
    rows.push({ remaining, pct, who: who.slice(0, 24) });
  }

  if (rows.length < 1) {
    return { ok: false, error: "Couldn't find any click rows. Expected: remaining, percent, who." };
  }

  // Chronological = remaining counting down.
  rows.sort((a, b) => b.remaining - a.remaining);

  const names = [...new Set(rows.map((r) => r.who))];
  if (names.length > 2) {
    return { ok: false, error: `Found ${names.length} different names (${names.join(", ")}). A game holds two players.` };
  }

  // Recover the original total from any row where time has actually elapsed:
  // pct = (total - remaining) / total  =>  total = remaining / (1 - pct)
  const totals = rows
    .filter((r) => Number.isFinite(r.pct) && r.pct > 0.0001 && r.pct < 0.9999)
    .map((r) => r.remaining / (1 - r.pct))
    .sort((a, b) => a - b);
  const total = totals.length ? totals[Math.floor(totals.length / 2)] : null;

  return {
    ok: true,
    kind: "countdown",
    rows,
    names,
    total,
    players: names.map((n) => ({ name: n, seconds: 0 })), // filled in on convert
  };
}

/**
 * Turn a parsed countdown log into claim records, given the deadline.
 *
 * Timestamps are absolute: a row with R seconds remaining happened at
 * `endsAt - R`. That makes the import line up with live play afterwards.
 *
 * @returns {{claims:Array, players:Array, firstUnknown:boolean}}
 */
export function countdownToClaims(parsed, endsAt) {
  const { rows, names, total } = parsed;
  const slotOf = new Map(names.map((n, i) => [n, i]));
  const claims = [];

  // What was remaining before the first logged click.
  let prev = Number.isFinite(total) && total !== null ? total : rows[0].remaining;
  const firstUnknown = !(Number.isFinite(total) && total !== null);

  for (const r of rows) {
    const seconds = Math.max(0, prev - r.remaining);
    prev = r.remaining;
    claims.push({
      slot: slotOf.get(r.who),
      at: endsAt - r.remaining * 1000,
      seconds,
      rawSeconds: seconds,
      multiplier: 1,
    });
  }

  const players = names.map((n, i) => ({
    name: n,
    seconds: claims.filter((c) => c.slot === i).reduce((s, c) => s + c.seconds, 0),
  }));

  return { claims, players, firstUnknown };
}

function parseJson(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: "That isn't valid JSON — " + e.message };
  }

  // Accept either a full export or a bare array of {name, seconds}.
  if (Array.isArray(data)) {
    const players = data
      .map((p) => ({ name: String(p.name || "").slice(0, 24), seconds: Number(p.seconds) }))
      .filter((p) => p.name && Number.isFinite(p.seconds) && p.seconds >= 0);
    if (!players.length) return { ok: false, error: "No usable players in that array." };
    if (players.length > 2) return { ok: false, error: "A game holds two players." };
    return { ok: true, kind: "totals", players };
  }

  if (!data.players || typeof data.players !== "object") {
    return { ok: false, error: "Expected a `players` field — is this a Clicky export?" };
  }

  // Map the original player ids onto ordered slots.
  const ids = Object.keys(data.players);
  if (!ids.length) return { ok: false, error: "That export has no players." };
  if (ids.length > 2) return { ok: false, error: "That export has more than two players." };

  const claims = Array.isArray(data.claims)
    ? data.claims
    : data.claims && typeof data.claims === "object"
      ? Object.values(data.claims)
      : [];

  const slotOf = new Map(ids.map((id, i) => [id, i]));
  const cleanClaims = claims
    .filter((c) => c && c.status === "settled" && slotOf.has(c.by))
    .map((c) => ({
      slot: slotOf.get(c.by),
      at: Number(c.at) || 0,
      seconds: Number(c.seconds) || 0,
      rawSeconds: Number(c.rawSeconds ?? c.seconds) || 0,
      multiplier: Number(c.multiplier) || 1,
      viaDuel: !!c.viaDuel,
    }))
    .filter((c) => c.at > 0 && c.seconds >= 0);

  const players = ids.map((id, i) => ({
    name: String(data.players[id]?.name || `Player ${i + 1}`).slice(0, 24),
    seconds: cleanClaims.filter((c) => c.slot === i).reduce((s, c) => s + c.seconds, 0),
  }));

  // No usable claim history — fall back to the stored totals if there are any.
  if (!cleanClaims.length) {
    const withTotals = ids.map((id, i) => ({
      name: String(data.players[id]?.name || `Player ${i + 1}`).slice(0, 24),
      seconds: Number(data.players[id]?.total) || 0,
    }));
    if (withTotals.every((p) => p.seconds === 0)) {
      return { ok: false, error: "That export has no claims to import." };
    }
    return { ok: true, kind: "totals", players: withTotals, gameName: data.meta?.name };
  }

  return {
    ok: true,
    kind: "json",
    players,
    claims: cleanClaims,
    gameName: data.meta?.name,
  };
}

/** Build the export payload for a game. */
export function buildExport(game) {
  return {
    format: "clicky-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    meta: {
      code: game.meta?.code,
      name: game.meta?.name,
      createdAt: game.meta?.createdAt,
      endsAt: game.meta?.endsAt,
    },
    players: Object.fromEntries(
      Object.entries(game.players || {}).map(([id, p]) => [id, { name: p.name }])
    ),
    claims: (game.claims || [])
      .filter((c) => c.status === "settled")
      .map((c) => ({
        by: c.by,
        at: c.at,
        seconds: c.seconds,
        rawSeconds: c.rawSeconds,
        multiplier: c.multiplier,
        status: "settled",
        ...(c.viaDuel ? { viaDuel: c.viaDuel } : {}),
      })),
  };
}
