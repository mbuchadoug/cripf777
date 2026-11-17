// services/docActions.js
// ═════════════════════════════════════════════════════════════════════════════
// The action menu shown when a business user opens a sales document.
//
// Invoices & receipts: EXACTLY the same 3 buttons as before (nothing changes).
// Quotations: a short list instead, so "🔄 Convert to invoice" fits without
// dropping Delete or Back (WhatsApp allows only 3 buttons, but 10 list rows).
//
// The convert tap arrives as QT_TO_INV ("qt_to_inv") - deliberately NOT "doc_…"
// because the engine treats every "doc_<id>" tap as "open document <id>".
// ═════════════════════════════════════════════════════════════════════════════
import { sendButtons, sendList } from "./metaSender.js";
import { ACTIONS } from "./actions.js";

export const QT_TO_INV = "qt_to_inv";

export function docActionButtons(isManager) {
  return isManager
    ? [
        { id: ACTIONS.VIEW_DOC,   title: "📄 View PDF" },
        { id: ACTIONS.DELETE_DOC, title: "🗑 Delete" },
        { id: ACTIONS.SALES_MENU, title: "⬅ Back" }
      ]
    : [
        { id: ACTIONS.VIEW_DOC,   title: "📄 View PDF" },
        { id: ACTIONS.SALES_MENU, title: "⬅ Back" },
        { id: ACTIONS.MAIN_MENU,  title: "🏠 Main Menu" }
      ];
}

export async function sendDocActions(to, { text, doc, isManager }) {
  if (doc?.type !== "quote") return sendButtons(to, { text, buttons: docActionButtons(isManager) });

  const invoiced = !!doc.convertedToInvoiceId;
  const body = String(text || "") + (invoiced ? "\n\n✅ _Already converted to an invoice._" : "\n\n💡 _Customer said yes? Convert it to an invoice._");
  const rows = [
    { id: ACTIONS.VIEW_DOC, title: "📄 View PDF" },
    invoiced
      ? { id: QT_TO_INV, title: "🧾 Get the invoice", description: "Already invoiced - send me the invoice again" }
      : { id: QT_TO_INV, title: "🔄 Convert to invoice", description: "Same items & prices, new invoice number" },
    isManager ? { id: ACTIONS.DELETE_DOC, title: "🗑 Delete" } : null,
    { id: ACTIONS.SALES_MENU, title: "⬅ Back" },
    { id: ACTIONS.MAIN_MENU,  title: "🏠 Main Menu" }
  ].filter(Boolean);
  try {
    return await sendList(to, body.slice(0, 1020), rows);
  } catch (e) {
    console.warn("[DOC ACTIONS] list failed, using buttons:", e.message);
    return sendButtons(to, { text: body.slice(0, 1020), buttons: [
      { id: ACTIONS.VIEW_DOC, title: "📄 View PDF" },
      { id: QT_TO_INV, title: invoiced ? "🧾 Get invoice" : "🔄 To invoice" },
      { id: ACTIONS.SALES_MENU, title: "⬅ Back" }
    ] });
  }
}

export default { sendDocActions, docActionButtons, QT_TO_INV };
