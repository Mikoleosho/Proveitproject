// The one model call per email. Deterministic context in, schema-validated JSON out.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { Triage, Draft } from "./schema.js";
import { weekday } from "./normalize.js";

// Haiku 4.5: cheapest current model that supports structured outputs, and the task is
// extraction + a short draft, not deep reasoning. Override with TRIAGE_MODEL to compare.
export const MODEL = process.env.TRIAGE_MODEL || "claude-haiku-4-5";

// $ per million tokens. Used for the cost readout in the UI, not billing.
const PRICES = {
  "claude-haiku-4-5": { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  "claude-sonnet-5-5": { in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-opus-5-5": { in: 4, out: 20, cacheWrite: 5, cacheRead: 0.2 },
};

export function costOf(usage, model = MODEL) {
  const p = PRICES[model] || PRICES["claude-haiku-4-5"];
  return (
    (usage.input_tokens * p.in +
      usage.output_tokens * p.out +
      (usage.cache_creation_input_tokens || 0) * p.cacheWrite +
      (usage.cache_read_input_tokens || 0) * p.cacheRead) / 1e6
  );
}

/** Frozen per firm, so it sits first and is cacheable across the whole batch. */
export function systemPrompt(firm) {
  return `You are the inbox assistant for ${firm.firm_name}, a small bookkeeping and tax firm in ${firm.location}. The owner, ${firm.owner_name}, reads your triage every morning and sends your drafts after a quick edit. Your job: turn one messy client email into a triage record and a reply draft.

FIRM PROFILE (the only firm facts you may state as true):
${JSON.stringify(firm, null, 2)}

HOW TO TRIAGE
- Urgency. critical: a hard deadline within 2 business days with a real consequence (bank chargeback, lender, IRS, a meeting today), or an angry client threatening to leave or dispute. high: a deadline this week, a repeated follow-up, or a money question from an active client. normal: routine requests with no near deadline. low: FYI, no action needed soon.
- Resolve relative dates ("friday", "EOW", "today", "next week", "oct") against TODAY, given in the user message. EOW means that Friday. A month with no day means the standard deadline in that month when one exists (business extension deadline: Oct 15), otherwise the 1st.
- A referral email is about the referred person, not the sender. Action items should cover both: contact the new client, and thank the referrer.
- Forwarded text was written by a third party (a bank, a loan officer). Treat its requirements as the client's requirements.
- route_to: owner for money disputes, refunds, churn risk and pricing; billing for payments; bookkeeper for deliverables, documents and onboarding; sales for new leads; admin for scheduling.
- crm_updates: only changes the email actually supports (a missing field the email fills in, a status change, a note worth keeping). Use field "new_record" only if the person isn't in the CRM at all. Never put sensitive numbers (EIN, SSN, account numbers) in CRM notes; write "EIN received" instead.
- sensitive_data: list any EIN, SSN, bank/routing/card numbers, masked.

HOW TO DRAFT THE REPLY
- Write as ${firm.owner_name}. ${firm.tone}
- Answer every question in client_questions. Acknowledge frustration plainly when it is there, and say what happens next and by when.
- NEVER invent a fact. If the reply needs something the firm profile and CRM record don't tell you (an invoice amount, whether docs were sent, whether a payment landed, a meeting time), write a placeholder in double square brackets that the owner fills in. Format: [[KIND: what to fill in]] where KIND is DATE (a day the owner commits to), AMOUNT, CONFIRM (a fact only the owner knows), INSERT (a short phrase) or WRITE (a sentence). The owner fills these in a form and the text is dropped in exactly where the brackets were, so write the sentence so it still reads naturally once filled. Add a likely answer after "e.g." when you can, e.g. [[AMOUNT: agreed total for invoice #4471, e.g. $2,400]] or [[DATE: when you'll send the Q2 numbers]]. Placeholders are expected and good. Guessing is not. Use as few as the reply truly needs.
- NEVER promise a refund, credit or invoice change. Say it is being looked into and give a date for an answer.
- NEVER repeat a full EIN, SSN or account number back. Refer to it as "the EIN you sent".
- If the request is something the firm doesn't do (see not_offered), say so kindly and point them to who does.
- No signature block beyond the owner's first name. No "I hope this email finds you well".
- Keep it short: most replies are 3 to 7 sentences.`;
}

export function userPrompt({ email, match, asOf }) {
  const crmBlock = match.client
    ? JSON.stringify(
        {
          ...match.client,
          match: { method: match.method, confidence: match.confidence, sender_is_client: match.role === "sender" },
        },
        null,
        2,
      )
    : "NO CRM MATCH. The sender is not in the CRM.";
  return `TODAY: ${weekday(asOf)}, ${asOf}

CRM RECORD (reconciled deterministically before you; trust it for who this is):
${crmBlock}

EMAIL:
From: ${email.from_name ? `${email.from_name} <${email.from_email}>` : email.from_email}
Subject: ${email.subject || "(no subject)"}

${email.body}`;
}

let client;
export function hasApiKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export async function triageWithClaude({ email, match, firm, asOf }) {
  client ??= new Anthropic();
  const started = Date.now();
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    temperature: 0.2,
    // Firm profile + instructions are identical for every email in the batch. On Haiku 4.5
    // this only caches once the prefix passes 4,096 tokens (a fuller playbook will), so it
    // costs nothing today and pays off as the firm profile grows.
    system: [{ type: "text", text: systemPrompt(firm), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userPrompt({ email, match, asOf }) }],
    output_config: { format: zodOutputFormat(Triage) },
  });

  if (response.stop_reason === "refusal") throw new Error("Model declined this email; triage it by hand.");
  if (response.stop_reason === "max_tokens") throw new Error("Output was cut off (max_tokens).");
  if (!response.parsed_output) throw new Error("Model output did not match the triage schema.");

  return {
    triage: response.parsed_output,
    meta: {
      engine: "claude",
      model: response.model,
      ms: Date.now() - started,
      usage: response.usage,
      cost_usd: costOf(response.usage, MODEL),
    },
  };
}

/**
 * Rewrite a draft per the owner's instruction ("say Monday", "shorter"). Same firm rules,
 * same guardrails afterwards. The current draft is the starting point so manual edits survive.
 */
export async function redraftWithClaude({ email, match, firm, asOf, draft, instruction }) {
  client ??= new Anthropic();
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 2000,
    temperature: 0.3,
    system: [{ type: "text", text: systemPrompt(firm), cache_control: { type: "ephemeral" } }],
    messages: [{
      role: "user",
      content: `${userPrompt({ email, match, asOf })}

CURRENT DRAFT (the owner may have edited it; keep their edits unless the instruction says otherwise):
Subject: ${draft.subject}

${draft.body}

OWNER'S INSTRUCTION: ${instruction}

Rewrite the draft following the instruction and all the drafting rules. Keep any [[blanks]] the instruction doesn't resolve. If the instruction gives you a fact (a date, an amount, a yes/no), use it and drop the matching blank.`,
    }],
    output_config: { format: zodOutputFormat(Draft) },
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) throw new Error("Couldn't rewrite this one. Edit it by hand.");
  return { draft: response.parsed_output, cost_usd: costOf(response.usage, MODEL) };
}

export { Anthropic };
