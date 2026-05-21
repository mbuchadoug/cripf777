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
import axios from "axios";




import dotenv from "dotenv";
import { fileURLToPath } from "url";
import fs_sync from "fs";
import path_sync from "path";

dotenv.config();

// Derive __dirname for ES modules (same as server.js)
// This ensures images are saved to the SAME docs/ folder that express.static serves.
const __filename_wh = fileURLToPath(import.meta.url);
// routes/meta_webhook.js → go up two levels to project root
const __projectRoot  = path_sync.resolve(path_sync.dirname(__filename_wh), "..", "..");
console.log("[WEBHOOK] Project root:", __projectRoot);

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
    // 🖼️ HANDLE ALL IMAGE MESSAGES
    // ===============================
    // Two cases:
    //  1. Supplier uploading their logo (sessionState = "awaiting_logo_upload")
    //  2. Buyer attaching a photo to a request (buyerRequestState = "awaiting_photo_upload")
    //  All other images are silently ignored.
    if (msg.type === "image") {
      const from    = msg.from;
      const mediaId = msg.image?.id;
      const mime    = msg.image?.mime_type || "image/jpeg";
      const caption = (msg.image?.caption || "").trim();

      if (!mediaId) return;

      // ── Case 1: Logo upload (existing flow, unchanged) ─────────────────────
      const biz = await getBizForPhone(from);
      if (biz && biz.sessionState === "awaiting_logo_upload") {
        try {
          // For logo we use the URL from msg.image if present, else fetch from Meta
          const rawUrl  = msg.image?.url || await getMetaMediaUrl(mediaId);
          if (!rawUrl) throw new Error("No image URL available");
          const logoUrl = await saveMetaLogo({ imageUrl: rawUrl, businessId: biz._id.toString() });
          biz.logoUrl      = logoUrl;
          biz.sessionState = "ready";
          biz.sessionData  = {};
          await biz.save();
          await sendText(from, "✅ Logo uploaded successfully!");
          return sendMainMenu(from);
        } catch (err) {
          console.error("META LOGO SAVE ERROR:", err);
          await sendText(from, "❌ Failed to save logo. Please try again.");
          return;
        }
      }

      // ── Case 2: Buyer attaching photo to request ────────────────────────────
      // Check if buyer is in awaiting_photo_upload state in their UserSession
      const { default: UserSession } = await import("../models/userSession.js");
      const sess = await UserSession.findOne({ phone: from.replace(/\D+/g, "") }).lean();

      if (sess?.tempData?.buyerRequestState === "awaiting_photo_upload") {
        try {
          // Download image from Meta immediately — mediaIds expire in ~10 minutes
          const token  = process.env.META_ACCESS_TOKEN;
          const metaRes = await axios.get(`https://graph.facebook.com/v24.0/${mediaId}`, {
            headers: { Authorization: `Bearer ${token}` }
          });
          const dlUrl = metaRes.data?.url;
          if (!dlUrl) throw new Error("Could not get Meta media download URL");

          const imgRes = await axios.get(dlUrl, {
            headers:      { Authorization: `Bearer ${token}` },
            responseType: "arraybuffer"
          });

          // Save to project root docs/ — same folder served by express.static in server.js
          // Use __projectRoot (derived from import.meta.url) NOT process.cwd()
          // process.cwd() differs from __dirname under PM2 and causes 404s.
          const ext    = mime.includes("png") ? "png" : "jpg";
          const fname  = `req_photo_${from}_${Date.now()}.${ext}`;
          const dir    = path_sync.join(__projectRoot, "public", "docs", "generated", "orders");
          if (!fs_sync.existsSync(dir)) fs_sync.mkdirSync(dir, { recursive: true });
          fs_sync.writeFileSync(path_sync.join(dir, fname), Buffer.from(imgRes.data));
          console.log("[BUYER PHOTO] ✅ Saved to:", path_sync.join(dir, fname));

          const siteUrl  = (process.env.SITE_URL || "").replace(/\/$/, "");

          // ── STRICT: abort if SITE_URL is missing — relative URLs break Meta API ──
          // Meta's sendImage and admin panel both need a full https:// URL.
          // If SITE_URL is not set, the image is saved but unusable. Fail loudly.
          if (!siteUrl || !siteUrl.startsWith("http")) {
            console.error("[BUYER PHOTO] ❌ SITE_URL is not set or invalid in .env!");
            console.error("[BUYER PHOTO] ❌ Must be a full URL: SITE_URL=https://yourdomain.com");
            console.error("[BUYER PHOTO] ❌ Image saved to disk but cannot be sent to sellers.");
            // Still call chatbotEngine with null imageUrl so buyer gets a useful message
            await handleIncomingMessage({
              from,
              action:       "__buyer_photo_uploaded__",
              hasImage:     false,
              imageUrl:     null,
              imageCaption: caption
            });
            return;
          }

          const imageUrl = `${siteUrl}/docs/generated/orders/${fname}`;
          console.log("[BUYER PHOTO] ✅ Public URL:", imageUrl);

          // Pass image data into chatbotEngine via action string + session
          await handleIncomingMessage({
            from,
            action:       "__buyer_photo_uploaded__",
            hasImage:     true,
            imageUrl,
            imageCaption: caption
          });
        } catch (err) {
          console.error("[BUYER PHOTO UPLOAD ERROR]", err.message);
          await sendText(from, "❌ Failed to save your photo. Please try again or type *skip* to submit without a photo.");
        }
        return;
      }

      // ── Unknown image context — ignore silently ─────────────────────────────
      return;
    }


