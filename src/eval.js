#!/usr/bin/env node
// npm run eval [-- --offline] [-- --holdout] [-- --run out/run.json]
// Scores a run against eval/gold.json. Runs the pipeline unless --run points at a saved result.

import fs from "node:fs";
import path from "node:path";
import { runPipeline, ROOT } from "./pipeline.js";
import { hasApiKey } from "./llm.js";

const args = process.argv.slice(2);
const runArg = args.includes("--run") ? args[args.indexOf("--run") + 1] : null;
const set = args.includes("--holdout") ? "holdout" : "sample";
const gold = JSON.parse(fs.readFileSync(path.join(ROOT, set === "holdout" ? "eval/holdout_gold.json" : "eval/gold.json"), "utf8"));
const emailsDir = set === "holdout" ? path.join(ROOT, "eval/holdout") : undefined;

const run = runArg
  ? JSON.parse(fs.readFileSync(path.resolve(runArg), "utf8"))
  : await runPipeline({ emailsDir, engine: args.includes("--offline") || !hasApiKey() ? "offline" : "claude" });

const checks = { client_match: [], intent: [], urgency: [], deadline: [], owner_review: [], pii_not_echoed: [], no_blocking_flags: [] };
const misses = [];
const oneOf = (v, want) => (Array.isArray(want) ? want : [want]).includes(v);

for (const it of run.items) {
  const g = gold[it.id];
  if (!g) continue;
  const t = it.triage;
  const record = (name, ok, got, want) => {
    checks[name].push(ok);
    if (!ok) misses.push(`${it.id} ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  };
  record("client_match", oneOf(it.match.client?.client_id ?? null, g.client_id), it.match.client?.client_id ?? null, g.client_id);
  record("intent", oneOf(t.intent, g.intent), t.intent, g.intent);
  record("urgency", oneOf(t.urgency, g.urgency), t.urgency, g.urgency);
  record("deadline", oneOf(t.deadline.date, g.deadline), t.deadline.date, g.deadline);
  if (g.owner_review) record("owner_review", t.needs_owner_review === true, t.needs_owner_review, true);
  if (g.pii) record("pii_not_echoed", !t.draft_reply.body.includes(g.pii), "full EIN in draft", "masked");
  record("no_blocking_flags", !it.flags.some((f) => f.level === "block"), it.flags.filter((f) => f.level === "block").map((f) => f.code), []);
}

const pct = (a) => (a.length ? `${Math.round((100 * a.filter(Boolean).length) / a.length)}%`.padStart(4) : "  - ");
console.log(`Eval [${set}]: ${run.engine}${run.model ? ` / ${run.model}` : ""}, ${run.items.length} emails, as of ${run.as_of}\n`);
for (const [k, v] of Object.entries(checks)) console.log(`  ${k.padEnd(18)} ${pct(v)}  (${v.filter(Boolean).length}/${v.length})`);
console.log(`\n  cost $${run.stats.cost_usd.toFixed(4)}, ${(run.stats.wall_ms / 1000).toFixed(1)}s`);
if (misses.length) console.log(`\nMisses:\n  ${misses.join("\n  ")}`);
