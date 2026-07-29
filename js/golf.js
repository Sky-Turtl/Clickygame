// The one-shot mini-putt duel game.
//
// Mounts a small canvas into a container and runs a drag-back-and-release
// physics sim. Pointer Events unify mouse and touch input, so the same code
// path drives it on desktop and phones. One shot per player: the ball bounces
// off all four rails, so once it stops (or sinks), the final distance from
// the hole is reported via `onDone` — the caller submits that as this
// player's pick, same as any other duel minigame.
//
// Both players get the same hole position (and, from round 2 on, the same
// obstacles) derived from the duel id, so there's nothing to store — same
// trick as the 2x windows in rules.js.

const W = 300;
const H = 170;
const EDGE_MARGIN = 22; // how close the tee/hole sit to whichever edge they're placed on
const HOLE_R = 12; // lenient — a rolling ball that clips the cup counts
const BALL_R = 6;
const SINK_R = 14;
const OBSTACLE_R = 9;
const MAX_PULL = 80;
const SHOT_SPEED = 4.5; // lower = softer max-power shots, more forgiving on a touch drag
const FRICTION = 0.985;
const STOP_SPEED = 0.06;
const WALL_BOUNCE = 0.65; // energy kept off the side rails/obstacles, so it damps out rather than bouncing forever
const MAX_FRAMES = 900; // ~15s safety cap so a stuck ball can't hang the modal forever

/** Deterministic [0,1) — a tiny local hash, not worth importing util.js's for one cosmetic offset. */
function seededRand(seedStr) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0) / 4294967296;
}

/**
 * Tee and hole always land on opposite edges of the green (top/bottom or
 * left/right) so every shot has to cross the whole course, but which pair of
 * edges — and which one gets the tee vs. the hole — varies per duel.
 */
function pickLayout(seed) {
  const horizontal = seededRand(seed + "|axis") < 0.5;
  const teeFirst = seededRand(seed + "|dir") < 0.5;
  if (horizontal) {
    const holeOffset = (seededRand(seed + "|hole") - 0.5) * 2 * 50; // -50..50
    const teeY = Math.max(30, Math.min(H - 30, H / 2 - holeOffset));
    const holeY = Math.max(30, Math.min(H - 30, H / 2 + holeOffset));
    const a = EDGE_MARGIN;
    const b = W - EDGE_MARGIN;
    return teeFirst
      ? { tee: { x: b, y: teeY }, hole: { x: a, y: holeY } }
      : { tee: { x: a, y: teeY }, hole: { x: b, y: holeY } };
  }
  const holeOffset = (seededRand(seed + "|hole") - 0.5) * 2 * 70; // -70..70
  const teeX = Math.max(30, Math.min(W - 30, W / 2 - holeOffset));
  const holeX = Math.max(30, Math.min(W - 30, W / 2 + holeOffset));
  const a = EDGE_MARGIN;
  const b = H - EDGE_MARGIN;
  return teeFirst
    ? { tee: { x: teeX, y: b }, hole: { x: holeX, y: a } }
    : { tee: { x: teeX, y: a }, hole: { x: holeX, y: b } };
}

/**
 * A tie (both players' shots landing at equal distance from the hole,
 * including both sinking it) replays as another round — see engine.js's
 * resolveGame/applySettle. Each replay adds one more obstacle to the green,
 * seeded off the round number so it's the same extra rock for both players.
 */
function placeObstacles(seed, round, tee, hole) {
  const count = Math.max(0, round - 1);
  const obstacles = [];
  const margin = 18;
  for (let i = 0; i < count; i++) {
    let x, y, tries = 0;
    do {
      x = margin + seededRand(`${seed}|obs${i}|x|${tries}`) * (W - margin * 2);
      y = margin + seededRand(`${seed}|obs${i}|y|${tries}`) * (H - margin * 2);
      tries++;
    } while (
      tries < 40 &&
      (Math.hypot(x - hole.x, y - hole.y) < 34 ||
        Math.hypot(x - tee.x, y - tee.y) < 34 ||
        obstacles.some((o) => Math.hypot(x - o.x, y - o.y) < OBSTACLE_R * 2 + 12))
    );
    obstacles.push({ x, y });
  }
  return obstacles;
}

/**
 * @param container element to mount the canvas + controls into
 * @param seed      shared seed (the duel id) so both players get the same course
 * @param round     current duel round — round 2+ adds one more obstacle each time
 * @param onDone    (distance:number, path:{x,y}[]) => void — fires once, distance 0 means
 *                  sunk; path is every frame of the shot, for replaying it later
 * @returns {destroy()} to unhook listeners if the modal goes away mid-shot
 */
