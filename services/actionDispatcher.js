// services/actionDispatcher.js
import { ACTIONS } from "./actions.js";
import Branch from "../models/branch.js";
//import { requireRole } from "./roleGuard.js";


// ⛔ DO NOT import Meta UI here
// ⛔ DO NOT import Twilio UI here
// ✅ ONLY business/session logic




export async function dispatchAction({
  action,
  biz,
  providerId,
  req,
  res,
  helpers
}) {
  const {
    saveBiz,
    resetSession,
    sendMenuForUser,
    sendTwimlText
  } = helpers;

  switch (action) {
    case ACTIONS.MENU:
      await resetSession(biz);
      return sendMenuForUser(res, biz, providerId);

    case ACTIONS.NEW_INVOICE:
      biz.sessionState = "creating_invoice_choose_client";
      biz.sessionData = { docType: "invoice", items: [] };
      await saveBiz(biz);
      return sendTwimlText(
        res,
        "Invoice:\n1) Use saved client\n2) New client\n3) Cancel"
      );

    case ACTIONS.ADD_CLIENT:
      biz.sessionState = "adding_client_name";
      biz.sessionData = {};
      await saveBiz(biz);
      return sendTwimlText(res, "Enter client name:");

    case ACTIONS.RECORD_PAYMENT:
      biz.sessionState = "payment_start";
      biz.sessionData = {};
      await saveBiz(biz);
      return res.redirect(307, req.originalUrl);





    case ACTIONS.REPORTS_MENU:
      biz.sessionState = "reports_menu";
      await saveBiz(biz);
      return res.redirect(307, req.originalUrl);

    case ACTIONS.UPGRADE:
      biz.sessionState = "upgrade_choose_package";
      await saveBiz(biz);
      return res.redirect(307, req.originalUrl);




    case ACTIONS.CANCEL:
    case ACTIONS.BACK:
      await resetSession(biz);
      return sendMenuForUser(res, biz, providerId);

    default:
      return sendTwimlText(res, "Unknown action. Reply *menu*.");
  }
}
