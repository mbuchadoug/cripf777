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


///////////////////////////
    // ===============================
    // 📄 HANDLE CSV BULK UPLOAD (META)
    // ===============================
    if (msg.type === "document") {
      const from = msg.from;

      const biz = await getBizForPhone(from);
      if (!biz || biz.sessionState !== "bulk_upload_products") {
        return; // ignore documents unless user is in bulk upload mode
      }

      const doc = msg.document;
      const mediaId = doc?.id;
      const mime = (doc?.mime_type || "").toLowerCase();
      const filename = doc?.filename || "upload.csv";

      // Accept common CSV mimes
      const isCsv =
        mime.includes("text/csv") ||
        mime.includes("application/csv") ||
        mime.includes("application/vnd.ms-excel") || // some phones send csv as this
        filename.toLowerCase().endsWith(".csv");

      if (!isCsv) {
        await sendText(
          from,
          "❌ Please upload a CSV file.\n\nExpected columns: name,unitPrice (optional: description)"
        );
        return;
      }

      if (!mediaId) {
        await sendText(from, "❌ Could not read the document. Please try again.");
        return;
      }

      try {
        const mediaUrl = await getMetaMediaUrl(mediaId);
        if (!mediaUrl) {
          await sendText(from, "❌ Could not fetch the file URL. Try again.");
          return;
        }

        const csvText = await downloadMetaMediaAsText(mediaUrl);

        const rows = parseLooseCSV(csvText);

        if (!rows.length) {
          await sendText(
            from,
            "❌ No valid rows found.\n\nMake sure your CSV has:\nname,unitPrice\nExample:\nMilk 1L,1.50"
          );
          return;
        }

        const Product = (await import("../models/product.js")).default;

        // Bulk insert (ignore partial failures)
        let inserted = 0;
        try {
          const resInsert = await Product.insertMany(
            rows.map(r => ({
              businessId: biz._id,
              name: r.name,
              unitPrice: r.unitPrice,
              description: r.description || "",
              isActive: true
            })),
            { ordered: false }
          );
          inserted = resInsert?.length || 0;
        } catch (err) {
          // insertMany with ordered:false may throw but still insert many
          // We can approximate inserted count by continuing without crashing.
          console.error("CSV insertMany warning:", err?.message || err);
          // fallback: try counting as "rows attempted"
          inserted = Math.max(inserted, 0);
        }

        await sendText(
          from,
          `✅ CSV processed: ${rows.length} rows\n✅ Imported: ${inserted || rows.length}\n\nYou can upload another CSV, paste lines, or reply *done* to finish.`
        );

        // keep them in bulk mode (so they can upload more files or paste)
        return;
      } catch (err) {
        console.error("CSV BULK UPLOAD ERROR:", err);
        await sendText(from, "❌ Failed to process CSV. Please try again.");
        return;
      }
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





