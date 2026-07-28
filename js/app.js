// Clicky — app shell, rendering, and the multi-game claim fan-out.

import { isConfigured, MIN_CLAIM_INTERVAL_MS, TIE_WINDOW_MS } from "./config.js";
import * as discord from "./discord.js";
import {
  PERIODS,
  THROW_EMOJI,
  doubleHoursFor,
  multiplierAt,
  summarize,
  windowStatus,
} from "./rules.js";
import {
  esc,
  fmtAgo,
  fmtDuration,
  fmtDurationShort,
  localPlayerId,
  makeGameCode,
  store,
  utcDayKey,
  utcHourToLocalRange,
} from "./util.js";
import { BUCKETS, bucketOHLC, claimRows, groupRuns, sortRows } from "./series.js";
import { barChart, candleChart, leadArea, legend } from "./charts.js";
import { buildExport, countdownToClaims, parseImport } from "./importer.js";

const $ = (id) => document.getElementById(id);

// `?demo` runs the whole game against an in-memory store with a practice bot —
// no Firebase, and no risk of writing to a real game while testing.
//
// The store is picked here rather than in a separate demo page. dev/index.html
// used to be a copy of this app's HTML, which silently went stale every time
// index.html changed; a dynamic import keeps one page and one source of truth.
// Nothing under dev/ is fetched unless ?demo is present.
const IS_DEMO = new URLSearchParams(location.search).has("demo");
if (IS_DEMO) globalThis.CLICKY_DEMO = true;
const db = IS_DEMO ? await import("../dev/mock-store.js") : await import("./store.js");

// --- App state --------------------------------------------------------------

const me = {
  id: localPlayerId(),
  name: store.get("name", ""),
  discordId: store.get("discordId", ""),
};

/** Local roster: which games this browser has joined, and which are synced. */
let roster = store.get("roster", []); // [{ code, synced }]

/** Live mirror of each game, keyed by code. */
const games = new Map(); // code -> { meta, players, presence, state, claims, unwatch }

let currentDetail = null; // code of the game open on the detail screen
let claiming = false;
/** Duels already announced/toasted locally, so we don't repeat on every render. */
const seenDuels = new Set();
const seenResults = new Set();
let lastWindowState = new Map(); // code -> boolean (was 2x active last tick)
let lastClaimIds = new Map(); // code -> last claim id we've already put in the feed

// Chart controls
let clickSort = store.get("clickSort", "time"); // "time" | "size"
let leadStyle = store.get("leadStyle", "area"); // "area" | "candle"
let bucketKey = store.get("bucketKey", "1h");

// --- Boot -------------------------------------------------------------------

(async function boot() {
  wireSetup();
  wireHub();
  wireDetail();
  wireModals();

  if (!isConfigured()) {
    $("config-warning").classList.remove("hidden");
    document.querySelectorAll("#panel-new button, #panel-join button").forEach(
      (b) => (b.disabled = true)
    );
    return;
  }

  await db.init();
  db.onConnectionChange((online) => {
    const dot = $("conn-dot");
    dot.classList.toggle("online", online);
    dot.classList.toggle("offline", !online);
    dot.title = online ? "Connected" : "Reconnecting…";
  });

  // Deep link: ?g=ABC123 prefills the join form.
  const linked = new URLSearchParams(location.search).get("g");
  if (linked) {
    switchTab("join");
    $("join-code").value = linked.toUpperCase();
  }

  for (const entry of roster) watchGameCode(entry.code);

  if (roster.length) showScreen("hub");
  else showScreen("setup");

  setInterval(tick, 200);
  tick();
})();

// --- Screens ----------------------------------------------------------------

function showScreen(which) {
  for (const s of ["setup", "hub", "detail"]) {
    $("screen-" + s).classList.toggle("hidden", s !== which);
  }
  window.scrollTo(0, 0);
  if (which === "setup") renderRejoin();
}

/** The main screen: the hub once you're in a game, otherwise setup. */
function goHome() {
  currentDetail = null;
  showScreen(roster.length ? "hub" : "setup");
  render();
}

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.innerHTML = msg;
  $("toast-host").appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .3s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 320);
  }, 4200);
}

// --- Setup screen -----------------------------------------------------------

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $("panel-new").classList.toggle("active", name === "new");
  $("panel-join").classList.toggle("active", name === "join");
}

function wireSetup() {
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => switchTab(t.dataset.tab))
  );

  // Default the deadline to 30 days out.
  const d = new Date(Date.now() + 30 * 86400e3);
  $("new-enddate").value =
    d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  $("new-enddate").min = new Date(Date.now() + 3600e3).toISOString().slice(0, 10);

  if (me.name) {
    $("new-name").value = me.name;
    $("join-name").value = me.name;
  }

  let previewTimer;
  const schedulePreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updateImportPreview, 250);
  };
  $("new-import").addEventListener("input", schedulePreview);
  $("new-name").addEventListener("input", schedulePreview);
  $("new-enddate").addEventListener("change", schedulePreview);

  $("panel-new").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("new-error");
    err.classList.add("hidden");
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;

    try {
      const name = $("new-name").value.trim();
      if (!name) throw new Error("Pick a name first.");

      const dateStr = $("new-enddate").value;
      if (!dateStr) throw new Error("Choose an end date.");
      const [y, m, dd] = dateStr.split("-").map(Number);
      // 23:59:59 local time on the chosen day.
      const endsAt = new Date(y, m - 1, dd, 23, 59, 59, 999).getTime();
      if (endsAt <= db.now()) throw new Error("The end date has to be in the future.");

      saveProfile(name, $("new-discordid").value.trim());

      // Imported history, if any. Parsed here so a bad paste fails before we
      // create anything.
      const seed = buildSeed($("new-import").value, endsAt, name);
      if (seed?.error) throw new Error(seed.error);

      // Vanishingly unlikely, but don't stomp an existing game.
      let code = makeGameCode();
      for (let i = 0; i < 5 && (await db.gameExists(code)); i++) code = makeGameCode();

      await db.createGame({
        code,
        name: $("new-gamename").value.trim(),
        webhook: $("new-webhook").value.trim(),
        endsAt,
        player: me,
        seed: seed?.data,
      });

      addToRoster(code);
      watchGameCode(code);
      showScreen("hub");
      toast(`Game <strong>${code}</strong> created. Send that code to your opponent.`, "good");
    } catch (ex) {
      err.textContent = ex.message || "Something went wrong.";
      err.classList.remove("hidden");
    } finally {
      btn.disabled = false;
    }
  });

  $("panel-join").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("join-error");
    err.classList.add("hidden");
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;

    try {
      const code = $("join-code").value.trim().toUpperCase();
      const name = $("join-name").value.trim();
      if (!name) throw new Error("Pick a name first.");
      if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error("Game codes are 6 letters and numbers.");
      if (roster.some((r) => r.code === code)) throw new Error("You're already in that game.");
      if (!(await db.gameExists(code))) throw new Error("No game with that code.");

      saveProfile(name, $("join-discordid").value.trim());
      await db.joinGame({ code, player: me });

      addToRoster(code);
      watchGameCode(code);
      showScreen("hub");
      toast(`Joined <strong>${code}</strong>. Your clicks now count here too.`, "good");
      $("join-code").value = "";
    } catch (ex) {
      err.textContent = ex.message || "Couldn't join that game.";
      err.classList.remove("hidden");
    } finally {
      btn.disabled = false;
    }
  });
}

