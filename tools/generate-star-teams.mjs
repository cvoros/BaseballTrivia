// Precompute, for each MLB team, how many players on its current 40-man roster
// have ever been named an All-Star. Drives the "favor teams with big-name
// players" difficulty setting (issue #3). Output: data/star-teams.json.
//
// Run: node tools/generate-star-teams.mjs [season]
// Cheap (~50 requests) and only needs re-running when you want fresher rosters.

import { writeFileSync, mkdirSync } from 'node:fs';

const API = 'https://statsapi.mlb.com/api/v1';
const SEASON = Number(process.argv[2]) || 2026;
const FIRST_ASG_YEAR = 2006; // ~20 years of All-Star selections

const j = async url => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
};

async function allStarIds() {
  const ids = new Set();
  const years = [];
  for (let y = FIRST_ASG_YEAR; y <= SEASON; y++) years.push(y);
  for (const y of years) {
    for (const award of ['ALAS', 'NLAS']) {
      try {
        const d = await j(`${API}/awards/${award}/recipients?sportId=1&season=${y}`);
        for (const a of d.awards || []) if (a.player?.id) ids.add(a.player.id);
      } catch { /* a missing year shouldn't abort the whole build */ }
    }
  }
  return ids;
}

async function main() {
  console.log(`Collecting All-Star selections ${FIRST_ASG_YEAR}–${SEASON}…`);
  const stars = await allStarIds();
  console.log(`  ${stars.size} unique All-Star players.`);

  const teams = (await j(`${API}/teams?sportId=1&season=${SEASON}`)).teams
    .map(t => ({ id: t.id, name: t.name }))
    .sort((a, b) => a.id - b.id);

  const counts = {};
  const names = {};
  for (const t of teams) {
    const roster = (await j(`${API}/teams/${t.id}/roster?rosterType=40Man&season=${SEASON}`)).roster || [];
    const onTeam = roster.filter(r => stars.has(r.person.id)).map(r => r.person.fullName);
    counts[t.id] = onTeam.length;
    names[t.id] = t.name;
    console.log(`  ${t.name}: ${onTeam.length} — ${onTeam.slice(0, 4).join(', ')}${onTeam.length > 4 ? '…' : ''}`);
  }

  // Marquee tier = teams at/above the median star count (the "big-name" clubs).
  const ranked = teams.map(t => t.id).sort((a, b) => counts[b] - counts[a]);
  const median = counts[ranked[Math.floor(ranked.length / 2)]];
  const marquee = ranked.filter(id => counts[id] >= Math.max(median, 3));

  const out = {
    generatedAt: new Date().toISOString(),
    season: SEASON,
    note: 'counts = players on current 40-man who have ever been an All-Star',
    counts, names,
    marquee,
  };
  mkdirSync('data', { recursive: true });
  writeFileSync('data/star-teams.json', JSON.stringify(out, null, 2));
  console.log(`\nWrote data/star-teams.json — marquee tier (${marquee.length} teams): ${marquee.map(id => names[id]).join(', ')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
