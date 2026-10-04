// Code-side checks on whatever the model (or the offline engine) produced.
// The model is told these rules too; this is the part that doesn't depend on it listening.

import { daysBetween } from "./normalize.js";

const EIN = /\b(\d{2})-?(\d{3})(\d{4})\b/g;
const SSN = /\b(\d{3})-(\d{2})-(\d{4})\b/g;

export function maskSensitive(text) {
  let hits = 0;
  const out = text
    .replace(SSN, (_, a, b, c) => { hits++; return `***-**-${c}`; })
    .replace(EIN, (m, a, b, c) => {
      // EIN needs the dash or a nearby "EIN" label, otherwise 9 digits is probably something else.
      if (!m.includes("-")) return m;
      hits++;
      return `${a}-***${c}`;
    });
  return { text: out, hits };
}

export const placeholders = (text) => [...text.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim());

const REFUND_PROMISE =
  /\b(we(?:'ll| will| have|'ve)|i(?:'ll| will| have|'ve))\s+(?:already\s+)?(?:issue[sd]?\s+(?:a|your|the)\s+refund|refund(?:ed)?|credit(?:ed)?\s+(?:your|the)|revers(?:e|ed)\s+the|waive[d]?|adjust(?:ed)?\s+the\s+invoice)/i;
const REFUND_DONE = /\brefund (?:is|has been) (?:on its way|issued|processed|sent)\b/i;

/** Every number with a $ sign or thousands separator in the draft must appear in a source. */
function unverifiedAmounts(draft, sources) {
  const norm = (s) => s.replace(/[$,\s]/g, "").replace(/\.00$/, "");
  const sourceText = sources.join(" ");
  const sourceNums = new Set([...sourceText.matchAll(/\$?\d[\d,]*(?:\.\d{2})?/g)].map((m) => norm(m[0])));
  const draftNoPlaceholders = draft.replace(/\[\[[^\]]+\]\]/g, "");
  return [...draftNoPlaceholders.matchAll(/\$\s?\d[\d,]*(?:\.\d{2})?|\b\d{1,3}(?:,\d{3})+(?:\.\d{2})?\b/g)]
    .map((m) => m[0])
    .filter((a) => !sourceNums.has(norm(a)));
}

const REPEAT = /\b(again|second time|third time|still waiting|circling back|following up again|nobody has gotten back|haven'?t heard)\b/i;

/**
 * Checks on reply text alone. `extraSources` are things the owner told us (a rewrite instruction),
 * which count as verified.
 */
export function checkDraft(body, { email, match, firm, extraSources = [] }) {
  const flags = [];
  // Sensitive numbers never go back out in a reply.
  const masked = maskSensitive(body);
  if (masked.hits) {
    body = masked.text;
    flags.push({ level: "fixed", code: "pii_masked", text: `Masked ${masked.hits} sensitive number(s) in the draft.` });
  }
  // No promises about money.
  if (REFUND_PROMISE.test(body) || REFUND_DONE.test(body)) {
    flags.push({ level: "block", code: "money_promise", text: "Draft promises a refund/credit/adjustment. Only the owner can approve that." });
  }
  // Dollar amounts must come from the email, CRM, firm profile, or the owner.
  const sources = [email.body, email.subject, JSON.stringify(match.client || {}), JSON.stringify(firm), ...extraSources];
  const bad = unverifiedAmounts(body, sources);
  if (bad.length) flags.push({ level: "block", code: "unverified_amount", text: `Amount(s) not found in any source: ${bad.join(", ")}` });
  // Placeholders must be filled before sending.
  const ph = placeholders(body);
  if (ph.length) flags.push({ level: "todo", code: "placeholders", text: `${ph.length} blank(s) to fill before sending.`, items: ph });
  return { body, flags };
}

/**
 * Apply checks, mutate a copy of the triage into a safe state, and return flags the UI shows.
 * Also computes an explainable priority score so the queue order isn't a black box.
 */
export function review(triage, { email, match, firm, asOf }) {
  const t = structuredClone(triage);
  const flags = [];

  // 1-4. Draft checks (shared with the rewrite endpoint).
  const d = checkDraft(t.draft_reply.body, { email, match, firm });
  t.draft_reply.body = d.body;
  flags.push(...d.flags);
  if (d.flags.some((f) => f.level === "block")) {
    t.needs_owner_review = true;
    const why = d.flags.filter((f) => f.level === "block").map((f) => f.text).join(" ");
    t.review_reason = t.review_reason ? `${t.review_reason} ${why}` : why;
  }
  for (const u of t.crm_updates) {
    const m = maskSensitive(u.value);
    if (m.hits) {
      u.value = m.text;
      flags.push({ level: "fixed", code: "pii_masked_crm", text: `Masked a sensitive number in a CRM ${u.field} update.` });
    }
  }

  // 5. Deadline sanity.
  if (t.deadline.date && !/^\d{4}-\d{2}-\d{2}$/.test(t.deadline.date)) t.deadline.date = null;
  const daysLeft = t.deadline.date ? daysBetween(asOf, t.deadline.date) : null;
  if (daysLeft !== null && daysLeft < 0) {
    flags.push({ level: "warn", code: "past_deadline", text: `Deadline ${t.deadline.date} is already past. Check the date.` });
  }

  // 6. Money disputes and churn risk always go to the owner, whatever the model said.
  if (t.intent === "billing_dispute" || t.secondary_intents.includes("billing_dispute") || t.churn_risk) {
    if (!t.needs_owner_review) {
      t.needs_owner_review = true;
      t.review_reason = "This one is about money or an unhappy client, so you decide how to handle it.";
    }
    t.route_to = "owner";
  }

  // 7. Low-confidence or ambiguous client match.
  if (!match.client) flags.push({ level: "warn", code: "no_match", text: "Sender not matched to a CRM record." });
  else if (match.confidence < 0.8) flags.push({ level: "warn", code: "weak_match", text: `Client matched by ${match.method} (${Math.round(match.confidence * 100)}%). Confirm it's ${match.client.name || match.client.email}.` });
  if (match.role === "mentioned") flags.push({ level: "info", code: "third_party", text: `Written by ${email.from_name || email.from_email}, about ${match.client?.name || "a client"}.` });

  return { triage: t, flags, priority: priority(t, { email, match, daysLeft }) };
}

export function priority(t, { email, match, daysLeft }) {
  const why = [];
  let score = { critical: 70, high: 50, normal: 25, low: 5 }[t.urgency] ?? 25;
  why.push(`${t.urgency} urgency (+${score})`);
  const add = (n, reason) => { score += n; why.push(`${reason} (+${n})`); };

  if (daysLeft !== null && daysLeft !== undefined) {
    if (daysLeft <= 0) add(20, "due today");
    else if (daysLeft === 1) add(15, "due tomorrow");
    else if (daysLeft <= 3) add(10, `due in ${daysLeft} days`);
    else if (daysLeft <= 7) add(5, "due this week");
  }
  if (t.sentiment === "angry") add(10, "angry");
  else if (t.sentiment === "frustrated") add(6, "frustrated");
  if (t.churn_risk) add(8, "churn risk");
  if (REPEAT.test(email.body) || email.reply_depth >= 3) add(6, "repeat follow-up");
  if ((match.client?.value || 0) >= 3000) add(3, `$${match.client.value.toLocaleString()} account`);

  return { score: Math.min(100, score), why };
}
