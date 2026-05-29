// routes/scoi_marketplace.js
// Default sort: newest uploaded first (special by createdAt desc, placement by createdAt desc)

import { Router } from "express";
import PlacementAudit from "../models/placementAudit.js";
import SpecialScoiAudit from "../models/specialScoiAudit.js";
import AuditPurchase from "../models/auditPurchase.js";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

// ── MARKETPLACE ──────────────────────────────────────────────────────────────
router.get("/scoi", async (req, res) => {
  try {
    // ── Fetch both types, newest first ──────────────────────────
    const placementAudits = await PlacementAudit.find({
      status: "archived_reference"
    })
      .sort({ createdAt: -1 })
      .lean();

    const specialAudits = await SpecialScoiAudit.find({
      isPaid: false
    })
      .sort({ createdAt: -1 })
      .lean();

    // ── Normalize ────────────────────────────────────────────────
    const normalizedPlacement = placementAudits.map(a => ({
      ...a,
      displayPrice: 149,
      auditKind: "placement"
    }));

    const normalizedSpecial = specialAudits.map(a => ({
      ...a,
      assessmentWindow: {
        label: a.assessmentWindow?.label || "Special Audit"
      },
      displayPrice: 299,
      auditKind: "special"
    }));

    // ── Merge: special first, then placement, both newest-first ──
    const audits = [...normalizedSpecial, ...normalizedPlacement];

    res.render("scoi/marketplace", {
      user: req.user || null,
      audits,
      pageTitle: "SCOI Intelligence Marketplace"
    });
  } catch (err) {
    console.error("[SCOI marketplace]", err);
    res.status(500).send("Failed to load marketplace");
  }
});

// ── PURCHASED REPORTS ────────────────────────────────────────────────────────
/**
 * GET /scoi/purchased
 * Shows all reports purchased by the logged-in user.
 * Populated with the full audit document so the template can render
 * subject name, assessment window, framework, author, etc.
 */
router.get("/scoi/purchased", ensureAuth, async (req, res) => {
  try {
    // Load all purchases for this user, populate the linked audit document.
    // AuditPurchase is expected to have:
    //   auditId   : ObjectId  (ref to PlacementAudit or SpecialScoiAudit - stored as a plain ref)
    //   auditModel: String    ('PlacementAudit' | 'SpecialScoiAudit')
    //   pricePaid : Number    (in cents)
    //   userId    : ObjectId
    //   createdAt : Date
    const rawPurchases = await AuditPurchase.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .lean();

    // Populate audit data manually because the ref model can vary per row
    const purchases = await Promise.all(
      rawPurchases.map(async purchase => {
        let audit = null;
        try {
          if (purchase.auditModel === "SpecialScoiAudit") {
            audit = await SpecialScoiAudit.findById(purchase.auditId).lean();
          } else {
            audit = await PlacementAudit.findById(purchase.auditId).lean();
          }
        } catch (_) {
          // audit may have been deleted - skip gracefully
        }
        return { ...purchase, auditId: audit };
      })
    );

    // Filter out purchases whose audit has been deleted
    const validPurchases = purchases.filter(p => p.auditId != null);

    res.render("scoi/purchased", {
      user: req.user,
      purchases: validPurchases,
      pageTitle: "My Intelligence Reports"
    });
  } catch (err) {
    console.error("[SCOI purchased]", err);
    res.status(500).send("Failed to load purchased reports");
  }
});

export default router;