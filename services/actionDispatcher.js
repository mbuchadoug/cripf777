import { ACTIONS } from "./actions.js";
import { ensureDefaultBranch } from "./ensureDefaultBranch.js";


// ⛔ DO NOT import Meta UI here
// ⛔ DO NOT import Twilio UI here
// ✅ ONLY business/session logic


async function ensureBranchContextOrAsk({ biz, saveBiz, req, res, sendTwimlText, purpose }) {
  // 1) make sure branch exists (auto create Main Branch)
  const { branches } = await ensureDefaultBranch(biz._id);

  // 2) If only one branch, auto select it
  if (branches.length === 1) {
    biz.sessionData = biz.sessionData || {};
    biz.sessionData.targetBranchId = branches[0]._id.toString();
    biz.sessionData.branchReturn = null;
    await saveBiz(biz);
    return { ok: true, branchId: branches[0]._id.toString(), auto: true };
  }

  // 3) Multiple branches: set a state that your Twilio UI layer can render as a picker
  biz.sessionState = "select_branch";
  biz.sessionData = {
    branchReturn: purpose // tells the system what to do after branch is picked
  };
  await saveBiz(biz);

  // IMPORTANT: we do NOT render UI here. We just force a re-run so your twilio bridge can show the list.
  return res.redirect(307, req.originalUrl);
}

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

  case ACTIONS.NEW_INVOICE: {
  // Ensure branch context
  const maybeRedirect = await ensureBranchContextOrAsk({
    biz, saveBiz, req, res, sendTwimlText,
    purpose: { kind: "new_doc", docType: "invoice" }
  });
  if (maybeRedirect?.ok !== true) return maybeRedirect; // redirect already sent

  // Branch is selected (auto if only 1 branch)
  biz.sessionState = "creating_invoice_choose_client";
  biz.sessionData = {
    ...(biz.sessionData || {}),
    docType: "invoice",
    items: []
  };
  await saveBiz(biz);

  return sendTwimlText(res, "Invoice:\n1) Use saved client\n2) New client\n3) Cancel");
}
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