/**
 * Parse the import textarea into the shape store.createGame wants.
 *
 * Slot 0 is always you. If the log names you second, the slots are swapped so
 * the history lands on the right player — matching on the name you typed.
 *
 * @returns null (nothing pasted) | {error} | {data, summary}
 */
function buildSeed(text, endsAt, myName) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const parsed = parseImport(raw);
  if (!parsed.ok) return { error: parsed.error };

  let players = parsed.players;
  let claims = parsed.claims;
  let firstUnknown = false;
  let total = null;

  if (parsed.kind === "countdown") {
    // The log counted down to some instant, which is not necessarily this
    // game's deadline — importing the same history into games with different
    // end dates has to keep the original anchor.
    const anchorRaw = $("new-anchor").value;
    const anchorMs = anchorRaw ? new Date(anchorRaw).getTime() : endsAt;
    if (anchorRaw && !Number.isFinite(anchorMs)) {
      return { error: "Couldn't read the 'counted down to' date." };
    }
    const totalRaw = $("new-total").value.trim().replace(/[, ]/g, "");
    const totalOverride = totalRaw ? Number(totalRaw) : undefined;
    if (totalRaw && !(Number.isFinite(totalOverride) && totalOverride > 0)) {
      return { error: "'Starting seconds' must be a positive number." };
    }

    const conv = countdownToClaims(parsed, anchorMs, totalOverride);
    players = conv.players;
    claims = conv.claims;
    firstUnknown = conv.firstUnknown;
    total = conv.total;
  }

  // Put whoever matches the creator's name in slot 0.
  const mineIdx = players.findIndex((p) => p.name.toLowerCase() === myName.trim().toLowerCase());
  if (mineIdx > 0) {
    players = [players[mineIdx], ...players.filter((_, i) => i !== mineIdx)];
    if (claims) claims = claims.map((c) => ({ ...c, slot: c.slot === mineIdx ? 0 : 1 }));
  }

  return {
    data: { players, claims },
    summary: {
      players,
      claimCount: claims?.length ?? 0,
      kind: parsed.kind,
      firstUnknown,
      total,
      matchedName: mineIdx >= 0,
      firstAt: claims?.length ? Math.min(...claims.map((c) => c.at)) : null,
      lastAt: claims?.length ? Math.max(...claims.map((c) => c.at)) : null,
    },
  };
}

/** Live feedback under the import box, so a bad paste is obvious before submit. */
function updateImportPreview() {
  const box = $("import-preview");
  const raw = $("new-import").value.trim();
  if (!raw) {
    box.classList.add("hidden");
    return;
  }

  const dateStr = $("new-enddate").value;
  let endsAt = db.now() + 30 * 86400e3;
  if (dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    endsAt = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
  }

  const seed = buildSeed(raw, endsAt, $("new-name").value || "");
  box.classList.remove("hidden");

  if (!seed || seed.error) {
    box.className = "import-preview bad";
    box.innerHTML = `⚠ ${esc(seed?.error || "Couldn't read that.")}`;
    return;
  }

  const s = seed.summary;
  const span =
    s.firstAt && s.lastAt
      ? `<div class="ip-note">Spans ${new Date(s.firstAt).toLocaleString()} → ` +
        `${new Date(s.lastAt).toLocaleString()}${
          s.total ? `, from a ${fmtDuration(s.total)} countdown` : ""
        }.</div>`
      : "";

  box.className = "import-preview good";
  box.innerHTML =
    `✓ Read ${s.claimCount ? `<strong>${s.claimCount}</strong> clicks` : "totals"} for ` +
    s.players.map((p) => `<strong>${esc(p.name)}</strong> ${fmtDuration(p.seconds)}`).join(" vs ") +
    span +
    (s.players.length > 1
      ? `<div class="ip-note">${esc(s.players[0].name)} is you; ` +
        `${esc(s.players[1].name)}'s history is applied when they join with the game code.</div>`
      : "") +
    (s.firstUnknown
      ? `<div class="ip-note">No percentages found, so the time before the first row ` +
        `couldn't be worked out — that first click counts as 0.</div>`
      : "") +
    (!s.matchedName && $("new-name").value.trim()
      ? `<div class="ip-note">Your name isn't in the log, so the first listed player is ` +
        `treated as you.</div>`
      : "");
}

function saveProfile(name, discordId) {
  me.name = name;
  me.discordId = discordId || "";
  store.set("name", me.name);
  store.set("discordId", me.discordId);
}

// --- Roster -----------------------------------------------------------------

function addToRoster(code) {
  if (!roster.some((r) => r.code === code)) {
    roster = [...roster, { code, synced: true }];
    store.set("roster", roster);
  }
}

function removeFromRoster(code) {
  roster = roster.filter((r) => r.code !== code);
  store.set("roster", roster);
  games.get(code)?.unwatch?.();
  games.delete(code);
  if (!roster.length) showScreen("setup");
}

function isSynced(code) {
  return roster.find((r) => r.code === code)?.synced !== false;
}

function toggleSync(code) {
  roster = roster.map((r) => (r.code === code ? { ...r, synced: !isSynced(code) } : r));
  store.set("roster", roster);
  render();
}

function watchGameCode(code) {
  if (games.has(code)) return;
  const g = { code, meta: null, players: {}, presence: {}, state: {}, claims: [] };
  games.set(code, g);
  g.unwatch = db.watchGame(code, (patch) => {
    Object.assign(g, patch);
    if (patch.state) onStateChange(g);
    if (patch.claims) onClaimsChange(g);
    render();
  });
  db.trackPresence(code, me.id);
}

// --- Derived helpers --------------------------------------------------------

const isOver = (g) => !!g.meta?.endsAt && db.now() > g.meta.endsAt;

/** The other player, or null while a game is still waiting for one. */
function opponentOf(g) {
  const id = Object.keys(g.players || {}).find((p) => p !== me.id);
  return id ? { id, ...g.players[id] } : null;
}

function totalsFor(g) {
  const ids = Object.keys(g.players || {});
  // While a duel is unresolved its disputed claim is still marked 'settled' in
  // the database (see store.claim). Nobody owns that time yet, so hide it.
  const escrowed = g.state?.duel?.status === "open" ? g.state.duel.disputedClaimId : null;
  const claims = escrowed ? (g.claims || []).filter((c) => c.id !== escrowed) : g.claims || [];
  const rows = summarize(claims, ids, db.now());
  return { ids, rows };
}

