import Business from "../models/business.js";
import UserSession from "../models/userSession.js";
import { sendButtons, sendText } from "./metaSender.js";

export async function startReceiptFlow(to) {
  const phone = to.replace(/\D+/g, "");
  const session = await UserSession.findOne({ phone });
  const biz = await Business.findById(session?.activeBusinessId);

  if (!biz) {
    return sendText(to, "❌ No active business. Reply *menu*.");
  }

  biz.sessionState = "creating_invoice_choose_client";
  biz.sessionData = { docType: "receipt", items: [] };
  await biz.save();

  /*return sendButtons(
    to,
    "🧾 New Receipt\n\nChoose client option:",
    [
      { id: "INV_USE_CLIENT", title: "📋 Use saved client" },
      { id: "INV_NEW_CLIENT", title: "➕ New client" },
      { id: "INV_CANCEL", title: "⬅ Cancel" }
    ]
  );*/

  return sendButtons(to, {
  text: "🧾 New Receipt\n\nChoose client option:",
  buttons: [
        { id: "INV_USE_CLIENT", title: "📋 Use saved client" },
      { id: "INV_NEW_CLIENT", title: "➕ New client" },
      { id: "INV_CANCEL", title: "⬅ Cancel" }
  ]
});

}
