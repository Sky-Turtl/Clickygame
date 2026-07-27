// Discord webhook notifications.
//
// Discord's webhook endpoint sends permissive CORS headers, so posting straight
// from the browser works. Every failure here is swallowed — a missed notification
// must never break the game.

import { fmtDuration } from "./util.js";

const COLORS = {
  claim: 0x5865f2,
  claim2x: 0xfee75c,
  duel: 0xed4245,
  duelResult: 0x57f287,
  window: 0xeb459e,
};

async function post(webhookUrl, payload) {
  if (!webhookUrl || !/^https:\/\/(canary\.|ptb\.)?discord\.com\/api\/webhooks\//.test(webhookUrl)) {
    return false;
  }
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowed_mentions: { parse: ["users"] }, ...payload }),
    });
    return res.ok;
  } catch (err) {
    console.warn("[discord] notification failed", err);
    return false;
  }
}

const mention = (discordId) => (discordId ? `<@${discordId}>` : "");

/** Fired by the clicking player's own browser, right after a successful claim. */
export function notifyClaim(webhookUrl, { actor, opponent, seconds, multiplier, gameCode }) {
  const doubled = multiplier > 1;
  return post(webhookUrl, {
    username: "Clicky",
    embeds: [
      {
        title: doubled ? "⚡ Claim (2x active)" : "⏱️ Claim",
        description:
          `**${actor.name}** claimed **${fmtDuration(seconds)}**` +
          (doubled ? `\n(${fmtDuration(seconds / multiplier)} of real time, doubled)` : ""),
        color: doubled ? COLORS.claim2x : COLORS.claim,
        footer: { text: `Game ${gameCode} · the clock is now running` },
        timestamp: new Date().toISOString(),
      },
    ],
    content: opponent?.discordId ? `${mention(opponent.discordId)} the clock is running.` : undefined,
  });
}

/** A 2x window just opened or closed. */
export function notifyWindow(webhookUrl, { opening, gameCode, players, localRange }) {
  return post(webhookUrl, {
    username: "Clicky",
    content: opening ? players.map((p) => mention(p.discordId)).filter(Boolean).join(" ") : undefined,
    embeds: [
      {
        title: opening ? "🔥 DOUBLE TIME — 2x window is OPEN" : "🌙 2x window closed",
        description: opening
          ? `Every claim counts double for the next hour (${localRange}). Go.`
          : "Claims are back to normal rate.",
        color: COLORS.window,
        footer: { text: `Game ${gameCode}` },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

/** Two players claimed within the tie window — a duel has started. */
export function notifyDuelStart(webhookUrl, { challenger, defender, potSeconds, gapMs, gameCode }) {
  return post(webhookUrl, {
    username: "Clicky",
    content: [challenger, defender].map((p) => mention(p?.discordId)).filter(Boolean).join(" "),
    embeds: [
      {
        title: "⚔️ CONTESTED — rock paper scissors",
        description:
          `**${challenger.name}** claimed ${(gapMs / 1000).toFixed(1)}s after **${defender.name}**.\n` +
          `**${fmtDuration(potSeconds)}** is in escrow. Winner takes all.\n\n` +
          `_Nobody can claim again until both of you throw._`,
        color: COLORS.duel,
        footer: { text: `Game ${gameCode}` },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

/** Duel resolved (or drawn and re-thrown). */
export function notifyDuelResult(webhookUrl, { winner, loser, throws, potSeconds, draw, gameCode }) {
  const line = Object.entries(throws)
    .map(([name, t]) => `${name}: ${t}`)
    .join("  vs  ");

  return post(webhookUrl, {
    username: "Clicky",
    embeds: [
      {
        title: draw ? "🤝 Draw — throw again" : "🏆 Duel decided",
        description: draw
          ? `${line}\n\nStill **${fmtDuration(potSeconds)}** on the line.`
          : `${line}\n\n**${winner.name}** takes **${fmtDuration(potSeconds)}**. ` +
            `${loser.name} gets nothing.`,
        color: draw ? COLORS.duel : COLORS.duelResult,
        footer: { text: `Game ${gameCode}` },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}
