import { Router } from "express";
import AuditPurchase from "../models/auditPurchase.js";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

router.get("/admin/scoi/financials", ensureAuth, async (req, res) => {
  try {
    // Get all purchases with audit details
    const purchases = await AuditPurchase.find({})
      .populate("userId", "email name")
      .populate("auditId")
      .sort({ createdAt: -1 })
      .lean();

    // Calculate revenue
    const totalRevenue = purchases.reduce((sum, p) => sum + (p.pricePaid || 0), 0);
    const monthlyRevenue = purchases
      .filter(p => {
        const purchaseDate = new Date(p.createdAt);
        const now = new Date();
        return (
          purchaseDate.getMonth() === now.getMonth() &&
          purchaseDate.getFullYear() === now.getFullYear()
        );
      })
      .reduce((sum, p) => sum + (p.pricePaid || 0), 0);

    // Group by month for chart
    const revenueByMonth = {};
    purchases.forEach(p => {
      const date = new Date(p.createdAt);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      revenueByMonth[monthKey] = (revenueByMonth[monthKey] || 0) + (p.pricePaid || 0);
    });

    // Top-selling audits
    const auditSales = {};
    purchases.forEach(p => {
      const auditName = p.auditId?.subject?.name || 'Unknown';
      auditSales[auditName] = (auditSales[auditName] || 0) + 1;
    });

    const topAudits = Object.entries(auditSales)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    res.render("admin/scoi_financials", {
      user: req.user,
      purchases,
      totalRevenue: (totalRevenue / 100).toFixed(2),
      monthlyRevenue: (monthlyRevenue / 100).toFixed(2),
      revenueByMonth,
      topAudits,
      stats: {
        totalSales: purchases.length,
        avgOrderValue: purchases.length > 0 ? (totalRevenue / purchases.length / 100).toFixed(2) : 0
      }
    });
  } catch (err) {
    console.error("[SCOI financials]", err);
    res.status(500).send("Failed to load financial data");
  }
});

export default router;