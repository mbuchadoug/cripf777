// services/schoolRegistration.js
// ─── ZimQuote Schools — WhatsApp Registration State Machine ──────────────────

import SchoolProfile from "../models/schoolProfile.js";
import SchoolSubscriptionPayment from "../models/schoolSubscriptionPayment.js";
import { sendText, sendButtons, sendList } from "./metaSender.js";
import {
  SCHOOL_CITIES, SCHOOL_TYPES, SCHOOL_CURRICULA, SCHOOL_GENDERS,
  SCHOOL_BOARDING, SCHOOL_FACILITIES, SCHOOL_EXTRAMURALACTIVITIES,
  SCHOOL_PLANS, SCHOOL_GRADE_FROM, SCHOOL_GRADE_TO,
  computeSchoolFeeRange
} from "./schoolPlans.js";

// ── Helper: get or init registration data from biz session ──────────────────
function getReg(biz) {
  biz.sessionData = biz.sessionData || {};
  biz.sessionData.schoolReg = biz.sessionData.schoolReg || {};
  return biz.sessionData.schoolReg;
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY POINT — called from chatbotEngine when user taps "🏫 Register My School"
// ─────────────────────────────────────────────────────────────────────────────
export async function startSchoolRegistration(from, biz) {
  const phone = from.replace(/\D+/g, "");
  const existing = await SchoolProfile.findOne({ phone });

  if (existing?.active) {
    const { sendSchoolAccountMenu } = await import("./metaMenus.js");
    return sendSchoolAccountMenu(from, existing);
  }

  if (existing && !existing.active) {
    return sendList(from, `🏫 *${existing.schoolName}* is registered but not yet live.`, [
      { id: "school_pay_plan",  title: "💳 Activate My Listing" },
      { id: "school_account",   title: "👁 View My Profile" },
      { id: "main_menu_back",   title: "⬅ Main Menu" }
    ]);
  }

  biz.sessionState   = "school_reg_name";
  biz.sessionData    = { schoolReg: {} };
  const { saveBizSafe } = await import("./bizHelpers.js");
  await saveBizSafe(biz);

  return sendText(from,
`🏫 *Register Your School on ZimQuote*

Let's get your school listed so parents in Zimbabwe can find you.

*Step 1 of 12* — What is your school's full name?

_Type *cancel* at any time to stop._`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE MACHINE — called from chatbotEngine for every school_reg_* state
// Returns true if it handled the state, false to fall through.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSchoolRegistrationStates({ state, from, text, biz, saveBiz }) {
  const phone = from.replace(/\D+/g, "");
  const reg   = getReg(biz);

  // ── Step 1: School Name ──────────────────────────────────────────────────
  if (state === "school_reg_name") {
    const name = text.trim();
    if (!name || name.length < 2) {
      await sendText(from, "❌ Please enter a valid school name:");
      return true;
    }
    reg.schoolName     = name;
    biz.sessionState   = "school_reg_type";
    await saveBiz(biz);

    return sendList(from, `📗 *Step 2 of 12* — What type of school is *${name}*?`, [
      ...SCHOOL_TYPES.map(t => ({ id: `school_reg_type_${t.id}`, title: t.label }))
    ]);
  }

  // ── Step 2: Type — handled via action button (school_reg_type_*)
  // (see handleSchoolRegistrationActions below)

  // ── Step 3: City ─────────────────────────────────────────────────────────
  if (state === "school_reg_city_text") {
    const city = text.trim();
    if (!city || city.length < 2) {
      await sendText(from, "❌ Please enter your city:");
      return true;
    }
    reg.city           = city;
    biz.sessionState   = "school_reg_suburb";
    await saveBiz(biz);
    return sendText(from,
      `📍 *Step 4 of 12* — What suburb or area is *${reg.schoolName}* located in?\n\n_e.g. Borrowdale, Avondale, Hillside_`
    );
  }

  // ── Step 4: Suburb ───────────────────────────────────────────────────────
  if (state === "school_reg_suburb") {
    const suburb = text.trim();
    if (!suburb || suburb.length < 2) {
      await sendText(from, "❌ Please enter the suburb or area:");
      return true;
    }
    reg.suburb         = suburb;
    biz.sessionState   = "school_reg_address";
    await saveBiz(biz);
    return sendButtons(from, {
      text: `🏠 *Step 5 of 12* — What is the physical address of *${reg.schoolName}*?\n\n_e.g. 15 Churchill Ave, Borrowdale_`,
      buttons: [{ id: "school_reg_address_skip", title: "⏭ Skip Address" }]
    });
  }

  // ── Step 5: Address ──────────────────────────────────────────────────────
  if (state === "school_reg_address") {
    reg.address        = text.trim() || "";
    biz.sessionState   = "school_reg_curriculum";
    await saveBiz(biz);

    const rows = SCHOOL_CURRICULA.map(c => ({ id: `school_reg_cur_${c.id}`, title: c.label }));
    rows.push({ id: "school_reg_cur_done", title: "✅ Done selecting" });
    return sendList(from,
      `📚 *Step 6 of 12* — Which curriculum(s) does *${reg.schoolName}* offer?\n\nTap all that apply, then tap ✅ Done.`,
      rows
    );
  }

  // ── Step 6: Curriculum — handled via actions

  // ── Step 7: Gender ───────────────────────────────────────────────────────
  // (handled via action school_reg_gender_*)

  // ── Step 8: Boarding ─────────────────────────────────────────────────────
  // (handled via action school_reg_boarding_*)

  // ── Step 9: Fees ─────────────────────────────────────────────────────────
  if (state === "school_reg_fees") {
    const raw = text.trim();
    const parts = raw.split(/[,\s\/]+/).map(s => Number(s.replace(/[^\d.]/g, ""))).filter(n => !isNaN(n) && n >= 0);

    if (!parts.length) {
      await sendText(from,
        `❌ Please enter your fees.\n\nExample: *800, 800, 750*\n_(term1, term2, term3 in USD)_\n\nOr enter a single amount if all terms are equal: *800*`
      );
      return true;
    }

    reg.fees = {
      term1:    parts[0] || 0,
      term2:    parts[1] !== undefined ? parts[1] : parts[0],
      term3:    parts[2] !== undefined ? parts[2] : parts[0],
      currency: "USD"
    };
    reg.feeRange = computeSchoolFeeRange(reg.fees.term1);
    biz.sessionState = "school_reg_facilities";
    await saveBiz(biz);

    const rows = SCHOOL_FACILITIES.map(f => ({ id: `school_reg_fac_${f.id}`, title: f.label }));
    rows.push({ id: "school_reg_fac_done", title: "✅ Done selecting" });

    return sendList(from,
      `🏊 *Step 10 of 12* — Select all facilities *${reg.schoolName}* has.\n\nTap each facility, then tap ✅ Done.\n\n_Already selected: ${(reg.facilities || []).length}_`,
      rows
    );
  }

  // ── Step 10: Facilities — handled via actions

  // ── Step 11: Extramural — handled via actions

  // ── Step 12: Principal name ───────────────────────────────────────────────
  if (state === "school_reg_principal") {
    reg.principalName  = text.trim() || "";
    biz.sessionState   = "school_reg_email";
    await saveBiz(biz);
    return sendButtons(from, {
      text: `📧 *Almost done!* — What is the school's email address?\n\n_e.g. admin@stjohns.ac.zw_`,
      buttons: [{ id: "school_reg_email_skip", title: "⏭ Skip Email" }]
    });
  }

  // ── Step 13: Email ────────────────────────────────────────────────────────
  if (state === "school_reg_email") {
    reg.email          = text.trim() || "";
    biz.sessionState   = "school_reg_confirm";
    await saveBiz(biz);
    return _sendSchoolConfirmPrompt(from, reg);
  }

  // ── Step 14: EcoCash payment ──────────────────────────────────────────────
  if (state === "school_reg_enter_ecocash") {
    const ecocash = text.replace(/\D/g, "");
    if (ecocash.length < 9) {
      await sendText(from, "❌ Please enter a valid EcoCash number (e.g. 0771234567):");
      return true;
    }
    const planData = biz.sessionData?.schoolPayPlan;
    if (!planData) {
      await sendText(from, "❌ Session expired. Please start again.");
      biz.sessionState = "ready";
      await saveBiz(biz);
      return sendText(from, "Type *menu* to start over.");
    }

    return _initiateSchoolPayment(from, biz, saveBiz, phone, ecocash, planData);
  }

  if (state === "school_reg_payment_pending") {
    await sendText(from,
`⏳ *Waiting for your EcoCash payment...*

Please approve the prompt on your phone.

If already approved, your listing activates within a minute.

_Type *cancel* to start over._`
    );
    return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION HANDLERS — called from chatbotEngine for school_reg_* button taps
// Returns true if handled.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSchoolRegistrationActions({ action: a, from, biz, saveBiz }) {
  const reg = getReg(biz);

  // ── School type selected ──────────────────────────────────────────────────
  if (a.startsWith("school_reg_type_")) {
    const typeId = a.replace("school_reg_type_", "");
    reg.type           = typeId;
    biz.sessionState   = "school_reg_city";
    await saveBiz(biz);

    return sendList(from, `📍 *Step 3 of 12* — Which city is *${reg.schoolName}* in?`, [
      ...SCHOOL_CITIES.map(c => ({ id: `school_reg_city_${c.toLowerCase().replace(/\s+/g, "_")}`, title: c })),
      { id: "school_reg_city_other", title: "📍 Other City" }
    ]);
  }

  // ── City selected from list ───────────────────────────────────────────────
  if (a.startsWith("school_reg_city_")) {
    if (a === "school_reg_city_other") {
      biz.sessionState = "school_reg_city_text";
      await saveBiz(biz);
      return sendText(from, "📍 Please type your city name:");
    }
    const cityRaw = a.replace("school_reg_city_", "").replace(/_/g, " ");
    reg.city           = cityRaw.charAt(0).toUpperCase() + cityRaw.slice(1);
    biz.sessionState   = "school_reg_suburb";
    await saveBiz(biz);
    return sendText(from,
      `📍 *Step 4 of 12* — What suburb or area is *${reg.schoolName}* in?\n\n_e.g. Borrowdale, Hillside, Glen View_`
    );
  }

  // ── Address skip ─────────────────────────────────────────────────────────
  if (a === "school_reg_address_skip") {
    reg.address        = "";
    biz.sessionState   = "school_reg_curriculum";
    await saveBiz(biz);

    const rows = SCHOOL_CURRICULA.map(c => ({ id: `school_reg_cur_${c.id}`, title: c.label }));
    rows.push({ id: "school_reg_cur_done", title: "✅ Done selecting" });
    return sendList(from,
      `📚 *Step 6 of 12* — Which curriculum(s) does *${reg.schoolName}* offer?\n\nTap all that apply, then tap ✅ Done.`,
      rows
    );
  }

  // ── Curriculum multi-select ───────────────────────────────────────────────
  if (a.startsWith("school_reg_cur_") && a !== "school_reg_cur_done") {
    const curId = a.replace("school_reg_cur_", "");
    reg.curriculum     = reg.curriculum || [];
    if (!reg.curriculum.includes(curId)) {
      reg.curriculum.push(curId);
    } else {
      reg.curriculum = reg.curriculum.filter(c => c !== curId); // toggle off
    }
    await saveBiz(biz);

    const selected = reg.curriculum.map(id => SCHOOL_CURRICULA.find(c => c.id === id)?.label || id).join(", ") || "None yet";
    const rows     = SCHOOL_CURRICULA.map(c => ({
      id:    `school_reg_cur_${c.id}`,
      title: (reg.curriculum.includes(c.id) ? "✅ " : "") + c.label
    }));
    rows.push({ id: "school_reg_cur_done", title: "✅ Done selecting" });
    return sendList(from, `📚 Curriculum selected: *${selected}*\n\nTap more or tap Done:`, rows);
  }

  if (a === "school_reg_cur_done") {
    if (!reg.curriculum?.length) {
      const rows = SCHOOL_CURRICULA.map(c => ({ id: `school_reg_cur_${c.id}`, title: c.label }));
      rows.push({ id: "school_reg_cur_done", title: "✅ Done selecting" });
      await sendText(from, "⚠️ Please select at least one curriculum.");
      return sendList(from, "📚 Select curriculum(s):", rows);
    }
    biz.sessionState = "school_reg_gender";
    await saveBiz(biz);
    return sendList(from, `👫 *Step 7 of 12* — Is *${reg.schoolName}* for boys, girls or mixed?`, [
      ...SCHOOL_GENDERS.map(g => ({ id: `school_reg_gender_${g.id}`, title: g.label }))
    ]);
  }

  // ── Gender selected ───────────────────────────────────────────────────────
  if (a.startsWith("school_reg_gender_")) {
    reg.gender         = a.replace("school_reg_gender_", "");
    biz.sessionState   = "school_reg_boarding";
    await saveBiz(biz);
    return sendList(from, `🏠 *Step 8 of 12* — Is *${reg.schoolName}* a day school or boarding school?`, [
      ...SCHOOL_BOARDING.map(b => ({ id: `school_reg_boarding_${b.id}`, title: b.label }))
    ]);
  }

  // ── Boarding selected ─────────────────────────────────────────────────────
  if (a.startsWith("school_reg_boarding_")) {
    reg.boarding       = a.replace("school_reg_boarding_", "");
    biz.sessionState   = "school_reg_fees";
    await saveBiz(biz);
    return sendText(from,
`💵 *Step 9 of 12* — What are the school fees per term (in USD)?

Enter as: *term1, term2, term3*
Example: *800, 800, 750*

Or one number if all terms are equal: *800*`
    );
  }

  // ── Facilities multi-select ───────────────────────────────────────────────
  if (a.startsWith("school_reg_fac_") && a !== "school_reg_fac_done") {
    const facId        = a.replace("school_reg_fac_", "");
    reg.facilities     = reg.facilities || [];
    if (!reg.facilities.includes(facId)) {
      reg.facilities.push(facId);
    } else {
      reg.facilities = reg.facilities.filter(f => f !== facId);
    }
    await saveBiz(biz);

    const selected = reg.facilities.map(id => SCHOOL_FACILITIES.find(f => f.id === id)?.label || id).join(", ") || "None yet";
    const rows = SCHOOL_FACILITIES.map(f => ({
      id:    `school_reg_fac_${f.id}`,
      title: (reg.facilities.includes(f.id) ? "✅ " : "") + f.label
    }));
    rows.push({ id: "school_reg_fac_done", title: "✅ Done selecting" });
    return sendList(from, `🏊 Selected: *${selected}*\n\nTap more or Done:`, rows);
  }

  if (a === "school_reg_fac_done") {
    biz.sessionState   = "school_reg_extramural";
    await saveBiz(biz);

    const rows = SCHOOL_EXTRAMURALACTIVITIES.map(e => ({ id: `school_reg_ext_${e.id}`, title: e.label }));
    rows.push({ id: "school_reg_ext_done", title: "✅ Done selecting" });
    return sendList(from,
      `🏃 *Step 11 of 12* — Select extramural activities *${reg.schoolName}* offers:\n\n_Tap all that apply, then Done._`,
      rows
    );
  }

  // ── Extramural multi-select ───────────────────────────────────────────────
  if (a.startsWith("school_reg_ext_") && a !== "school_reg_ext_done") {
    const extId             = a.replace("school_reg_ext_", "");
    reg.extramuralActivities = reg.extramuralActivities || [];
    if (!reg.extramuralActivities.includes(extId)) {
      reg.extramuralActivities.push(extId);
    } else {
      reg.extramuralActivities = reg.extramuralActivities.filter(e => e !== extId);
    }
    await saveBiz(biz);

    const selected = reg.extramuralActivities.map(id => SCHOOL_EXTRAMURALACTIVITIES.find(e => e.id === id)?.label || id).join(", ") || "None yet";
    const rows = SCHOOL_EXTRAMURALACTIVITIES.map(e => ({
      id:    `school_reg_ext_${e.id}`,
      title: (reg.extramuralActivities.includes(e.id) ? "✅ " : "") + e.label
    }));
    rows.push({ id: "school_reg_ext_done", title: "✅ Done selecting" });
    return sendList(from, `🏃 Selected: *${selected}*\n\nTap more or Done:`, rows);
  }

  if (a === "school_reg_ext_done") {
    biz.sessionState = "school_reg_principal";
    await saveBiz(biz);
    return sendButtons(from, {
      text: `👤 *Step 12 of 12* — What is the name of the school principal?\n\n_e.g. Mrs J. Moyo_`,
      buttons: [{ id: "school_reg_principal_skip", title: "⏭ Skip" }]
    });
  }

  // ── Principal skip ────────────────────────────────────────────────────────
  if (a === "school_reg_principal_skip") {
    reg.principalName  = "";
    biz.sessionState   = "school_reg_email";
    await saveBiz(biz);
    return sendButtons(from, {
      text: `📧 What is the school's email address?\n\n_e.g. admin@stjohns.ac.zw_`,
      buttons: [{ id: "school_reg_email_skip", title: "⏭ Skip Email" }]
    });
  }

  // ── Email skip ────────────────────────────────────────────────────────────
  if (a === "school_reg_email_skip") {
    reg.email          = "";
    biz.sessionState   = "school_reg_confirm";
    await saveBiz(biz);
    return _sendSchoolConfirmPrompt(from, reg);
  }

  // ── Confirm: Yes ─────────────────────────────────────────────────────────
  if (a === "school_reg_confirm_yes") {
    return _saveSchoolAndOfferPlans(from, biz, saveBiz, phone, reg);
  }

  // ── Confirm: No (restart) ─────────────────────────────────────────────────
  if (a === "school_reg_confirm_no") {
    biz.sessionState = "school_reg_name";
    biz.sessionData  = { schoolReg: {} };
    await saveBiz(biz);
    return sendText(from, "🔄 Starting over.\n\nWhat is your school's full name?");
  }

  // ── Plan selected ─────────────────────────────────────────────────────────
  if (a.startsWith("school_plan_")) {
    // e.g. "school_plan_basic_monthly" or "school_plan_featured_annual"
    const parts   = a.replace("school_plan_", "").split("_");
    const tier    = parts[0];              // "basic" | "featured"
    const period  = parts.slice(1).join("_"); // "monthly" | "annual"
    const plan    = SCHOOL_PLANS[tier];
    if (!plan) return false;
    const planDetail = period === "annual" ? plan.annual : plan.monthly;

    biz.sessionData = {
      ...(biz.sessionData || {}),
      schoolPayPlan: { tier, period, price: planDetail.price, label: planDetail.label }
    };
    biz.sessionState = "school_reg_enter_ecocash";
    await saveBiz(biz);

    return sendText(from,
`💳 *${plan.name} Plan — ${planDetail.label}*

To activate your listing, pay via EcoCash.

Please enter your *EcoCash number* (the number to charge):
_e.g. 0771234567_`
    );
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function _sendSchoolConfirmPrompt(from, reg) {
  const typeLabels   = { primary: "Primary (ECD–Grade 7)", secondary: "Secondary (Form 1–6)", combined: "Combined (ECD–Form 6)" };
  const genderLabels = { mixed: "Mixed (Co-ed)", boys: "Boys Only", girls: "Girls Only" };
  const boardLabels  = { day: "Day School", boarding: "Boarding", both: "Day & Boarding" };

  const facilityCount  = (reg.facilities || []).length;
  const extraCount     = (reg.extramuralActivities || []).length;
  const curriculumText = (reg.curriculum || []).map(c => c.toUpperCase()).join(" + ") || "Not set";

  const feeLine = reg.fees
    ? `$${reg.fees.term1} / $${reg.fees.term2} / $${reg.fees.term3} per term (USD)`
    : "Not set";

  return sendButtons(from, {
    text:
`✅ *Confirm Your School Listing*

🏫 *${reg.schoolName}*
📍 ${reg.suburb || ""}, ${reg.city || ""}
${reg.address ? `🏠 ${reg.address}\n` : ""}
📗 Type: ${typeLabels[reg.type] || reg.type || "Not set"}
📚 Curriculum: ${curriculumText}
👫 ${genderLabels[reg.gender] || reg.gender || "Not set"}
🏠 ${boardLabels[reg.boarding] || reg.boarding || "Not set"}
💵 Fees: ${feeLine}
🏊 Facilities: ${facilityCount} selected
🏃 Extramural: ${extraCount} selected
${reg.principalName ? `👤 Principal: ${reg.principalName}\n` : ""}${reg.email ? `📧 ${reg.email}` : ""}

_Is this correct?_`,
    buttons: [
      { id: "school_reg_confirm_yes", title: "✅ Confirm & List" },
      { id: "school_reg_confirm_no",  title: "❌ Start Over" }
    ]
  });
}

async function _saveSchoolAndOfferPlans(from, biz, saveBiz, phone, reg) {
  // Upsert school profile
  const school = await SchoolProfile.findOneAndUpdate(
    { phone },
    {
      $set: {
        phone,
        schoolName:           reg.schoolName,
        city:                 reg.city,
        suburb:               reg.suburb || "",
        address:              reg.address || "",
        type:                 reg.type,
        curriculum:           reg.curriculum || [],
        gender:               reg.gender,
        boarding:             reg.boarding,
        fees:                 reg.fees || { term1: 0, term2: 0, term3: 0, currency: "USD" },
        feeRange:             computeSchoolFeeRange(reg.fees?.term1 || 0),
        facilities:           reg.facilities || [],
        extramuralActivities: reg.extramuralActivities || [],
        principalName:        reg.principalName || "",
        email:                reg.email || "",
        active:               false
      }
    },
    { upsert: true, new: true }
  );

  biz.sessionData = { ...(biz.sessionData || {}), schoolId: String(school._id) };
  biz.sessionState = "school_reg_choose_plan";
  await saveBiz(biz);

  await sendText(from,
`✅ *${reg.schoolName} is saved!*

Now choose a plan to go live and start receiving parent inquiries.`
  );

  return sendList(from, "💳 *Choose Your Plan*\n\nAll plans include:\n✅ Listed in parent search\n✅ Downloadable school profile PDF\n✅ Online application link\n✅ Parent inquiry alerts on WhatsApp", [
    { id: "school_plan_basic_monthly",   title: "✅ Basic — $15/month",  description: "Listed in search + profile PDF + application link" },
    { id: "school_plan_basic_annual",    title: "✅ Basic — $150/year",  description: "Save $30 vs monthly" },
    { id: "school_plan_featured_monthly",title: "🔥 Featured — $35/month", description: "Top of results + verified badge + analytics" },
    { id: "school_plan_featured_annual", title: "🔥 Featured — $350/year", description: "Save $70 vs monthly" }
  ]);
}

async function _initiateSchoolPayment(from, biz, saveBiz, phone, ecocash, planData) {
  const paynow = (await import("./paynow.js")).default;
  const school  = await SchoolProfile.findOne({ phone });

  if (!school) {
    await sendText(from, "❌ School profile not found. Please start registration again.");
    biz.sessionState = "ready";
    await saveBiz(biz);
    return;
  }

  const reference = `SCH-${phone}-${Date.now()}`;
  const now       = new Date();
  const isAnnual  = planData.period === "annual";
  const expiresAt = new Date(now.getFullYear(), now.getMonth() + (isAnnual ? 12 : 1), now.getDate());

  await SchoolSubscriptionPayment.create({
    phone,
    schoolId:  school._id,
    tier:      planData.tier,
    plan:      planData.period,
    amount:    planData.price,
    currency:  "USD",
    reference,
    status:    "pending"
  });

  biz.sessionState = "school_reg_payment_pending";
  await saveBiz(biz);

  try {
    const result = await paynow.sendMobile(
      paynow.createPayment(reference, `school@zimquote.co.zw`),
      ecocash,
      "ecocash"
    );

    await sendText(from,
`💳 *EcoCash payment request sent!*

Amount: *$${planData.price}*
Reference: ${reference}

Please check your phone and enter your PIN to approve.

Your listing will activate automatically once payment is confirmed. ✅`
    );

    // Poll for payment confirmation
    const Business = (await import("../models/business.js")).default;
    const MAX_ATTEMPTS = 18;
    let attempts = 0;

    const pollInterval = setInterval(async () => {
      try {
        attempts++;
        const status = await paynow.pollTransaction(result.pollUrl);

        if (status.paid) {
          clearInterval(pollInterval);

          school.active             = true;
          school.tier               = planData.tier;
          school.subscriptionPlan   = planData.period;
          school.subscriptionEndsAt = expiresAt;
          await school.save();

          await SchoolSubscriptionPayment.findOneAndUpdate(
            { reference },
            { status: "paid", paidAt: now, endsAt: expiresAt }
          );

          const freshBiz = await Business.findById(biz._id);
          if (freshBiz) {
            freshBiz.sessionState = "ready";
            freshBiz.sessionData  = {};
            await freshBiz.save();
          }

          // Generate school profile PDF
          try {
            const { generateSchoolProfilePDF } = await import("./schoolPdfGenerator.js");
            const pdfResult = await generateSchoolProfilePDF(school);
            if (pdfResult?.url) {
              school.profilePdfUrl = pdfResult.url;
              await school.save();
              const { sendDocument } = await import("./metaSender.js");
              await sendDocument(from, { link: pdfResult.url, filename: pdfResult.filename });
            }
          } catch (pdfErr) {
            console.error("[School Payment] PDF generation failed:", pdfErr.message);
          }

          await sendText(from,
`🎉 *Payment Confirmed! Your school is now LIVE!*

🏫 *${school.schoolName}*
Plan: *${SCHOOL_PLANS[planData.tier]?.name}*
Active until: *${expiresAt.toDateString()}*

Parents can now find your school when they search. 🎓

_We've sent you a PDF of your school profile above._`
          );

          const { sendSchoolAccountMenu } = await import("./metaMenus.js");
          return sendSchoolAccountMenu(from, school);
        }

        if (attempts >= MAX_ATTEMPTS) {
          clearInterval(pollInterval);
          const fb = await Business.findById(biz._id);
          if (fb?.sessionState === "school_reg_payment_pending") {
            fb.sessionState = "ready";
            fb.sessionData  = {};
            await fb.save();
          }
          await sendText(from,
`⏰ *Payment not confirmed yet.*

If you already paid, your listing will activate shortly.
Otherwise type *menu* and try again from your school account.`
          );
        }
      } catch (pollErr) {
        console.error("[School Payment] Poll error:", pollErr.message);
      }
    }, 10000);

  } catch (err) {
    console.error("[School Payment] Error:", err);
    biz.sessionState = "ready";
    await saveBiz(biz);
    await sendText(from, "❌ Something went wrong starting your payment. Please try again.");
  }
}