/** Seconds currently sitting on this game's clock, unclaimed. */
function onClock(g) {
  if (!g.state?.lastClaimAt) return 0;
  const end = isOver(g) ? g.meta.endsAt : db.now();
  return Math.max(0, (end - g.state.lastClaimAt) / 1000);
}

function openDuelFor(g) {
  const d = g.state?.duel;
  if (!d || d.status !== "open") return null;
  if (d.challenger !== me.id && d.defender !== me.id) return null;
  return d;
}

/** Duels I'm in that I haven't thrown for yet — these block the claim button. */
function pendingThrows() {
  const out = [];
  for (const g of games.values()) {
    const d = openDuelFor(g);
    if (d && !(d.picks || {})[me.id]) out.push({ g, duel: d });
  }
  return out;
}

/** Milliseconds left on my per-player cooldown in this game (0 if ready). */
function cooldownLeft(g) {
  const mine = g.state?.lastBy?.[me.id];
  if (!mine) return 0;
  return Math.max(0, MIN_CLAIM_INTERVAL_MS - (db.now() - mine));
}

/** Games a click would actually land in right now. */
function claimableGames() {
  return roster
    .filter((r) => r.synced !== false)
    .map((r) => games.get(r.code))
    .filter(
      (g) =>
        g &&
        g.meta &&
        !isOver(g) &&
        !(g.state?.duel?.status === "open") &&
        cooldownLeft(g) === 0
    );
}

/** Synced games blocked purely by the cooldown — used for the countdown label. */
function coolingGames() {
  return roster
    .filter((r) => r.synced !== false)
    .map((r) => games.get(r.code))
    .filter(
      (g) => g && g.meta && !isOver(g) && !(g.state?.duel?.status === "open") && cooldownLeft(g) > 0
    );
}

// --- The claim action -------------------------------------------------------

async function doClaim() {
  if (claiming) return;

  const blocked = pendingThrows();
  if (blocked.length) {
    openDuelModal();
    return;
  }

  const targets = claimableGames();
  if (!targets.length) return;

  claiming = true;
  $("btn-claim").disabled = true;

  // Fire every game in parallel so the timestamps stay as close together as
  // possible — a synced click should feel like one action, not a queue.
  const results = await Promise.allSettled(targets.map((g) => db.claim(g.code, me.id)));

  let banked = 0;
  let duels = 0;
  const claimedIn = [];

  results.forEach((res, i) => {
    const g = targets[i];
    if (res.status !== "fulfilled") return;
    const r = res.value;

    if (r.outcome === "claim") {
      banked += r.claim.seconds;
      claimedIn.push({ g, claim: r.claim });
      const opp = opponentOf(g);
      discord.notifyClaim(g.meta?.webhook, {
        actor: { name: me.name, discordId: me.discordId },
        opponent: opp,
        seconds: r.claim.seconds,
        multiplier: r.claim.multiplier,
        gameCode: g.code,
      });
    } else if (r.outcome === "duel") {
      duels++;
    }
  });

  claiming = false;
  render();

  if (banked > 0) {
    const where =
      claimedIn.length === 1
        ? esc(gameLabel(claimedIn[0].g))
        : `${claimedIn.length} games`;
    toast(`Claimed <strong>${fmtDuration(banked)}</strong> across ${where}.`, "good");
  }
  if (duels > 0) {
    toast(`⚔️ Contested in ${duels} game${duels > 1 ? "s" : ""} — throw to settle.`, "warn");
    openDuelModal();
  }
  if (!banked && !duels) toast("Nothing landed — the clock had just been claimed.", "");
}

// --- Reacting to remote changes ---------------------------------------------

function onStateChange(g) {
  const d = g.state?.duel;
  if (!d) return;

  // A duel I'm in just opened.
  if (d.status === "open" && !seenDuels.has(d.id)) {
    seenDuels.add(d.id);
    if (d.challenger === me.id || d.defender === me.id) {
      announceDuelStart(g, d);
      openDuelModal();
    }
  }

  // Both throws are in — race to settle it. The transaction picks one winner.
  if (d.status === "open" && d.picks && d.picks[d.challenger] && d.picks[d.defender]) {
    db.trySettleDuel(g.code, d.id).then((r) => {
      if (r) announceDuelOutcome(g, r);
    });
  }

  if (d.status === "resolved" && !seenResults.has(d.id)) {
    seenResults.add(d.id);
    if (d.challenger === me.id || d.defender === me.id) renderDuelModal();
  }
}

function onClaimsChange(g) {
  const latest = (g.claims || []).filter((c) => c.status === "settled").at(-1);
  // Mark the game as seen even when it has no claims yet, so that the *first*
  // claim of a brand-new game still notifies rather than being mistaken for
  // pre-existing history.
  const seenBefore = lastClaimIds.has(g.code);
  const prev = lastClaimIds.get(g.code);
  lastClaimIds.set(g.code, latest?.id ?? null);
  if (!latest) return;

  // Only surface the *other* player's claims, and never replay history on load.
  if (seenBefore && latest.id !== prev && latest.by !== me.id) {
    const who = g.players?.[latest.by]?.name || "Someone";
    toast(
      `<strong>${esc(who)}</strong> claimed ${fmtDuration(latest.seconds)} in ` +
        `${esc(gameLabel(g))}.`,
      "warn"
    );
  }
}

async function announceDuelStart(g, d) {
  if (!(await db.claimAnnouncement(g.code, `duel-${d.id}-start`))) return;
  discord.notifyDuelStart(g.meta?.webhook, {
    challenger: { name: g.players?.[d.challenger]?.name || "?", discordId: g.players?.[d.challenger]?.discordId },
    defender: { name: g.players?.[d.defender]?.name || "?", discordId: g.players?.[d.defender]?.discordId },
    potSeconds: d.potSeconds,
    gapMs: d.gapMs,
    gameCode: g.code,
  });
}

async function announceDuelOutcome(g, r) {
  const d = r.duel;
  const key = r.draw ? `duel-${d.id}-draw-${d.round}` : `duel-${d.id}-result`;
  if (!(await db.claimAnnouncement(g.code, key))) return;

  const nameOf = (id) => g.players?.[id]?.name || "?";
  const picks = r.draw ? d.picks || {} : d.finalPicks || {};
  const throws = {};
  for (const [pid, t] of Object.entries(picks)) throws[nameOf(pid)] = `${THROW_EMOJI[t]} ${t}`;
  // On a draw the picks were already cleared; fall back to the recorded throw.
  if (r.draw && d.lastDraw?.throw) {
    throws[nameOf(d.challenger)] = `${THROW_EMOJI[d.lastDraw.throw]} ${d.lastDraw.throw}`;
    throws[nameOf(d.defender)] = `${THROW_EMOJI[d.lastDraw.throw]} ${d.lastDraw.throw}`;
  }

  discord.notifyDuelResult(g.meta?.webhook, {
    winner: { name: nameOf(d.winner) },
    loser: { name: nameOf(d.loser) },
    throws,
    potSeconds: d.potSeconds,
    draw: r.draw,
    gameCode: g.code,
  });
}

