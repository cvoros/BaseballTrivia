import * as E from './engine.js';
import * as MLB from './mlb.js';
import { findMatch } from './fuzzy.js';
import { LocalStore, OnlineStore, onlineEnabled, newGameCode, myIdentity, saveIdentity, forgetIdentity, rememberGame, knownGames } from './store.js';

// --- App state --------------------------------------------------------------

let G = null;              // current game object
let gameCode = null;       // online game code (null for local)
let myIdx = null;          // my player index online (null for local hot-seat)
let unsubscribe = null;
let teams = null;          // [{id, name, teamName}] sorted by id
let teamById = {};
let marqueeSet = new Set(); // star-studded team ids (issue #3 difficulty aid)
let handoffDone = null;    // half key confirmed via handoff screen (local mode)
let pendingMode = null;    // which mode the names screen is collecting for

const SEASON = (() => {
  const now = new Date();
  // Before April, last year's rosters are the most recent meaningful ones.
  return now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
})();

const $ = id => document.getElementById(id);
const screens = ['screen-home', 'screen-claim', 'screen-names', 'screen-lobby', 'screen-game'];

function show(id) {
  for (const s of screens) $(s).classList.toggle('hidden', s !== id);
  window.scrollTo(0, 0);
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}

// Key-order-independent serialization. Firestore snapshots return the same
// data with different key order than the local object, so JSON.stringify
// comparison misfires and our own write echoes re-render mid-feedback.
function stableStringify(o) {
  if (o === null || typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return '[' + o.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
}

async function ensureTeams() {
  if (!teams) {
    teams = await MLB.getTeams(SEASON);
    teamById = Object.fromEntries(teams.map(t => [t.id, t]));
    try {
      const star = await (await fetch('data/star-teams.json')).json();
      marqueeSet = new Set((star.marquee || []).map(Number));
    } catch { marqueeSet = new Set(); } // no star data → uniform team odds
  }
  return teams;
}

// Options that make team selection favor the Dodgers + marquee teams.
function questionOpts() {
  return { marquee: marqueeSet, favoriteId: G?.favoriteId };
}

function save() {
  if (G.mode === 'online') return OnlineStore.save(gameCode, G);
  LocalStore.save(G);
}

// --- Home / setup flow --------------------------------------------------------

function initHome() {
  $('btn-local').onclick = () => showNames('local');
  $('btn-create').onclick = () => showNames('online-create');
  $('btn-join').onclick = () => {
    const code = $('join-code').value.trim().toUpperCase();
    if (code.length === 6) joinFlow(code);
  };
  if (!onlineEnabled) {
    $('btn-create').disabled = true;
    $('btn-join').disabled = true;
    $('online-hint').classList.remove('hidden');
  }
  const resumable = LocalStore.load();
  if (resumable && resumable.status !== 'final') {
    $('btn-resume').classList.remove('hidden');
    $('btn-resume').textContent = `Resume: ${resumable.players[0].name} vs ${resumable.players[1].name} →`;
    $('btn-resume').onclick = () => resumeLocal(resumable);
  }
  document.querySelectorAll('.btn-home').forEach(b => (b.onclick = goHome));
  renderGameList();
}

// Home-page list of this device's online games, with live "your move" badges.
function renderGameList() {
  const el = $('game-list');
  if (!onlineEnabled) { el.innerHTML = ''; return; }
  const games = knownGames().filter(g => myIdentity(g.code)).slice(0, 8);
  if (!games.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<h2 class="list-title">Your games</h2>' +
    games.map(g => `
      <button class="game-item" data-code="${esc(g.code)}">
        <span>${esc(g.names[0] || '?')} vs ${esc(g.names[1] || '(waiting)')} · ${esc(g.code)}</span>
        <span class="gstatus" id="gstatus-${esc(g.code)}">…</span>
      </button>`).join('');
  el.querySelectorAll('.game-item').forEach(b => (b.onclick = () => joinFlow(b.dataset.code)));
  for (const g of games) refreshGameBadge(g.code);
}

async function refreshGameBadge(code) {
  try {
    const game = await OnlineStore.load(code);
    const el = $(`gstatus-${code}`);
    if (!el || !game) return;
    const idx = myIdentity(code)?.playerIdx;
    if (game.status === 'final') el.textContent = 'Finished';
    else if (game.status === 'lobby') el.textContent = 'Waiting for opponent';
    else if (E.batterIdx(game) === idx) { el.textContent = '▶ Your move'; el.classList.add('yourmove'); }
    else el.textContent = 'Their move';
  } catch { /* offline — leave the placeholder */ }
}

function goHome() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  G = null; gameCode = null; myIdx = null; handoffDone = null;
  history.replaceState(null, '', location.pathname);
  initHome();
  show('screen-home');
}

function showNames(mode, prefillCode) {
  pendingMode = mode;
  const two = mode === 'local';
  $('name2-label').classList.toggle('hidden', !two);
  $('names-title').textContent =
    mode === 'local' ? "Who's playing?" :
    mode === 'online-create' ? 'Your name?' : `Joining game ${prefillCode} — your name?`;
  $('names-error').classList.add('hidden');
  $('btn-start').onclick = () => startFromNames(prefillCode);
  show('screen-names');
  $('name1').focus();
}

async function startFromNames(joinCode) {
  const n1 = $('name1').value.trim();
  const n2 = $('name2').value.trim();
  const fail = msg => { $('names-error').textContent = msg; $('names-error').classList.remove('hidden'); };
  if (!n1) return fail('Enter a name.');
  try {
    if (pendingMode === 'local') {
      if (!n2) return fail('Enter both names.');
      G = E.newGame({ mode: 'local', names: [n1, n2], season: SEASON });
      gameCode = null; myIdx = null; handoffDone = null;
      LocalStore.save(G);
      enterGame();
    } else if (pendingMode === 'online-create') {
      $('btn-start').disabled = true;
      G = E.newGame({ mode: 'online', names: [n1, ''], season: SEASON });
      G.status = 'lobby';
      G.players[1].name = ''; // empty slot signals "joinable" (newGame defaults it)
      gameCode = newGameCode();
      myIdx = 0;
      await OnlineStore.create(gameCode, G);
      saveIdentity(gameCode, 0);
      rememberGame(gameCode, G);
      history.replaceState(null, '', `?game=${gameCode}`);
      showLobby();
      await subscribeOnline();
    } else { // online-join
      $('btn-start').disabled = true;
      G = await OnlineStore.join(joinCode, n1);
      gameCode = joinCode;
      myIdx = 1;
      saveIdentity(joinCode, 1);
      rememberGame(joinCode, G);
      history.replaceState(null, '', `?game=${joinCode}`);
      await subscribeOnline();
      enterGame();
    }
  } catch (err) {
    fail(err.message || 'Something went wrong.');
  } finally {
    $('btn-start').disabled = false;
  }
}

function showLobby() {
  $('lobby-code').textContent = gameCode;
  const link = `${location.origin}${location.pathname}?game=${gameCode}`;
  $('lobby-link').value = link;
  $('btn-copy-link').onclick = async () => {
    try {
      await navigator.clipboard.writeText(link);
      $('btn-copy-link').textContent = 'Copied!';
      setTimeout(() => ($('btn-copy-link').textContent = 'Copy Link'), 1500);
    } catch {
      $('lobby-link').select();
    }
  };
  show('screen-lobby');
}

async function joinFlow(code) {
  const id = myIdentity(code);
  if (id) return enterOnlineGame(code, id.playerIdx);
  // No identity on this device: ask who they are. Named seats can be
  // reclaimed (new phone, cleared cache); an open seat can be joined.
  let game = null;
  try { game = await OnlineStore.load(code); } catch { /* fall through */ }
  if (!game || !game.players) { alert('No game found with that code.'); return goHome(); }
  showClaim(code, game);
}

function showClaim(code, game) {
  const named = game.players.map((p, i) => ({ p, i })).filter(x => x.p.name);
  $('claim-title').textContent = named.length === 2
    ? `Game ${code}: ${named[0].p.name} vs ${named[1].p.name}`
    : `Game ${code}, started by ${named[0].p.name}`;
  $('claim-buttons').innerHTML =
    named.map(x => `<button class="big-btn" data-idx="${x.i}">I'm ${esc(x.p.name)}</button>`).join('') +
    (named.length < 2
      ? `<button class="big-btn" id="btn-claim-join">I'm new here — join as ${esc(named[0].p.name)}'s opponent</button>`
      : '');
  document.querySelectorAll('#claim-buttons button[data-idx]').forEach(b => {
    b.onclick = () => {
      saveIdentity(code, Number(b.dataset.idx));
      enterOnlineGame(code, Number(b.dataset.idx));
    };
  });
  const joinBtn = $('btn-claim-join');
  if (joinBtn) joinBtn.onclick = () => showNames('online-join', code);
  show('screen-claim');
}

async function enterOnlineGame(code, playerIdx) {
  const game = await OnlineStore.load(code);
  if (!game) { alert('No game found with that code.'); return goHome(); }
  // Stale identity: this device claims a seat that's since been vacated
  // (e.g. an accidental join was undone). Forget it and ask again.
  if (!game.players[playerIdx]?.name) {
    forgetIdentity(code);
    return joinFlow(code);
  }
  gameCode = code;
  myIdx = playerIdx;
  G = game;
  rememberGame(code, G);
  history.replaceState(null, '', `?game=${code}`);
  await subscribeOnline();
  if (G.status === 'lobby') showLobby(); else enterGame();
}

async function subscribeOnline() {
  if (unsubscribe) unsubscribe();
  unsubscribe = await OnlineStore.subscribe(gameCode, remote => {
    const changed = stableStringify(remote) !== stableStringify(G);
    if (!changed) return;
    // Never let a snapshot yank the screen away mid-at-bat: while I'm batting
    // I'm the only writer, so anything differing here is stale/echo noise.
    if (G?.status === 'active' && E.batterIdx(G) === myIdx) return;
    const wasLobby = G?.status === 'lobby';
    G = remote;
    rememberGame(gameCode, G);
    if (wasLobby && G.status !== 'lobby') enterGame();
    else if (!$('screen-game').classList.contains('hidden')) renderGame();
    else if (G.status !== 'lobby') enterGame();
  });
}

function resumeLocal(game) {
  G = game;
  gameCode = null; myIdx = null;
  // Require a fresh handoff confirmation so nobody resumes mid-question unseen.
  handoffDone = null;
  enterGame();
}

function enterGame() {
  show('screen-game');
  renderGame();
}

// --- Rendering ----------------------------------------------------------------

function renderGame() {
  renderScoreboard();
  ensureTeams().then(() => {
    if (G.status === 'final') renderFinal();
    else renderActive();
    renderReplays();
  }).catch(err => {
    $('game-content').innerHTML =
      `<div class="card center"><p class="error">Couldn't reach the MLB Stats API: ${esc(err.message)}</p>
       <button class="big-btn slim" onclick="location.reload()">Retry</button></div>`;
  });
}

function renderScoreboard() {
  const away = G.players[G.awayIdx];
  const home = G.players[1 - G.awayIdx];
  const ls = E.lineScore(G);
  const battingSide = G.current?.half === 'top' ? 'away' : 'home';
  const active = G.status === 'active';

  const inningCells = side =>
    ls.innings.map(i => `<td>${esc(String(i[side]).replace('*', ''))}${String(i[side]).includes('*') ? '<span class="at-bat-marker">▸</span>' : ''}</td>`).join('');

  let statusLine = '';
  if (active) {
    const cur = G.current;
    const batter = G.players[E.batterIdx(G)];
    const outsDots = '●'.repeat(cur.outs) + '○'.repeat(E.MAX_OUTS - cur.outs);
    statusLine = `<div class="board-status">${cur.half === 'top' ? 'TOP' : 'BOT'} ${cur.inning} · AT BAT: ${esc(batter.name)} · OUTS <span class="outs">${outsDots}</span></div>`;
  } else if (G.status === 'lobby') {
    statusLine = `<div class="board-status">WAITING FOR OPPONENT</div>`;
  } else {
    statusLine = `<div class="board-status">FINAL${ls.innings.length > E.REG_INNINGS ? '/' + ls.innings.length : ''}</div>`;
  }

  $('scoreboard').innerHTML = `
    <table>
      <tr><th></th>${ls.innings.map(i => `<th>${i.inning}</th>`).join('')}<th>R</th></tr>
      <tr><td class="team">${active && battingSide === 'away' ? '▸ ' : ''}${esc(away.name || '—')}</td>${inningCells('away')}<td class="total">${ls.away}</td></tr>
      <tr><td class="team">${active && battingSide === 'home' ? '▸ ' : ''}${esc(home.name || '—')}</td>${inningCells('home')}<td class="total">${ls.home}</td></tr>
    </table>
    ${statusLine}`;
}

function renderActive() {
  const batter = E.batterIdx(G);
  const hk = E.halfKey(G.current.inning, G.current.half);

  if (G.mode === 'online') {
    if (batter === myIdx) renderQuestion();
    else renderWaiting();
    return;
  }
  // Hot-seat: require an explicit handoff tap at the start of each half.
  if (handoffDone === hk) renderQuestion();
  else renderHandoff(hk);
}

function renderHandoff(hk) {
  const batter = G.players[E.batterIdx(G)];
  const half = G.current.half === 'top' ? 'Top' : 'Bottom';
  $('game-content').innerHTML = `
    <div class="card handoff">
      <h2>${half} of inning ${G.current.inning}</h2>
      <p><strong>${esc(batter.name)}</strong>, you're up!<br>
      Your own set of teams — nothing your opponent saw will help you here.</p>
      <button class="big-btn" id="btn-handoff">I'm ${esc(batter.name)} — Play Ball</button>
    </div>`;
  $('btn-handoff').onclick = () => { handoffDone = hk; renderGame(); };
}

function renderWaiting() {
  const opp = G.players[E.batterIdx(G)];
  $('game-content').innerHTML = `
    <div class="card handoff">
      <h2>${esc(opp.name)} is at bat<span class="dots"></span></h2>
      <p>Follow their at-bats live in the play-by-play below.<br>
      This page updates automatically when it's your turn — come back whenever.</p>
    </div>`;
}

async function renderQuestion() {
  const q = E.currentQuestion(G, teams.map(t => t.id), questionOpts());
  const team = teamById[q.teamId];
  const cur = G.current;
  // Results so far in this trip through the order, for the progress dots.
  const passEvents = (G.halves[E.halfKey(cur.inning, cur.half)]?.events || [])
    .filter(e => e.passIdx === cur.passIdx);

  $('game-content').innerHTML = `
    <div class="card question-card">
      <div class="q-progress">${E.POSITIONS.map((p, i) => {
        const ev = passEvents[i];
        const cls = i === cur.posIdx ? 'now' : i < cur.posIdx ? (ev && !ev.correct ? 'out' : 'done') : '';
        return `<div class="pos-dot ${cls}">${p}</div>`;
      }).join('')}
      </div>
      <div class="q-team">
        <img src="${MLB.teamLogoUrl(q.teamId)}" alt="" onerror="this.style.display='none'">
        <span class="team-name">${esc(team.name)}</span>
      </div>
      <div class="q-pos">${E.POSITION_NAMES[q.pos]} (${q.pos})</div>
      <div class="q-hint">${E.POSITION_HINTS[q.pos]}</div>
      <div class="answer-row">
        <input id="answer" type="text" placeholder="Player name…" autocomplete="off" autocorrect="off" spellcheck="false">
        <button class="big-btn slim" id="btn-answer">Swing</button>
      </div>
    </div>`;

  const input = $('answer');
  input.focus();

  // Fetch the roster while the player reads the question.
  let roster;
  try {
    roster = await MLB.getRoster(q.teamId, G.season);
  } catch (err) {
    $('game-content').querySelector('.card').innerHTML =
      `<p class="error">Couldn't load the ${esc(team.name)} roster: ${esc(err.message)}</p>
       <button class="big-btn slim" onclick="location.reload()">Retry</button>`;
    return;
  }
  const eligible = MLB.eligiblePlayers(roster, q.pos);

  // No clock — take as long as you like.
  const submit = () => {
    const guess = input.value.trim();
    if (!guess) return;
    settle({ guess, timedOut: false });
  };
  $('btn-answer').onclick = submit;
  input.onkeydown = e => { if (e.key === 'Enter') submit(); };

  let settled = false;
  function settle({ guess }) {
    if (settled) return; // guard against double-click / Enter+click
    settled = true;
    const match = guess ? findMatch(guess, eligible) : null;
    const result = {
      teamId: q.teamId, pos: q.pos, guess: guess || '',
      correct: !!match, matchedName: match ? match.fullName : null,
    };
    if (result.correct) {
      commitResult(result, team, eligible);
    } else {
      // A miss isn't final until the batter accepts it: appeal process.
      showOutDecision(result, team, eligible);
    }
  }
}

// The ump's call on a miss, with the appeal option (honor system, same as the
// Jeopardy game): overridden answers are flagged in the play-by-play so your
// opponent sees exactly what you claimed.
function showOutDecision(result, team, eligible) {
  renderScoreboard();
  const answers = eligible.map(p => p.fullName);
  const shown = answers.slice(0, 6);
  $('game-content').innerHTML = `
    <div class="card">
      <div class="feedback bad">
        <div class="verdict">✗ Out?</div>
        <div class="detail">"${esc(result.guess)}" doesn't match anyone listed on the ${esc(team.name)} at ${result.pos}.</div>
        <div class="detail">Listed there: ${shown.map(esc).join(', ')}${answers.length > shown.length ? '…' : ''}</div>
      </div>
      <button class="big-btn" id="btn-take-out">Fair call — take the out</button>
      <button class="link-btn" id="btn-override">Bad call, ump! My answer names a real ${esc(team.teamName)} ${result.pos} — count it</button>
    </div>`;
  $('btn-take-out').onclick = () => commitResult(result, team, eligible);
  $('btn-override').onclick = () =>
    commitResult({ ...result, correct: true, overridden: true }, team, eligible);
}

// Apply an answer, persist it, and show the verdict. Reads the run count off
// the half record (not game.current, which resets when a half ends) so a run
// that ends the half is still detected.
function commitResult(result, team, eligible) {
  const hk = E.halfKey(G.current.inning, G.current.half);
  const runsBefore = G.halves[hk]?.runs || 0;
  E.applyResult(G, result);
  save();
  const scoredRun = (G.halves[hk]?.runs || 0) > runsBefore;
  const halfEnded = G.status === 'final' || E.halfKey(G.current.inning, G.current.half) !== hk;
  showFeedback(result, team, eligible, { scoredRun, halfEnded });
}

function showFeedback(result, team, eligible, { scoredRun, halfEnded }) {
  renderScoreboard();
  const nextPos = E.POSITION_NAMES[E.POSITIONS[G.current.posIdx]];
  let html = '';
  if (result.correct) {
    html = `<div class="feedback good">
      <div class="verdict">✓ ${esc(result.matchedName || result.guess)}</div>
      ${scoredRun ? '<div class="run-banner">🏃 RUN SCORES! You batted through the order!</div>' : ''}
      <div class="detail">${result.overridden
        ? 'Counted on appeal — your opponent will see this one in the play-by-play.'
        : `${esc(result.guess)} — safe!`}</div>
      ${!scoredRun && !halfEnded ? `<div class="detail">Next up: ${esc(nextPos)}.</div>` : ''}
    </div>`;
  } else {
    const answers = eligible.map(p => p.fullName);
    const shown = answers.slice(0, 6);
    html = `<div class="feedback bad">
      <div class="verdict">✗ Out!</div>
      <div class="detail">"${esc(result.guess)}" isn't on the ${esc(team.name)} at ${result.pos}.</div>
      <div class="detail">You could've said: ${shown.map(esc).join(', ')}${answers.length > shown.length ? '…' : ''}</div>
      ${scoredRun ? '<div class="run-banner">🏃 RUN SCORES anyway — you batted through the order!</div>' : ''}
      ${!halfEnded ? `<div class="detail">You stay in the order — next up: ${esc(nextPos)}.</div>` : ''}
    </div>`;
  }

  const nextLabel =
    G.status === 'final' ? 'See Final' :
    G.mode === 'online' && E.batterIdx(G) !== myIdx ? 'End of my half' : 'Next';

  $('game-content').innerHTML = `<div class="card">${html}
    <button class="big-btn" id="btn-next">${nextLabel} →</button></div>`;
  $('btn-next').onclick = () => renderGame();
}

function renderFinal() {
  const w = E.winnerIdx(G);
  const ls = E.lineScore(G);
  const loserIdx = w === null ? null : 1 - w;
  $('game-content').innerHTML = `
    <div class="card final-banner">
      <div class="trophy">🏆</div>
      <h2>${w === null ? 'It’s a tie?!' : esc(G.players[w].name) + ' wins!'}</h2>
      <p>Final: ${esc(G.players[G.awayIdx].name)} ${ls.away}, ${esc(G.players[1 - G.awayIdx].name)} ${ls.home}${ls.innings.length > E.REG_INNINGS ? ` (${ls.innings.length} innings)` : ''}</p>
      ${w !== null ? `<p>Tough one, ${esc(G.players[loserIdx].name)}. Rematch?</p>` : ''}
      <button class="big-btn" id="btn-rematch">Play Again</button>
    </div>`;
  $('btn-rematch').onclick = () => {
    if (G.mode === 'local') {
      const names = [G.players[0].name, G.players[1].name];
      G = E.newGame({ mode: 'local', names, season: SEASON });
      handoffDone = null;
      LocalStore.save(G);
      renderGame();
    } else {
      goHome();
      showNames('online-create');
    }
  };
}

// Every half is visible to both players, live — each half-inning draws its own
// teams, so watching your opponent's at-bats can't give away your own answers.
function canViewHalf(inning, half) {
  return !!G.halves[E.halfKey(inning, half)];
}

function renderReplays() {
  const parts = [];
  const innings = [...new Set(Object.keys(G.halves).map(k => parseInt(k, 10)))].sort((a, b) => a - b);
  for (const inning of innings) {
    for (const half of ['top', 'bottom']) {
      const hk = E.halfKey(inning, half);
      const h = G.halves[hk];
      if (!h || !h.events.length || !canViewHalf(inning, half)) continue;
      const batter = G.players[half === 'top' ? G.awayIdx : 1 - G.awayIdx];
      const rows = [];
      let lastPass = -1;
      let inPass = 0;    // batters faced in this trip through the order
      let outs = 0;      // outs so far in the half (3 ends it, no run credited)
      for (const ev of h.events) {
        if (ev.passIdx !== lastPass) { lastPass = ev.passIdx; inPass = 0; }
        inPass++;
        if (!ev.correct) outs++;
        const team = teamById[ev.teamId];
        if (ev.correct) {
          rows.push(`<li><span class="ev-ok">✓</span><span class="ev-what">${esc(team?.teamName || '?')} ${ev.pos}</span> ${esc(ev.matchedName || ev.guess)}${ev.overridden ? ' <em class="appealed">(overruled the ump)</em>' : ''}</li>`);
        } else {
          rows.push(`<li><span class="ev-bad">✗</span><span class="ev-what">${esc(team?.teamName || '?')} ${ev.pos}</span> ${ev.timedOut ? '(clock ran out)' : esc(ev.guess)} — out</li>`);
        }
        // Batting through all 9 scores — unless that batter made the third out.
        if (inPass === E.POSITIONS.length && outs < E.MAX_OUTS) {
          rows.push(`<li class="run-line">🏃 Run scores!</li>`);
        }
      }
      parts.push(`<div class="card replay-half">
        <h3>${half === 'top' ? 'Top' : 'Bottom'} ${inning} — ${esc(batter.name)} (${h.runs} R, ${h.outs} out${h.outs === 1 ? '' : 's'}${h.done ? '' : ', in progress'})</h3>
        <ul>${rows.join('')}</ul></div>`);
    }
  }
  $('replays').innerHTML = parts.length
    ? `<h2 style="margin:6px 0 10px;font-size:1.05rem;color:var(--cream-dim)">📋 Play-by-play</h2>${parts.reverse().join('')}`
    : '';
}

// --- Boot ---------------------------------------------------------------------

initHome();
const urlCode = new URLSearchParams(location.search).get('game');
if (urlCode && onlineEnabled) {
  joinFlow(urlCode.toUpperCase());
} else {
  show('screen-home');
}
