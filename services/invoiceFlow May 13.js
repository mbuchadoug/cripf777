/**
 * invoiceFlow.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Starts a new invoice, quotation, or receipt flow.
 *
 * CHANGES FROM ORIGINAL:
 *   • startInvoiceFlow now accepts an optional docType param so that
 *     quoteFlow.js and receiptFlow.js can call it directly instead of
 *     duplicating this logic.
 *   • preserveSessionCore() used instead of inline field extraction.
 *   • Label in the button text updates to match the document type.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import Business    from "../models/business.js";
import UserSession from "../models/userSession.js";
import { sendText, sendButtons } from "./metaSender.js";

/**
 * startInvoiceFlow
 * ────────────────
 * Resets session and presents the client-choice menu.
 *
 * @param {string} to       WhatsApp "to" address
 * @param {string} docType  "invoice" | "quote" | "receipt"   (default: "invoice")
 */
export async function startInvoiceFlow(to, docType = "invoice") {
  const phone   = to.replace(/\D+/g, "");
  const session = await UserSession.findOne({ phone });
  const biz     = await Business.findById(session?.activeBusinessId);

  if (!biz) {
    return sendText(to, "❌ No active business. Reply *menu*.");
  }

  // Preserve owner's branch selection across the session reset
  const targetBranchId = biz.sessionData?.targetBranchId || null;

  biz.sessionState = "creating_invoice_choose_client";
  biz.sessionData  = {
    docType,
    targetBranchId,
    items:        [],
    itemMode:     null,
    lastItem:     null,
    expectingQty: false
  };
  await biz.save();

  const label =
    docType === "invoice" ? "📄 New Invoice"
    : docType === "quote" ? "📋 New Quotation"
    :                       "🧾 New Receipt";

  return sendButtons(to, {
    text: `${label}\n\nChoose client option:`,
    buttons: [
      { id: "INV_SKIP_CLIENT", title: "⏭ Skip client"  },
      { id: "INV_USE_CLIENT",  title: "📋 Saved client" },
      { id: "INV_NEW_CLIENT",  title: "➕ New client"   }
    ]
  });
}