// server.js — CRIPFCnt (local-friendly, render-wrapper + optional features)
// Based on your working v5 server but safer: fixes express-handlebars render crash.

import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { engine } from "express-handlebars";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// --------------------
// Simple per-request render wrapper
// (ensures render errors call the real next(err), avoiding `req.next is not a function`)
// --------------------
app.use((req, res, next) => {
  // defensive: if some middleware expects req.next, provide it (but prefer real next)
  if (typeof req.next !== "function") req.next = next;

  // keep original render
  const origRender = res.render && res.render.bind(res);

  res.render = function patchedRender(view, opts, cb) {
    try {
      if (typeof opts === "function") {
        cb = opts;
        opts = undefined;
      }

      if (!origRender) {
        const err = new Error("res.render not available");
        return next(err);
      }

      return origRender(view, opts, function renderCallback(err, html) {
        if (err) {
          // IMPORTANT: call the real next (closed over)
          return next(err);
        }
        if (typeof cb === "function") return cb(null, html);
        if (!res.headersSent) return res.send(html);
      });
    } catch (err) {
      // fallback
      console.error("patchedRender error:", err && err.stack ? err.stack : err);
      return next(err);
    }
  };

  next();
});

// --------------------
// Handlebars setup
// --------------------
app.engine("hbs", engine({ extname: ".hbs" }));
app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "views"));

// --------------------
// OpenAI client (optional — keep if you use chat-stream endpoint)
// --------------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

// --------------------
// Simple helper to ensure data dir exists (used by your audits if needed)
// --------------------
const dataPath = path.join(process.cwd(), "data", "scoi.json");
if (!fs.existsSync(path.dirname(dataPath))) fs.mkdirSync(path.dirname(dataPath), { recursive: true });

// --------------------
// Simple routes (kept like your working v5 server)
// --------------------
app.get("/", (req, res) => {
  // try website/index first, fall back to landing or static public/index.html
  try {
    const candidates = [
      path.join(app.get("views"), "website", "index.hbs"),
      path.join(app.get("views"), "landing.hbs"),
      path.join(app.get("views"), "index.hbs"),
      path.join(__dirname, "public", "index.html"),
    ];
    const found = candidates.find(p => fs.existsSync(p));
    if (!found) {
      return res.status(200).send(`<h3>No homepage template found</h3>
        <p>Create views/website/index.hbs or public/index.html</p>`);
    }
    if (found.endsWith("public/index.html")) return res.sendFile(found);
    // compute relative view name (e.g. website/index)
    const rel = path.relative(app.get("views"), found).replace(/\.hbs$/, "").split(path.sep).join("/");
    return res.render(rel, {});
  } catch (err) {
    console.error("GET / render error:", err && err.stack ? err.stack : err);
    return res.status(500).send("Server error rendering homepage");
  }
});

app.get("/about", (req, res) => res.render("website/about"));
app.get("/services", (req, res) => res.render("website/services"));
app.get("/contact", (req, res) => res.render("website/contact"));

app.get("/audit", (req, res) => {
  return res.render("chat", {
    title: "CRIPFCnt SCOI Audit",
    message: "Enter an organization or entity name to perform a live CRIPFCnt audit.",
  });
});

// --------------------
// SSE chat-stream (kept from your v5)
// --------------------
app.post("/api/chat-stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const keepAlive = setInterval(() => {
    try { res.write(":\n\n"); } catch (e) {}
  }, 15000);

  try {
    const { entity } = req.body;
    if (!entity) {
      res.write("data: ❌ Missing entity name.\n\n");
      clearInterval(keepAlive);
      return res.end();
    }

    const systemPrompt = `
You are the CRIPFCnt Audit Intelligence — trained under Donald Mataranyika’s model.
Return a single, structured SCOI audit for the entity provided.
`;
    if (!openai || !openai.chat) {
      res.write("data: ❌ OpenAI not configured.\n\n");
      clearInterval(keepAlive);
      return res.end();
    }

    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Perform a full SCOI Audit for: "${entity}".` }
      ]
    });

    for await (const chunk of stream) {
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) res.write(`data: ${String(content).replace(/\r/g, "")}\n\n`);
    }
  } catch (err) {
    console.error("chat-stream error:", err && err.stack ? err.stack : err);
    res.write(`data: ❌ Server error: ${String(err).replace(/\r?\n/g, " ")}\n\n`);
  } finally {
    clearInterval(keepAlive);
    res.write("data: [DONE]\n\n");
    res.end();
  }
});

// --------------------
// Sample audits JSON endpoint (kept as before)
// --------------------
app.get("/api/audits", (req, res) => {
  return res.json({
    framework: "CRIPFCnt SCOI Audit System",
    author: "Donald Mataranyika",
    data: []
  });
});

// --------------------
// Catch-all error handler
// --------------------
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500);
  if (req.headers.accept && req.headers.accept.indexOf("text/html") !== -1) {
    return res.send("<h1>Server error</h1><p>Check logs</p>");
  }
  return res.json({ error: "Server error" });
});

// --------------------
// Start server
// --------------------
const PORT = process.env.PORT || 9000;
app.listen(PORT, "127.0.0.1", () => console.log(`🚀 Server running on http://127.0.0.1:${PORT}`));
