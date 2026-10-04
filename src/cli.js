#!/usr/bin/env node
// npm run triage -- [--emails DIR] [--crm FILE] [--as-of YYYY-MM-DD] [--offline] [--out FILE]

import fs from "node:fs";
import path from "node:path";
import { runPipeline, ROOT } from "./pipeline.js";
import { hasApiKey } from "./llm.js";
import { writeExports } from "./export.js";
import { displayName } from "./normalize.js";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};

const engine = args.includes("--offline") ? "offline" : hasApiKey() ? "claude" : "offline";
if (engine === "offline" && !args.includes("--offline")) {
  console.log("No ANTHROPIC_API_KEY found (env or .env). Running the offline rules engine instead.\n");
}

const outFile = path.resolve(flag("out", path.join(ROOT, "out/run.json")));
const run = await runPipeline({
  emailsDir: flag("emails") && path.resolve(flag("emails")),
  crmFile: flag("crm") && path.resolve(flag("crm")),
  asOf: flag("as-of", "2024-05-02"),
  engine,
  onProgress: (n, total, r) =>
    console.log(`[${String(n).padStart(2)}/${total}] ${r.id.padEnd(9)} ${r.triage.urgency.padEnd(8)} ${r.triage.intent.padEnd(20)} ${displayName(r.match.client, "(no match)")}`),
}).catch((err) => {
  console.error(`\nRun failed: ${err.message}`);
  if (err.status === 401) console.error("Check ANTHROPIC_API_KEY in .env");
  process.exit(1);
});

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(run, null, 2));
const files = writeExports(run, path.dirname(outFile));

const s = run.stats;
console.log(`\nToday's queue (${run.as_of}), ${run.engine}${run.model ? ` / ${run.model}` : ""}`);
for (const it of run.items) {
  const who = displayName(it.match.client, it.email.from_email);
  const tag = it.triage.needs_owner_review ? " [OWNER]" : "";
  console.log(`  ${String(it.priority.score).padStart(3)}  ${it.triage.urgency.padEnd(8)} ${who.padEnd(16).slice(0, 16)} ${it.triage.summary}${tag}`);
}
console.log(`\n${s.emails} emails | ${s.critical} critical, ${s.high} high | ${s.owner_review} need owner sign-off | ${s.blanks_to_fill} blanks to fill | ${s.crm_updates} CRM updates proposed`);
if (s.fallbacks) console.log(`${s.fallbacks} email(s) fell back to offline rules after an API error.`);
console.log(`Tokens ${s.input_tokens} in / ${s.output_tokens} out | cost $${s.cost_usd.toFixed(4)} | ${(s.wall_ms / 1000).toFixed(1)}s`);
console.log(`\nWrote ${path.relative(process.cwd(), outFile)}, ${files.map((f) => path.relative(process.cwd(), f)).join(", ")}`);
console.log("Open the dashboard: npm start");
