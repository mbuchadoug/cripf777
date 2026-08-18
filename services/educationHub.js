// services/educationHub.js
// ─── ZimQuote Education Hub - the renamed, inclusive "Find a School" entry ────
//
// The main-menu row previously labelled "🏫 Find a School" now opens this hub.
// One short fork lets a parent choose exactly what they're looking for, so the
// three very different searches never get tangled:
//   • Academic school (ECD → Form 6)      → schoolSearch.startSchoolSearch
//   • Private tutor / lessons             → tutorSearch.startTutorSearch
//   • College / course / academy          → institutionSearch.startInstitutionSearch
//
// Works for biz users AND non-biz parents (no session state is set here - the
// downstream start* functions own their own state).
// ─────────────────────────────────────────────────────────────────────────────

import { sendList } from "./metaSender.js";

export async function startEducationHub(from, biz, saveBiz) {
  return sendList(
    from,
`🎓 *Schools, Tutors & Colleges*

Find the right education on ZimQuote. What are you looking for?`,
    [
      { id: "edu_find_school",  title: "🏫 A School (ECD-Form 6)", description: "Primary & secondary schools" },
      { id: "edu_find_tutor",   title: "👩‍🏫 A Private Tutor",       description: "Extra lessons by subject, level & budget" },
      { id: "edu_find_college", title: "🎓 A College / Course",      description: "Culinary, driving, IT, music, skills & more" }
    ]
  );
}

// Returns true if it handled the action.
export async function handleEducationHubAction({ action: a, from, biz, saveBiz }) {
  if (a === "edu_find_school") {
    const { startSchoolSearch } = await import("./schoolSearch.js");
    await startSchoolSearch(from, biz, saveBiz);
    return true;
  }
  if (a === "edu_find_tutor") {
    const { startTutorSearch } = await import("./tutorSearch.js");
    await startTutorSearch(from, biz, saveBiz);
    return true;
  }
  if (a === "edu_find_college") {
    const { startInstitutionSearch } = await import("./institutionSearch.js");
    await startInstitutionSearch(from, biz, saveBiz);
    return true;
  }
  return false;
}