import Business from "../models/business.js";
import UserSession from "../models/userSession.js";
import { sendText } from "./metaSender.js";

export async function startClientFlow(to) {
  const phone = to.replace(/\D+/g, "");
  const session = await UserSession.findOne({ phone });
  const biz = await Business.findById(session?.activeBusinessId);

  if (!biz) return sendText(to, "❌ No active business.");

  biz.sessionState = "adding_client_name";
  biz.sessionData = {};
  await biz.save();

  return sendText(to, "👤 Enter client name:");
}
