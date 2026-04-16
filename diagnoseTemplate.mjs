// diagnoseTemplate.mjs
// ─── Run once on your server to see exactly what Meta returns ────────────────
// Usage:
//   node diagnoseTemplate.mjs
//
// It will call the template API with your real credentials and print the full
// raw response body so you can see why delivery is failing.

import axios from "axios";

const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID
  || process.env.META_PHONE_NUMBER_ID
  || process.env.PHONE_NUMBER_ID;

const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN
  || process.env.WHATSAPP_ACCESS_TOKEN;

// ── Change this to YOUR own WhatsApp number to receive the test message ───────
// Use international format, no +, no spaces: e.g. 263771234567
const TEST_RECIPIENT = "263771143904"; // <-- your own number (the bot's number or yours)

console.log("=== TEMPLATE DIAGNOSTIC ===");
console.log("PHONE_NUMBER_ID :", PHONE_NUMBER_ID);
console.log("ACCESS_TOKEN    :", ACCESS_TOKEN ? ACCESS_TOKEN.slice(0, 20) + "..." : "❌ NOT SET");
console.log("Sending to      :", TEST_RECIPIENT);
console.log("");

// ── Step 1: Verify the phone number ID is valid and shows correct details ─────
try {
  console.log("── Step 1: Checking phone number ID via Graph API...");
  const infoRes = await axios.get(
    `https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}`,
    {
      params: { fields: "display_phone_number,verified_name,code_verification_status,account_mode" },
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
    }
  );
  console.log("Phone number info:", JSON.stringify(infoRes.data, null, 2));
} catch (e) {
  console.error("Step 1 FAILED:", e.response?.data || e.message);
}

console.log("");

// ── Step 2: Check which WABA this phone number belongs to ─────────────────────
try {
  console.log("── Step 2: Checking WABA ownership...");
  const wabaRes = await axios.get(
    `https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}`,
    {
      params: { fields: "whatsapp_business_account" },
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
    }
  );
  console.log("WABA info:", JSON.stringify(wabaRes.data, null, 2));
} catch (e) {
  console.error("Step 2 FAILED:", e.response?.data || e.message);
}

console.log("");

// ── Step 3: List templates registered under this WABA ─────────────────────────
try {
  console.log("── Step 3: Listing templates visible to this token...");

  // First get the WABA ID
  const wabaRes = await axios.get(
    `https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}`,
    {
      params: { fields: "whatsapp_business_account{id,name}" },
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
    }
  );
  const wabaId = wabaRes.data?.whatsapp_business_account?.id;
  console.log("WABA ID from token:", wabaId);

  if (wabaId) {
    const tplRes = await axios.get(
      `https://graph.facebook.com/v24.0/${wabaId}/message_templates`,
      {
        params: { fields: "name,status,components", limit: 20 },
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
      }
    );
    const templates = tplRes.data?.data || [];
    console.log(`Templates visible to this token (${templates.length} found):`);
    templates.forEach(t => {
      console.log(`  - ${t.name} [${t.status}]`);
    });
    if (!templates.find(t => t.name === "school_profile_view")) {
      console.warn("  ⚠️  school_profile_view NOT found in this token's WABA — WABA mismatch confirmed!");
    } else {
      console.log("  ✅ school_profile_view found in this WABA — template is accessible");
    }
  }
} catch (e) {
  console.error("Step 3 FAILED:", e.response?.data || e.message);
}

console.log("");

// ── Step 4: Send actual template and print the raw response body ──────────────
try {
  console.log(`── Step 4: Sending school_profile_view template to ${TEST_RECIPIENT}...`);
  const res = await axios.post(
    `https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to:   TEST_RECIPIENT,
      type: "template",
      template: {
        name:     "school_profile_view",
        language: { code: "en" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "Test School" },
              { type: "text", text: TEST_RECIPIENT },
              { type: "text", text: new Date().toLocaleString("en-GB") }
            ]
          }
        ]
      }
    },
    {
      headers: {
        Authorization:  `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );

  console.log("HTTP Status :", res.status);
  console.log("Raw response:", JSON.stringify(res.data, null, 2));

  const msg = res.data?.messages?.[0];
  if (msg) {
    console.log(`\n✅ Meta accepted — message_id: ${msg.id}, status: ${msg.message_status}`);
    console.log("Watch your WhatsApp for delivery. If you get the message, templates work.");
    console.log("If you don't receive it within 60 seconds, the issue is on Meta's delivery side.");
  }

} catch (e) {
  const errData = e.response?.data;
  console.error("Step 4 FAILED — HTTP", e.response?.status);
  console.error("Meta error response:", JSON.stringify(errData, null, 2));
  if (errData?.error?.code === 190) {
    console.error("→ Token is invalid or expired (code 190)");
  } else if (errData?.error?.code === 100) {
    console.error("→ Invalid parameter — likely wrong PHONE_NUMBER_ID or template name mismatch");
  } else if (errData?.error?.code === 131030) {
    console.error("→ Recipient phone not on WhatsApp");
  } else if (errData?.error?.code === 132001) {
    console.error("→ Template does not exist or is not approved under this WABA");
  }
}

console.log("\n=== DIAGNOSTIC COMPLETE ===");
