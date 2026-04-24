/**
 * Ranking utilities for Soulseek search results.
 *
 * Score breakdown (0–1, higher = better match):
 *   0.50 — token coverage: fraction of query tokens found in filename
 *   0.30 — normalized Levenshtein similarity against best substring
 *   0.10 — slot free bonus
 *   0.10 — bitrate bonus (normalized, capped at 320kbps)
 */

// ─── Levenshtein ─────────────────────────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  // Use two-row DP to save memory
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (curr[j - 1] ?? 0) + 1, // insert
        (prev[j] ?? 0) + 1, // delete
        (prev[j - 1] ?? 0) + cost, // replace
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] ?? 0;
}

/** Normalized similarity: 1 = identical, 0 = completely different */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// ─── Text normalization ───────────────────────────────────────────────────────

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/, "") // strip file extension
    .replace(/[_\-().[\]{}]/g, " ") // punctuation → space
    .replace(/[^a-z0-9 ]/g, "") // strip remaining non-alphanum
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s: string): string[] {
  return normalize(s).split(" ").filter(Boolean);
}

// ─── Best-substring similarity ───────────────────────────────────────────────
// Slide a window of queryLen tokens over the filename tokens and find the
// window whose joined string is most similar to the query string.
// This handles "Feel Good Inc" matching "Gorillaz Feel Good Inc" naturally.

function bestSubstringSimilarity(
  queryNorm: string,
  filenameNorm: string,
): number {
  const qTokens = queryNorm.split(" ").filter(Boolean);
  const fTokens = filenameNorm.split(" ").filter(Boolean);

  if (qTokens.length === 0 || fTokens.length === 0) return 0;

  let best = 0;
  const windowSize = qTokens.length;

  // Try all windows of size ±1 around queryLen for flexibility
  for (let size = Math.max(1, windowSize - 1); size <= windowSize + 1; size++) {
    for (let start = 0; start <= fTokens.length - size; start++) {
      const window = fTokens.slice(start, start + size).join(" ");
      const sim = similarity(queryNorm, window);
      if (sim > best) best = sim;
    }
  }

  // Also try full filename similarity as a fallback
  const fullSim = similarity(queryNorm, filenameNorm);
  return Math.max(best, fullSim);
}

// ─── Token coverage ──────────────────────────────────────────────────────────
// Fraction of query tokens that appear verbatim (or with ≥0.8 similarity)
// in any filename token. Handles typos per-token.

function tokenCoverage(
  queryTokens: string[],
  filenameTokens: string[],
): number {
  if (queryTokens.length === 0) return 1;

  let matched = 0;
  for (const qt of queryTokens) {
    // Exact match first (fast path)
    if (filenameTokens.includes(qt)) {
      matched++;
      continue;
    }
    // Fuzzy: any filename token with similarity ≥ 0.75
    const best = filenameTokens.reduce(
      (max, ft) => Math.max(max, similarity(qt, ft)),
      0,
    );
    if (best >= 0.75) matched++;
  }

  return matched / queryTokens.length;
}

// ─── Main scoring function ───────────────────────────────────────────────────

export interface ScoredFile {
  score: number;
  /** 0–1 coverage of query tokens in filename */
  coverage: number;
  /** 0–1 best substring similarity */
  strSim: number;
}

export function scoreFile(
  query: string,
  filename: string,
  slotsFree: boolean,
  bitrate: number | undefined,
): ScoredFile {
  const queryNorm = normalize(query);
  const filenameNorm = normalize(filename.split(/[\\/]/).pop() ?? filename);

  const qTokens = tokenize(query);
  const fTokens = tokenize(filename.split(/[\\/]/).pop() ?? filename);

  const coverage = tokenCoverage(qTokens, fTokens);
  const strSim = bestSubstringSimilarity(queryNorm, filenameNorm);

  const slotBonus = slotsFree ? 0.1 : 0;
  const bitrateBonus = Math.min((bitrate ?? 0) / 320, 1) * 0.1;

  const score = coverage * 0.5 + strSim * 0.3 + slotBonus + bitrateBonus;

  return { score, coverage, strSim };
}
