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

// Space-insensitive fuzzy equality with a typo budget scaled to length.
// Very short targets must be exact so "Cruz" can't drift into "Ruiz".
function fuzzyEquals(guess, target) {
  if (!guess || !target) return false;
  if (guess === target) return true;
  if (target.length <= 3) return false;
  const budget = target.length <= 4 ? 1 : target.length <= 8 ? 2 : 3;
  return levenshtein(guess, target) <= budget;
}

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

function significantWords(s) {
  const words = normalize(s).split(' ').filter(Boolean);
  while (words.length > 1 && SUFFIXES.has(words[words.length - 1])) words.pop();
  return words;
}

// A guess counts if, ignoring spaces/punctuation/accents/suffixes, it lands
// within typo distance of: the full name, the last-name group ("de la cruz"),
// the plain last word, or first-initial + last name ("fTatis").
export function guessMatchesName(guess, fullName) {
  const g = significantWords(guess).join('');
  if (!g) return false;
  const words = significantWords(fullName);
  const lastGroup = words.slice(1).join('');
  const targets = [words.join('')];
  if (words.length > 1) {
    targets.push(lastGroup);
    targets.push(words[words.length - 1]);
  }
  if (targets.some(t => fuzzyEquals(g, t))) return true;
  // First-initial + last name ("fTatis"): the initial must match exactly so a
  // wrong short guess can't ride the typo budget into someone else's name.
  return words.length > 1 && g[0] === words[0][0] && fuzzyEquals(g.slice(1), lastGroup);
}

// Returns the first player in `players` (objects with .fullName) the guess
// matches, or null.
export function findMatch(guess, players) {
  for (const p of players) {
    if (guessMatchesName(guess, p.fullName)) return p;
  }
  return null;
}
