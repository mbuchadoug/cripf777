// routes/audienceAdmin.js
// ─── Admin: interest groups (audiences) + the Broadcast Hub "🎯 Interest groups" mode
//
// Wired at the bottom of routes/supplierAdmin.js:
//   registerAudienceAdminRoutes(router, { requireSupplierAdmin, layout, esc });
//
//   /zq-admin/audiences                 Groups with sizes (all-time / last 30 days /
//                                       buyers only), "📣 Broadcast" and "⬇ CSV" per
//                                       group, rebuild, Claude classification, the
//                                       searches nobody could place (set them by hand),
//                                       and a phone lookup ("what is this person into?").
//   /zq-admin/audiences/segments.json   Group list + counts for the Broadcast Hub panel
//   /zq-admin/audiences/count           Live audience size for the chosen filters
//   /zq-admin/audiences/broadcast-panel.js   The panel shown in Broadcast Hub Step 1
// ─────────────────────────────────────────────────────────────────────────────

import {
  AudienceMember, AudienceMeta, SearchTextClass, getSegments, segmentOverview, countSegment,
  resolveSegmentPhones, rebuildAudiences, classifyWithClaude, setTextClass, aiReady, isBuilding,
  startAudienceAutoBuild, normText
} from "../services/audienceSegments.js";

const CSS = `<style>
.au-wrap{max-width:1150px}
.au-card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin-bottom:16px}
.au-card h3{font-size:15px;margin-bottom:10px}
.au-t{width:100%;border-collapse:collapse;font-size:13px}
.au-t th{text-align:left;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0;padding:7px 6px}
.au-t td{border-bottom:1px solid #f1f5f9;padding:7px 6px;vertical-align:middle}
.au-btn{display:inline-block;border:0;border-radius:8px;padding:7px 12px;font-weight:600;cursor:pointer;background:#0d9488;color:#fff;text-decoration:none;font-size:12px}
.au-btn.gray{background:#e2e8f0;color:#1e293b}.au-btn.purple{background:#7c3aed}
.au-muted{color:#64748b;font-size:12px}
.au-flash{padding:10px 14px;border-radius:10px;margin-bottom:14px;font-weight:600}
.au-flash.ok{background:#dcfce7;color:#166534}.au-flash.err{background:#fee2e2;color:#991b1b}
.au-bar{height:8px;background:#e2e8f0;border-radius:6px;overflow:hidden;min-width:80px}.au-bar i{display:block;height:100%;background:#0d9488}
.au-pill{display:inline-block;padding:1px 8px;border-radius:999px;background:#f1f5f9;font-size:11px;margin:1px}
.au-in{padding:7px 9px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;font-size:13px}
</style>`;

const when = d => d ? new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Harare" }) : "never";
const _p = (p) => { let d = String(p || "").replace(/\D+/g, ""); if (d.startsWith("0") && d.length === 10) d = "263" + d.slice(1); return d; };
const _opts = (q) => ({
  segments: String(q.segments || q.seg || ""),
  days: parseInt(q.segDays ?? q.days, 10) || 0,
  minHits: parseInt(q.segMin, 10) || 1,
  city: String(q.segCity || "").trim(),
  excludeSellers: String(q.segExcludeSellers ?? "1") !== "0",
  match: q.segMatch === "all" ? "all" : "any"
});