/** Watch for 2x windows opening and closing, and announce the transition once. */
async function checkWindows(g) {
  if (isOver(g)) return;
  const active = multiplierAt(g.code, db.now()) > 1;
  const was = lastWindowState.get(g.code);
  lastWindowState.set(g.code, active);
  if (was === undefined || was === active) return;

  const dayKey = utcDayKey(db.now());
  const hour = new Date(db.now()).getUTCHours();
  const key = `2x-${dayKey}-${active ? hour : (hour + 23) % 24}-${active ? "open" : "close"}`;
  if (!(await db.claimAnnouncement(g.code, key))) return;

  discord.notifyWindow(g.meta?.webhook, {
    opening: active,
    gameCode: g.code,
    players: Object.values(g.players || {}),
    localRange: utcHourToLocalRange(dayKey, active ? hour : (hour + 23) % 24),
  });
  if (active) toast(`🔥 <strong>2x is live</strong> in ${esc(gameLabel(g))} for the next hour.`, "warn");
}

// --- Rendering --------------------------------------------------------------

function gameLabel(g) {
  return g.meta?.name?.trim() || g.code;
}

function tick() {
  for (const g of games.values()) checkWindows(g);
  render();
}

function render() {
  if (!$("screen-setup").classList.contains("hidden")) renderRejoin();
  if (!$("screen-hub").classList.contains("hidden")) renderHub();
  if (!$("screen-detail").classList.contains("hidden")) renderDetail();
  $("brand-logo").classList.toggle("clickable", roster.length > 0);
  renderDuelModal();
}

function renderHub() {
  const targets = claimableGames();
  const cooling = coolingGames();
  const blocked = pendingThrows();
  // The clock keeps ticking during a cooldown, so keep those games in the total.
  const shown = targets.length ? targets : cooling;
  const totalOnClock = shown.reduce((sum, g) => sum + onClock(g), 0);
  const anyHot = shown.some((g) => multiplierAt(g.code, db.now()) > 1);

  $("clock").textContent = fmtDuration(totalOnClock);
  $("clock").classList.toggle("hot", anyHot);

  const syncedCount = roster.filter((r) => r.synced !== false).length;
  $("clock-label").textContent =
    shown.length > 1 ? `On the clock across ${shown.length} games` : "On the clock";

  const hotGames = shown.filter((g) => multiplierAt(g.code, db.now()) > 1);
  $("clock-sub").innerHTML = hotGames.length
    ? `⚡ 2x active in ${hotGames.map((g) => esc(gameLabel(g))).join(", ")}`
    : targets.length
      ? "Claim it before they do."
      : "";

  const btn = $("btn-claim");
  const note = $("claim-note");
  btn.classList.toggle("hot", anyHot && !blocked.length);

  if (blocked.length) {
    btn.disabled = false;
    btn.querySelector(".btn-claim-text").textContent = "THROW TO CONTINUE";
    $("btn-claim-sub").textContent = `${blocked.length} duel${blocked.length > 1 ? "s" : ""} waiting on you`;
    note.textContent = "Claiming is locked until you've picked rock, paper or scissors.";
  } else if (!targets.length && cooling.length) {
    // Nothing to claim into only because the cooldown is still running.
    const left = Math.max(...cooling.map(cooldownLeft));
    btn.disabled = true;
    btn.classList.remove("hot");
    btn.querySelector(".btn-claim-text").textContent = (left / 1000).toFixed(1) + "s";
    $("btn-claim-sub").textContent = "cooling down";
    note.textContent = `You have to wait ${MIN_CLAIM_INTERVAL_MS / 1000}s between your own claims. Your opponent doesn't.`;
  } else if (!targets.length) {
    btn.disabled = true;
    btn.querySelector(".btn-claim-text").textContent = "CLAIM";
    $("btn-claim-sub").textContent = syncedCount ? "" : "no games synced";
    note.textContent = syncedCount
      ? "Every synced game is finished or settling."
      : "Turn on sync for at least one game.";
  } else {
    btn.disabled = claiming;
    btn.querySelector(".btn-claim-text").textContent = "CLAIM";
    $("btn-claim-sub").textContent =
      targets.length > 1 ? `banks into ${targets.length} games` : "";
    note.textContent = "";
  }

  $("sync-hint").textContent = `${syncedCount} of ${roster.length} synced`;
  renderHubStats();

  // Banners
  const banners = [];
  for (const g of games.values()) {
    if (isOver(g)) {
      const { ids, rows } = totalsFor(g);
      const ranked = ids.sort((a, b) => rows[b].all.claimed - rows[a].all.claimed);
      const winner = ranked[0];
      const tie = ranked.length > 1 && rows[ranked[0]].all.claimed === rows[ranked[1]].all.claimed;
      banners.push(
        `<div class="banner banner-info">🏁 <strong>${esc(gameLabel(g))}</strong> has ended — ` +
          (tie
            ? "it's a dead tie."
            : `<strong>${esc(g.players?.[winner]?.name || "?")}</strong> wins with ${fmtDuration(rows[winner].all.claimed)}.`) +
          `</div>`
      );
    }
  }
  $("hub-banners").innerHTML = banners.join("");

  renderGameList();
}

function renderGameList() {
  const host = $("game-list");
  const html = roster
    .map((entry) => {
      const g = games.get(entry.code);
      if (!g || !g.meta) {
        return `<div class="game-card loading"><div class="gc-name">${esc(entry.code)}</div>
                <div class="gc-sub">loading…</div></div>`;
      }

      const { rows } = totalsFor(g);
      const opp = opponentOf(g);
      const mine = rows[me.id]?.all.claimed || 0;
      const theirs = opp ? rows[opp.id]?.all.claimed || 0 : 0;
      const lead = mine - theirs;
      const over = isOver(g);
      const hot = !over && multiplierAt(g.code, db.now()) > 1;
      const duel = openDuelFor(g);
      const synced = entry.synced !== false;
      const oppOnline = opp && g.presence?.[opp.id]?.online;

      const remain = g.meta.endsAt - db.now();
      const deadline = over
        ? "ended"
        : remain < 86400e3
          ? `${Math.max(0, Math.floor(remain / 3600e3))}h left`
          : `${Math.ceil(remain / 86400e3)}d left`;

      return `
      <div class="game-card ${over ? "over" : ""} ${duel ? "duel" : ""}" data-code="${esc(g.code)}">
        <div class="gc-main" data-open="${esc(g.code)}">
          <div class="gc-head">
            <span class="gc-name">${esc(gameLabel(g))}</span>
            ${hot ? '<span class="gc-flag hot">2x</span>' : ""}
            ${duel ? '<span class="gc-flag duel">DUEL</span>' : ""}
            ${over ? '<span class="gc-flag over">ENDED</span>' : ""}
          </div>
          <div class="gc-bar">
            <div class="gc-bar-mine" style="width:${
              mine + theirs > 0 ? Math.round((mine / (mine + theirs)) * 100) : 50
            }%"></div>
          </div>
          <div class="gc-scores">
            <span class="gc-me">You ${fmtDurationShort(mine)}</span>
            <span class="gc-lead ${lead >= 0 ? "up" : "down"}">
              ${opp ? (lead === 0 ? "level" : `${lead > 0 ? "+" : "−"}${fmtDurationShort(Math.abs(lead))}`) : "waiting for player 2"}
            </span>
            <span class="gc-them">${
              opp ? `${esc(opp.name)} ${fmtDurationShort(theirs)}` : `code ${esc(g.code)}`
            }<span class="dot ${oppOnline ? "online" : ""}"></span></span>
          </div>
          <div class="gc-sub">
            ${over ? "" : `<span class="gc-clock">${fmtDuration(onClock(g))} on the clock</span> · `}${deadline}
          </div>
        </div>
        <button class="sync-toggle ${synced ? "on" : ""}" data-sync="${esc(g.code)}"
                title="${synced ? "Synced — clicks land here" : "Not synced"}"
                ${over ? "disabled" : ""}>
          <span class="knob"></span>
          <span class="sync-label">${synced ? "SYNC" : "OFF"}</span>
        </button>
      </div>`;
    })
    .join("");

  if (host.dataset.sig !== html) {
    host.dataset.sig = html;
    host.innerHTML = html;
    host.querySelectorAll("[data-sync]").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleSync(b.dataset.sync);
      })
    );
    host.querySelectorAll("[data-open]").forEach((b) =>
      b.addEventListener("click", () => openDetail(b.dataset.open))
    );
  }
}

