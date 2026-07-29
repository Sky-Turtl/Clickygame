# ⏱️ Clicky

A two-player game of clock-stealing. Every second that passes belongs to whoever
clicks **CLAIM** next. Whoever has banked the most time when the deadline hits, wins.

- **Claim** — pressing the button banks all the time since the *last* press, by
  either player. Wait longer, win more — but they might beat you to it.
- **2x windows** — two random one-hour windows a day double everything you claim.
  Each game rolls its own, so they never line up.
- **Contested claims** — if you both claim within 3 seconds, that time goes into
  escrow and rock-paper-scissors decides it. Winner takes the whole pot.
- **Sync** — join as many games as you like. One click banks into every synced
  game at once, each against its own separate clock.
- **Discord** — optional webhook posts when the other player claims, when a 2x
  window opens, and when a duel starts or resolves.
- **Charts** — every claim as a bar (sortable by when it happened or how big it
  was), and a running "who's winning" chart bucketed by minute, half hour, hour,
  6 hours or day, as a line or as candlesticks.
- **Import** — start a game from data you already have, including a countdown log.

---

## Starting from existing data

When you create a game, open **Start from existing data** and paste your history.
Three formats are accepted, detected automatically.

### Countdown log

A row per click: **time remaining**, **percent elapsed**, and **who clicked**, in
any column order. Tabs, commas or multiple spaces all work, and a header row is
fine.

```
remaining   percent   who
604800      0%        Will
601200      0.6%      Sam
598000      1.1%      Will
```

The claim for each click is the **drop in remaining** since the previous click —
which is exactly this game's mechanic, so the conversion is exact rather than an
approximation. Timestamps come out absolute (a row with `R` seconds remaining
happened at `endsAt − R`), so imported history sits on the same timeline as live
play and the charts read straight across the join.

The percent column is what recovers the original total, and the total is what
fixes the **first** click's claim — without it there's no way to know how much
time preceded row one, so that first click is counted as 0 and the app says so.
The total is taken as the median of every row's implied total, so one inconsistent
row won't skew it.

Time values can be raw seconds (`604800`) or durations (`7d`, `2h 30m`, `1:30:00`).

### Totals

```
Will: 3h 20m
Sam = 2h 05m 30s
```

### JSON

Whatever the **Copy game data** button on a game's page produces. This is the only
format that round-trips the full per-claim history including 2x multipliers and
duel wins.

### How players are matched

The first player listed is you — unless one of the names matches the name you
typed, in which case that one is. Your opponent has no player id until they join,
so their history is parked on the game and applied automatically the moment they
enter the code.

---

## Try it without any setup

```bash
npx --yes http-server . -p 8123
```

Then open <http://localhost:8123/?demo>. The `?demo` flag runs the whole game
against an in-memory store with a practice bot — no Firebase, no accounts, and no
risk of writing to a real game. Drop the flag for the real thing.

---

## Setup

The site itself is static and lives happily on GitHub Pages. The one thing a
static host can't do is let two browsers share state, so the shared clock lives
in **Firebase Realtime Database**. It's free, there's no server to run, and it
pushes changes over a WebSocket — when your opponent claims, your page updates in
under a second without a refresh.

### 1. Create the Firebase project

1. Go to <https://console.firebase.google.com> and click **Add project**.
   Name it anything. You can turn Google Analytics off.
2. In the left sidebar: **Build → Realtime Database → Create Database**.
   - Pick a location near you.
   - Choose **Start in test mode** for now — you'll replace the rules in step 3.
3. In the left sidebar click **Settings** (the gear) → **Project settings**.
   You land on the **General** tab — scroll to the bottom, to **Your apps**.
4. Click the **web** button (`</>`) among the platform icons.
   - Give it any nickname; it's just a label.
   - **Leave "Also set up Firebase Hosting" unchecked** — you're deploying to
     GitHub Pages, not Firebase Hosting.
   - Click **Register app**.
