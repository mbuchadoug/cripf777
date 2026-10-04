// routes/zqIntelAdmin.js
// ─── /zq-admin/intel - view, export and share the business-intelligence reports ──
//
// Mount in server.js AFTER the session middleware (requireSupplierAdmin reads req.session):
//   import zqIntelAdminRoutes, { zqIntelShareRoutes } from "./routes/zqIntelAdmin.js";
//   app.use("/zq-admin", zqIntelAdminRoutes);
//   app.use("/zq-intel-share", zqIntelShareRoutes);
//
// Admin (login required):
//   GET  /zq-admin/intel                  latest full report
//   GET  /zq-admin/intel/memo             latest Claude memo as a clean web page
//   GET  /zq-admin/intel/runs             all runs
//   GET  /zq-admin/intel/r/:run           a run's full report
//   GET  /zq-admin/intel/r/:run/memo      a run's memo page
//   GET  /zq-admin/intel/r/:run/dl/:name  download, extension-less (memo-pdf, report-pdf, lapsed_buyers-csv...)
//                                         nginx serves *.pdf / *.csv URLs as static files and 404s them,
//                                         so every download link uses this form.
//   GET  /zq-admin/intel/log              output of the last background scan
//   GET  /zq-admin/intel/r/:run/targets   conversion-targets PDF for any time frame
//                                         ?from=YYYY-MM-DD&to=YYYY-MM-DD (either may be blank = open-ended)
//                                         &zero=1 include sellers with no activity, &view=1 open in browser
//   POST /zq-admin/intel/r/:run/pdf       (re)build memo.pdf + report.pdf for a run
//   POST /zq-admin/intel/run              start a scan (ai=1 memo, deep=1 Opus)
//
// Shareable (no login) - MEMO ONLY, never the report (the report has phone numbers).
// Lives on its own path so no /zq-admin auth guard can intercept it:
//   GET  /zq-intel-share/:run/:token          memo web page
//   GET  /zq-intel-share/:run/:token/pdf      memo PDF
//   Needs ZQ_INTEL_SHARE_SECRET (or SESSION_SECRET) in .env. Each link is tied to one run.
//
import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import os from "os";
import { requireSupplierAdmin } from "../middleware/supplierAdminAuth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const REPORTS = path.join(ROOT, "reports", "zq-intel");
const SCRIPT = path.join(ROOT, "scripts", "zqIntel.js");
const LOCK = path.join(REPORTS, ".running");
const RUN_LOG = path.join(REPORTS, "last-run.log");

const router = express.Router();
router.use("/intel", express.urlencoded({ extended: true }));
export const zqIntelShareRoutes = express.Router();

const RUN_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;
const FILE_RE = /^[a-z_]+\.(csv|json|md|html|pdf)$/;
const DL_RE = /^([a-z_]+)-(csv|json|md|pdf)$/;              // memo-pdf → memo.pdf
const HIDDEN = new Set(["report_data.json", "ai_payload.json"]);   // internal files, not listed
const SHARE_SECRET = process.env.ZQ_INTEL_SHARE_SECRET || process.env.SESSION_SECRET || "";

const runDir = (run) => path.join(REPORTS, run);
const listRuns = () => !fs.existsSync(REPORTS) ? [] : fs.readdirSync(REPORTS).filter(d => RUN_RE.test(d)).sort().reverse();
const isRunning = () => fs.existsSync(LOCK) && Date.now() - fs.statSync(LOCK).mtimeMs < 30 * 60 * 1000;
const shareToken = (run) => SHARE_SECRET ? crypto.createHmac("sha256", SHARE_SECRET).update(`zq-intel-memo:${run}`).digest("hex").slice(0, 32) : "";
const tokenOk = (run, t) => {
  const good = shareToken(run);
  return !!good && typeof t === "string" && t.length === good.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(good));
};

let _mod = null;
const intel = async () => (_mod = _mod || await import("../scripts/zqIntel.js"));

