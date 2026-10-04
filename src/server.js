#!/usr/bin/env node
// npm start  ->  http://localhost:3000
// Zero-dependency server: static dashboard + a small JSON API over the pipeline.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { runPipeline, triageOne, loadFirm, ROOT } from "./pipeline.js";
import { parseEmail, loadCrm } from "./ingest.js";
import { hasApiKey, MODEL, redraftWithClaude, Anthropic } from "./llm.js";
import { checkDraft } from "./guardrails.js";
import { matchEmail } from "./match.js";
import { writeExports } from "./export.js";

const PORT = Number(process.env.PORT) || 3000;
const OUT = path.join(ROOT, "out");
const RUN_FILE = path.join(OUT, "run.json");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".md": "text/markdown; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml" };

const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve, reject) => {
  let data = "";
  req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
  req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
});
const engineFor = (requested) => (requested === "offline" || !hasApiKey() ? "offline" : "claude");

function save(run) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(RUN_FILE, JSON.stringify(run, null, 2));
  writeExports(run, OUT);
}

async function latestRun() {
  if (fs.existsSync(RUN_FILE)) return JSON.parse(fs.readFileSync(RUN_FILE, "utf8"));
  const run = await runPipeline({ engine: engineFor() });
  save(run);
  return run;
}

let running = null; // one batch at a time
const listeners = new Set(); // SSE clients watching the current batch
const broadcast = (event, data) => { for (const res of listeners) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

function startRun(engine) {
  // Keep emails that were pasted into the dashboard: they aren't in the folder.
  const pasted = fs.existsSync(RUN_FILE) ? JSON.parse(fs.readFileSync(RUN_FILE, "utf8")).items.filter((i) => i.id.startsWith("pasted_")).map((i) => i.email) : [];
  running ??= runPipeline({
    engine,
    extraEmails: pasted,
    onProgress: (n, total, r) => broadcast("progress", { n, total, id: r.id, who: r.match.client?.name || r.email.from_email, urgency: r.triage.urgency }),
  })
    .then((run) => { save(run); broadcast("done", { ok: true }); return run; })
    .catch((err) => { broadcast("failed", { error: err.status === 401 ? "Anthropic API key was rejected. Check ANTHROPIC_API_KEY in .env." : err.message }); throw err; })
    .finally(() => { running = null; });
  return running;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/status") {
      return json(res, 200, { has_key: hasApiKey(), model: MODEL, firm: loadFirm() });
    }
    if (url.pathname === "/api/run" && req.method === "GET") return json(res, 200, await latestRun());
    if (url.pathname === "/api/run" && req.method === "POST") {
      const body = await readBody(req);
      return json(res, 200, await startRun(engineFor(body.engine)));
    }
    if (url.pathname === "/api/run/stream") {
      // Live progress while the inbox is re-triaged: one event per email.
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      listeners.add(res);
      req.on("close", () => listeners.delete(res));
      startRun(engineFor(url.searchParams.get("engine"))).catch(() => {});
      return;
    }
    if (url.pathname === "/api/redraft" && req.method === "POST") {
      const body = await readBody(req);
      if (!hasApiKey()) return json(res, 400, { error: "Rewriting needs Claude. Add ANTHROPIC_API_KEY to .env." });
      const instruction = String(body.instruction || "").trim().slice(0, 500);
      if (!instruction) return json(res, 400, { error: "Say what to change." });
      const run = await latestRun();
      const item = run.items.find((i) => i.id === body.id);
      if (!item) return json(res, 404, { error: "That email isn't in the current run." });
      const firm = loadFirm();
      const crm = loadCrm(path.join(ROOT, "sample-data/crm_export.csv"));
      const match = matchEmail(item.email, crm);
      const { draft, cost_usd } = await redraftWithClaude({
        email: item.email, match, firm, asOf: run.as_of,
        draft: { subject: String(body.subject || ""), body: String(body.body || "") },
        instruction,
      });
      const checked = checkDraft(draft.body, { email: item.email, match, firm, extraSources: [instruction, String(body.body || "")] });
      return json(res, 200, { draft: { subject: draft.subject, body: checked.body }, flags: checked.flags, cost_usd });
    }
    if (url.pathname === "/api/triage" && req.method === "POST") {
      // Paste any raw email. It joins the current queue.
      const body = await readBody(req);
      if (!body.raw || body.raw.trim().length < 10) return json(res, 400, { error: "Paste a full email (From: line, blank line, body)." });
      const run = await latestRun();
      const email = parseEmail(body.raw.trim(), `pasted_${Date.now().toString(36)}`);
      if (!email.from_email) return json(res, 400, { error: "Couldn't find a sender. Start with a line like: From: Name <name@example.com>" });
      const item = await triageOne(email, {
        crm: loadCrm(path.join(ROOT, "sample-data/crm_export.csv")),
        firm: loadFirm(),
        asOf: run.as_of,
        engine: engineFor(body.engine),
      });
      run.items = [item, ...run.items.filter((i) => i.id !== item.id)].sort((a, b) => b.priority.score - a.priority.score);
      run.stats.emails = run.items.length;
      run.stats.cost_usd += item.meta.cost_usd || 0;
      save(run);
      return json(res, 200, { item, run });
    }

    // Static: dashboard + generated files
    let file = url.pathname === "/" ? path.join(ROOT, "public/index.html")
      : url.pathname.startsWith("/out/") ? path.join(OUT, path.basename(url.pathname))
      : path.join(ROOT, "public", path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ""));
    const allowed = [path.join(ROOT, "public") + path.sep, OUT + path.sep].some((dir) => file.startsWith(dir));
    if (!allowed || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end("Not found");
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    console.error(err);
    if (res.headersSent) return res.end();
    json(res, err.status === 401 ? 401 : 500, { error: err.status === 401 ? "Anthropic API key was rejected. Check ANTHROPIC_API_KEY in .env." : err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Inbox Desk running at http://localhost:${PORT}`);
  console.log(hasApiKey() ? `Engine: Claude (${MODEL})` : "Engine: offline rules (add ANTHROPIC_API_KEY to .env for Claude)");
});
