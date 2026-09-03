// ==============================
// 📡 MIKROTIK SERVICE
// The ONLY file that talks to the router. Everything else calls these
// helpers. If the router isn't configured or is unreachable, calls throw
// a MikrotikError and the caller keeps working in "offline mode" (vouchers
// are still saved in Mongo and pushed later by the sync loop).
// ==============================

let RouterOSAPI = null;   // lazy-loaded so the app boots even without the package

const CFG = {
  host: process.env.MT_HOST || "",
  user: process.env.MT_USER || "admin",
  password: process.env.MT_PASS || "",
  port: Number(process.env.MT_PORT || 8728),
  tls: String(process.env.MT_TLS || "false") === "true",
  timeout: Number(process.env.MT_TIMEOUT || 8),
  server: process.env.MT_HOTSPOT_SERVER || "all"   // which hotspot server to log users out of
};

export class MikrotikError extends Error {}

export function isConfigured() {
  return Boolean(CFG.host && CFG.password);
}

// Read the ".id" field that RouterOS returns for every row.
function rowId(row) {
  return row?.[".id"] || row?.id || null;
}

// Open a short-lived connection, run fn, always close. Low volume → simple & safe.
async function withConn(fn) {
  if (!isConfigured()) throw new MikrotikError("Router not configured");
  if (!RouterOSAPI) {
    try {
      ({ RouterOSAPI } = await import("node-routeros"));
    } catch {
      throw new MikrotikError("node-routeros not installed (run: npm i node-routeros)");
    }
  }
  const api = new RouterOSAPI({
    host: CFG.host, user: CFG.user, password: CFG.password,
    port: CFG.port, timeout: CFG.timeout, tls: CFG.tls ? {} : undefined
  });
  try {
    await api.connect();
    return await fn(api);
  } catch (err) {
    throw new MikrotikError(err?.message || String(err));
  } finally {
    try { api.close(); } catch { /* ignore */ }
  }
}