5. Firebase shows a code block containing `const firebaseConfig = { ... }`.
   Copy that object.

### 2. Paste the config

Open [`js/config.js`](js/config.js) and replace the placeholder block with what
Firebase gave you:

```js
export const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "your-project.firebaseapp.com",
  databaseURL: "https://your-project-default-rtdb.firebaseio.com",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123",
};
```

Make sure `databaseURL` is present — the web snippet sometimes omits it. You'll
find it at the top of the Realtime Database page.

> These values are **not secrets**. Firebase web config is designed to ship in
> client code; access is controlled by the database rules below, not by hiding
> the key.

### 3. Replace the security rules

Test mode stops working after 30 days, so swap the rules before that happens.
In **Realtime Database → Rules**, paste this and hit **Publish**:

```json
{
  "rules": {
    "games": {
      "$code": {
        ".read": true,
        ".write": true,
        "meta": {
          ".validate": "newData.hasChildren(['code', 'endsAt'])"
        },
        "claims": {
          "$claimId": {
            ".validate": "newData.hasChildren(['by', 'at', 'seconds', 'status'])"
          }
        }
      }
    },
    "accounts": {
      "$uid": {
        ".read": "auth != null && auth.uid === $uid",
        ".write": "auth != null && auth.uid === $uid"
      }
    }
  }
}
```

The `accounts` block is only needed if you're using the optional username/password
accounts feature (cross-device game sync + the profile page) — it keeps each
account's data readable and writable only by that signed-in account.

**What this does and doesn't do.** Anyone who knows a game code can read and
write that game. Nobody can list or discover games — you can only reach one by
its exact code, and there are ~887 million possible codes. That's the right
trade-off for a private game between two people who trust each other, and it
keeps setup to a single paste.

It does mean the rules can't stop a determined player from writing a bogus score
directly to the database. If that matters to you, the honest fix is a real
server, not stricter rules — a browser-side game where both players can write is
always ultimately trust-based.

### 4. (Optional) Lock the database to your own site with App Check

The rules above let *anyone who knows a game code* read and write it — that's
by design, it's how your opponent's browser talks to the game with zero setup
on their end. But it also means anyone who copies your `firebaseConfig` (which
is never secret — see the note above) could point their *own* script at your
project, not just play through your actual site.

