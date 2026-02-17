import axios from "axios";
import Product from "../models/product.js";

// GET media URL then download file
async function downloadMetaMedia(mediaId) {
  const token = process.env.META_ACCESS_TOKEN;

  // 1) Get media URL
  const metaInfo = await axios.get(
    `https://graph.facebook.com/v19.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  const url = metaInfo.data?.url;
  if (!url) throw new Error("No media URL returned by Meta");

  // 2) Download file bytes
  const file = await axios.get(url, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${token}` }
  });

  return Buffer.from(file.data);
}

function parseCsvSimple(csvText) {
  // Assumes: header row: name,unitPrice,description (description optional)
  const lines = csvText
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length < 2) return [];

  // Remove header
  const rows = lines.slice(1);

  return rows.map(line => {
    // simple split (works for your template; if you need quoted commas later, upgrade parser)
    const [name, unitPrice, ...rest] = line.split(",").map(x => x.trim());
    const description = rest.join(",").trim();
    return { name, unitPrice, description };
  });
}

export async function importCsvFromMetaDocument({ mediaId, bizId }) {
  const buf = await downloadMetaMedia(mediaId);
  const csvText = buf.toString("utf8");

  const rows = parseCsvSimple(csvText);

  let imported = 0;
  let skipped = 0;

  for (const r of rows) {
    const name = (r.name || "").trim();
    const price = Number(r.unitPrice);

    if (!name || name.length < 2 || Number.isNaN(price) || price <= 0) {
      skipped++;
      continue;
    }

    await Product.create({
      businessId: bizId,
      name,
      unitPrice: price,
      description: r.description || "",
      isActive: true
    });

    imported++;
  }

  return { imported, skipped };
}