///////////////////////////
// ===============================
// 🚫 DOCUMENTS DISABLED (PASTE-ONLY MODE)
// ===============================
// ===============================
// 📄 DOCUMENT UPLOAD (school brochure PDF)
// ===============================
// ===============================
// 📄 DOCUMENT UPLOAD (school brochure PDF)
// ===============================
if (msg.type === "document") {
  const from     = msg.from;
  const mimeType = msg.document?.mime_type || "";
  const mediaUrl = msg.document?.url;        // Meta sends direct URL in webhook payload
  const mediaId  = msg.document?.id;

  // Only handle PDFs - everything else ignored silently
  if (mimeType !== "application/pdf") {
    return;
  }

  const biz = await getBizForPhone(from);

  // Only accept when school admin is in brochure-upload state
  if (!biz || biz.sessionState !== "school_admin_awaiting_brochure") {
    return;
  }

  try {
    // 1. Get the download URL - use webhook URL if present, else fetch from Meta
    const token      = process.env.META_ACCESS_TOKEN;
    const dlUrl      = mediaUrl || await getMetaMediaUrl(mediaId);
    if (!dlUrl) throw new Error("No media URL available");

    // 2. Download the PDF binary
    const fileRes = await axios.get(dlUrl, {
      headers:      { Authorization: `Bearer ${token}` },
      responseType: "arraybuffer"
    });
    const pdfBuffer = Buffer.from(fileRes.data);

    // 3. Save to local filesystem - same folder used by generatePDF
    const fs       = await import("fs");
    const path     = await import("path");
    const filename = `brochure_${from}_${Date.now()}.pdf`;
    const dir      = path_sync.join(__projectRoot, "public", "docs", "generated", "orders");

    // Create directory if it doesn't exist
    if (!fs_sync.existsSync(dir)) fs_sync.mkdirSync(dir, { recursive: true });
    fs_sync.writeFileSync(path_sync.join(dir, filename), pdfBuffer);

    // 4. Build the public URL - same pattern as schoolPdfGenerator.js
    const site   = (process.env.SITE_URL || "").replace(/\/$/, "");
    const pdfUrl = `${site}/docs/generated/orders/${filename}`;

    // 5. Store URL in biz session so the state handler picks it up
    biz.sessionData = { ...(biz.sessionData || {}), pendingDocumentUrl: pdfUrl };
    await biz.save();

    // 6. Route through the engine - state machine handles confirmation
    await handleIncomingMessage({ from, action: "__document_uploaded__" });

  } catch (err) {
    console.error("[School Brochure Upload] Error:", err.message);
    await sendText(from, "❌ Failed to save your PDF. Please try again.");
  }

  return; // 🚫 STOP - do not continue to text handling
}





    const from = msg.from;
  let action = "";

// ===========================
// 🔥 NORMALIZE INPUT HERE
// ===========================

// ✅ TEXT (fallback)
if (msg.type === "text") {
  const rawText = (msg.text?.body || "").trim();
  const lowered = rawText.toLowerCase();

  // ── ZQ:REQUEST deep link — drops buyer straight into Request Sellers flow ──
  // Share link: https://wa.me/263771143904?text=ZQ%3AREQUEST
  if (/^ZQ:REQUEST$/i.test(rawText)) {
    action = "sup_request_sellers";
  } else if (lowered === "view & quote" || lowered === "view and quote") {
    action = "view_and_quote";
  } else if (lowered === "not available") {
    action = "not_available";
  } else {
    action = lowered;
  }
}

// ✅ TEMPLATE QUICK REPLY (THIS IS YOUR MISSING PIECE)
if (msg.type === "button") {
  action = (
    msg.button?.payload ||   // 🔥 THIS is the real value: view_and_quote
    msg.button?.text ||      // fallback
    ""
  )
    .trim()
    .toLowerCase();
}

// ✅ INTERACTIVE (list/buttons after bot sends menus)
if (msg.type === "interactive") {
  action = (
    msg.interactive?.button_reply?.id ||
    msg.interactive?.list_reply?.id ||
    msg.interactive?.button_reply?.title ||
    msg.interactive?.list_reply?.title ||
    ""
  )
    .trim()
    .toLowerCase();
}
    // 🔥 IMPORTANT: do NOT touch res below this line
    await handleIncomingMessage({ from, action, hasImage: false, imageUrl: null, imageCaption: "" });


  } catch (e) {
    console.error("[META WEBHOOK ERROR]", e);
    // ❌ Do NOT send res here - Meta already got 200
  }
});



export default router;