export function mountGolf(container, seed, round, onDone) {
  const { tee, hole } = pickLayout(seed);
  const obstacles = placeObstacles(seed, round || 1, tee, hole);

  container.innerHTML = "";
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  canvas.className = "golf-canvas";
  container.appendChild(canvas);
  const hint = document.createElement("div");
  hint.className = "golf-hint";
  hint.textContent = "Drag back from the ball, then let go to aim.";
  container.appendChild(hint);
  const actions = document.createElement("div");
  actions.className = "golf-actions hidden";
  actions.innerHTML = `
    <button type="button" class="btn btn-ghost" data-golf="reaim">Re-aim</button>
    <button type="button" class="btn btn-primary" data-golf="putt">Putt</button>`;
  container.appendChild(actions);

  const ctx = canvas.getContext("2d");
  const ball = { x: tee.x, y: tee.y };
  let vel = null; // {x,y} once the shot is in flight
  let pending = null; // {x,y} confirmed shot velocity, waiting on the Putt button
  let dragging = false;
  let dragTo = null;
  let done = false;
  let frame = 0;
  let raf = null;
  const path = [{ x: ball.x, y: ball.y }]; // every frame of the shot — handed back via onDone so it can be replayed later

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#1b3a2a";
    ctx.fillRect(0, 0, W, H);
    ctx.beginPath();
    ctx.fillStyle = "#06100a";
    ctx.arc(hole.x, hole.y, HOLE_R, 0, Math.PI * 2);
    ctx.fill();
    for (const o of obstacles) {
      ctx.beginPath();
      ctx.fillStyle = "#5b6675";
      ctx.arc(o.x, o.y, OBSTACLE_R, 0, Math.PI * 2);
      ctx.fill();
    }
    if ((dragging || pending) && dragTo) {
      ctx.strokeStyle = "rgba(255,255,255,.55)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ball.x, ball.y);
      ctx.lineTo(dragTo.x, dragTo.y);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.fillStyle = "#fff";
    ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
    ctx.fill();
  }

  function pointFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (W / rect.width),
      y: (e.clientY - rect.top) * (H / rect.height),
    };
  }

  function clampPull(p) {
    const dx = p.x - ball.x;
    const dy = p.y - ball.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= MAX_PULL) return p;
    const k = MAX_PULL / dist;
    return { x: ball.x + dx * k, y: ball.y + dy * k };
  }

  function onDown(e) {
    if (vel || pending || done) return;
    dragging = true;
    dragTo = clampPull(pointFromEvent(e));
    canvas.setPointerCapture?.(e.pointerId);
    draw();
  }
  function onMove(e) {
    if (!dragging) return;
    dragTo = clampPull(pointFromEvent(e));
    draw();
  }
  function onUp() {
    if (!dragging) return;
    dragging = false;
    const dx = ball.x - dragTo.x; // launches AWAY from the pull, like a slingshot
    const dy = ball.y - dragTo.y;
    const power = Math.hypot(dx, dy) / MAX_PULL;
    if (power < 0.05) {
      dragTo = null;
      draw();
      return; // too soft to count as an aim — try again
    }
    // Hold the aim as a pending shot instead of firing immediately — the
    // player confirms with the Putt button (or scraps it with Re-aim).
    pending = { x: (dx / MAX_PULL) * SHOT_SPEED, y: (dy / MAX_PULL) * SHOT_SPEED };
    hint.textContent = "Putt when ready, or re-aim.";
    actions.classList.remove("hidden");
    draw();
  }

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);

  function onAction(e) {
    const btn = e.target.closest("[data-golf]");
    if (!btn) return;
    if (btn.dataset.golf === "reaim") {
      pending = null;
      dragTo = null;
      actions.classList.add("hidden");
      hint.textContent = "Drag back from the ball, then let go to aim.";
      draw();
      return;
    }
    // Putt: hand the confirmed velocity to the physics sim.
    vel = pending;
    pending = null;
    actions.classList.add("hidden");
    hint.textContent = "…";
    raf = requestAnimationFrame(tick);
  }
  actions.addEventListener("click", onAction);

  function tick() {
    if (done) return;
    frame++;
    ball.x += vel.x;
    ball.y += vel.y;
    vel.x *= FRICTION;
    vel.y *= FRICTION;

    // All four rails bounce the ball back onto the green — the canvas border
    // is drawn on every side, so every side should behave like a wall.
    if (ball.x < BALL_R) {
      ball.x = BALL_R;
      vel.x = Math.abs(vel.x) * WALL_BOUNCE;
    } else if (ball.x > W - BALL_R) {
      ball.x = W - BALL_R;
      vel.x = -Math.abs(vel.x) * WALL_BOUNCE;
    }
    if (ball.y < BALL_R) {
      ball.y = BALL_R;
      vel.y = Math.abs(vel.y) * WALL_BOUNCE;
    } else if (ball.y > H - BALL_R) {
      ball.y = H - BALL_R;
      vel.y = -Math.abs(vel.y) * WALL_BOUNCE;
    }

    // Obstacles bounce the ball the same way the rails do, just off
    // whichever direction it hit them from instead of a fixed axis.
    for (const o of obstacles) {
      const dx = ball.x - o.x;
      const dy = ball.y - o.y;
      const dist = Math.hypot(dx, dy) || 0.0001;
      const minDist = BALL_R + OBSTACLE_R;
      if (dist >= minDist) continue;
      const nx = dx / dist;
      const ny = dy / dist;
      ball.x = o.x + nx * minDist;
      ball.y = o.y + ny * minDist;
      const vn = vel.x * nx + vel.y * ny;
      if (vn < 0) {
        const bounceSpeed = Math.abs(vn) * WALL_BOUNCE;
        vel.x += (bounceSpeed - vn) * nx;
        vel.y += (bounceSpeed - vn) * ny;
      }
    }

    path.push({ x: ball.x, y: ball.y });

    const speed = Math.hypot(vel.x, vel.y);
    const distToHole = Math.hypot(ball.x - hole.x, ball.y - hole.y);
    const sunk = distToHole < SINK_R && speed < 1.6;

    draw();

    if (sunk || speed < STOP_SPEED || frame > MAX_FRAMES) {
      done = true;
      const finalDist = sunk ? 0 : distToHole;
      hint.textContent = sunk ? "🏌️ Sunk it!" : `${Math.round(finalDist)} from the hole.`;
      onDone(finalDist, path);
      return;
    }
    raf = requestAnimationFrame(tick);
  }

  draw();

  return {
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      actions.removeEventListener("click", onAction);
    },
  };
}

