/* ============================================================================
   fix-plumbers.js  —  make the real plumbing listings visible
   ----------------------------------------------------------------------------
   WHY: runSupplierSearch() (what the tools + "find plumber" use) only returns
   suppliers with  active:true  AND  subscriptionStatus in ["active","trial"]
   AND not suspended. Some genuine early plumbers are "pending" or have an
   expired subscription, so they stay hidden.

   HOW TO RUN (pick one):
     • mongosh "<your connection string>" fix-plumbers.js
     • or paste the commands into mongosh / Compass shell against your DB.

   Collection name assumed: supplierprofiles  (Mongoose model "SupplierProfile").
   If yours differs, change COLL below.
   ========================================================================== */

const COLL = "supplierprofiles";
const db_ = db.getSiblingDB(db.getName()); // current db

/* ── A) Targeted fix: the 3 known plumbers ──────────────────────────────────
   Gomo is active:true but subscriptionStatus:"pending" -> give it a trial so
   it shows in Harare. Noddah & Tanyatown are already active (they only needed
   the city-aware tool). This line is safe to run regardless. */
printjson(
  db_[COLL].updateMany(
    { businessName: { $regex: /gomo plumbers|noddah plumbers and construction|tanyatown contracting/i } },
    { $set: { active: true, subscriptionStatus: "trial", suspended: false } }
  )
);

/* ── B) Data tidy: Tanyatown's area "kadoma" under city "Gweru" is wrong.
   Kadoma is its own city. Set it to a sensible Gweru suburb label. Adjust if
   you know the real one. (Cosmetic only — affects the card's area label.) */
printjson(
  db_[COLL].updateOne(
    { businessName: { $regex: /tanyatown contracting/i } },
    { $set: { "location.area": "Gweru" } }
  )
);

/* ── C) OPTIONAL bulk (recommended while building momentum) ──────────────────
   Give EVERY genuine active plumbing listing a trial so the directory looks
   alive and recruits others. Comment this out if you want strict paid-only.
   It only touches service plumbers that are active but pending/expired. */
printjson(
  db_[COLL].updateMany(
    {
      profileType: "service",
      categories: "plumbing",
      active: true,
      subscriptionStatus: { $in: ["pending", "expired"] }
    },
    { $set: { subscriptionStatus: "trial" } }
  )
);

/* ── D) Verify: list what the tools will now see in each city ────────────── */
["Harare", "Bulawayo", "Gweru"].forEach(function (city) {
  const rows = db_[COLL].find(
    {
      profileType: "service",
      categories: "plumbing",
      active: true,
      suspended: { $ne: true },
      subscriptionStatus: { $in: ["active", "trial"] },
      "location.city": new RegExp("^" + city + "$", "i")
    },
    { businessName: 1, "location.city": 1, "location.area": 1, subscriptionStatus: 1 }
  ).toArray();
  print("\n" + city + " → " + rows.length + " plumber(s) now visible:");
  rows.forEach(function (r) {
    print("  • " + r.businessName + "  (" + (r.location && r.location.area) + ")  [" + r.subscriptionStatus + "]");
  });
});