// ==============================
// 🛡️ SOCKET-ERROR GUARD (optional but recommended)
//
// node-routeros can throw on raw socket events (RouterOS version quirks).
// Those escape normal try/catch and would kill the whole process. The patch
// script fixes the known cases; this guard is a final safety net so that ANY
// stray node-routeros socket error is logged and swallowed instead of taking
// down cripfcnt.com. It ONLY swallows errors that clearly come from
// node-routeros - everything else still crashes loudly, as it should.
//
// Wire it in at the VERY TOP of server.js (first import), before anything else:
//     import "./hotspot/guard.js";
// ==============================

function looksLikeRouterOsError(err) {
  const s = String(err?.stack || err?.message || err || "");
  return (
    s.includes("node-routeros") ||
    err?.errno === "UNKNOWNREPLY" ||
    err?.errno === "UNREGISTEREDTAG" ||
    err?.name === "RosException"
  );
}

process.on("uncaughtException", (err) => {
  if (looksLikeRouterOsError(err)) {
    console.error("[hotspot guard] swallowed node-routeros socket error:", err?.message || err);
    return; // keep the app alive; the sync loop retries next tick
  }
  // Not ours - preserve normal fatal behaviour.
  console.error("[uncaughtException]", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  if (looksLikeRouterOsError(reason)) {
    console.error("[hotspot guard] swallowed node-routeros rejection:", reason?.message || reason);
    return;
  }
  console.error("[unhandledRejection]", reason);
});