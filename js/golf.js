// The one-shot mini-putt duel game.
//
// Mounts a small canvas into a container and runs a drag-back-and-release
// physics sim. Pointer Events unify mouse and touch input, so the same code
// path drives it on desktop and phones. One shot per player: once the ball
// stops (or leaves the green, or sinks), the final distance from the hole is
// reported via `onDone` — the caller submits that as this player's pick, same
// as any other duel minigame.
//
// Both players get the same hole position and wind, derived from the duel id
// so there's nothing to store — same trick as the 2x windows in rules.js.

const W = 300;
const H = 170;
const TEE = { x: W / 2, y: H - 22 };
const HOLE_Y = 26;
const HOLE_R = 9;
const BALL_R = 6;
const SINK_R = 10;
const MAX_PULL = 80;
const SHOT_SPEED = 6.5;
const FRICTION = 0.985;
const STOP_SPEED = 0.06;
const WALL_BOUNCE = 0.65; // energy kept off the side rails, so it damps out rather than bouncing forever
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
 * @param container element to mount the canvas + controls into
 * @param seed      shared seed (the duel id) so both players get the same course
 * @param onDone    (distance:number) => void — fires once, distance 0 means sunk
 * @returns {destroy()} to unhook listeners if the modal goes away mid-shot
 */
export function mountGolf(container, seed, onDone) {
  const holeOffset = (seededRand(seed + "|hole") - 0.5) * 2 * 70; // -70..70
  const wind = (seededRand(seed + "|wind") - 0.5) * 2 * 0.012; // small lateral drift while airborne
  const hole = { x: Math.max(30, Math.min(W - 30, W / 2 + holeOffset)), y: HOLE_Y };

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
  const ball = { x: TEE.x, y: TEE.y };
  let vel = null; // {x,y} once the shot is in flight
  let pending = null; // {x,y} confirmed shot velocity, waiting on the Putt button
  let dragging = false;
  let dragTo = null;
  let done = false;
  let frame = 0;
  let raf = null;

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#1b3a2a";
    ctx.fillRect(0, 0, W, H);
    ctx.beginPath();
    ctx.fillStyle = "#06100a";
    ctx.arc(hole.x, hole.y, HOLE_R, 0, Math.PI * 2);
    ctx.fill();
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
    vel.x += wind;
    ball.x += vel.x;
    ball.y += vel.y;
    vel.x *= FRICTION;
    vel.y *= FRICTION;

    // The side rails bounce the ball back onto the green instead of losing
    // it — only the near/far ends (past the tee, past the hole) end the shot.
    if (ball.x < BALL_R) {
      ball.x = BALL_R;
      vel.x = Math.abs(vel.x) * WALL_BOUNCE;
    } else if (ball.x > W - BALL_R) {
      ball.x = W - BALL_R;
      vel.x = -Math.abs(vel.x) * WALL_BOUNCE;
    }

    const outOfBounds = ball.y < -20 || ball.y > H + 20;
    const speed = Math.hypot(vel.x, vel.y);
    const distToHole = Math.hypot(ball.x - hole.x, ball.y - hole.y);
    const sunk = distToHole < SINK_R && speed < 1.2;

    draw();

    if (sunk || outOfBounds || speed < STOP_SPEED || frame > MAX_FRAMES) {
      done = true;
      const finalDist = outOfBounds ? Math.max(distToHole, 120) : sunk ? 0 : distToHole;
      hint.textContent = sunk ? "🏌️ Sunk it!" : `${Math.round(finalDist)} from the hole.`;
      onDone(finalDist);
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
