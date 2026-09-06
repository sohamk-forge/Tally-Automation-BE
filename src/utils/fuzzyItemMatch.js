import { distance } from "fastest-levenshtein";

// Strips everything but letters/digits (not just whitespace) so that
// punctuation/spacing-only drift — "Cottton Waste - 01 Qty" vs
// "Cotton Waste 01Qty" — collapses toward the same key before scoring.
export function aggressiveNormalize(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// Pulls every number out of a name, in order — "BOLT FLANGE (10X1.25X20) 8"
// -> ["10", "1.25", "20", "8"]. Leading zeros are normalized away (parsed
// as Number then restringified) so "01" and "1" count as the same number;
// only a genuinely different quantity/measurement should ever block a match.
function extractNumbers(name) {
  return (String(name || "").match(/\d+(\.\d+)?/g) || []).map((n) => String(Number(n)));
}

// Two names that are otherwise near-identical text can still refer to
// clearly different real items when they carry different numbers — a pack
// size, a bolt length, a distance in km. "Tie Clip - 06 Qty" and
// "Tie Clip - 01 Qty" score ~93% similar on text alone, but they are not
// the same stock item. Only vetoes when BOTH names actually contain a
// number and those numbers differ — a name with no number on one side
// (e.g. "GASKET" vs "GASKET (10)") is left to the normal text score,
// since there's nothing conflicting to compare.
function hasConflictingNumbers(targetName, candidateName) {
  const targetNums = extractNumbers(targetName);
  const candidateNums = extractNumbers(candidateName);
  if (!targetNums.length || !candidateNums.length) return false;
  return JSON.stringify(targetNums) !== JSON.stringify(candidateNums);
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
    if (hasConflictingNumbers(targetName, candidate)) continue;

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
    if (hasConflictingNumbers(targetName, trimmedCandidate)) continue;

    const maxLen = Math.max(target.length, normalizedCandidate.length);
    if (maxLen === 0) continue;

    const score = 1 - distance(target, normalizedCandidate) / maxLen;
    if (score >= minScore) {
      scored.push({ name: trimmedCandidate, score: Math.round(score * 100) / 100 });
    }
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
