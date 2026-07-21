# ⚾ Lineup Duel

Head-to-head baseball roster trivia. Name the player at each position for the
team you're shown — string together all 9 and you score a run. Three innings,
extra innings if tied.

Rosters come live from the free [MLB Stats API](https://statsapi.mlb.com), so
answers are always current — no stale trivia.

## Rules

- One player is randomly **home**, the other **away**. Away bats first.
- Your half-inning: you're shown a **team + position**, in lineup order
  (P, C, 1B, 2B, 3B, SS, LF, CF, RF). Type any player at that spot on the
  team's active roster. Typos and missing accents are forgiven.
- **Batting through all 9 spots = 1 run**, then the order turns over with a
  fresh set of teams.
- **A miss = 1 out**, but you stay in the order and keep batting — a miss never
  sends you back to the top. There is no clock; take as long as you like.
- **3 outs or 3 runs** ends your half. (No run is credited on the play that
  makes the third out.)
- Each half-inning draws its **own set of teams**, so your opponent's answers
  can never give away yours. That means the play-by-play is visible to both of
  you **live** — you can follow their half like a gameday feed while they play.
- Every inning includes the **Dodgers** and leans toward star-studded teams, so
  there are always some gettable questions in the mix.
- Tied after 3 innings → extra innings, walk-offs included.

### What counts as correct

- Answers come from each team's **40-man roster**, so injured-list players
  (e.g. Will Smith at Dodgers catcher) and depth pieces count too.
- **P** — any pitcher on the roster (SP, RP, two-way).
- **C / 1B / 2B / 3B / SS** — any player listed at that position on the roster.
- **LF / CF / RF** — any outfielder counts, regardless of which corner.
- Players listed as pure **DH** count at 1B and OF slots.
- Matching is forgiving: last names alone ("Betts"), first-initial + last
  ("F Tatis"), suffixes optional ("Tatis Jr"), and spacing/punctuation/accents
  ignored ("cj abrams", "de la cruz"), plus a typo budget that scales with
  name length.
- **Appeals**: a miss isn't final until you accept it. If the ump (the
  matcher) blows the call, tap "Bad call, ump!" and it counts — honor system,
  and the play-by-play shows your opponent exactly what you typed.

## Play modes

**🪑 Pass & Play** — two players, one device. Works immediately, no setup.

**🌐 Online (async)** — create a game, send the link, and each of you plays
your half whenever it's convenient, like a chess game played over days. The
page updates automatically when it's your turn. Requires the one-time Firebase
setup below.

## Hosting (GitHub Pages)

This is a plain static site — no build step. Push the folder to a GitHub repo,
then Settings → Pages → deploy from the `main` branch root. Done.

(Modules require http, so opening `index.html` directly from disk won't work —
use GitHub Pages or any local server, e.g. `npx serve`.)

## One-time Firebase setup for online play (~5 minutes, free)

1. Go to [console.firebase.google.com](https://console.firebase.google.com),
   sign in with a Google account, and click **Add project**. Name it anything
   (e.g. `lineup-duel`). You can turn OFF Google Analytics when asked.
2. In the project, click the **web icon `</>`** ("Add app"). Nickname it
   anything, skip Firebase Hosting, and click **Register app**.
3. It shows you a `firebaseConfig = { ... }` code block. Copy just the
   `{ ... }` object.
4. In this repo, open `js/firebase-config.js` and replace `null` with that
   object (the commented example shows exactly what it looks like).
5. Back in the Firebase console: **Build → Firestore Database → Create
   database**. Choose **Start in test mode** and any location.
6. Test mode expires after 30 days, so set permanent rules now: in Firestore,
   open the **Rules** tab and replace the contents with:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /games/{code} {
         allow read, write: if true;
       }
     }
   }
   ```

   Click **Publish**. (Yes, this is wide open — fine for a two-person game of
   no monetary value. Anyone who found your project ID could read game docs,
   which contain only usernames and trivia answers.)
7. Commit + push. Online play is now enabled.

Free-tier limits (50k reads / 20k writes per day) are thousands of times more
than two players can use.

## Regenerating data / icons

- `node tools/generate-star-teams.mjs [season]` refreshes `data/star-teams.json`
  (which teams have the most current players who've ever been All-Stars — drives
  the "favor star teams" difficulty aid). Re-run when rosters change.
- The app icon lives in `tools/source-icon.png`; `apple-touch-icon.png`,
  `icon-192.png`, `icon-512.png`, and `favicon-32.png` are resized from it.

## Ideas parked for v2

- Historical innings: same game, but rosters from a random past season
  (the roster API takes a `season` parameter — cheap to add).
- Dodgers deep-dive inning with hand-written questions.
- Live "gameday" spectating of the opponent's half in progress.