// --- Rejoin list (setup screen) ---------------------------------------------

/**
 * The setup screen doubles as home, so it lists the games this browser is
 * already in. Reachable via the logo or "+ Game", which is otherwise a one-way
 * trip into the join form.
 */
function renderRejoin() {
  const section = $("rejoin-section");
  section.classList.toggle("hidden", roster.length === 0);
  if (!roster.length) return;

  $("rejoin-hint").textContent = `${roster.length} game${roster.length > 1 ? "s" : ""}`;

  const html = roster
    .map((entry) => {
      const g = games.get(entry.code);
      if (!g || !g.meta) {
        return `<div class="game-card loading" data-rejoin="${esc(entry.code)}">
          <div class="gc-main"><div class="gc-name">${esc(entry.code)}</div>
          <div class="gc-sub">loading…</div></div></div>`;
      }
      const { rows } = totalsFor(g);
      const opp = opponentOf(g);
      const mine = rows[me.id]?.all.claimed || 0;
      const theirs = opp ? rows[opp.id]?.all.claimed || 0 : 0;
      const over = isOver(g);
      const remain = g.meta.endsAt - db.now();

      return `<div class="game-card ${over ? "over" : ""}" data-rejoin="${esc(g.code)}">
        <div class="gc-main">
          <div class="gc-head">
            <span class="gc-name">${esc(gameLabel(g))}</span>
            ${over ? '<span class="gc-flag over">ENDED</span>' : ""}
            <span class="gc-code">${esc(g.code)}</span>
          </div>
          <div class="gc-scores">
            <span class="gc-me">You ${fmtDurationShort(mine)}</span>
            <span class="gc-them">${
              opp ? `${esc(opp.name)} ${fmtDurationShort(theirs)}` : "waiting for player 2"
            }</span>
          </div>
          <div class="gc-sub">${
            over
              ? "ended"
              : remain < 86400e3
                ? `${Math.max(0, Math.floor(remain / 3600e3))}h left`
                : `${Math.ceil(remain / 86400e3)}d left`
          }</div>
        </div>
        <span class="rejoin-arrow">→</span>
      </div>`;
    })
    .join("");

  const host = $("rejoin-list");
  if (host.dataset.sig === html) return;
  host.dataset.sig = html;
  host.innerHTML = html;
  host.querySelectorAll("[data-rejoin]").forEach((el) =>
    el.addEventListener("click", () => {
      showScreen("hub");
      render();
    })
  );
}

// --- Hub stats --------------------------------------------------------------

/**
 * Summary on the main screen, scoped to one game or aggregated across all of
 * them. In the aggregate view opponents are pooled — each game is its own 1v1,
 * so a single "them" column is the only thing that reads sensibly.
 */
function renderHubStats() {
  const sel = $("stats-scope");

  // Rebuild the dropdown only when the set of games actually changes, so it
  // isn't yanked out from under the user mid-interaction.
  const optSig = roster.map((r) => `${r.code}:${gameLabel(games.get(r.code) || { code: r.code })}`).join("|");
  if (sel.dataset.sig !== optSig) {
    const keep = sel.value;
    sel.dataset.sig = optSig;
    sel.innerHTML =
      `<option value="__all__">All games</option>` +
      roster
        .map((r) => {
          const g = games.get(r.code);
          return `<option value="${esc(r.code)}">${esc(g ? gameLabel(g) : r.code)}</option>`;
        })
        .join("");
    if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }

  const scope = sel.value || "__all__";
  const single = scope !== "__all__" ? games.get(scope) : null;

  if (single && single.meta) {
    renderStatsFor([single], single, "hub-summary-table", "hub-stat-grid");
    renderCharts([single], single);
  } else {
    const all = roster.map((r) => games.get(r.code)).filter((g) => g && g.meta);
    renderStatsFor(all, null, "hub-summary-table", "hub-stat-grid");
    renderCharts(all, null);
  }
}

// --- Charts -----------------------------------------------------------------

/**
 * Both charts follow the stats scope selector.
 *
 * Across several games the claim streams are merged: each game is its own 1v1
 * against you, so "you vs them" still reads correctly in aggregate even though
 * the opponents differ. When exactly one game is in scope we can use the real
 * opponent's name.
 */
function renderCharts(list, single) {
  const width = Math.max(280, Math.min(680, ($("chart-clicks").clientWidth || 620)));

  // Merge every in-scope game's claims into one stream keyed to me-vs-them.
  const merged = [];
  for (const g of list) {
    const escrowed = g.state?.duel?.status === "open" ? g.state.duel.disputedClaimId : null;
    for (const c of g.claims || []) {
      if (c.status !== "settled" || c.id === escrowed) continue;
      merged.push({ ...c, by: c.by === me.id ? "__me__" : "__them__" });
    }
  }

  const oppName = single
    ? opponentOf(single)?.name || "Opponent"
    : list.length === 1
      ? opponentOf(list[0])?.name || "Opponent"
      : "Opponents";
  const meName = me.name || "You";

  // --- per-click bars ---
  const rows = sortRows(claimRows(merged, "__me__"), clickSort);
  setHTML("chart-clicks-legend", rows.length ? legend(meName, oppName) : "");
  setHTML("chart-clicks", barChart(rows, { width, meName, oppName }));

  // --- who's winning ---
  const bucket = BUCKETS.find((b) => b.key === bucketKey) || BUCKETS[2];
  const buckets = bucketOHLC(merged, "__me__", bucket.ms, db.now());

  setHTML("chart-lead-legend", buckets.length ? legend(meName, oppName) : "");
  setHTML(
    "chart-lead",
    leadStyle === "candle"
      ? candleChart(buckets, { width, meName, oppName })
      : leadArea(buckets, { width, meName, oppName })
  );

  const last = buckets[buckets.length - 1];
  const note = !last
    ? ""
    : leadStyle === "candle"
      ? `Each candle is one ${bucket.label.toLowerCase()}: body spans the lead at the ` +
        `start and end, wick spans its high and low within that ${bucket.label.toLowerCase()}. ` +
        `Blue means your lead grew.`
      : `Above the dashed line ${esc(meName)} is ahead; below it ${esc(oppName)} ${
          list.length > 1 || oppName.endsWith("s") ? "are" : "is"
        }.`;
  setHTML("chart-lead-note", note);
}

