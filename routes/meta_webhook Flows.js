import express from "express";
import { dispatchAction } from "../services/actionDispatcher.js";
import { ACTIONS } from "../services/actions.js";
import { getBizContext } from "../services/getBizContext.js";
import { handleIncomingMessage } from "../services/chatbotEngineFlow.js";
    import { getBizForPhone } from "../services/bizHelpers.js";
import Business from "../models/business.js";
import { saveMetaLogo } from "../services/saveMetaLogo.js";
import { sendText } from "../services/metaSender.js";
import { sendMainMenu } from "../services/metaMenus.js";
import axios from "axios";




import dotenv from "dotenv";


dotenv.config();
const router = express.Router();


function parseLooseCSV(text) {
  // Supports:
  // - header CSV: name,unitPrice,description
  // - no header CSV: Milk 1L,1.50,optional desc
  // Handles quotes in a basic way.
  const lines = (text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);

  if (!lines.length) return [];

  // Basic CSV row parser with quotes
  const parseRow = (line) => {
    const out = [];
    let cur = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
        continue;
      }

      if (ch === '"') {
        inQuotes = !inQuotes;
        continue;
      }

      if (ch === "," && !inQuotes) {
        out.push(cur.trim());
        cur = "";
        continue;
      }

      cur += ch;
    }
    out.push(cur.trim());
    return out;
  };

  const rows = lines.map(parseRow);

  // Detect header
  const header = rows[0].map(h => (h || "").toLowerCase());
  const hasHeader =
    header.includes("name") &&
    (header.includes("unitprice") || header.includes("price"));

  let startIndex = 0;
  let colMap = { name: 0, unitPrice: 1, description: 2 };

  if (hasHeader) {
    startIndex = 1;
    colMap.name = header.indexOf("name");
    colMap.unitPrice =
      header.indexOf("unitprice") !== -1
        ? header.indexOf("unitprice")
        : header.indexOf("price");
    colMap.description = header.indexOf("description");
  }

  const items = [];
  for (let i = startIndex; i < rows.length; i++) {
    const r = rows[i];

    const name = (r[colMap.name] || "").trim();
    const priceRaw = (r[colMap.unitPrice] || "").trim();
    const description =
      colMap.description >= 0 ? (r[colMap.description] || "").trim() : "";

    const unitPrice = Number(priceRaw);

    if (!name) continue;
    if (Number.isNaN(unitPrice) || unitPrice < 0) continue;

    items.push({ name, unitPrice, description });
  }

  return items;
}

async function getMetaMediaUrl(mediaId) {
  const token = process.env.META_ACCESS_TOKEN;
  const url = `https://graph.facebook.com/v19.0/${mediaId}`;

  const r = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  // Meta typically returns: { url: "https://..." }
  return r.data?.url || null;
}

async function downloadMetaMediaAsText(mediaUrl) {
  const token = process.env.META_ACCESS_TOKEN;

  const r = await axios.get(mediaUrl, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: "arraybuffer"
  });

  return Buffer.from(r.data).toString("utf-8");
}




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

  // ✅ Meta gives image.id, not image.url
  const mediaId = msg.image?.id;
  if (!mediaId) {
    await sendText(from, "❌ Image received but missing media id. Please resend the logo.");
    return;
  }

  // ✅ Convert mediaId -> downloadable URL (Graph API)
  let imageUrl = null;
  try {
    imageUrl = await getMetaMediaUrl(mediaId);
  } catch (e) {
    console.error("META getMetaMediaUrl error:", e?.response?.data || e?.message || e);
  }

  if (!imageUrl) {
    await sendText(from, "❌ Failed to fetch image from Meta. Please resend the logo.");
    return;
  }

  const biz = await getBizForPhone(from);

  // Only accept image when user is in logo upload mode
  if (!biz || biz.sessionState !== "awaiting_logo_upload") {
    // optional: give a hint instead of silent return
    // await sendText(from, "Reply *menu* then choose Upload logo first.");
    return;
  }

  try {
    const logoUrl = await saveMetaLogo({
      imageUrl,
      businessId: biz._id.toString()
    });

    biz.logoUrl = logoUrl;

    // 🔑 COMPLETE ONBOARDING IF THIS WAS ONBOARDING
    biz.sessionState = "ready";
    biz.sessionData = {};
    await biz.save();

    await sendText(from, "✅ Logo uploaded successfully!");
    return sendMainMenu(from);

  } catch (err) {
    console.error("META LOGO SAVE ERROR:", err);
    await sendText(from, "❌ Failed to save logo. Please try again.");
    return;
  }
}


///////////////////////////
// ===============================
// 🚫 DOCUMENTS DISABLED (PASTE-ONLY MODE)
// ===============================
if (msg.type === "document") {
  const from = msg.from;
  // Optional: if you want a friendly message:
  // await sendText(from, "📄 File uploads are disabled. Please use Paste list to add items.");
  return;
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
    //await handleIncomingMessage({ from, action: msg });


  } catch (e) {
    console.error("[META WEBHOOK ERROR]", e);
    // ❌ Do NOT send res here — Meta already got 200
  }
});



export default router;





