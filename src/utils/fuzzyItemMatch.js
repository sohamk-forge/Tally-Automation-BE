import { distance } from "fastest-levenshtein";

// Strips everything but letters/digits (not just whitespace) so that
// punctuation/spacing-only drift — "Cottton Waste - 01 Qty" vs
// "Cotton Waste 01Qty" — collapses toward the same key before scoring.
export function aggressiveNormalize(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Finds the closest real item name to targetName among candidateNames,
 * using Levenshtein similarity on the aggressively-normalized form.
 * Only ever used as an automatic fallback after an exact-match lookup has
 * already failed — never as the primary check.
 */
export function findBestItemMatch(candidateNames, targetName, threshold = 0.9) {
  const target = aggressiveNormalize(targetName);
  if (!target) return null;

  let best = null;
  let bestScore = 0;

  for (const candidate of candidateNames) {
    const normalizedCandidate = aggressiveNormalize(candidate);
    if (!normalizedCandidate) continue;

    const maxLen = Math.max(target.length, normalizedCandidate.length);
    if (maxLen === 0) continue;

    const score = 1 - distance(target, normalizedCandidate) / maxLen;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return bestScore >= threshold ? best : null;
}

/**
 * Like findBestItemMatch, but returns several ranked candidates instead of
 * auto-picking one — for a user-facing "did you mean...?" suggestion list
 * rather than a silent auto-correct. Threshold is deliberately much lower
 * than findBestItemMatch's 0.9 (auto-apply needs near-certainty; a
 * suggestion the user has to click to accept can afford to be more
 * permissive, since a bad suggestion just gets ignored).
 */
export function findTopItemMatches(candidateNames, targetName, { limit = 3, minScore = 0.45 } = {}) {
  const target = aggressiveNormalize(targetName);
  if (!target) return [];

  const scored = [];
  const seen = new Set();

  for (const candidate of candidateNames) {
    const trimmedCandidate = String(candidate || "").trim();
    if (!trimmedCandidate) continue;

    const key = trimmedCandidate.toLowerCase();
    if (seen.has(key)) continue; // dedupe candidate names, keep first score
    seen.add(key);

    const normalizedCandidate = aggressiveNormalize(trimmedCandidate);
    if (!normalizedCandidate) continue;

    const maxLen = Math.max(target.length, normalizedCandidate.length);
    if (maxLen === 0) continue;

    const score = 1 - distance(target, normalizedCandidate) / maxLen;
    if (score >= minScore) {
      scored.push({ name: trimmedCandidate, score: Math.round(score * 100) / 100 });
    }
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
