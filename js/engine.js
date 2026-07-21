// Game engine: pure state transitions, no DOM and no I/O.
//
// Rules (v1):
// - 3 innings; away side (random) bats the top of each inning.
// - A half-inning is a series of "lineup passes": 9 positions in batting-quiz
//   order (P, C, 1B, 2B, 3B, SS, LF, CF, RF), each paired with a team.
// - Correct answer -> next position. All 9 correct -> 1 run, start next pass.
// - Miss or timeout -> 1 out, abandon the pass, next pass starts at P.
// - Half ends at 3 outs or 3 runs.
// - Both players face the identical passes in a given inning (seeded), so the
//   matchup is fair. Don't watch your opponent's half before playing yours!
// - Tie after 3 innings -> extra innings. Standard walk-off logic: the game
//   ends the moment the home side leads in inning 3+.

export const POSITIONS = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'];

export const POSITION_NAMES = {
  P: 'Pitcher', C: 'Catcher', '1B': 'First Base', '2B': 'Second Base',
  '3B': 'Third Base', SS: 'Shortstop', LF: 'Left Field', CF: 'Center Field',
  RF: 'Right Field',
};

export const POSITION_HINTS = {
  P: 'Any pitcher on the active roster counts',
  C: 'Any catcher on the active roster counts',
  '1B': 'Any 1B (or DH) on the active roster counts',
  '2B': 'Any 2B on the active roster counts',
  '3B': 'Any 3B on the active roster counts',
  SS: 'Any SS on the active roster counts',
  LF: 'Any outfielder (or DH) counts',
  CF: 'Any outfielder (or DH) counts',
  RF: 'Any outfielder (or DH) counts',
};

export const MAX_STRIKES = 3; // swings per spot in the order before it's an out
export const REG_INNINGS = 3;
export const MAX_OUTS = 3;
export const MAX_RUNS = 3;
const PASSES_PER_INNING = MAX_OUTS + MAX_RUNS; // worst case

// --- Seeded RNG (mulberry32) ---------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const FAVORITE_TEAM_ID = 119; // Dodgers — always in the mix (issue #3)
const MARQUEE_WEIGHT = 2;            // star-studded teams appear ~2x as often

// Pick `count` distinct ids from `pool` with probability proportional to
// weight (default 1). Deterministic given rng. Sampling without replacement.
function weightedSampleDistinct(pool, weightOf, count, rng) {
  const remaining = pool.slice();
  const picked = [];
  while (picked.length < count && remaining.length) {
    let total = 0;
    for (const id of remaining) total += weightOf(id);
    let r = rng() * total;
    let idx = 0;
    for (; idx < remaining.length; idx++) {
      r -= weightOf(remaining[idx]);
      if (r <= 0) break;
    }
    if (idx >= remaining.length) idx = remaining.length - 1;
    picked.push(remaining[idx]);
    remaining.splice(idx, 1);
  }
  return picked;
}

// Deterministic passes for one HALF-inning: PASSES_PER_INNING passes of 9
// distinct team ids. Each half gets its own sequence (`opts.half` salts the
// seed), so the two players never see the same teams — that's what lets the
// play-by-play be shown live without spoiling anything. Still seeded, so both
// devices agree on what the batter is being asked.
// Each pass guarantees the favorite team (Dodgers) and leans toward marquee
// teams, so the questions are more gettable.
// `opts.marquee` is a Set of team ids; `opts.favoriteId` overrides the default.
export function buildPasses(seed, inning, teamIds, opts = {}) {
  const marquee = opts.marquee || new Set();
  const favoriteId = opts.favoriteId ?? FAVORITE_TEAM_ID;
  const hasFavorite = teamIds.includes(favoriteId);
  const weightOf = id => (marquee.has(id) ? MARQUEE_WEIGHT : 1);
  const halfSalt = opts.half === 'bottom' ? 0x85ebca6b : 0;
  const rng = mulberry32((seed ^ (inning * 0x9e3779b9) ^ halfSalt) >>> 0);

  const passes = [];
  for (let p = 0; p < PASSES_PER_INNING; p++) {
    const need = POSITIONS.length;
    let pass;
    if (hasFavorite) {
      const others = weightedSampleDistinct(
        teamIds.filter(id => id !== favoriteId), weightOf, need - 1, rng);
      pass = shuffled([favoriteId, ...others], rng);
    } else {
      pass = weightedSampleDistinct(teamIds, weightOf, need, rng);
    }
    passes.push(pass);
  }
  return passes;
}

// --- Game state ------------------------------------------------------------