/**
 * @param list   games to aggregate over
 * @param single non-null when showing exactly one game, which lets us use the
 *               players' real names instead of "You" / "Them"
 */
function renderStatsFor(list, single, tableId, gridId) {
  const nowMs = db.now();

  let cols; // [{ key, label, get(rows, periodKey) -> {claimed, actual} }]
  if (single) {
    const ids = Object.keys(single.players || {});
    cols = ids.map((id) => ({
      key: id,
      label: single.players[id].name + (id === me.id ? " (you)" : ""),
    }));
  } else {
    cols = [
      { key: "__me__", label: "You" },
      { key: "__them__", label: list.length === 1 ? "Opponent" : "Opponents" },
    ];
  }

  // period -> col -> {claimed, actual}
  const grid = {};
  for (const p of PERIODS) {
    grid[p.key] = {};
    for (const c of cols) grid[p.key][c.key] = { claimed: 0, actual: 0 };
  }

  for (const g of list) {
    const { ids, rows } = totalsFor(g);
    for (const p of PERIODS) {
      for (const id of ids) {
        const cell = rows[id][p.key];
        const colKey = single ? id : id === me.id ? "__me__" : "__them__";
        if (!grid[p.key][colKey]) continue;
        grid[p.key][colKey].claimed += cell.claimed;
        grid[p.key][colKey].actual += cell.actual;
      }
    }
  }

  const head =
    `<thead><tr><th>Period</th>` +
    cols.map((c) => `<th>${esc(c.label)}</th>`).join("") +
    `</tr></thead>`;

  const body =
    `<tbody>` +
    PERIODS.map((p) => {
      const best = Math.max(...cols.map((c) => grid[p.key][c.key].claimed));
      return (
        `<tr><td>${p.label}</td>` +
        cols
          .map((c) => {
            const cell = grid[p.key][c.key];
            const win = cols.length > 1 && cell.claimed === best && best > 0;
            return `<td class="num ${win ? "win" : ""}">${fmtDurationShort(cell.claimed)}
              <div class="sub">${fmtDurationShort(cell.actual)} actual</div></td>`;
          })
          .join("") +
        `</tr>`
      );
    }).join("") +
    `</tbody>`;

  setHTML(tableId, head + body);

  // Totals row
  let claimedAll = 0;
  let actualAll = 0;
  let claimCount = 0;
  let duelCount = 0;
  let clock = 0;
  for (const g of list) {
    const { ids, rows } = totalsFor(g);
    for (const id of ids) {
      claimedAll += rows[id].all.claimed;
      actualAll += rows[id].all.actual;
    }
    claimCount += (g.claims || []).filter((c) => c.status === "settled").length;
    duelCount += (g.claims || []).filter((c) => c.viaDuel).length;
    if (!isOver(g)) clock += onClock(g);
  }

  setHTML(
    gridId,
    [
      ["Actual time clicked", fmtDuration(actualAll)],
      ["Total claimed", fmtDuration(claimedAll)],
      ["Bonus from 2x", fmtDuration(claimedAll - actualAll)],
      ["Claims", String(claimCount)],
      ["Duels", String(duelCount)],
      [list.length > 1 ? "On the clock (all)" : "On the clock", fmtDuration(clock)],
    ]
      .map(
        ([l, v]) =>
          `<div class="stat"><div class="stat-label">${l}</div><div class="stat-value">${v}</div></div>`
      )
      .join("")
  );
}

/** Skip the DOM write when nothing changed — this runs on a 200ms tick. */
function setHTML(id, html) {
  const el = $(id);
  if (el.dataset.sig === html) return;
  el.dataset.sig = html;
  el.innerHTML = html;
}

// --- Detail screen ----------------------------------------------------------

function openDetail(code) {
  currentDetail = code;
  const g = games.get(code);
  $("detail-webhook").value = g?.meta?.webhook || "";
  showScreen("detail");
  renderDetail();
}

