// Reconcile each email against the CRM. Deterministic first: an LLM should never be the thing
// deciding which client's file a reply goes into.

import { findEmails, findPhones } from "./normalize.js";

const FREEMAIL = new Set(["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "protonmail.com", "icloud.com", "aol.com"]);
const domainOf = (e) => (e ? e.split("@")[1] : null);
const tokens = (s) => (s || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((t) => t.length > 1);

/**
 * Returns { client, method, confidence, role, candidates, enrichment, sender_known }.
 * role = "sender" when the client wrote the email, "mentioned" when someone else wrote about them
 * (referrals, assistants, forwarded threads).
 */
export function matchEmail(email, crm) {
  const bodyEmails = findEmails(email.body).filter((e) => e !== email.from_email);
  const bodyPhones = findPhones(email.body);
  const candidates = [];
  const add = (client, method, confidence, role) => {
    if (!candidates.some((c) => c.client.client_id === client.client_id)) candidates.push({ client, method, confidence, role });
  };

  // 1. Exact sender address
  for (const c of crm) if (c.email && c.email === email.from_email) add(c, "sender email", 0.99, "sender");

  // 2. Same company domain (skip gmail etc. — sharing gmail.com means nothing)
  const dom = domainOf(email.from_email);
  if (dom && !FREEMAIL.has(dom)) {
    for (const c of crm) if (domainOf(c.email) === dom) add(c, "sender domain", 0.8, "sender");
  }

  // 3. Contact details mentioned in the body (referrals, "call my cell")
  for (const c of crm) {
    if (c.email && bodyEmails.includes(c.email)) add(c, "email in body", 0.9, "mentioned");
    if (c.phone && bodyPhones.includes(c.phone)) add(c, "phone in body", 0.85, "mentioned");
    const bodyDomains = bodyEmails.map(domainOf);
    const companySlug = (c.company || "").toLowerCase().replace(/[^a-z]/g, "");
    if (companySlug.length > 4 && bodyDomains.some((d) => d && d.replace(/[^a-z]/g, "").startsWith(companySlug))) {
      add(c, "company domain in body", 0.75, "mentioned");
    }
  }

  // 4. Name overlap (weakest signal: "mike" matches a lot of people)
  const senderTokens = new Set(tokens(email.from_name));
  const bodyTokens = new Set(tokens(email.body));
  for (const c of crm) {
    const nameT = tokens(c.name).filter((t) => t.length > 2);
    if (!nameT.length) continue;
    const full = nameT.every((t) => bodyTokens.has(t) || senderTokens.has(t));
    if (full && nameT.length > 1) add(c, "full name", 0.7, senderTokens.has(nameT[0]) ? "sender" : "mentioned");
  }

  candidates.sort((a, b) => b.confidence - a.confidence);
  // Several weak matches pointing at different clients = ambiguous, make a human pick.
  const top = candidates[0] || null;
  const ambiguous = candidates.length > 1 && candidates[1].client.client_id !== top.client.client_id && candidates[1].confidence >= top.confidence - 0.05;

  return {
    client: top && !ambiguous ? top.client : null,
    method: top ? top.method : null,
    confidence: top ? (ambiguous ? 0.4 : top.confidence) : 0,
    role: top ? top.role : null,
    ambiguous,
    candidates: candidates.map((c) => ({ client_id: c.client.client_id, name: c.client.name, method: c.method, confidence: c.confidence })),
    sender_known: crm.some((c) => c.email && c.email === email.from_email),
    enrichment: top && !ambiguous ? enrichment(top.client, email, bodyEmails, bodyPhones) : [],
    found: { emails: bodyEmails, phones: bodyPhones },
  };
}

/** CRM fields that are blank but the email fills in. Proposed, never auto-applied. */
function enrichment(client, email, bodyEmails, bodyPhones) {
  const out = [];
  const role = email.from_email === client.email ? "sender" : "mentioned";
  if (!client.email) {
    const candidate = role === "sender" ? email.from_email : bodyEmails.find((e) => !FREEMAIL.has(domainOf(e)) || bodyEmails.length === 1);
    if (candidate) out.push({ field: "email", from: null, to: candidate, source: "email body", deterministic: true });
  }
  if (!client.phone && bodyPhones.length === 1 && role === "sender") {
    out.push({ field: "phone", from: null, to: bodyPhones[0], source: "email body", deterministic: true });
  }
  if (role === "sender" && email.from_name && client.name && !/\s/.test(client.name)) {
    const fromT = tokens(email.from_name);
    if (fromT.length > 1 && fromT[0] === client.name.toLowerCase()) {
      out.push({ field: "name", from: client.name, to: email.from_name, source: "From header", deterministic: true });
    }
  }
  return out;
}
