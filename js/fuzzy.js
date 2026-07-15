// Fuzzy name matching: normalize (lowercase, strip accents, strip punctuation),
// then exact or per-word Levenshtein with length-based thresholds.

export function normalize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// A guessed word matches a target word within a typo budget scaled to length.
// Very short words must be exact so "Cruz" can't drift into "Ruiz".
function wordMatches(guessWord, targetWord) {
  if (guessWord === targetWord) return true;
  if (targetWord.length <= 3) return false;
  const budget = targetWord.length <= 5 ? 1 : 2;
  return levenshtein(guessWord, targetWord) <= budget;
}

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

// Candidate strings a guess may match: the full name, and the last-name group
// (everything after the first word, suffixes stripped) so "Betts", "Tatis",
// and "De La Cruz" all work.
function candidatesFor(fullName) {
  let words = normalize(fullName).split(' ').filter(Boolean);
  while (words.length > 1 && SUFFIXES.has(words[words.length - 1])) words.pop();
  const cands = [words];
  if (words.length > 1) cands.push(words.slice(1));
  return cands;
}

export function guessMatchesName(guess, fullName) {
  const guessWords = normalize(guess).split(' ').filter(Boolean);
  if (!guessWords.length) return false;
  for (const cand of candidatesFor(fullName)) {
    if (cand.length !== guessWords.length) continue;
    if (cand.every((w, i) => wordMatches(guessWords[i], w))) return true;
  }
  return false;
}

// Returns the first player in `players` (objects with .fullName) the guess
// matches, or null.
export function findMatch(guess, players) {
  for (const p of players) {
    if (guessMatchesName(guess, p.fullName)) return p;
  }
  return null;
}
