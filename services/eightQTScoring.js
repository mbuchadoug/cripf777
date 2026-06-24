// services/eightQTScoring.js
// Calculates quotient scores, assigns band labels, and matches archetypes

import EightQTArchetype from "../models/eightQTArchetype.js";
import EightQTCertTemplate from "../models/eightQTCertTemplate.js";

/**
 * Given the attempt's answers and active quotient configs,
 * compute raw points per quotient then normalise to 0-100.
 *
 * @param {Array} answers      - attempt.answers array
 * @param {Array} configs      - active EightQTConfig docs
 * @returns {Array} quotientScores
 */
export function computeQuotientScores(answers, configs) {
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
    const maxPossible = cfg.questionCount * 3; // 3 pts = perfect answer
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
 * Evaluate all active archetypes in priority order.
 * Returns the first matching archetype document, or the default.
 */
export async function matchArchetype(quotientScores) {
  const archetypes = await EightQTArchetype.find({ active: true })
    .sort({ priority: -1 })
    .lean();

  const scoreMap = {};
  for (const s of quotientScores) scoreMap[s.code] = s.score;

  for (const arch of archetypes) {
    if (arch.isDefault) continue; // check default last

    const allMatch = arch.conditions.every(cond => {
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

    if (allMatch) return arch;
  }

  // Fallback: default archetype
  return archetypes.find(a => a.isDefault) || null;
}

/**
 * Determine dominant quotient (highest score) and development edge (lowest).
 */
export function getDominantAndEdge(quotientScores) {
  if (!quotientScores.length) return { dominant: null, edge: null };
  const sorted = [...quotientScores].sort((a, b) => b.score - a.score);
  return {
    dominant: sorted[0].code,
    edge: sorted[sorted.length - 1].code
  };
}

/**
 * Get active certificate template for band labels and pricing.
 */
export async function getActiveTemplate() {
  return EightQTCertTemplate.findOne({ active: true }).lean();
}
