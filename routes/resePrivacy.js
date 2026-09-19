// routes/resePrivacy.js
//
// Public legal pages for the Rese Rese app.
//   GET /rese-rese/privacy         → privacy policy (Play Store URL)
//   GET /rese-rese/delete-account  → how to delete an account + data
//
// Mount in server.js:
//    import resePrivacyRouter from "./routes/resePrivacy.js";
//    app.use("/", resePrivacyRouter);
//
// ⚠️ Replace CONTACT_EMAIL below with the address you want users to write to.

import { Router } from "express";

const router = Router();

const CONTACT_EMAIL = "reserese@cripfcnt.com"; // ← change to your real support email
const EFFECTIVE_DATE = "19 September 2026";

function page(title, body) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Rese Rese</title>
<style>
  :root{--orange:#F97316;--green:#12B76A;--ink:#141414;--dim:#5b5b5b;--line:#ebe7e1;--bg:#fff}
  *{box-sizing:border-box}
  body{margin:0;background:#faf7f3;color:var(--ink);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.6}
  .bar{background:var(--orange);color:#fff;padding:22px 20px}
  .wrap{max-width:760px;margin:0 auto;padding:20px}
  .logo{font-weight:800;font-size:22px;letter-spacing:-.5px}
  .logo .g{color:#0a3;color:#dff5e8}
  .card{background:var(--bg);border:1px solid var(--line);border-radius:16px;padding:26px 24px;margin-top:-30px;box-shadow:0 8px 30px rgba(0,0,0,.06)}
  h1{font-size:26px;margin:0 0 4px}
  .eff{color:var(--dim);font-size:14px;margin:0 0 18px}
  h2{font-size:18px;margin:26px 0 6px;color:var(--orange)}
  p,li{font-size:15.5px;color:#222}
  ul{padding-left:20px}
  a{color:var(--orange)}
  .foot{color:var(--dim);font-size:13px;text-align:center;margin:26px 0}
  code{background:#f1ede7;padding:1px 6px;border-radius:6px}
</style></head><body>
<div class="bar"><div class="wrap logo">R<span style="color:#dff5e8">R</span> &nbsp;Rese Rese</div></div>
<div class="wrap"><div class="card">${body}</div>
<p class="foot">Rese Rese · BLACK GREY · Harare, Zimbabwe</p></div>
</body></html>`;
}

/* ── Privacy policy ───────────────────────────────────────── */
router.get("/rese-rese/privacy", (req, res) => {
  res.send(
    page(
      "Privacy Policy",
      `
    <h1>Privacy Policy</h1>
    <p class="eff">Effective ${EFFECTIVE_DATE}</p>

    <p>Rese Rese ("we", "us") is a mobile app that connects people who need small,
    casual jobs done with workers nearby, in Zimbabwe. This policy explains what
    information we collect, why, and your choices. We handle personal information
    in line with Zimbabwe's Cyber and Data Protection Act [Chapter 12:07].</p>

    <h2>Information we collect</h2>
    <ul>
      <li><b>Phone number</b> - used to create your account and sign you in.</li>
      <li><b>Your name</b> and an optional <b>profile photo</b>.</li>
      <li><b>Your area</b> - the suburb(s) you select, so jobs can be matched locally.</li>
      <li><b>Job information</b> - the requests you post or the offers you make (category, description, price).</li>
      <li><b>Worker verification (workers only)</b> - a <b>selfie</b> and a photo of your <b>national ID</b>, used only to confirm you are a real person before you receive jobs.</li>
      <li><b>Notification token</b> - a device token so we can send you job alerts.</li>
      <li><b>Basic technical data</b> needed to run the service (e.g. app version).</li>
    </ul>

    <h2>How we use your information</h2>
    <ul>
      <li>To run the marketplace - post jobs, match requesters with nearby workers, and let a matched pair contact each other.</li>
      <li>To sign you in, we send a one-time code to your phone <b>over WhatsApp</b>.</li>
      <li>To send you notifications about jobs and offers.</li>
      <li>To verify workers' identity and keep the community safe and trustworthy.</li>
    </ul>

    <h2>How contact details are shared</h2>
    <p>Your phone number is <b>not public</b>. It is shared <b>only</b> with the other
    person once a job is matched - that is, after a requester chooses a worker - so the
    two of you can arrange the work. We do <b>not</b> sell your personal information or
    share it for advertising.</p>

    <h2>Identity documents</h2>
    <p>Selfie and national ID images are used solely to verify a worker's identity.
    They are stored securely with restricted access, are visible only to our verification
    administrators, and are never shown to other users or shared with third parties.</p>

    <h2>Service providers</h2>
    <p>We rely on a small number of providers to operate: WhatsApp/Meta (to deliver
    login codes), our hosting on <code>cripfcnt.com</code>, and the app store. They process
    data only as needed to provide their service.</p>

    <h2>Storage and security</h2>
    <p>Your data is stored on our servers at <b>https://cripfcnt.com</b> in a secured
    database. Data is transmitted over encrypted connections (HTTPS), and verification
    images are kept in access-controlled storage.</p>

    <h2>How long we keep it</h2>
    <p>We keep your information while your account is active. If you delete your account,
    we remove your personal information and verification images, except anything we must
    keep for legal or fraud-prevention reasons.</p>

    <h2>Your rights and choices</h2>
    <p>You may ask us to access, correct, or delete your personal information at any time.
    To do so, email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>, or see
    <a href="/rese-rese/delete-account">how to delete your account</a>.</p>

    <h2>Children</h2>
    <p>Rese Rese is for adults (18+). It is not directed at children, and we do not
    knowingly collect information from anyone under 18.</p>

    <h2>Changes to this policy</h2>
    <p>We may update this policy from time to time. The effective date above shows when
    it was last changed.</p>

    <h2>Contact us</h2>
    <p>Questions about this policy or your data? Email
    <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
    `
    )
  );
});

/* ── Account / data deletion (Play requires this be reachable) ── */
router.get("/rese-rese/delete-account", (req, res) => {
  res.send(
    page(
      "Delete your account",
      `
    <h1>Delete your Rese Rese account</h1>
    <p class="eff">Effective ${EFFECTIVE_DATE}</p>
    <p>You can ask us to delete your Rese Rese account and the personal information
    linked to it - your name, phone number, area, job history, and any verification
    images (selfie and national ID).</p>
    <h2>How to request deletion</h2>
    <ul>
      <li>Email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> from the phone number on your account, or include that number in your message.</li>
      <li>Put "Delete my account" in the subject.</li>
    </ul>
    <p>We will delete your data within 30 days, except anything we are legally required
    to retain. Once deleted, your account cannot be recovered.</p>
    <h2>Contact</h2>
    <p><a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
    `
    )
  );
});

export default router;