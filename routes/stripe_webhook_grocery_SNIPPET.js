/* ============================================================================
   ADDITIVE SNIPPET - paste this branch INSIDE your existing stripe_webhook.js,
   inside the `if (event.type === "checkout.session.completed") { ... }` block,
   alongside your existing meta.type branches (scoi_audit_report, 8qt_certificate).
   It reuses your already-correct raw-body mount + signature verification.
   Add this import at the top of stripe_webhook.js:

     import { markPaidByReference } from "./groceryOrders.js";

   Then add this branch:
   ========================================================================== */

// 5️⃣ GROCERY ORDER (ZimQuote delivery)
if (meta.type === "grocery_order" && meta.reference) {
  try {
    await markPaidByReference(meta.reference, "stripe");
    console.log(`✅ Grocery order paid via Stripe: ${meta.reference}`);
  } catch (err) {
    // Log but still return 200 - Stripe needs a 200 or it retries forever.
    console.error("[grocery stripe webhook]", err.message);
  }
}
