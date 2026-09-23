'use strict';
// Fuzzy file-name matching for Quick Open (pure → unit-testable).
//
// Per term: exact > prefix > contiguous > subsequence (case-insensitive).
// Space-separated terms are ANDed. A term containing "/" (or "\") is matched
// against "<folder relative to its root>/<name>" instead of the name alone.
// Ties: shorter name first, then natural name order, then path.

const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

const EXACT = 1000;
const PREFIX = 800;
const CONTIG = 600;
const SUBSEQ = 300;

/**
 * Score `q` (already lower-case) against `text`. Returns {score, positions}
 * (positions = matched character indexes in `text`) or null.
 */
function scoreText(text, q, stem = null) {
  if (!q) return { score: 0, positions: [] };
  const t = text.toLowerCase();
  const range = (from, n) => Array.from({ length: n }, (_, i) => from + i);
  if (t === q || (stem !== null && stem.toLowerCase() === q)) return { score: EXACT, positions: range(0, q.length) };
  if (t.startsWith(q)) return { score: PREFIX - (t.length - q.length) * 0.01, positions: range(0, q.length) };
  const idx = t.indexOf(q);
  if (idx >= 0) {
    // word-boundary starts rank above mid-word ones
    const boundary = idx > 0 && /[\s_\-.()[\]/\\]/.test(t[idx - 1]) ? 50 : 0;
    return { score: CONTIG + boundary - idx, positions: range(idx, q.length) };
  }
  // subsequence: greedy leftmost, penalise gaps
  const positions = [];
  let from = 0;
  let gaps = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, from);
    if (i < 0) return null;
    if (positions.length && i > positions[positions.length - 1] + 1) gaps += i - positions[positions.length - 1] - 1;
    positions.push(i);
    from = i + 1;
  }
  return { score: SUBSEQ - gaps - positions[0] * 0.5, positions };
}

function splitTerms(query) {
  return String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Match one entry {name, rel} against a query. Returns
 * {score, positions (in name)} or null when any term fails.
 */
function matchEntry(entry, query) {
  const terms = splitTerms(query);
  if (!terms.length) return null;
  const name = entry.name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const full = `${(entry.rel || '').split('\\').join('/')}${entry.rel ? '/' : ''}${name}`;
  let score = 0;
  const positions = new Set();
  for (const term of terms) {
    if (term.includes('/') || term.includes('\\')) {
      const r = scoreText(full, term.split('\\').join('/'));
      if (!r) return null;
      score += r.score;
      const off = full.length - name.length;
      for (const p of r.positions) if (p >= off) positions.add(p - off);
    } else {
      const r = scoreText(name, term, stem);
      if (!r) return null;
      score += r.score;
      for (const p of r.positions) positions.add(p);
    }
  }
  return { score, positions: [...positions].sort((a, b) => a - b) };
}

/** Search entries → [{...entry, score, positions}] best first, at most `limit`. */
function search(entries, query, limit = 100) {
  const out = [];
  for (const e of entries) {
    const m = matchEntry(e, query);
    if (m) out.push({ ...e, score: m.score, positions: m.positions });
  }
  out.sort((a, b) => (b.score - a.score)
    || (a.name.length - b.name.length)
    || collator.compare(a.name, b.name)
    || collator.compare(a.path, b.path));
  return out.slice(0, limit);
}

module.exports = { scoreText, matchEntry, search, splitTerms };
