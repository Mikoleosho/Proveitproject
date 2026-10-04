// Orchestration: ingest -> reconcile -> triage (Claude or offline) -> guardrails -> rollups.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEmails, loadCrm } from "./ingest.js";
import { displayName } from "./normalize.js";
import { matchEmail } from "./match.js";
import { review } from "./guardrails.js";
import { triageOffline } from "./offline.js";
import { triageWithClaude, hasApiKey, MODEL, Anthropic } from "./llm.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try { process.loadEnvFile(path.join(ROOT, ".env")); } catch { /* no .env is fine */ }

export const loadFirm = () => JSON.parse(fs.readFileSync(path.join(ROOT, "firm.json"), "utf8"));

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/** Triage a single parsed email. Falls back to the offline engine if the API call fails. */
export async function triageOne(email, { crm, firm, asOf, engine }) {
  const match = matchEmail(email, crm);
  const ctx = { email, match, firm, asOf };
  let result, error = null;

  if (engine === "claude") {
    try {
      result = await triageWithClaude(ctx);
    } catch (err) {
      // Auth problems affect every email: fail the run loudly instead of silently degrading.
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) throw err;
      error = err instanceof Anthropic.APIError ? `API ${err.status ?? ""}: ${err.message}` : err.message;
      result = triageOffline(ctx);
    }
  } else {
    result = triageOffline(ctx);
  }

  const checked = review(result.triage, ctx);
  if (error) checked.flags.unshift({ level: "warn", code: "fallback", text: `Claude call failed (${error}). Showing offline rules result.` });
  return {
    id: email.id,
    email,
    match: { ...match, client: match.client ? { ...match.client } : null },
    triage: checked.triage,
    flags: checked.flags,
    priority: checked.priority,
    meta: result.meta,
  };
}

export async function runPipeline({
  emailsDir = path.join(ROOT, "sample-data/emails"),
  crmFile = path.join(ROOT, "sample-data/crm_export.csv"),
  asOf = "2024-05-02",
  engine = hasApiKey() ? "claude" : "offline",
  concurrency = 4,
  onProgress = () => {},
  extraEmails = [], // emails added by hand (pasted in the dashboard) that aren't in the folder
} = {}) {
  const started = Date.now();
  const firm = loadFirm();
  const crm = loadCrm(crmFile);
  const emails = [...loadEmails(emailsDir), ...extraEmails];
  let done = 0;

  const items = await mapLimit(emails, concurrency, async (email) => {
    const r = await triageOne(email, { crm, firm, asOf, engine });
    onProgress(++done, emails.length, r);
    return r;
  });
  items.sort((a, b) => b.priority.score - a.priority.score);

  return {
    generated_at: new Date().toISOString(),
    as_of: asOf,
    engine,
    model: engine === "claude" ? MODEL : null,
    firm: firm.firm_name,
    stats: stats(items, Date.now() - started),
    items,
    clients: clientRollup(items, crm),
    // Normalized CRM, so the dashboard can export an updated copy with accepted changes applied.
    crm: crm.map(({ issues, status_raw, last_contact_raw, ...rest }) => rest),
    crm_quality: crm.filter((c) => c.issues.length).map((c) => ({ client_id: c.client_id, name: displayName(c), issues: c.issues })),
  };
}

function stats(items, ms) {
  const usage = items.map((i) => i.meta.usage).filter(Boolean);
  const sum = (k) => usage.reduce((s, u) => s + (u[k] || 0), 0);
  return {
    emails: items.length,
    critical: items.filter((i) => i.triage.urgency === "critical").length,
    high: items.filter((i) => i.triage.urgency === "high").length,
    owner_review: items.filter((i) => i.triage.needs_owner_review).length,
    blanks_to_fill: items.reduce((s, i) => s + (i.flags.find((f) => f.code === "placeholders")?.items.length || 0), 0),
    crm_updates: items.reduce((s, i) => s + i.triage.crm_updates.length, 0),
    fallbacks: items.filter((i) => i.flags.some((f) => f.code === "fallback")).length,
    input_tokens: sum("input_tokens"),
    output_tokens: sum("output_tokens"),
    cache_read_tokens: sum("cache_read_input_tokens"),
    cost_usd: items.reduce((s, i) => s + (i.meta.cost_usd || 0), 0),
    wall_ms: ms,
  };
}

/** One row per client touched today: everything to do for them, in one place. */
function clientRollup(items, crm) {
  const by = new Map();
  for (const it of items) {
    const key = it.match.client?.client_id || `unmatched:${it.email.from_email}`;
    if (!by.has(key)) {
      by.set(key, {
        client_id: it.match.client?.client_id || null,
        name: it.match.client?.name || it.email.from_name || displayName(it.match.client, it.email.from_email),
        company: it.match.client?.company || null,
        crm_status: it.match.client?.status || null,
        emails: [], actions: [], crm_updates: [], top_priority: 0,
      });
    }
    const c = by.get(key);
    c.emails.push(it.id);
    c.actions.push(...it.triage.action_items.map((a) => ({ ...a, from: it.id })));
    c.crm_updates.push(...it.triage.crm_updates.map((u) => ({ ...u, from: it.id, current: currentValue(crm, c.client_id, u.field) })));
    c.top_priority = Math.max(c.top_priority, it.priority.score);
  }
  return [...by.values()].sort((a, b) => b.top_priority - a.top_priority);
}

function currentValue(crm, id, field) {
  const rec = crm.find((c) => c.client_id === id);
  if (!rec || field === "new_record") return null;
  return rec[field] ?? null;
}