// Convert minutes → RouterOS time string, e.g. 150 → "02:30:00", 1500 → "1d01:00:00".
export function minutesToRos(minutes) {
  let secs = Math.max(0, Math.round(minutes * 60));
  const d = Math.floor(secs / 86400); secs -= d * 86400;
  const h = Math.floor(secs / 3600);  secs -= h * 3600;
  const m = Math.floor(secs / 60);    const s = secs - m * 60;
  const hms =
    `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return d > 0 ? `${d}d${hms}` : hms;
}

// ── Connection check (for the status pill) ──
export async function ping() {
  return withConn(async (api) => {
    const id = await api.write("/system/identity/print");
    const active = await api.write("/ip/hotspot/active/print", ["=count-only="]);
    return {
      ok: true,
      identity: id?.[0]?.name || "MikroTik",
      activeCount: Number(active?.[0]?.ret || active?.length || 0)
    };
  });
}

// ── Ensure a user-profile exists for a plan (device cap + speed) ──
export async function ensureProfile({ name, sharedUsers, rateLimit }) {
  return withConn(async (api) => {
    const existing = await api.write("/ip/hotspot/user/profile/print", [`?name=${name}`]);
    const params = [
      `=shared-users=${sharedUsers || 1}`,
      "=add-mac-cookie=yes"
    ];
    if (rateLimit) params.push(`=rate-limit=${rateLimit}`);

    if (existing?.length) {
      await api.write("/ip/hotspot/user/profile/set", [`=.id=${rowId(existing[0])}`, ...params]);
      return rowId(existing[0]);
    }
    await api.write("/ip/hotspot/user/profile/add", [`=name=${name}`, ...params]);
    const created = await api.write("/ip/hotspot/user/profile/print", [`?name=${name}`]);
    return rowId(created?.[0]);
  });
}

// ── Add a voucher as a hotspot user. Returns the router id. ──
export async function addVoucherUser({ code, profile, limitUptimeMinutes }) {
  return withConn(async (api) => {
    const params = [`=name=${code}`, `=password=${code}`, `=profile=${profile}`];
    if (limitUptimeMinutes && limitUptimeMinutes > 0) {
      params.push(`=limit-uptime=${minutesToRos(limitUptimeMinutes)}`);
    }
    await api.write("/ip/hotspot/user/add", params);
    const rows = await api.write("/ip/hotspot/user/print", [`?name=${code}`]);
    return rowId(rows?.[0]);
  });
}

export async function setUptimeLimit(code, totalMinutes) {
  return withConn(async (api) => {
    const rows = await api.write("/ip/hotspot/user/print", [`?name=${code}`]);
    if (!rows?.length) throw new MikrotikError(`voucher ${code} not on router`);
    await api.write("/ip/hotspot/user/set",
      [`=.id=${rowId(rows[0])}`, `=limit-uptime=${minutesToRos(totalMinutes)}`]);
    return true;
  });
}

export async function setUserDisabled(code, disabled) {
  return withConn(async (api) => {
    const rows = await api.write("/ip/hotspot/user/print", [`?name=${code}`]);
    if (!rows?.length) return false;
    await api.write("/ip/hotspot/user/set",
      [`=.id=${rowId(rows[0])}`, `=disabled=${disabled ? "yes" : "no"}`]);
    return true;
  });
}

export async function removeVoucherUser(code) {
  return withConn(async (api) => {
    const rows = await api.write("/ip/hotspot/user/print", [`?name=${code}`]);
    if (rows?.length) {
      await api.write("/ip/hotspot/user/remove", [`=.id=${rowId(rows[0])}`]);
    }
    return true;
  });
}

// Kick any live sessions for a code (used on revoke / expiry).
export async function kick(code) {
  return withConn(async (api) => {
    const active = await api.write("/ip/hotspot/active/print", [`?user=${code}`]);
    for (const row of active || []) {
      await api.write("/ip/hotspot/active/remove", [`=.id=${rowId(row)}`]);
    }
    return true;
  });
}

// ── Snapshot everything the sync loop needs in as few calls as possible ──
export async function snapshot() {
  return withConn(async (api) => {
    const [active, users, hosts] = await Promise.all([
      api.write("/ip/hotspot/active/print"),
      api.write("/ip/hotspot/user/print"),
      api.write("/ip/hotspot/host/print")
    ]);

    const hostByMac = {};
    for (const h of hosts || []) {
      const mac = (h["mac-address"] || "").toUpperCase();
      if (mac && h["host-name"]) hostByMac[mac] = h["host-name"];
    }

    const usageByCode = {};
    for (const u of users || []) {
      usageByCode[u.name] = {
        uptimeUsedSec: parseRosUptime(u.uptime),
        bytesIn: Number(u["bytes-in"] || 0),
        bytesOut: Number(u["bytes-out"] || 0)
      };
    }

    const sessions = (active || []).map((a) => {
      const mac = (a["mac-address"] || "").toUpperCase();
      return {
        code: a.user,
        mac,
        ip: a.address || "",
        hostname: hostByMac[mac] || "",
        uptimeSec: parseRosUptime(a.uptime),
        bytesIn: Number(a["bytes-in"] || 0),
        bytesOut: Number(a["bytes-out"] || 0)
      };
    });

    return { sessions, usageByCode };
  });
}

// ── Bypass devices (cameras, reception) ──
export async function addBypass(mac, comment) {
  return withConn(async (api) => {
    const existing = await api.write("/ip/hotspot/ip-binding/print", [`?mac-address=${mac}`]);
    if (existing?.length) {
      await api.write("/ip/hotspot/ip-binding/set",
        [`=.id=${rowId(existing[0])}`, "=type=bypassed", `=comment=${comment || ""}`]);
      return rowId(existing[0]);
    }
    await api.write("/ip/hotspot/ip-binding/add",
      [`=mac-address=${mac}`, "=type=bypassed", `=comment=${comment || ""}`]);
    const rows = await api.write("/ip/hotspot/ip-binding/print", [`?mac-address=${mac}`]);
    return rowId(rows?.[0]);
  });
}

export async function removeBypass(mac) {
  return withConn(async (api) => {
    const rows = await api.write("/ip/hotspot/ip-binding/print", [`?mac-address=${mac}`]);
    for (const row of rows || []) {
      await api.write("/ip/hotspot/ip-binding/remove", [`=.id=${rowId(row)}`]);
    }
    return true;
  });
}

// RouterOS uptime like "1d2h3m4s" → seconds.
function parseRosUptime(str) {
  if (!str) return 0;
  let total = 0;
  const re = /(\d+)([wdhms])/g;
  const mult = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
  let m;
  while ((m = re.exec(str)) !== null) total += Number(m[1]) * (mult[m[2]] || 0);
  return total;
}

export const HOTSPOT_SERVER = CFG.server;