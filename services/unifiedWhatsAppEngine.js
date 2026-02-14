import twilioRouter from "../routes/twilio_biz.js";

/**
 * Feed Meta WhatsApp messages into the Twilio webhook logic
 */
export async function handleMetaMessage({
  phone,
  text,
  mediaUrls = []
}, req, res) {

  // Build a fake Twilio-style body
  req.body = {
    From: "whatsapp:" + phone,
    Body: text || "",
    NumMedia: mediaUrls.length,
    MediaUrl0: mediaUrls[0] || undefined
  };

  // Reuse the SAME webhook logic
  return twilioRouter.handle(req, res);
}
