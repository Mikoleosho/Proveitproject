// Plain-file outputs a non-technical owner can open without the dashboard.

import fs from "node:fs";
import path from "node:path";

const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows, cols) => [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";

export function morningBrief(run) {
  const lines = [`# Inbox brief for ${run.as_of}`, ""];
  const s = run.stats;
  lines.push(`${s.emails} emails. ${s.critical} critical, ${s.high} high. ${s.owner_review} need your sign-off.`, "");
  for (const [label, filter] of [
    ["Do first", (i) => i.triage.urgency === "critical"],
    ["Today", (i) => i.triage.urgency === "high"],
    ["This week", (i) => i.triage.urgency === "normal"],
    ["Whenever", (i) => i.triage.urgency === "low"],
  ]) {
    const items = run.items.filter(filter);
    if (!items.length) continue;
    lines.push(`## ${label}`, "");
    for (const it of items) {
      const who = it.match.client ? `${it.match.client.name || it.match.client.email}${it.match.client.company ? ` (${it.match.client.company})` : ""}` : it.email.from_email;
      const due = it.triage.deadline.date ? ` · due ${it.triage.deadline.date}` : "";
      lines.push(`- **${who}**: ${it.triage.summary}${due}${it.triage.needs_owner_review ? " · **owner**" : ""}`);
      for (const a of it.triage.action_items) lines.push(`  - [ ] ${a.task} (${a.owner}${a.due ? `, ${a.due}` : ""})`);
    }
    lines.push("");
  }
  if (run.crm_quality.length) {
    lines.push("## CRM cleanup", "");
    for (const q of run.crm_quality) lines.push(`- ${q.client_id} ${q.name}: ${q.issues.join("; ")}`);
  }
  return lines.join("\n") + "\n";
}

export function writeExports(run, dir) {
  const brief = path.join(dir, "brief.md");
  fs.writeFileSync(brief, morningBrief(run));

  const changes = path.join(dir, "crm_proposed_changes.csv");
  const rows = run.clients.flatMap((c) =>
    c.crm_updates.map((u) => ({ client_id: c.client_id, client: c.name, field: u.field, current: u.current, proposed: u.value, reason: u.reason, source_email: u.from })),
  );
  fs.writeFileSync(changes, toCsv(rows, ["client_id", "client", "field", "current", "proposed", "reason", "source_email"]));

  const drafts = path.join(dir, "drafts.md");
  fs.writeFileSync(
    drafts,
    run.items
      .map((it) => `## ${it.id} → ${it.email.from_email}\n**Subject:** ${it.triage.draft_reply.subject}\n\n${it.triage.draft_reply.body}\n`)
      .join("\n---\n\n"),
  );
  return [brief, changes, drafts];
}
