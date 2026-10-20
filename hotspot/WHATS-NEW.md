# What's new in this build

Everything is **additive** — the token flow, plans, sync loop and router handling
you already rely on are unchanged. Deploy by replacing the `hotspot/` folder and
restarting the app. No database migration and **no new router/walled-garden config**
are required (the account page lives on the same host as `buy`/`status`).

New files: `models/hotspotAccount.js`, `models/hotspotSetting.js`, `portal/account.html`.

---

## 1. Edit a ticket while it's active
Open any voucher → **Edit this voucher**. Change total time, devices, download/upload
speed (Mbps, 0 = unlimited), price or note and hit **Save** — it applies live, even
mid-session. Under the hood: speed/device changes move the live user onto a matching
RouterOS profile; a time change resets the router's uptime limit (or the clock window)
in place. "Add time" (the old extend) is still there.

API: `PATCH /hotspot/api/vouchers/:code` `{durationMinutes, deviceCap, downKbps, upKbps, price, note}`

## 2. User accounts (tenants & regular clients)
A new **Accounts** tab. An account is a username+password login (not a code) that is a
normal RouterOS hotspot user, so the **same captive-portal page** signs it in — guests
still see the code box by default; "Tenant or member? Sign in with your account"
reveals username/password.

- **Capped** by speed, by devices (both enforced on the router via the account's
  profile), and by a validity period.
- **Billing**: *subscription* (a rolling window, e.g. 30 days — best for tenants) or
  *prepaid* (a pool of connected minutes). Both are topped up to renew.
- **Global cap** on how many accounts may exist — owner sets it in Accounts → "change limit".
- **Top up**: admin does it from the drawer (cash/EcoCash/free); the member can do it
  themselves at **`/hotspot/account`** (log in → renew by EcoCash).
- Expired subscriptions are auto-disabled by the sync loop and come back on top-up.

## 3. Speed-cap staff / bypassed devices (protect the WiFi)
Bypass devices (Devices tab) now take an optional **download/upload cap in Mbps**.
Leave cameras at 0 (unlimited, untouched). Give a heavy staff phone a cap and it stays
**bypassed — no login page** — but can no longer starve the WiFi. The limit is applied
straight on the router's `ip-binding` (`rate-limit`), so nothing about how cameras
connect changes.

---

### Notes
- Account & bypass caps use the same `up/down` (rx/tx) convention as your plans. If a
  speed ever looks swapped on the router, flip the two numbers (same caveat as plans).
- Account passwords are stored as entered (like voucher codes) because the router needs
  the real secret to recreate the user on resync.