// Memo page, built from summary.json + ai_strategy.md (cached as memo.html)
async function memoHtml(run) {
  const dir = runDir(run), cached = path.join(dir, "memo.html");
  const md = path.join(dir, "ai_strategy.md");
  const full = path.join(dir, "report_data.json");
  const fresh = fs.existsSync(cached) && (!fs.existsSync(md) || fs.statSync(cached).mtimeMs >= fs.statSync(md).mtimeMs)
    && fs.readFileSync(cached, "utf8").includes("Part B. Data briefing");          // rebuild memos made by older versions
  if (fresh) return fs.readFileSync(cached, "utf8");
  const { renderMemoHtml } = await intel();
  const S = JSON.parse(fs.readFileSync(fs.existsSync(full) ? full : path.join(dir, "summary.json"), "utf8"));
  const html = renderMemoHtml(S, fs.existsSync(md) ? fs.readFileSync(md, "utf8") : null);
  fs.writeFileSync(cached, html, "utf8");
  return html;
}

const toolbar = (req, run) => {
  const dir = run ? runDir(run) : null;
  const files = dir && fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => FILE_RE.test(f) && !/\.(html|pdf)$/.test(f) && !HIDDEN.has(f)).sort() : [];
  const has = (f) => dir && fs.existsSync(path.join(dir, f));
  const dl = (f) => `/zq-admin/intel/r/${run}/dl/${f.replace(".", "-")}`;
  const hasMemo = dir && fs.existsSync(path.join(dir, "ai_strategy.md"));
  const share = run && SHARE_SECRET ? `${req.protocol}://${req.get("host")}/zq-intel-share/${run}/${shareToken(run)}` : "";
  const btn = 'style="font:inherit;padding:4px 10px;cursor:pointer"';
  return `<div style="font:14px system-ui,sans-serif;padding:10px 20px;border-bottom:1px solid #ccc;display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;background:#fff;color:#0f2a24">
  <a href="/zq-admin">ZimQuote admin</a><a href="/zq-admin/intel/runs">All runs</a>
  ${run ? `<a href="/zq-admin/intel/r/${run}">Full report</a>` : ""}
  ${run ? `<a href="/zq-admin/intel/r/${run}/memo">${hasMemo ? "Strategy memo" : "Data briefing"}</a>` : ""}
  ${run && has("memo.pdf") ? `<strong><a href="${dl("memo.pdf")}">Download memo PDF</a></strong> <a href="${dl("memo.pdf")}?view=1" target="_blank">(view)</a>` : ""}
  ${run && has("report.pdf") ? `<strong><a href="${dl("report.pdf")}">Download full report PDF</a></strong> <a href="${dl("report.pdf")}?view=1" target="_blank">(view)</a>` : ""}
  ${run && has("report_data.json") ? `<a href="/zq-admin/intel/r/${run}/targets?from=&to=">Targets PDF (all time)</a>` : ""}
  ${run ? `<form method="post" action="/zq-admin/intel/r/${run}/pdf" style="display:inline"><button ${btn}>${has("memo.pdf") || has("report.pdf") ? "Rebuild PDFs" : "Make PDFs"}</button></form>` : ""}
  ${files.length ? `<details style="display:inline-block"><summary style="cursor:pointer">Data files (${files.length})</summary>${files.map(f => `<a href="${dl(f)}" style="margin-right:10px">${f}</a>`).join("")}</details>` : ""}
  <form method="post" action="/zq-admin/intel/run" style="display:inline"><button ${btn}>Run new scan</button></form>
  <form method="post" action="/zq-admin/intel/run" style="display:inline"><input type="hidden" name="ai" value="1"><button ${btn}>Scan + Claude memo</button></form>
  <form method="post" action="/zq-admin/intel/run" style="display:inline"><input type="hidden" name="ai" value="1"><input type="hidden" name="deep" value="1"><button ${btn}>Deep memo (Opus)</button></form>
  ${isRunning() ? "<strong>A scan is running - refresh in a few minutes.</strong>" : ""}
  ${fs.existsSync(RUN_LOG) ? `<a href="/zq-admin/intel/log">Last scan log</a>` : ""}
  ${share ? `<span>Share memo: <input readonly value="${share}" onclick="this.select()" style="width:22em;font:12px monospace"> <a href="https://wa.me/?text=${encodeURIComponent("ZimQuote strategy memo: " + share)}">send on WhatsApp</a></span>` : ""}
</div>`;
};