export function newGame({ mode, names, season }) {
  return {
    version: 1,
    mode, // 'local' | 'online'
    season,
    favoriteId: FAVORITE_TEAM_ID,
    seed: (Math.random() * 0xffffffff) >>> 0,
    players: [{ name: names[0] || 'Player 1' }, { name: names[1] || 'Player 2' }],
    awayIdx: Math.random() < 0.5 ? 0 : 1,
    status: 'active', // 'lobby' | 'active' | 'final'
    current: { inning: 1, half: 'top', passIdx: 0, posIdx: 0, outs: 0, runs: 0 },
    halves: {}, // "1-top": { events: [...], outs, runs, done }
  };
}

export function halfKey(inning, half) {
  return `${inning}-${half}`;
}

export function batterIdx(game) {
  const { half } = game.current;
  return half === 'top' ? game.awayIdx : 1 - game.awayIdx;
}

export function currentQuestion(game, teamIds, opts) {
  const { inning, half, passIdx, posIdx } = game.current;
  const passes = buildPasses(game.seed, inning, teamIds, { ...opts, half });
  return { teamId: passes[passIdx][posIdx], pos: POSITIONS[posIdx] };
}

export function runTotals(game) {
  const totals = { away: 0, home: 0 };
  for (const [key, h] of Object.entries(game.halves)) {
    const side = key.endsWith('top') ? 'away' : 'home';
    totals[side] += h.runs || 0;
  }
  return totals;
}

function ensureHalf(game) {
  const key = halfKey(game.current.inning, game.current.half);
  if (!game.halves[key]) {
    game.halves[key] = { events: [], outs: 0, runs: 0, done: false };
  }
  return game.halves[key];
}

// Apply one answered question. `result` = { teamId, pos, guess, correct,
// matchedName, timedOut }. Mutates and returns game.
export function applyResult(game, result) {
  const cur = game.current;
  const h = ensureHalf(game);
  h.events.push({ ...result, passIdx: cur.passIdx });

  // A miss costs an out but does NOT restart the lineup: you always bat on to
  // the next spot in the order. Batting through all 9 scores a run and turns
  // the order over (fresh set of teams). Third out ends the half immediately,
  // so no run is credited on the play that makes it.
  if (!result.correct) {
    cur.outs++;
    h.outs = cur.outs;
    cur.posIdx++;
    if (cur.outs === MAX_OUTS) return endHalf(game, h);
  } else {
    cur.posIdx++;
  }

  if (cur.posIdx === POSITIONS.length) {
    cur.runs++;
    h.runs = cur.runs;
    cur.posIdx = 0;
    cur.passIdx++;
    // Walk-off: home takes the lead in the bottom of inning 3+.
    if (cur.half === 'bottom' && cur.inning >= REG_INNINGS) {
      const t = runTotals(game);
      if (t.home > t.away) return endHalf(game, h);
    }
    if (cur.runs === MAX_RUNS) return endHalf(game, h);
  }
  return game;
}

function endHalf(game, h) {
  h.done = true;
  const cur = game.current;
  const t = runTotals(game);

  if (cur.half === 'top') {
    // Home already leads heading into the bottom of the final inning: game over.
    if (cur.inning >= REG_INNINGS && t.home > t.away) {
      game.status = 'final';
      return game;
    }
    game.current = { inning: cur.inning, half: 'bottom', passIdx: 0, posIdx: 0, outs: 0, runs: 0 };
  } else {
    if (cur.inning >= REG_INNINGS && t.home !== t.away) {
      game.status = 'final';
      return game;
    }
    game.current = { inning: cur.inning + 1, half: 'top', passIdx: 0, posIdx: 0, outs: 0, runs: 0 };
  }
  return game;
}

export function winnerIdx(game) {
  if (game.status !== 'final') return null;
  const t = runTotals(game);
  if (t.away === t.home) return null;
  return t.away > t.home ? game.awayIdx : 1 - game.awayIdx;
}

// Line score rows for display: one cell per inning plus R total.
export function lineScore(game) {
  const innings = [];
  const last = game.status === 'final'
    ? Math.max(REG_INNINGS, ...Object.keys(game.halves).map(k => parseInt(k, 10)))
    : Math.max(REG_INNINGS, game.current.inning);
  for (let i = 1; i <= last; i++) {
    const top = game.halves[halfKey(i, 'top')];
    const bot = game.halves[halfKey(i, 'bottom')];
    innings.push({
      inning: i,
      away: top ? (top.done ? top.runs : `${top.runs}*`) : (top === undefined ? '' : top.runs),
      home: bot ? (bot.done ? bot.runs : `${bot.runs}*`) : '',
    });
  }
  const t = runTotals(game);
  return { innings, away: t.away, home: t.home };
}
