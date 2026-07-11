// services/eightQTScoring.js
// Calculates quotient scores, assigns band labels, and matches archetypes

import EightQTArchetype from "../models/eightQTArchetype.js";
import EightQTCertTemplate from "../models/eightQTCertTemplate.js";

/**
 * Given the attempt's answers and active quotient configs,
 * compute raw points per quotient then normalise to 0-100.
 *
 * @param {Array}  answers     - attempt.answers array
 * @param {Array}  configs     - active EightQTConfig docs
 * @param {Object} quotientMax - optional { CsQ: 24, RQ: 6, ... } = max achievable
 *                               per quotient for THIS attempt's served questions.
 *                               When present it is the correct denominator for any
 *                               quiz size/mode; when absent we fall back to the
 *                               legacy questionCount*3 assumption.
 * @returns {Array} quotientScores
 */
export function computeQuotientScores(answers, configs, quotientMax = null) {
  // Accumulate raw points and max possible per quotient
  const rawMap = {};   // { "RQ": { earned: N, max: M } }

  for (const cfg of configs) {
    rawMap[cfg.code] = { earned: 0, max: 0, name: cfg.name };
  }

  for (const answer of answers) {
    const qScores = answer.scores || {};
    for (const [code, pts] of Object.entries(qScores)) {
      if (!rawMap[code]) rawMap[code] = { earned: 0, max: 0, name: code };
      rawMap[code].earned += Number(pts) || 0;
    }
  }

  // Max possible: for each question, find the best option score per quotient
  // This is pre-calculated when questions are loaded (passed in via maxPossible map)
  // Here we normalise assuming max = questionCount * 3 (3 = top score per question)
  // A more precise approach passes maxPossible per quotient from the question set
  const scores = [];

  for (const cfg of configs) {
    const code = cfg.code;
    const data = rawMap[code] || { earned: 0, max: 0, name: cfg.name };
    const storedMax = quotientMax && Number.isFinite(Number(quotientMax[code]))
      ? Number(quotientMax[code])
      : null;
    const maxPossible = storedMax != null
      ? storedMax
      : cfg.questionCount * 3; // legacy: 3 pts = perfect answer
    const pct = maxPossible > 0
      ? Math.round((data.earned / maxPossible) * 100)
      : 0;
    const clamped = Math.min(100, Math.max(0, pct));

    scores.push({
      code,
      name: cfg.name,
      raw: data.earned,
      max: maxPossible,
      score: clamped,
      band: getBand(clamped)
    });
  }

  return scores;
}

/**
 * Return band label for a given 0-100 score.
 * Uses admin-configured bands if provided, otherwise defaults.
 */
export function getBand(score, bands) {
  const b = bands || {
    0: "Emerging",
    21: "Developing",
    41: "Functional",
    61: "Structural",
    81: "Recalibrative"
  };
  const thresholds = Object.keys(b)
    .map(Number)
    .sort((a, z) => z - a); // descending

  for (const t of thresholds) {
    if (score >= t) return b[t];
  }
  return "Emerging";
}

/**
 * Pick the dominant (or, inverted, weakest) quotient with real tie-breaking.
 * The old logic sorted by score only; with small quizzes (e.g. 8 questions,
 * 1 per quotient) score ties are common and the stable sort meant ties ALWAYS
 * resolved to the first config (CsQ) - so everyone got the same archetype.
 * New order: highest % score -> highest raw points -> random among still-tied.
 * The random pick happens ONCE at submit and is persisted on the attempt.
 */
export function pickByScore(quotientScores, highest = true) {
  if (!quotientScores || !quotientScores.length) return null;
  const dir = highest ? 1 : -1;
  const bestScore = quotientScores.reduce((b, s) =>
    (s.score * dir > b * dir ? s.score : b), quotientScores[0].score);
  let tied = quotientScores.filter(s => s.score === bestScore);
  if (tied.length > 1) {
    const bestRaw = tied.reduce((b, s) =>
      ((s.raw || 0) * dir > b * dir ? (s.raw || 0) : b), tied[0].raw || 0);
    tied = tied.filter(s => (s.raw || 0) === bestRaw);
  }
  if (tied.length > 1) {
    return tied[Math.floor(Math.random() * tied.length)].code;
  }
  return tied[0].code;
}

/**
 * Evaluate all active archetypes in priority order.
 * Pass 1: dominant-quotient archetypes - fire when that quotient is the
 *         participant's highest (tie-broken). Robust for any quiz size.
 * Pass 2: legacy threshold-only archetypes (original behaviour).
 * Fallback: the default archetype.
 *
 * dominantOverride: pass the dominant already computed at submit so the
 * archetype ALWAYS agrees with the attempt's stored dominantQuotient.
 */
export async function matchArchetype(quotientScores, dominantOverride = null) {
  const archetypes = await EightQTArchetype.find({ active: true })
    .sort({ priority: -1 })
    .lean();

  const scoreMap = {};
  for (const s of quotientScores) scoreMap[s.code] = s.score;

  const dominant = dominantOverride || pickByScore(quotientScores, true);

  const passesConditions = (arch) => (arch.conditions || []).every(cond => {
    const val = scoreMap[cond.quotient] ?? 0;
    switch (cond.operator) {
      case "gte": return val >= cond.value;
      case "lte": return val <= cond.value;
      case "gt":  return val >  cond.value;
      case "lt":  return val <  cond.value;
      case "between": return val >= cond.value && val <= (cond.value2 ?? 100);
      default: return false;
    }
  });

  // Pass 1: dominant-quotient archetypes
  for (const arch of archetypes) {
    if (arch.isDefault) continue;
    if (!arch.dominantQuotient) continue;
    if (arch.dominantQuotient !== dominant) continue;
    if (passesConditions(arch)) return arch;
  }

  // Pass 2: legacy threshold-only archetypes
  for (const arch of archetypes) {
    if (arch.isDefault) continue;
    if (arch.dominantQuotient) continue;
    if ((arch.conditions || []).length && passesConditions(arch)) return arch;
  }

  // Fallback: default archetype
  return archetypes.find(a => a.isDefault) || null;
}

/**
 * Determine dominant quotient (highest score) and development edge (lowest),
 * with tie-breaking, excluding the dominant from the edge pick so a flat
 * profile still yields two DIFFERENT quotients where possible.
 */
export function getDominantAndEdge(quotientScores) {
  if (!quotientScores.length) return { dominant: null, edge: null };
  const dominant = pickByScore(quotientScores, true);
  const rest = quotientScores.filter(s => s.code !== dominant);
  const edge = pickByScore(rest.length ? rest : quotientScores, false);
  return { dominant, edge };
}

/**
 * Get active certificate template for band labels and pricing.
 */
export async function getActiveTemplate() {
  return EightQTCertTemplate.findOne({ active: true }).lean();
}