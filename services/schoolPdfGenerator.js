// services/schoolPdfGenerator.js
// ─── Generates a school profile PDF using existing generatePDF infrastructure ─

import { SCHOOL_FACILITIES, feeRangeLabel } from "./schoolPlans.js";

export async function generateSchoolProfilePDF(school) {
  const { generatePDF } = await import("../routes/twilio_biz.js");

  const typeLabels   = { primary: "Primary", secondary: "Secondary", combined: "Combined" };
  const genderLabels = { mixed: "Mixed (Co-ed)", boys: "Boys Only", girls: "Girls Only" };
  const boardLabels  = { day: "Day School", boarding: "Boarding", both: "Day & Boarding" };

  const facilitiesText = (school.facilities || [])
    .map(id => SCHOOL_FACILITIES.find(f => f.id === id)?.label || id)
    .join(", ") || "Not specified";

  const curriculumText = (school.curriculum || []).map(c => c.toUpperCase()).join(" + ") || "Not specified";

  const feeLine = school.fees?.term1
    ? `Term 1: $${school.fees.term1} | Term 2: $${school.fees.term2} | Term 3: $${school.fees.term3} USD`
    : feeRangeLabel(school.feeRange);

  const schoolRef  = `SCH-${String(school._id).slice(-8).toUpperCase()}`;
  const now        = new Date();

  // Re-use the existing generatePDF "invoice" type as a structured doc
  const { filename } = await generatePDF({
    type:      "invoice",
    number:    schoolRef,
    date:      now,
    billingTo: `${school.schoolName}\n${school.suburb ? school.suburb + ", " : ""}${school.city}${school.address ? "\n" + school.address : ""}${school.principalName ? "\nPrincipal: " + school.principalName : ""}${school.email ? "\n" + school.email : ""}`,
    items: [
      { item: "Type",                qty: 1, unit: 0, total: 0, description: typeLabels[school.type] || school.type },
      { item: "Curriculum",          qty: 1, unit: 0, total: 0, description: curriculumText },
      { item: "Gender",              qty: 1, unit: 0, total: 0, description: genderLabels[school.gender] || school.gender },
      { item: "Boarding",            qty: 1, unit: 0, total: 0, description: boardLabels[school.boarding] || school.boarding },
      { item: "Grades Offered",      qty: 1, unit: 0, total: 0, description: `${school.grades?.from || "ECD A"} – ${school.grades?.to || "Form 6"}` },
      { item: "Fees Per Term",       qty: 1, unit: 0, total: 0, description: feeLine },
      { item: "Facilities",          qty: 1, unit: 0, total: 0, description: facilitiesText },
      { item: "Admissions",          qty: 1, unit: 0, total: 0, description: school.admissionsOpen ? "Currently OPEN" : "Currently CLOSED" },
      { item: "Rating",              qty: 1, unit: 0, total: 0, description: school.reviewCount > 0 ? `${school.rating.toFixed(1)}/5 (${school.reviewCount} reviews)` : "No reviews yet" }
    ],
    bizMeta: {
      name:    school.schoolName,
      logoUrl: school.logoUrl || "",
      address: `${school.suburb ? school.suburb + ", " : ""}${school.city}`,
      _id:     String(school._id),
      status:  school.active ? "active" : "pending"
    }
  });

  const site = (process.env.SITE_URL || "").replace(/\/$/, "");
  const url  = `${site}/docs/generated/orders/${filename}`;

  return { filename, url };
}