function renderDetail() {
  const g = games.get(currentDetail);
  if (!g || !g.meta) return;

  $("detail-title").textContent = gameLabel(g);
  $("code-text").textContent = g.code;

  const { ids, rows } = totalsFor(g);
  const opp = opponentOf(g);
  const over = isOver(g);

  // Deadline line
  const remain = g.meta.endsAt - db.now();
  $("detail-deadline").innerHTML = over
    ? `Ended ${new Date(g.meta.endsAt).toLocaleString()}.`
    : `Ends ${new Date(g.meta.endsAt).toLocaleString()} — ` +
      `<strong>${remain > 86400e3 ? Math.ceil(remain / 86400e3) + " days" : Math.floor(remain / 3600e3) + " hours"}</strong> left. ` +
      `Most claimed time wins.`;

  // Banners
  const wnd = windowStatus(g.code, db.now());
  const bn = [];
  if (over) {
    const ranked = [...ids].sort((a, b) => rows[b].all.claimed - rows[a].all.claimed);
    const tie = ranked.length > 1 && rows[ranked[0]].all.claimed === rows[ranked[1]].all.claimed;
    bn.push(
      `<div class="banner banner-info">🏁 ${
        tie ? "Dead tie." : `<strong>${esc(g.players?.[ranked[0]]?.name || "?")}</strong> won.`
      }</div>`
    );
  } else if (wnd.active) {
    bn.push(
      `<div class="banner banner-2x">⚡ 2x ACTIVE — ends in ${fmtDuration((wnd.endsAt - db.now()) / 1000)}</div>`
    );
  }
  if (!opp) {
    bn.push(
      `<div class="banner banner-info">Waiting for a second player. Share code <strong>${esc(g.code)}</strong>.</div>`
    );
  }
  $("detail-banners").innerHTML = bn.join("");

  // Standings
  $("detail-scores").innerHTML = ids
    .map((id) => {
      const p = g.players[id];
      const isMe = id === me.id;
      const lead = ids.every((o) => rows[id].all.claimed >= rows[o].all.claimed);
      return `<div class="score ${isMe ? "me" : ""} ${lead && ids.length > 1 ? "leader" : ""}">
        <div class="score-name">
          <span class="dot ${g.presence?.[id]?.online ? "online" : ""}"></span>
          <span class="who">${esc(p.name)}${isMe ? " (you)" : ""}</span>
        </div>
        <div class="score-total">${fmtDuration(rows[id].all.claimed)}</div>
        <div class="score-meta">${fmtDuration(rows[id].all.actual)} actual · ${rows[id].all.count} claims</div>
      </div>`;
    })
    .concat(ids.length < 2 ? [`<div class="score empty">Empty seat</div>`] : [])
    .join("");

  // Period table
  const head =
    `<thead><tr><th>Period</th>` +
    ids.map((id) => `<th>${esc(g.players[id].name)}</th>`).join("") +
    `</tr></thead>`;
  const body =
    `<tbody>` +
    PERIODS.map((p) => {
      const best = Math.max(...ids.map((id) => rows[id][p.key].claimed));
      return (
        `<tr><td>${p.label}</td>` +
        ids
          .map((id) => {
            const cell = rows[id][p.key];
            const win = ids.length > 1 && cell.claimed === best && best > 0;
            return `<td class="num ${win ? "win" : ""}">${fmtDurationShort(cell.claimed)}
              <div class="sub">${fmtDurationShort(cell.actual)} actual</div></td>`;
          })
          .join("") +
        `</tr>`
      );
    }).join("") +
    `</tbody>`;
  $("summary-table").innerHTML = head + body;

  // Totals
  const allClaimed = ids.reduce((s, id) => s + rows[id].all.claimed, 0);
  const allActual = ids.reduce((s, id) => s + rows[id].all.actual, 0);
  const duelsPlayed = (g.claims || []).filter((c) => c.viaDuel).length;
  $("stat-grid").innerHTML = [
    ["Actual time clicked", fmtDuration(allActual)],
    ["Total claimed", fmtDuration(allClaimed)],
    ["Bonus from 2x", fmtDuration(allClaimed - allActual)],
    ["Claims", String((g.claims || []).filter((c) => c.status === "settled").length)],
    ["Duels", String(duelsPlayed)],
    ["On the clock", fmtDuration(onClock(g))],
  ]
    .map(
      ([l, v]) =>
        `<div class="stat"><div class="stat-label">${l}</div><div class="stat-value">${v}</div></div>`
    )
    .join("");

  // 2x windows today
  const dayKey = utcDayKey(db.now());
  const nowHour = new Date(db.now()).getUTCHours();
  $("windows-list").innerHTML = doubleHoursFor(g.code, dayKey)
    .map((h) => {
      const live = h === nowHour;
      const state = live ? "live now" : h < nowHour ? "done" : "upcoming";
      return `<div class="win-row ${live ? "live" : ""}">
        <span>${live ? "⚡" : "🕐"}</span>
        <span class="win-when">${utcHourToLocalRange(dayKey, h)}</span>
        <span class="win-state">${state}</span>
      </div>`;
    })
    .join("");

  // Feed. Consecutive claims by the same player collapse into one row carrying
  // the combined total; the individual splits stay available behind a toggle.
  const escrowedId = g.state?.duel?.status === "open" ? g.state.duel.disputedClaimId : null;
  const feedRows = claimRows(g.claims || [], me.id);
  const runs = groupRuns(feedRows).reverse().slice(0, 15);

  setHTML(
    "feed",
    runs.length
      ? runs
          .map((run) => {
            const who = g.players?.[run.by]?.name || "?";
            const tags =
              (run.anyDoubled ? '<span class="f-tag x2">2x</span>' : "") +
              (run.anyDuel ? '<span class="f-tag duel">DUEL</span>' : "") +
              (run.items.some((i) => i.id === escrowedId)
                ? '<span class="f-tag duel">ESCROW</span>'
                : "");

            if (run.count === 1) {
              return `<li>
                <span class="f-who">${esc(who)}</span>
                <span class="f-amt">${fmtDuration(run.seconds)}</span>
                ${tags}
                <span class="f-when">${fmtAgo(db.now() - run.to)}</span>
              </li>`;
            }

            const splits = run.items
              .slice()
              .reverse()
              .map(
                (i) => `<li class="split">
                  <span class="split-n">#${i.order}</span>
                  <span class="f-amt">${fmtDuration(i.seconds)}</span>
                  ${i.multiplier > 1 ? '<span class="f-tag x2">2x</span>' : ""}
                  ${i.viaDuel ? '<span class="f-tag duel">DUEL</span>' : ""}
                  <span class="f-when">${fmtAgo(db.now() - i.at)}</span>
                </li>`
              )
              .join("");

            return `<li class="run">
              <details>
                <summary>
                  <span class="f-who">${esc(who)}</span>
                  <span class="f-amt">${fmtDuration(run.seconds)}</span>
                  <span class="f-count">${run.count} clicks</span>
                  ${tags}
                  <span class="f-when">${fmtAgo(db.now() - run.to)}</span>
                </summary>
                <ul class="splits">${splits}</ul>
              </details>
            </li>`;
          })
          .join("")
      : `<li class="feed-empty">No claims yet.</li>`
  );
}

