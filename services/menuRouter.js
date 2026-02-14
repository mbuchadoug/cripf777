export function routeMenuAction(actionId, biz) {
  switch (actionId) {

    case "invoice:new":
      biz.sessionState = "creating_invoice_choose_client";
      biz.sessionData = { docType: "invoice", items: [] };
      return "Invoice started";

    case "receipt:new":
      biz.sessionState = "creating_invoice_choose_client";
      biz.sessionData = { docType: "receipt", items: [] };
      return "Receipt started";

    case "quote:new":
      biz.sessionState = "creating_invoice_choose_client";
      biz.sessionData = { docType: "quote", items: [] };
      return "Quotation started";

    case "payment:new":
      biz.sessionState = "payment_start";
      return "Payment started";

    case "expense:new":
      biz.sessionState = "expense_amount";
      return "Expense started";

    case "reports":
      biz.sessionState = "reports_menu";
      return "Reports opened";

    case "upgrade":
      biz.sessionState = "upgrade_choose_package";
      return "Upgrade";

    case "settings":
      biz.sessionState = "settings_menu";
      return "Settings";

    default:
      return null;
  }
}