/**
 * Replays a previously recorded shot (the `path` handed back from `onDone`)
 * on the same course it was played on. Only the local player's own path is
 * ever recorded today — there's no wire format yet for sharing an opponent's
 * shot — so this is what a "watch their replay" button falls back to until
 * that's built.
 *
 * @param container element to mount the canvas + replay button into
 * @param seed      same duel id used for the original shot, so the course matches
 * @param round     same round the shot was played in
 * @param path      the recorded {x,y}[] from that shot's onDone callback
 * @returns {destroy()} to unhook listeners if the modal goes away mid-replay
 */
export function mountGolfReplay(container, seed, round, path) {
  const { tee, hole } = pickLayout(seed);
  const obstacles = placeObstacles(seed, round || 1, tee, hole);

  container.innerHTML = "";
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  canvas.className = "golf-canvas";
  container.appendChild(canvas);
  const actions = document.createElement("div");
  actions.className = "golf-actions";
  actions.innerHTML = `<button type="button" class="btn btn-ghost" data-golf="replay">Watch replay</button>`;
  container.appendChild(actions);
  const replayBtn = actions.querySelector('[data-golf="replay"]');

  const ctx = canvas.getContext("2d");
  const ball = { x: (path[0] || tee).x, y: (path[0] || tee).y };
  let raf = null;

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#1b3a2a";
    ctx.fillRect(0, 0, W, H);
    ctx.beginPath();
    ctx.fillStyle = "#06100a";
    ctx.arc(hole.x, hole.y, HOLE_R, 0, Math.PI * 2);
    ctx.fill();
    for (const o of obstacles) {
      ctx.beginPath();
      ctx.fillStyle = "#5b6675";
      ctx.arc(o.x, o.y, OBSTACLE_R, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.fillStyle = "#fff";
    ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
    ctx.fill();
  }

  function play() {
    if (raf || !path || !path.length) return;
    replayBtn.disabled = true;
    let i = 0;
    function step() {
      if (i >= path.length) {
        replayBtn.disabled = false;
        raf = null;
        return;
      }
      ball.x = path[i].x;
      ball.y = path[i].y;
      draw();
      i++;
      raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);
  }

  function onAction(e) {
    if (e.target.closest('[data-golf="replay"]')) play();
  }
  actions.addEventListener("click", onAction);

  draw();
  play();

  return {
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      actions.removeEventListener("click", onAction);
    },
  };
}