function wireDetail() {
  $("btn-back").addEventListener("click", () => {
    currentDetail = null;
    showScreen("hub");
  });

  $("code-chip").addEventListener("click", async () => {
    const g = games.get(currentDetail);
    if (!g) return;
    const link = `${location.origin}${location.pathname}?g=${g.code}`;
    try {
      await navigator.clipboard.writeText(link);
      toast("Invite link copied.", "good");
    } catch {
      toast(`Game code: <strong>${g.code}</strong>`, "");
    }
  });

  $("btn-export").addEventListener("click", async () => {
    const g = games.get(currentDetail);
    if (!g) return;
    const json = JSON.stringify(buildExport(g), null, 2);
    try {
      await navigator.clipboard.writeText(json);
      toast(`Copied ${g.claims?.length || 0} claims to the clipboard.`, "good");
    } catch {
      // Clipboard blocked (needs a secure context) — fall back to a download.
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `clicky-${g.code}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast("Downloaded the game data.", "good");
    }
  });

  $("webhook-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await db.setWebhook(currentDetail, $("detail-webhook").value.trim());
    toast("Webhook saved.", "good");
  });

  $("btn-leave").addEventListener("click", () => {
    const g = games.get(currentDetail);
    if (!confirm(`Leave ${gameLabel(g)}? Your claims stay in the game — you just stop tracking it here.`)) {
      return;
    }
    removeFromRoster(currentDetail);
    currentDetail = null;
    if (roster.length) showScreen("hub");
  });
}

// --- Hub wiring -------------------------------------------------------------

function wireHub() {
  $("btn-claim").addEventListener("click", doClaim);
  $("btn-add").addEventListener("click", () => {
    switchTab("join");
    showScreen("setup");
  });
  $("hub-logo").addEventListener("click", goHome);
  $("detail-logo").addEventListener("click", goHome);
  $("brand-logo").addEventListener("click", () => {
    if (roster.length) goHome();
  });
  $("stats-scope").addEventListener("change", renderHubStats);

  // Chart controls. Each persists, so the view you left is the view you return to.
  document.querySelectorAll("[data-clicksort]").forEach((b) =>
    b.addEventListener("click", () => {
      clickSort = b.dataset.clicksort;
      store.set("clickSort", clickSort);
      document
        .querySelectorAll("[data-clicksort]")
        .forEach((x) => x.classList.toggle("active", x === b));
      renderHubStats();
    })
  );
  document.querySelectorAll("[data-leadstyle]").forEach((b) =>
    b.addEventListener("click", () => {
      leadStyle = b.dataset.leadstyle;
      store.set("leadStyle", leadStyle);
      document
        .querySelectorAll("[data-leadstyle]")
        .forEach((x) => x.classList.toggle("active", x === b));
      renderHubStats();
    })
  );
  $("bucket-size").addEventListener("change", (e) => {
    bucketKey = e.target.value;
    store.set("bucketKey", bucketKey);
    renderHubStats();
  });

  // Restore persisted chart controls.
  $("bucket-size").value = bucketKey;
  document
    .querySelectorAll("[data-clicksort]")
    .forEach((x) => x.classList.toggle("active", x.dataset.clicksort === clickSort));
  document
    .querySelectorAll("[data-leadstyle]")
    .forEach((x) => x.classList.toggle("active", x.dataset.leadstyle === leadStyle));
  $("btn-settings").addEventListener("click", () => {
    $("set-name").value = me.name;
    $("set-discordid").value = me.discordId;
    $("settings-modal").classList.remove("hidden");
  });

  // Spacebar claims, because of course it does.
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space") return;
    if (/^(INPUT|TEXTAREA|BUTTON)$/.test(document.activeElement?.tagName)) return;
    if ($("screen-hub").classList.contains("hidden")) return;
    e.preventDefault();
    doClaim();
  });
}

// --- Duel modal -------------------------------------------------------------

let modalDuelKey = null;

/** The duel to show: first one awaiting my throw, else an unseen result. */
function activeDuel() {
  const waiting = pendingThrows();
  if (waiting.length) return waiting[0];

  for (const g of games.values()) {
    const d = g.state?.duel;
    if (!d || (d.challenger !== me.id && d.defender !== me.id)) continue;
    if (d.status === "open" && (d.picks || {})[me.id]) return { g, duel: d };
    if (d.status === "resolved" && !dismissedResults.has(d.id)) return { g, duel: d };
  }
  return null;
}

const dismissedResults = new Set();

function openDuelModal() {
  if (activeDuel()) $("rps-modal").classList.remove("hidden");
  renderDuelModal();
}

function renderDuelModal() {
  const modal = $("rps-modal");
  const entry = activeDuel();

  if (!entry) {
    modal.classList.add("hidden");
    modalDuelKey = null;
    return;
  }

  const { g, duel: d } = entry;
  const resolved = d.status === "resolved";
  const myPick = (d.picks || {})[me.id];
  const oppId = d.challenger === me.id ? d.defender : d.challenger;
  const oppPick = (d.picks || {})[oppId];
  const oppName = g.players?.[oppId]?.name || "They";

  // Force the modal open when it needs a throw, or when the result just landed.
  // Once you've thrown and are only waiting, dismissing it stays dismissed.
  if (!myPick || resolved) modal.classList.remove("hidden");

  $("rps-game").textContent = gameLabel(g);
  $("rps-sub").innerHTML = resolved
    ? ""
    : `<strong>${esc(oppName)}</strong> and you claimed within ` +
      `${(d.gapMs / 1000).toFixed(1)}s of each other. Rock paper scissors, best of one — ` +
      `winner takes the whole pot.`;

  $("rps-pot").innerHTML = `<div class="pot-label">In escrow${d.round > 1 ? ` · round ${d.round}` : ""}</div>
    <div class="pot-value">${fmtDuration(d.potSeconds)}</div>`;

  // Throw buttons
  const throwsEl = $("rps-throws");
  throwsEl.classList.toggle("hidden", resolved);
  throwsEl.querySelectorAll(".throw").forEach((b) => {
    b.disabled = !!myPick || resolved;
    b.classList.toggle("picked", myPick === b.dataset.throw);
  });

  // Status + result
  const statusEl = $("rps-status");
  const resultEl = $("rps-result");

  if (resolved) {
    const iWon = d.winner === me.id;
    const picks = d.finalPicks || {};
    statusEl.textContent = "";
    resultEl.classList.remove("hidden");
    resultEl.innerHTML = `
      <div class="rr-throws">${THROW_EMOJI[picks[me.id]] || "?"} vs ${THROW_EMOJI[picks[oppId]] || "?"}</div>
      <div class="rr-verdict ${iWon ? "won" : "lost"}">${iWon ? "You take it" : "You lose it"}</div>
      <div class="rr-detail">${
        iWon
          ? `${fmtDuration(d.potSeconds)} banked. ${esc(oppName)} gets nothing.`
          : `${esc(oppName)} takes ${fmtDuration(d.potSeconds)}.`
      }</div>`;
    $("rps-dismiss").classList.remove("hidden");
    $("rps-lock").classList.add("hidden");
  } else {
    resultEl.classList.add("hidden");
    $("rps-dismiss").classList.toggle("hidden", !myPick);
    $("rps-lock").classList.toggle("hidden", !!myPick);
    if (!myPick) {
      statusEl.textContent = oppPick ? `${oppName} has thrown. Your move.` : "Pick your throw.";
    } else {
      statusEl.textContent = `Locked in ${THROW_EMOJI[myPick]}. Waiting for ${oppName}…`;
    }
  }

  modalDuelKey = `${g.code}:${d.id}:${d.round}:${d.status}`;
}

function wireModals() {
  $("rps-throws").addEventListener("click", async (e) => {
    const btn = e.target.closest(".throw");
    if (!btn || btn.disabled) return;
    const entry = activeDuel();
    if (!entry) return;
    btn.disabled = true;
    await db.submitThrow(entry.g.code, entry.duel.id, me.id, btn.dataset.throw);
    render();
  });

  $("rps-dismiss").addEventListener("click", () => {
    const entry = activeDuel();
    if (entry?.duel.status === "resolved") dismissedResults.add(entry.duel.id);
    $("rps-modal").classList.add("hidden");
    render();
  });

  $("settings-cancel").addEventListener("click", () => $("settings-modal").classList.add("hidden"));
  $("settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    saveProfile($("set-name").value.trim() || me.name, $("set-discordid").value.trim());
    await Promise.all(
      [...games.keys()].map((code) =>
        db.updatePlayer(code, me.id, { name: me.name, discordId: me.discordId })
      )
    );
    $("settings-modal").classList.add("hidden");
    toast("Saved.", "good");
  });
}
