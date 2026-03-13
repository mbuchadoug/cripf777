// utils/autoFetchAndScore.js
import { TavilyClient } from "tavily";
import fs from "fs";
import path from "path";

const tavily = new TavilyClient({
  apiKey: process.env.TAVILY_API_KEY || "your_tavily_key_here",
});

// ----------------------
// 🔹 Load CRIPFCnt Logic
// ----------------------
const logicPath = path.join(process.cwd(), "data", "cripfcnt.txt");
let cripfLogic = "";
try {
  cripfLogic = fs.readFileSync(logicPath, "utf8");
  console.log("✅ Loaded CRIPFCnt logic from data/cripfcnt.txt");
} catch (err) {
  console.warn("⚠️ Could not read cripfcnt.txt:", err.message);
}

// ----------------------
// 🔹 Parse exemplars from the logic file (e.g., “Marketing”)
// ----------------------
function parseExemplars(text) {
  const exemplars = {};
  const sectionRe = /CRIPFCnt SCOI Audit\s*-\s*[“"]?([^"\n(]+)[”"]?.*?\n([\s\S]*?)(?=\n⸻|\n-{3,}|\n?#|\n?CRIPFCnt SCOI Audit|$)/g;
  let m;
  while ((m = sectionRe.exec(text)) !== null) {
    const name = m[1].trim();
    const body = m[2];

    const vis = /Visibility[^:]*[:--]\s*(\d+(?:\.\d+)?)\s*\/\s*10/i.exec(body)?.[1];
    const con = /Contribution[^:]*[:--]\s*(\d+(?:\.\d+)?)\s*\/\s*10/i.exec(body)?.[1];
    const erf = /ERF[^:\d]*:\s*(\d+(?:\.\d+)?)/i.exec(body)?.[1];

    if (vis && con && erf) {
      const visibility = +vis, contribution = +con, ERF = +erf;
      const rawSCOI = +(contribution / visibility).toFixed(3);
      const adjustedSCOI = +(rawSCOI * ERF).toFixed(3);
      const interpretation = /Interpretation[^:]*:\s*([\s\S]*?)(?=\n⸻|\n\d️⃣|$)/i.exec(body)?.[1]?.trim() || "";
      const commentary = /Final CRIPFCnt Commentary[^:]*:\s*([\s\S]*?)(?=\n⸻|\n\d️⃣|$)/i.exec(body)?.[1]?.trim() || "";
      exemplars[name.toLowerCase()] = {
        entity: name,
        visibility, contribution, ERF,
        rawSCOI, adjustedSCOI,
        interpretation, commentary,
        placementLevel:
          adjustedSCOI > 1.0 ? "Silent Over-Contributor" :
          adjustedSCOI >= 0.95 ? "Balanced Axis" : "Grid Performer",
        source: "CRIPFCnt exemplar"
      };
    }
  }
  return exemplars;
}
const EXEMPLARS = parseExemplars(cripfLogic);

// ----------------------
// 🔹 Setup Cache
// ----------------------
const cachePath = path.join(process.cwd(), "data", "cache.json");
if (!fs.existsSync(cachePath)) fs.writeFileSync(cachePath, "{}");
let cache = {};
try {
  cache = JSON.parse(fs.readFileSync(cachePath, "utf8") || "{}");
} catch {
  cache = {};
}

// ----------------------
// 🔹 JSON Schema for model
// ----------------------
const jsonSchema = {
  name: "CRIPFCntSCOI",
  schema: {
    type: "object",
    required: [
      "visibility","visibilityRationale",
      "contribution","contributionRationale",
      "erf","erfRationale",
      "scoiInterpretation","commentary"
    ],
    properties: {
      visibility: { type: "number", minimum: 0, maximum: 10 },
      contribution: { type: "number", minimum: 0, maximum: 10 },
      erf: { type: "number", minimum: 0.5, maximum: 1.5 },
      visibilityRationale: { type: "string" },
      contributionRationale: { type: "string" },
      erfRationale: { type: "string" },
      scoiInterpretation: { type: "string" },
      commentary: { type: "string" }
    },
    additionalProperties: false
  },
  strict: true
};

/**
 * Generate SCOI-style audit using CRIPFCnt methodology
 * Deterministic + Framework-anchored version
 */
export default async function autoFetchAndScore(entity, openai) {
  console.log(`🔍 Running CRIPFCnt SCOI audit for: ${entity}`);
  const key = entity.trim().toLowerCase();

  // ✅ Return from cache if already analyzed
  if (cache[entity]) {
    console.log(`⚡ Returning cached SCOI for ${entity}`);
    return cache[entity];
  }

  // ✅ Exact exemplar override (guaranteed canonical values)
  if (EXEMPLARS[key]) {
    cache[entity] = EXEMPLARS[key];
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
    return EXEMPLARS[key];
  }

  // ----------------------
  // 🔹 Fetch context (optional, helps for companies/books)
  // ----------------------
  let tavilyResults;
  try {
    tavilyResults = await tavily.search({
      query: entity,
      search_depth: "advanced",
      max_results: 5,
    });
  } catch (error) {
    console.error("❌ Tavily fetch failed:", error.message);
  }

  const webText =
    tavilyResults?.results
      ?.map((r) => `${r.title}\n${r.snippet}`)
      .join("\n\n") || "No search results available.";

  // ----------------------
  // 🔹 AI Prompt (Anchored, deterministic, JSON-only)
  // ----------------------
  const systemPrompt = `
You are the official CRIPFCnt SCOI computation model (Donald Mataranyika Axis Framework).
Use the CRIPFCnt logic below as the ONLY authority for scores, ratios, tone, and placement.

--- CRIPFCnt LOGIC (verbatim) ---
${cripfLogic}
--- END LOGIC ---

Calibration anchors (must inform outputs):
- Marketing: Visibility=9, Contribution=5, ERF=1.1 → Adjusted≈0.605.
- Law: Visibility=7, Contribution=6, ERF=0.90 → Adjusted≈0.77.
- Corporate Governance: Visibility=9, Contribution=6, ERF=1.2 → Adjusted≈0.80.

Guardrails:
- High visibility ≠ high contribution by default.
- Prefer conservative contribution for performative/visibility-heavy domains.
- Output JSON only per schema.
`;

  const userPrompt = `
Perform a CRIPFCnt SCOI Audit for: "${entity}"

Context (neutral; optional to cite):
${webText}

Return ONLY JSON with fields:
visibility, visibilityRationale,
contribution, contributionRationale,
erf, erfRationale,
scoiInterpretation, commentary.
`;

  // ----------------------
  // 🔹 Generate AI Response (deterministic + schema-locked)
  // ----------------------
  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    temperature: 0,
    top_p: 0.05,
    seed: 42,
    response_format: { type: "json_schema", json_schema: jsonSchema },
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
  });

  const raw = response.output?.[0]?.content?.[0]?.text || "{}";

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = {
      visibility: 8.5,
      contribution: 7.5,
      erf: 1.1,
      visibilityRationale: "Defaulted due to parse failure.",
      contributionRationale: "Defaulted due to parse failure.",
      erfRationale: "Defaulted due to parse failure.",
      scoiInterpretation: "Defaulted due to parse failure.",
      commentary: "Defaulted due to parse failure."
    };
  }

  // ----------------------
  // 🔹 Authoritative math + placement
  // ----------------------
  const visibility = Number(data.visibility);
  const contribution = Number(data.contribution);
  const ERF = Number(data.erf);

  const rawSCOI = +(contribution / visibility).toFixed(3);
  const adjustedSCOI = +(rawSCOI * ERF).toFixed(3);

  const placementLevel =
    adjustedSCOI > 1.0
      ? "Silent Over-Contributor"
      : adjustedSCOI >= 0.95
      ? "Balanced Axis"
      : "Grid Performer";

  // ----------------------
  // 🔹 Build final object
  // ----------------------
  const result = {
    entity,
    visibility,
    contribution,
    ERF,
    rawSCOI,
    adjustedSCOI,
    placementLevel,
    interpretation: data.scoiInterpretation?.trim() || "",
    commentary: data.commentary?.trim() || "",
    visibilityRationale: data.visibilityRationale?.trim() || "",
    contributionRationale: data.contributionRationale?.trim() || "",
    ERFRationale: data.erfRationale?.trim() || "",
    urls: tavilyResults?.results?.map((r) => r.url) || [],
    source: "tavily + CRIPFCnt logic (anchored)"
  };

  // ----------------------
  // 🔹 Cache for future use
  // ----------------------
  cache[entity] = result;
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));

  return result;
}