[Firebase App Check](https://firebase.google.com/docs/app-check) closes that
gap: it makes every request carry a token proving it came from a real load of
*your* site, and lets you reject anything that doesn't have one.

1. Firebase console → **Build → App Check → Apps** → your web app → **Register**.
2. Pick **reCAPTCHA v3** as the provider. Firebase creates a
   [reCAPTCHA](https://www.google.com/recaptcha/admin) site key for you —
   copy it.
3. Paste it into `RECAPTCHA_SITE_KEY` in [`js/config.js`](js/config.js) and
   deploy.
4. Play the game a few times so real traffic shows up in the App Check
   dashboard as verified.
5. Only then, in **App Check → APIs**, turn **Enforce** on for **Realtime
   Database**. Enforcing before step 4 locks *everyone* out, including you —
   there'd be no verified traffic yet to prove the token flow works.

Leave `RECAPTCHA_SITE_KEY` blank to skip this — the game works fine without
it, just without this particular protection.

### 5. Publish to GitHub Pages

```bash
git init
git add .
git commit -m "Clicky"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/Clickygame.git
git push -u origin main
```

Then on GitHub: **Settings → Pages → Source: Deploy from a branch → `main` /
`(root)` → Save**. A minute later it's live at
`https://YOUR-USERNAME.github.io/Clickygame/`.

---

## Discord notifications

Optional, and set per game.

1. In Discord: **Server Settings → Integrations → Webhooks → New Webhook**, pick
   a channel, **Copy Webhook URL**.
2. Paste it when creating a game, or later from a game's page → **Discord webhook**.

The URL is stored in that game's database record rather than in the page source,
so it isn't sitting in your public repo. If it ever leaks, delete the webhook in
Discord and make a new one — a webhook URL can only post to its one channel.

To get **@mentioned** when your opponent claims: in Discord enable
**Settings → Advanced → Developer Mode**, then right-click yourself → **Copy User
ID**, and paste it into the app's settings (⚙).

You'll get a ping when the other player claims, when a 2x window opens or closes,
and when a duel starts or resolves. Each event fires exactly once even though
both browsers see it — the clients race for a lock in the database and only the
winner posts.

No notifications go out between **1am and 7am US Eastern**, regardless of time
zone — the game itself doesn't sleep, it just won't page anyone overnight.

---

## How the rules actually work

**Claiming.** The game tracks one timestamp: when the clock was last taken. Your
claim banks `now − lastClaimAt`, then resets it to now. Across a whole game the
time banked by both players sums to the wall-clock time the game has existed
(minus whatever is currently on the clock). Nobody can conjure time from nowhere.

**2x windows.** Not stored anywhere — derived. Both browsers run the same seeded
random function over `gameCode + UTC date` and independently arrive at the same
two hours. No writes, no races, and no way to see tomorrow's windows without the
game code. Windows are aligned to UTC hours and shown in your local time, so two
players in different timezones always agree on when 2x is live.

**Contested claims.** If a *different* player claimed less than 3 seconds ago,
you were both racing for the same block. It goes into escrow: their banked time
plus the sliver you were reaching for, one pot. Rock-paper-scissors, best of one,
winner takes all — the loser gets nothing. Draws re-throw with the pot intact.
Clicking twice yourself never triggers this.

While a duel is unsettled, that game is frozen — no claims land in it. You're
also locked out of claiming in *any* game until you've thrown, which is what
stops you from stalling a duel while you keep farming elsewhere. Once you've
thrown you're free again, even if your opponent hasn't answered yet, so nobody
can hold your other games hostage by going to sleep.

**The clock keeps running during a duel.** Whoever claims first after it settles
picks up the duel's own duration too.

**Simultaneous clicks.** Every claim goes through a Firebase transaction, which
is atomic. If you both press at the same millisecond, one write provably lands
first and the other is re-evaluated against the result. There is no ambiguity
and no lost update — the 3-second rule is applied to a single agreed ordering,
not to whichever packet happened to arrive first.

---

## Project layout

```
index.html          the site
css/styles.css      all styling
js/config.js        Firebase config + tuning constants   <- you edit this
js/engine.js        the state machine, as pure functions
js/rules.js         2x windows, RPS, summary aggregation
js/series.js        chart maths: lead timeline, OHLC bucketing
js/charts.js        SVG renderers (no chart library)
js/importer.js      parsing pasted data; building exports
js/store.js         Firebase reads/writes and transactions
js/discord.js       webhook payloads
js/app.js           screens, rendering, the claim fan-out
js/util.js          formatting, seeded PRNG, localStorage
dev/mock-store.js   demo mode: in-memory store + practice bot (?demo only)
```

`engine.js`, `rules.js`, `series.js` and `importer.js` are pure — no Firebase, no
DOM — which is what makes the tricky parts (tie detection, escrow, draws,
deadlines, OHLC bucketing, countdown conversion) directly testable.

The charts are hand-built SVG rather than a charting library: it keeps the site
dependency-free and there is nothing to load from a CDN. The two series colours
were validated for the dark surface against colour-vision-deficiency separation
and contrast rather than picked by eye, and blue always means you while orange
always means your opponent — including in the candle bodies, where "up" means
your lead grew.

## Tuning

In [`js/config.js`](js/config.js):

| Constant | Default | Meaning |
| --- | --- | --- |
| `TIE_WINDOW_MS` | `3000` | How close two claims must be to trigger rock-paper-scissors |
| `DOUBLE_WINDOWS_PER_DAY` | `2` | Number of bonus windows each day |
| `DOUBLE_MULTIPLIER` | `2` | What those windows multiply claims by |
