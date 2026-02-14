import axios from "axios";
import fs from "fs";
import path from "path";

export async function saveMetaLogo({ imageUrl, businessId }) {
  const imgDir = path.join(process.cwd(), "public", "img");
  if (!fs.existsSync(imgDir)) {
    fs.mkdirSync(imgDir, { recursive: true });
  }

  const filename = `logo-${businessId}.jpg`;
  const filepath = path.join(imgDir, filename);

  const response = await axios.get(imageUrl, {
    responseType: "arraybuffer",
    headers: {
      Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`
    }
  });

  fs.writeFileSync(filepath, response.data);

  return `/img/${filename}`;
}