export function registerAudienceAdminRoutes(router, { requireSupplierAdmin, layout, esc }) {
  startAudienceAutoBuild();

  // ── Overview page ──────────────────────────────────────────────────────────
  router.get("/audiences", requireSupplierAdmin, async (req, res) => {
    try {
      const [overview, meta, segs] = await Promise.all([segmentOverview({ days: 30 }), AudienceMeta.findById("main").lean(), getSegments()]);
      const [members, optOuts] = await Promise.all([AudienceMember.countDocuments({ optOut: { $ne: true } }), AudienceMember.countDocuments({ optOut: true })]);
      const max = Math.max(1, ...overview.map(o => o.total));
      const rows = overview.map(o => `<tr>
        <td><b>${esc(o.label)}</b>${o.kind === "behaviour" ? ` <span class="au-muted">· behaviour</span>` : ""}</td>
        <td style="width:28%"><div class="au-bar"><i style="width:${Math.round(o.total / max * 100)}%"></i></div></td>
        <td><b>${o.total}</b></td><td>${o.recent}</td><td>${o.buyers}</td>
        <td style="white-space:nowrap">
          <a class="au-btn" href="/zq-admin/broadcast?seg=${encodeURIComponent(o.id)}">📣 Broadcast</a>
          <a class="au-btn gray" href="/zq-admin/audiences/export?seg=${encodeURIComponent(o.id)}">⬇ CSV</a>
        </td></tr>`).join("");

      // Unclassified searches (top) with a quick "set group" form
      const segOpts = `<option value="">- leave -</option>` + segs.filter(s => s.kind === "interest").map(s => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join("") + `<option value="none">🚫 Not a search (ignore)</option>`;
      const unc = (meta?.unclassified || []).slice(0, 80);
      const uncRows = unc.map((u, i) => `<tr><td>${esc(u.sample || u.key)}</td><td>${u.n}</td>
        <td><input type="hidden" name="k${i}" value="${esc(u.key)}"><select class="au-in" name="s${i}">${segOpts}</select></td></tr>`).join("");

      const learned = await SearchTextClass.find({}).sort({ updatedAt: -1 }).limit(60).lean();
      const segName = id => (segs.find(s => s.id === id)?.label) || (id === "none" ? "🚫 ignored" : id);
      const learnedRows = learned.map(l => `<tr><td>${esc(l.key)}</td><td>${esc(segName(l.section))}</td><td class="au-muted">${l.by === "admin" ? "you" : "Claude"}</td>
        <td><form method="POST" action="/zq-admin/audiences/classify" style="display:inline"><input type="hidden" name="k0" value="${esc(l.key)}"><input type="hidden" name="s0" value="__forget"><button class="au-btn gray" title="Forget this answer">↺</button></form></td></tr>`).join("");

      // Phone lookup
      let lookup = "";
      if (req.query.phone) {
        const m = await AudienceMember.findOne({ phone: _p(req.query.phone) }).lean();
        lookup = m ? `<div style="margin-top:10px"><b>${esc(m.phone)}</b> ${m.optOut ? `<span class="au-pill" style="background:#fee2e2">unsubscribed</span>` : ""} ${m.isSeller ? `<span class="au-pill">seller</span>` : ""}
            <div class="au-muted">Searches: ${m.searches} · link opens: ${m.linkOpens} · city: ${esc(m.city || "-")} · last seen ${when(m.lastSeen)}</div>
            <div style="margin-top:6px">${(m.segs || []).sort((a, b) => b.n - a.n).map(s => `<span class="au-pill">${esc(segName(s.s))} ×${s.n}</span>`).join(" ")}</div>
            <div class="au-muted" style="margin-top:6px">Recent: ${(m.terms || []).map(esc).join(" · ") || "-"}</div>
            <form method="POST" action="/zq-admin/audiences/optout" style="margin-top:8px"><input type="hidden" name="phone" value="${esc(m.phone)}"><input type="hidden" name="on" value="${m.optOut ? "0" : "1"}"><button class="au-btn gray">${m.optOut ? "✅ Re-subscribe" : "🚫 Unsubscribe from broadcasts"}</button></form></div>`
          : `<div class="au-muted" style="margin-top:8px">No activity found for that number.</div>`;
      }

      const building = isBuilding() || meta?.building;
      res.send(layout("Audiences", `${CSS}<div class="au-wrap">
${req.query.ok ? `<div class="au-flash ok">✅ ${esc(req.query.ok)}</div>` : ""}${req.query.err ? `<div class="au-flash err">❌ ${esc(req.query.err)}</div>` : ""}
<div class="au-card">
  <h3>🎯 Interest groups <span class="au-muted">- built from searches, smart-link opens, quote requests and grocery orders</span></h3>
  <p class="au-muted" style="margin-bottom:10px">${members} people in groups · ${optOuts} unsubscribed (never messaged) ·
    last built <b>${when(meta?.lastBuiltAt)}</b>${meta?.buildMs ? ` in ${Math.round(meta.buildMs / 1000)}s` : ""} · rebuilds automatically every 6 hours.
    ${building ? "<b style='color:#c2410c'>⏳ Rebuilding now - refresh in a minute.</b>" : ""}</p>
  <form method="POST" action="/zq-admin/audiences/rebuild" style="display:inline"><button class="au-btn" ${building ? "disabled" : ""}>🔄 Rebuild now</button></form>
  <form method="POST" action="/zq-admin/audiences/classify-ai" style="display:inline" onsubmit="return confirm('Ask Claude to classify up to 300 of the most common unclassified searches?')">
    <button class="au-btn purple" ${aiReady() && !building ? "" : "disabled"}>🤖 Classify ${Math.min(300, meta?.stats?.unclassifiedTerms || 0)} searches with Claude</button></form>
  ${aiReady() ? "" : `<span class="au-muted"> (add ANTHROPIC_API_KEY to .env to enable)</span>`}
  ${meta?.lastAi ? `<div class="au-muted" style="margin-top:6px">Last Claude run ${when(meta.lastAi.at)}: ${meta.lastAi.classified} placed, ${meta.lastAi.none} ignored${meta.lastAi.errors ? `, ${meta.lastAi.errors} batch errors` : ""}.</div>` : ""}
  <div class="table-wrap" style="margin-top:12px"><table class="au-t"><tr><th>Group</th><th></th><th>People</th><th>Active 30 days</th><th>Buyers only</th><th></th></tr>${rows}</table></div>
  <p class="au-muted" style="margin-top:8px">A person can be in several groups. "Buyers only" leaves out registered sellers. People who reply <b>UNSUBSCRIBE</b> are removed from every broadcast automatically.</p>
</div>

<div class="au-card">
  <h3>🔎 What is this person interested in?</h3>
  <form method="GET" action="/zq-admin/audiences"><input class="au-in" name="phone" placeholder="0771234567" value="${esc(req.query.phone || "")}"> <button class="au-btn gray">Look up</button></form>
  ${lookup}
</div>

<div class="au-card">
  <h3>❓ Searches nobody could place yet <span class="au-muted">(${meta?.stats?.unclassifiedTerms || 0} different texts)</span></h3>
  <p class="au-muted" style="margin-bottom:8px">Pick a group for the common ones (or let Claude do it). Your choice is remembered and wins over the rules and over Claude.</p>
  ${unc.length ? `<form method="POST" action="/zq-admin/audiences/classify"><div class="table-wrap"><table class="au-t"><tr><th>Search</th><th>Times</th><th>Group</th></tr>${uncRows}</table></div>
    <button class="au-btn" style="margin-top:10px">💾 Save & rebuild</button></form>` : `<p class="au-muted">Nothing waiting. 🎉</p>`}
</div>

<details class="au-card"><summary><b>🧠 Learned answers</b> <span class="au-muted">(last 60 - from you and Claude)</span></summary>
  <div class="table-wrap" style="margin-top:10px"><table class="au-t"><tr><th>Search</th><th>Group</th><th>By</th><th></th></tr>${learnedRows || `<tr><td class="au-muted" colspan="4">None yet.</td></tr>`}</table></div>
</details>
</div>`));
    } catch (e) {
      console.error("[AUDIENCES]", e);
      res.status(500).send(layout("Audiences", `<div class="au-flash err">${esc(e.message)}</div>`));
    }
  });

  router.post("/audiences/rebuild", requireSupplierAdmin, async (req, res) => {
    if (isBuilding()) return res.redirect("/zq-admin/audiences?err=" + encodeURIComponent("Already rebuilding"));
    rebuildAudiences({ reason: "admin" }).catch(e => console.error("[AUDIENCE] rebuild", e.message));
    res.redirect("/zq-admin/audiences?ok=" + encodeURIComponent("Rebuilding in the background - refresh in a minute."));
  });

  router.post("/audiences/classify-ai", requireSupplierAdmin, async (req, res) => {
    if (!aiReady()) return res.redirect("/zq-admin/audiences?err=" + encodeURIComponent("ANTHROPIC_API_KEY is not set"));
    if (isBuilding()) return res.redirect("/zq-admin/audiences?err=" + encodeURIComponent("Wait for the rebuild to finish"));
    classifyWithClaude({}).then(r => console.log("[AUDIENCE AI]", r)).catch(e => console.error("[AUDIENCE AI]", e.message));
    res.redirect("/zq-admin/audiences?ok=" + encodeURIComponent("Claude is classifying - the groups update in a minute or two."));
  });

  router.post("/audiences/classify", requireSupplierAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      let n = 0;
      for (let i = 0; i < 200; i++) {
        const k = b[`k${i}`]; if (k === undefined) break;
        const s = String(b[`s${i}`] || "");
        if (!s) continue;
        await setTextClass(k, s === "__forget" ? "" : s); n++;
      }
      if (n && !isBuilding()) rebuildAudiences({ reason: "admin classify" }).catch(() => {});
      res.redirect("/zq-admin/audiences?ok=" + encodeURIComponent(n ? `Saved ${n} - groups are updating.` : "Nothing changed."));
    } catch (e) { res.redirect("/zq-admin/audiences?err=" + encodeURIComponent(e.message)); }
  });

  router.post("/audiences/optout", requireSupplierAdmin, async (req, res) => {
    const phone = _p(req.body?.phone), on = req.body?.on === "1";
    if (phone) await AudienceMember.updateOne({ phone }, { $set: { phone, optOut: on, ...(on ? { optOutAt: new Date() } : {}) } }, { upsert: true });
    res.redirect(`/zq-admin/audiences?phone=${encodeURIComponent(phone)}&ok=${encodeURIComponent(on ? "Unsubscribed" : "Re-subscribed")}`);
  });

  router.get("/audiences/export", requireSupplierAdmin, async (req, res) => {
    try {
      const { phones, label } = await resolveSegmentPhones({ ..._opts(req.query), excludeSellers: req.query.segExcludeSellers === "1" });
      const rows = await AudienceMember.find({ phone: { $in: phones } }).lean();
      const csv = "phone,city,searches,link_opens,last_seen,groups,recent_searches\n" + rows.map(m =>
        [m.phone, m.city || "", m.searches, m.linkOpens, m.lastSeen ? new Date(m.lastSeen).toISOString().slice(0, 10) : "",
          (m.segs || []).map(s => `${s.s}:${s.n}`).join(" "), (m.terms || []).join(" | ")]
          .map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="zimquote-audience-${String(req.query.seg || "custom").replace(/[^a-z0-9_-]/gi, "")}.csv"`);
      res.send(csv);
      void label;
    } catch (e) { res.status(500).send(e.message); }
  });

  // ── JSON for the Broadcast Hub panel ───────────────────────────────────────
  router.get("/audiences/segments.json", requireSupplierAdmin, async (req, res) => {
    try {
      const [overview, meta] = await Promise.all([segmentOverview({ days: 30 }), AudienceMeta.findById("main").lean()]);
      res.json({ ok: true, segments: overview, lastBuiltAt: meta?.lastBuiltAt || null, building: isBuilding() });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  router.get("/audiences/count", requireSupplierAdmin, async (req, res) => {
    try { res.json({ ok: true, count: await countSegment(_opts(req.query)) }); }
    catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  // ── The "🎯 Interest groups" panel injected into Broadcast Hub Step 1 ─────
  router.get("/audiences/broadcast-panel.js", requireSupplierAdmin, (req, res) => {
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(PANEL_JS);
  });
}

// Plain ES5 (no template literals) so it can never clash with the page's own script.
const PANEL_JS = String.raw`(function(){
  var panel = document.getElementById("segmentPanel");
  if (!panel) return;
  function esc(s){ return String(s == null ? "" : s).replace(/[&<>"]/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]; }); }
  var pre = (new URLSearchParams(location.search)).get("seg");
  panel.innerHTML =
    '<p style="font-size:12px;color:var(--muted);margin-bottom:10px">Send only to people who showed interest - from what they <b>searched</b>, the <b>smart links</b> they opened, <b>quotes</b> they asked for and <b>grocery orders</b>. Tick one or more groups. <a href="/zq-admin/audiences" target="_blank">Manage groups</a></p>' +
    '<div id="segGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:6px;margin-bottom:12px"><span style="color:var(--muted);font-size:12px">Loading groups…</span></div>' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:10px">' +
      '<div><label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">Interest shown in the last</label><select name="segDays" id="segDays" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;font-size:13px"><option value="0">Any time</option><option value="7">7 days</option><option value="30">30 days</option><option value="90" selected>90 days</option><option value="180">6 months</option><option value="365">1 year</option></select></div>' +
      '<div><label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">How keen</label><select name="segMin" id="segMin" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;font-size:13px"><option value="1">Once or more</option><option value="2">2+ times</option><option value="3">3+ times (hot)</option></select></div>' +
      '<div><label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">City (optional)</label><input name="segCity" id="segCity" placeholder="e.g. Harare" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;font-size:13px"></div>' +
      '<div><label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">Several groups ticked</label><select name="segMatch" id="segMatch" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;font-size:13px"><option value="any">In ANY of them</option><option value="all">In ALL of them</option></select></div>' +
    '</div>' +
    '<label style="font-size:13px;display:flex;align-items:center;gap:6px;margin-bottom:10px"><input type="checkbox" id="segExcl" checked> Buyers only (leave out registered sellers)</label>' +
    '<input type="hidden" name="segExcludeSellers" id="segExcludeSellers" value="1"><input type="hidden" name="segments" id="segments" value="">' +
    '<div id="segCount" style="background:#f0fdfa;border:1px solid #99f6e4;border-radius:8px;padding:10px 12px;font-size:13px;font-weight:700;color:#0f766e">Tick a group to see how many people it reaches.</div>';

  var grid = document.getElementById("segGrid");
  var t = null;
  function picked(){ var a = []; grid.querySelectorAll("input[type=checkbox]:checked").forEach(function(c){ a.push(c.value); }); return a; }
  function sync(){
    document.getElementById("segments").value = picked().join(",");
    document.getElementById("segExcludeSellers").value = document.getElementById("segExcl").checked ? "1" : "0";
    clearTimeout(t); t = setTimeout(count, 250);
  }
  function params(){
    return { segments: document.getElementById("segments").value, segDays: document.getElementById("segDays").value,
      segMin: document.getElementById("segMin").value, segCity: document.getElementById("segCity").value,
      segMatch: document.getElementById("segMatch").value, segExcludeSellers: document.getElementById("segExcludeSellers").value };
  }
  function count(){
    var box = document.getElementById("segCount"), p = params();
    if (!p.segments) { box.textContent = "Tick a group to see how many people it reaches."; return; }
    box.textContent = "Counting…";
    fetch("/zq-admin/audiences/count?" + new URLSearchParams(p)).then(function(r){ return r.json(); }).then(function(d){
      box.innerHTML = d.ok ? ("🎯 <b>" + d.count + "</b> people will receive this broadcast" + (d.count ? "" : " - try a longer time range or untick Buyers only")) : ("⚠️ " + esc(d.error));
    }).catch(function(e){ box.textContent = "⚠️ " + e.message; });
  }
  panel.addEventListener("change", sync);
  panel.addEventListener("input", function(e){ if (e.target && e.target.id === "segCity") sync(); });

  fetch("/zq-admin/audiences/segments.json").then(function(r){ return r.json(); }).then(function(d){
    if (!d.ok) throw new Error(d.error || "failed");
    grid.innerHTML = d.segments.map(function(s){
      return '<label style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;cursor:pointer;font-size:13px;background:#fff">' +
        '<input type="checkbox" value="' + esc(s.id) + '"' + (s.id === pre ? " checked" : "") + '> <span style="flex:1">' + esc(s.label) + '</span>' +
        '<span style="font-size:11px;color:var(--muted)" title="all-time / active in 30 days">' + s.total + ' · ' + s.recent + '</span></label>';
    }).join("") + (d.lastBuiltAt ? "" : '<div style="font-size:12px;color:#c2410c">Groups not built yet - open <a href="/zq-admin/audiences">Audiences</a> and press Rebuild.</div>');
    sync();
  }).catch(function(e){ grid.innerHTML = '<span style="color:#dc2626;font-size:12px">Could not load groups: ' + esc(e.message) + '</span>'; });

  // Batch Sender support: createBatchJob() calls this to add the group fields
  window.zqSegParams = function(p){ var x = params(); for (var k in x) p.set(k, x[k]); };

  function preselect(){
    if (!pre || typeof window.setAudienceMode !== "function") return;
    window.setAudienceMode("segment");
    setTimeout(function(){ var el = document.getElementById("segmentPanel"); if (el && el.scrollIntoView) el.scrollIntoView({ block: "center" }); }, 300);
  }
  if (document.readyState === "complete") preselect(); else window.addEventListener("load", preselect);
})();`;

export default registerAudienceAdminRoutes;
