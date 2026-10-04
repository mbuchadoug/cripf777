// routes/zqIntelAdmin.js
// ─── /zq-admin/intel - view and run the business-intelligence scanner ───────
//
// Mount in server.js next to the other /zq-admin routers:
//   import zqIntelAdminRoutes from "./routes/zqIntelAdmin.js";
//   app.use("/zq-admin", zqIntelAdminRoutes);
//
// GET  /zq-admin/intel                 latest report (or a "run first" page)
// GET  /zq-admin/intel/runs            list of past runs
// GET  /zq-admin/intel/r/:run          a specific run's report
// GET  /zq-admin/intel/r/:run/:file    download a CSV / JSON / memo from a run
// POST /zq-admin/intel/run             start a scan in the background (ai=1 adds the Claude memo)
//
import express from "express";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { requireSupplierAdmin } from "../middleware/supplierAdminAuth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const REPORTS = path.join(ROOT, "reports", "zq-intel");
const SCRIPT = path.join(ROOT, "scripts", "zqIntel.js");
const LOCK = path.join(REPORTS, ".running");

const router = express.Router();
router.use(express.urlencoded({ extended: true }));

const RUN_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;
const FILE_RE = /^[a-z_]+\.(csv|json|md|html)$/;

const listRuns = () => {
  if (!fs.existsSync(REPORTS)) return [];
  return fs.readdirSync(REPORTS).filter(d => RUN_RE.test(d)).sort().reverse();
};
const isRunning = () => {
  if (!fs.existsSync(LOCK)) return false;
  // stale lock after 20 minutes
  return Date.now() - fs.statSync(LOCK).mtimeMs < 20 * 60 * 1000;
};

const toolbar = (run) => {
  const files = run && fs.existsSync(path.join(REPORTS, run))
    ? fs.readdirSync(path.join(REPORTS, run)).filter(f => FILE_RE.test(f) && f !== "report.html") : [];
  return `<div style="font:14px system-ui,sans-serif;padding:10px 20px;border-bottom:1px solid #ccc;display:flex;flex-wrap:wrap;gap:10px;align-items:center;background:#fff;color:#0f2a24">
  <a href="/zq-admin">ZimQuote admin</a>
  <a href="/zq-admin/intel/runs">All runs</a>
  <form method="post" action="/zq-admin/intel/run" style="display:inline"><button>Run new scan</button></form>
  <form method="post" action="/zq-admin/intel/run" style="display:inline"><input type="hidden" name="ai" value="1"><button>Run scan + Claude memo</button></form>
  ${isRunning() ? "<strong>A scan is running - refresh in a minute.</strong>" : ""}
  ${files.map(f => `<a href="/zq-admin/intel/r/${run}/${f}">${f}</a>`).join("")}
</div>`;
};

function sendReport(res, run) {
  const file = path.join(REPORTS, run, "report.html");
  if (!fs.existsSync(file)) return res.status(404).send("Report not found.");
  const html = fs.readFileSync(file, "utf8").replace("<body>", `<body>${toolbar(run)}`);
  res.type("html").send(html);
}

router.get("/intel", requireSupplierAdmin, (req, res) => {
  const runs = listRuns();
  if (!runs.length) {
    return res.type("html").send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${toolbar(null)}
<p style="font:15px system-ui;padding:20px">No scans yet. Start one above - a full-history scan usually takes under a minute.</p>`);
  }
  sendReport(res, runs[0]);
});

router.get("/intel/runs", requireSupplierAdmin, (req, res) => {
  const runs = listRuns();
  res.type("html").send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${toolbar(runs[0])}
<ul style="font:15px system-ui;padding:20px 40px">${runs.map(r => `<li><a href="/zq-admin/intel/r/${r}">${r}</a>${fs.existsSync(path.join(REPORTS, r, "ai_strategy.md")) ? " (with Claude memo)" : ""}</li>`).join("") || "<li>No runs yet</li>"}</ul>`);
});

router.get("/intel/r/:run", requireSupplierAdmin, (req, res) => {
  if (!RUN_RE.test(req.params.run)) return res.status(400).send("Bad run id.");
  sendReport(res, req.params.run);
});

router.get("/intel/r/:run/:file", requireSupplierAdmin, (req, res) => {
  const { run, file } = req.params;
  if (!RUN_RE.test(run) || !FILE_RE.test(file)) return res.status(400).send("Bad path.");
  const p = path.join(REPORTS, run, file);
  if (!fs.existsSync(p)) return res.status(404).send("Not found.");
  res.download(p, `zq-${run}-${file}`);
});

router.post("/intel/run", requireSupplierAdmin, (req, res) => {
  if (isRunning()) return res.redirect("/zq-admin/intel");
  fs.mkdirSync(REPORTS, { recursive: true });
  fs.writeFileSync(LOCK, String(Date.now()));
  const args = [SCRIPT, "--quiet"];
  if (req.body?.ai === "1") args.push("--ai");
  const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  child.stderr.on("data", d => { err += d.toString().slice(0, 4000); });
  child.on("exit", (code) => {
    try { fs.unlinkSync(LOCK); } catch {}
    if (code !== 0) console.error("[zq-intel] scan exited", code, err);
  });
  res.redirect("/zq-admin/intel");
});

export default router;
