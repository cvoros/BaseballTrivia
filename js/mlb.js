// MLB Stats API access with day-scoped localStorage caching.

const API = 'https://statsapi.mlb.com/api/v1';

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function cacheGet(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { day, data } = JSON.parse(raw);
    return day === dayKey() ? data : null;
  } catch {
    return null;
  }
}

function cacheSet(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ day: dayKey(), data }));
  } catch {
    /* storage full or unavailable — just skip caching */
  }
}

export async function getTeams(season) {
  const key = `bt_teams_${season}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const res = await fetch(`${API}/teams?sportId=1&season=${season}`);
  if (!res.ok) throw new Error(`MLB API teams request failed (${res.status})`);
  const json = await res.json();
  const teams = (json.teams || [])
    .map(t => ({ id: t.id, name: t.name, teamName: t.teamName }))
    .sort((a, b) => a.id - b.id);
  if (teams.length < 30) throw new Error(`Only ${teams.length} teams returned for ${season}`);
  cacheSet(key, teams);
  return teams;
}

export async function getRoster(teamId, season) {
  const key = `bt_roster_${teamId}_${season}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const res = await fetch(`${API}/teams/${teamId}/roster?rosterType=active&season=${season}`);
  if (!res.ok) throw new Error(`MLB API roster request failed (${res.status})`);
  const json = await res.json();
  const roster = (json.roster || []).map(r => ({
    fullName: r.person.fullName,
    pos: r.position?.abbreviation || '',
  }));
  cacheSet(key, roster);
  return roster;
}

// Which listed roster positions satisfy each quiz position. Deliberately
// generous: any pitcher counts for P, any outfielder for an OF slot, and
// DH-listed bats count at 1B/OF so pure DHs aren't unanswerable.
const ELIGIBLE = {
  P: ['P', 'SP', 'RP', 'LHP', 'RHP', 'TWP'],
  C: ['C'],
  '1B': ['1B', 'IF', 'UT', 'DH'],
  '2B': ['2B', 'IF', 'UT'],
  '3B': ['3B', 'IF', 'UT'],
  SS: ['SS', 'IF', 'UT'],
  LF: ['LF', 'CF', 'RF', 'OF', 'UT', 'DH'],
  CF: ['LF', 'CF', 'RF', 'OF', 'UT', 'DH'],
  RF: ['LF', 'CF', 'RF', 'OF', 'UT', 'DH'],
};

export function eligiblePlayers(roster, quizPos) {
  const ok = ELIGIBLE[quizPos] || [quizPos];
  return roster.filter(p => ok.includes(p.pos));
}

export function teamLogoUrl(teamId) {
  return `https://www.mlbstatic.com/team-logos/${teamId}.svg`;
}