const withToolbar = (req, run, html) => html.replace(/<body([^>]*)>/, `<body$1>${toolbar(req, run)}`);
const page = (req, run, body) => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${toolbar(req, run)}<div style="font:15px system-ui;padding:20px">${body}</div>`;
const validRun = (run) => RUN_RE.test(run || "") && fs.existsSync(runDir(run));

// ── Admin pages ──────────────────────────────────────────────────────────────
router.get("/intel", requireSupplierAdmin, (req, res) => {
  const run = listRuns()[0];
  if (!run) return res.type("html").send(page(req, null, "No scans yet. Start one above."));
  const f = path.join(runDir(run), "report.html");
  res.type("html").send(fs.existsSync(f) ? withToolbar(req, run, fs.readFileSync(f, "utf8")) : page(req, run, "Report not ready."));
});

router.get("/intel/memo", requireSupplierAdmin, (req, res) => {
  const run = listRuns().find(r => fs.existsSync(path.join(runDir(r), "ai_strategy.md")));
  if (!run) return res.type("html").send(page(req, listRuns()[0], "No Claude memo yet. Click \"Scan + Claude memo\" above."));
  res.redirect(`/zq-admin/intel/r/${run}/memo`);
});

router.get("/intel/runs", requireSupplierAdmin, (req, res) => {
  const runs = listRuns();
  res.type("html").send(page(req, runs[0], `<ul>${runs.map(r => {
    const memo = fs.existsSync(path.join(runDir(r), "ai_strategy.md"));
    return `<li><a href="/zq-admin/intel/r/${r}">${r}</a>${memo ? ` · <a href="/zq-admin/intel/r/${r}/memo">memo</a>` : ""}</li>`;
  }).join("") || "<li>No runs yet</li>"}</ul>`));
});

router.get("/intel/r/:run", requireSupplierAdmin, (req, res) => {
  const { run } = req.params; if (!validRun(run)) return res.status(404).send("Run not found.");
  const f = path.join(runDir(run), "report.html");
  if (!fs.existsSync(f)) return res.status(404).send("Report not found.");
  res.type("html").send(withToolbar(req, run, fs.readFileSync(f, "utf8")));
});

router.get("/intel/r/:run/memo", requireSupplierAdmin, async (req, res) => {
  const { run } = req.params; if (!validRun(run)) return res.status(404).send("Run not found.");
  try { res.type("html").send(withToolbar(req, run, await memoHtml(run))); }
  catch (e) { res.status(500).send("Could not build memo: " + e.message); }
});

router.post("/intel/r/:run/pdf", requireSupplierAdmin, async (req, res) => {
  const { run } = req.params; if (!validRun(run)) return res.status(404).send("Run not found.");
  try {
    const { buildPdfs } = await intel();
    const { made, errors, detailed } = await buildPdfs(runDir(run));
    const esc = (t) => String(t).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    res.type("html").send(page(req, run, `
      ${made.length ? `<p>Built: ${made.map(f => `<a href="/zq-admin/intel/r/${run}/dl/${f.replace(".", "-")}"><strong>${f}</strong></a>`).join(" and ")}.</p>` : ""}
      ${errors.length ? `<p style="color:#b23a2b">Problems:<br>${errors.map(esc).join("<br>")}</p>` : ""}
      ${detailed ? "" : "<p>This is an older run, so the PDFs only contain the summary. Click <em>Run new scan</em>, then rebuild, to get every seller, school and buyer row.</p>"}`));
  } catch (e) { res.status(500).send("PDF build failed: " + e.message); }
});

function sendFileOut(req, res, run, file) {
  const p = path.join(runDir(run), file);
  if (!fs.existsSync(p)) return res.status(404).send(`${file} has not been made for this run yet. Use "Make PDFs" / "Rebuild PDFs".`);
  res.set("Cache-Control", "no-store");
  if (file.endsWith(".pdf") && req.query.view === "1") return res.type("application/pdf").set("Content-Disposition", `inline; filename="zq-${run}-${file}"`).sendFile(p);
  res.download(p, `zq-${run}-${file}`);
}

router.get("/intel/r/:run/dl/:name", requireSupplierAdmin, (req, res) => {
  const { run, name } = req.params; const m = (name || "").match(DL_RE);
  if (!validRun(run) || !m) return res.status(400).send("Bad path.");
  sendFileOut(req, res, run, `${m[1]}.${m[2]}`);
});

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
router.get("/intel/r/:run/targets", requireSupplierAdmin, async (req, res) => {
  const { run } = req.params; if (!validRun(run)) return res.status(404).send("Run not found.");
  const dataFile = path.join(runDir(run), "report_data.json");
  if (!fs.existsSync(dataFile)) return res.type("html").send(page(req, run, "This run was made before time-frame filtering existed. Click <em>Run new scan</em> and use the new run."));
  const from = ISO_RE.test(req.query.from || "") ? req.query.from : "";
  const to = ISO_RE.test(req.query.to || "") ? req.query.to : "";
  try {
    const { renderTargetsHtml, renderPdf } = await intel();
    const S = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    if (!S.timeline) return res.type("html").send(page(req, run, "This run has no timeline data. Click <em>Run new scan</em>."));
    const html = renderTargetsHtml(S, from, to, { includeZero: req.query.zero === "1" });
    if (req.query.format === "html") return res.type("html").send(html);
    const tmp = path.join(os.tmpdir(), `zq-targets-${run}-${Date.now()}.pdf`);
    await renderPdf(html, tmp, { landscape: true });
    const name = `zq-conversion-targets-${from || "start"}-to-${to || "today"}.pdf`;
    res.set("Cache-Control", "no-store");
    const done = () => fs.unlink(tmp, () => {});
    if (req.query.view === "1") { res.type("application/pdf").set("Content-Disposition", `inline; filename="${name}"`); return res.sendFile(tmp, done); }
    res.download(tmp, name, done);
  } catch (e) { res.status(500).type("html").send(page(req, run, `Could not build the PDF: ${String(e.message).replace(/</g, "&lt;")}`)); }
});

router.get("/intel/log", requireSupplierAdmin, (req, res) => {
  const t = fs.existsSync(RUN_LOG) ? fs.readFileSync(RUN_LOG, "utf8") : "No scan has been started from this page yet.";
  res.type("text/plain").send(t.slice(-60000));
});

router.get("/intel/r/:run/:file", requireSupplierAdmin, (req, res) => {
  const { run, file } = req.params;
  if (!validRun(run) || !FILE_RE.test(file)) return res.status(400).send("Bad path.");
  sendFileOut(req, res, run, file);
});

router.post("/intel/run", requireSupplierAdmin, (req, res) => {
  if (isRunning()) return res.redirect("/zq-admin/intel");
  fs.mkdirSync(REPORTS, { recursive: true });
  fs.writeFileSync(LOCK, String(Date.now()));
  const args = [SCRIPT];
  if (req.body?.ai === "1") args.push("--ai");
  if (req.body?.deep === "1") args.push("--model", process.env.ZQ_INTEL_DEEP_MODEL || "claude-opus-5-5");
  const out = fs.openSync(RUN_LOG, "w");
  fs.writeSync(out, `Started ${new Date().toISOString()}: node ${args.map(a => path.basename(a)).join(" ")}\n\n`);
  const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env, stdio: ["ignore", out, out] });
  child.on("error", (e) => { try { fs.appendFileSync(RUN_LOG, `\nCould not start: ${e.message}\n`); fs.unlinkSync(LOCK); } catch {} });
  child.on("exit", (code) => {
    try { fs.appendFileSync(RUN_LOG, `\nFinished ${new Date().toISOString()} with exit code ${code}\n`); } catch {}
    try { fs.closeSync(out); } catch {}
    try { fs.unlinkSync(LOCK); } catch {}
  });
  res.redirect("/zq-admin/intel");
});

// ── Shareable memo (no login, memo only) ─────────────────────────────────────
zqIntelShareRoutes.get("/:run/:token", async (req, res) => {
  const { run, token } = req.params;
  if (!validRun(run) || !tokenOk(run, token)) return res.status(404).send("Not found.");
  res.set("X-Robots-Tag", "noindex, nofollow").set("Referrer-Policy", "no-referrer");
  const html = await memoHtml(run);
  const bar = `<div style="font:14px system-ui;padding:10px 20px;border-bottom:1px solid #ccc;background:#fff"><a href="/zq-intel-share/${run}/${token}/pdf">Download PDF</a></div>`;
  res.type("html").send(html.replace(/<body([^>]*)>/, `<body$1>${bar}`));
});

zqIntelShareRoutes.get("/:run/:token/pdf", async (req, res) => {
  const { run, token } = req.params;
  if (!validRun(run) || !tokenOk(run, token)) return res.status(404).send("Not found.");
  const p = path.join(runDir(run), "memo.pdf");
  if (!fs.existsSync(p)) {
    try { await memoHtml(run); const { buildPdfs } = await intel(); await buildPdfs(runDir(run), { report: false }); } catch {}
  }
  if (!fs.existsSync(p)) return res.status(404).send("PDF not available.");
  res.set("X-Robots-Tag", "noindex, nofollow").type("pdf").sendFile(p);
});

export default router;