import express from "express";
import { dispatchAction } from "../services/actionDispatcher.js";
import { ACTIONS } from "../services/actions.js";
import { getBizContext } from "../services/getBizContext.js";
import { handleIncomingMessage } from "../services/chatbotEngine.js";
    import { getBizForPhone } from "../services/bizHelpers.js";
import Business from "../models/business.js";
import { saveMetaLogo } from "../services/saveMetaLogo.js";
import { sendText } from "../services/metaSender.js";
import { sendMainMenu } from "../services/metaMenus.js";




import dotenv from "dotenv";


dotenv.config();
const router = express.Router();

/**
 * ✅ Meta webhook verification
 */
router.get("/whatsapp", (req, res) => {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

/**
 * ✅ Incoming messages from WhatsApp
 */




router.post("/whatsapp", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];


    //////////////////////////////////
    // 🔍 DEBUG META WEBHOOK
console.log("===== META WEBHOOK HIT =====");
console.log("Message type:", msg?.type);
console.log("From:", msg?.from);
console.log("Text:", msg?.text?.body);
console.log("Has image:", !!msg?.image);
console.log("Image ID:", msg?.image?.id);
console.log("Image MIME:", msg?.image?.mime_type);
console.log("Full msg:", JSON.stringify(msg, null, 2));

    // ✅ ALWAYS ACK META IMMEDIATELY
    res.sendStatus(200);





    if (!msg) return;



    // ===============================
    // 🖼️ HANDLE LOGO UPLOAD (META)
    // ===============================
    if (msg.type === "image") {
      const from = msg.from;
      const imageUrl = msg.image?.url;

      if (!imageUrl) return;

      const biz = await getBizForPhone(from);

      // Only accept image when user is in logo upload mode
      if (!biz || biz.sessionState !== "awaiting_logo_upload") {
        return;
      }

      try {
        const logoUrl = await saveMetaLogo({
          imageUrl,
          businessId: biz._id.toString()
        });

      biz.logoUrl = logoUrl;

// 🔑 COMPLETE ONBOARDING IF THIS WAS ONBOARDING
if (biz.sessionState === "awaiting_logo_upload") {
  biz.sessionState = "ready";
  biz.sessionData = {};
  await biz.save();

  await sendText(from, "✅ Logo uploaded successfully!");
  return sendMainMenu(from);
}

// ⚙️ Settings flow fallback
await biz.save();
await sendText(from, "✅ Logo updated successfully.");


      } catch (err) {
        console.error("META LOGO SAVE ERROR:", err);
        await sendText(from, "❌ Failed to save logo. Please try again.");
      }

      return; // 🚫 STOP — do NOT continue to text handling
    }







    const from = msg.from;
    let action = "";

    // ===========================
    // 🔥 NORMALIZE INPUT HERE
    // ===========================

    if (msg.type === "text") {
      action = (msg.text?.body || "")
        .trim()
        .toLowerCase();
    }

    if (msg.type === "interactive") {
      action = (
        msg.interactive?.button_reply?.id ||
        msg.interactive?.list_reply?.id ||
        ""
      )
        .trim()
        .toLowerCase();
    }

    // 🔥 IMPORTANT: do NOT touch res below this line
    await handleIncomingMessage({ from, action });

  } catch (e) {
    console.error("[META WEBHOOK ERROR]", e);
    // ❌ Do NOT send res here — Meta already got 200
  }
});



export default router;





