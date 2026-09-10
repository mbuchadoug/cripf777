// services/courseTaxonomy.js
// Single source of truth for the 3-tier hierarchy:
//   MODULE / PILLAR  (consciousness, responsibility, …)  ← capstone certificate
//     └ AREA / CATEGORY (structural-responsibility, …)    ← area course
//         └ QUIZ (a comprehension passage)                ← completion slip
//
// Mirrors CLASSIFY_PILLAR_CATEGORIES in org_management.js so the course engine
// and the classifier agree on which areas roll up to which module.

export const PILLAR_CATEGORIES = {
  consciousness:  ["consciousness-studies","philosophical-inquiry","systems-thinking","critical-thinking","psychology","education","communication"],
  responsibility: ["governance","institutional-accountability","public-sector-ethics","rule-of-law","financial-accountability","structural-responsibility","social-contract","administration"],
  interpretation: ["interpretive-frameworks","language-recalibration","media-literacy","strategic-communication","narrative-framing","research-methodology"],
  purpose:        ["strategic-leadership","change-management","policy-implementation","community-leadership","crisis-management","motivation","organisational-development","human-resources"],
  frequencies:    ["frequencies-and-influence","social-development","institutional-reform","performance-metrics"],
  civilization:   ["civilisation-theory","social-justice","human-rights","economic-justice","environmental-governance","electoral-systems","public-policy","law"],
  negotiation:    ["conflict-resolution","negotiation-dynamics","diplomacy","finance","strategy"],
  technology:     ["technology-governance","digital-ethics","ai-governance","risk-and-compliance","innovation"]
};

export const CATEGORY_TO_PILLAR = {};
for (const [pillar, cats] of Object.entries(PILLAR_CATEGORIES)) {
  for (const c of cats) CATEGORY_TO_PILLAR[c] = pillar;
}

export const ALL_PILLARS = Object.keys(PILLAR_CATEGORIES);

export function slugToLabel(s) {
  return String(s || "")
    .split("-")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function pillarOf(category) {
  return CATEGORY_TO_PILLAR[String(category || "").toLowerCase()] || null;
}

export function categoriesOf(pillar) {
  return PILLAR_CATEGORIES[String(pillar || "").toLowerCase()] || [];
}