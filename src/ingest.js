// Loading raw inputs: free-text emails and a messy CRM CSV.
// Everything here is deterministic. No model calls.

import fs from "node:fs";
import path from "node:path";
import { normalizeDate, normalizePhone, normalizeStatus, clean } from "./normalize.js";

/** Parse one raw email (headers, then a blank line, then the body). Tolerates missing headers. */
export function parseEmail(raw, id = "email") {
  const text = raw.replace(/\r\n/g, "\n");
  const split = text.indexOf("\n\n");
  const headerBlock = split === -1 ? "" : text.slice(0, split);
  const body = (split === -1 ? text : text.slice(split + 2)).trim();

  const headers = {};
  for (const line of headerBlock.split("\n")) {
    const m = line.match(/^([A-Za-z-]+):\s?(.*)$/);
    if (m) headers[m[1].toLowerCase()] = m[2].trim();
  }

  const from = parseFromHeader(headers.from || "");
  const subject = clean(headers.subject) || "";
  // "Fwd:" / forwarded blocks mean part of the body was written by someone else.
  const forwarded = /^-+\s*forwarded message/im.test(body) || /^fwd?:/i.test(subject);

  return {
    id,
    from_name: from.name,
    from_email: from.email,
    subject,
    body,
    forwarded,
    reply_depth: (subject.match(/\b(re|fwd?):/gi) || []).length,
  };
}

/** `"Delgado, Ray" <r.delgado@x.net>` / `marcy h <m@x.com>` / `bare@x.com` */
export function parseFromHeader(value) {
  const angle = value.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (angle) {
    let name = angle[1].trim();
    // "Last, First" -> "First Last"
    const lf = name.match(/^([^,]+),\s*(.+)$/);
    if (lf) name = `${lf[2]} ${lf[1]}`;
    return { name: name || null, email: angle[2].trim().toLowerCase() };
  }
  const bare = value.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/);
  return { name: null, email: bare ? bare[0].toLowerCase() : null };
}

export function loadEmails(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(txt|eml)$/i.test(f))
    .sort()
    .map((f) => parseEmail(fs.readFileSync(path.join(dir, f), "utf8"), path.parse(f).name));
}

/** Minimal RFC-4180 CSV parser (quoted fields, embedded commas/newlines, "" escapes). */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const [header, ...data] = rows.filter((r) => r.some((v) => v.trim() !== ""));
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ""])));
}

/** Load the CRM and normalize every record, keeping a list of data-quality issues per row. */
export function loadCrm(file) {
  return parseCsv(fs.readFileSync(file, "utf8")).map(normalizeCrmRow);
}

export function normalizeCrmRow(row) {
  const issues = [];
  const name = clean(row.name);
  const email = clean(row.email)?.toLowerCase() || null;
  const date = normalizeDate(row.last_contact);
  const status = normalizeStatus(row.status);
  const valueNum = clean(row.value) ? Number(String(row.value).replace(/[$,]/g, "")) : null;

  if (!name) issues.push("missing name");
  else if (!/\s/.test(name) || /^\w\.\s|\s\w\.?$/.test(name)) issues.push("incomplete name");
  if (!email) issues.push("missing email");
  if (!clean(row.phone)) issues.push("missing phone");
  if (row.last_contact && !date) issues.push(`unparseable date "${row.last_contact}"`);
  if (!row.last_contact) issues.push("no last-contact date");
  if (status.uncertain) issues.push(`ambiguous status "${row.status}"`);

  return {
    client_id: clean(row.client_id),
    name,
    company: clean(row.company),
    email,
    phone: normalizePhone(row.phone),
    status: status.value,
    status_raw: row.status,
    last_contact: date,
    last_contact_raw: row.last_contact || null,
    value: Number.isFinite(valueNum) ? valueNum : null,
    notes: clean(row.notes),
    issues,
  };
}
