// One schema, shared by the Claude path, the offline path, the guardrails and the UI.

import { z } from "zod/v4";

export const INTENTS = [
  "billing_dispute",      // wrong invoice, double charge, refund
  "payment_notice",       // "I sent the money"
  "deliverable_request",  // "I need numbers / reports / statements"
  "document_followup",    // "where is my paperwork / did you send X"
  "client_sending_docs",  // client is providing documents or info
  "scheduling",
  "onboarding_issue",
  "contract_change",      // proposal changes, start dates, scope
  "new_client_inquiry",
  "referral",
  "out_of_scope",         // something the firm doesn't do
  "other",
];
export const URGENCY = ["critical", "high", "normal", "low"];
export const ROLES = ["owner", "billing", "bookkeeper", "sales", "admin"];
export const CRM_FIELDS = ["name", "company", "email", "phone", "status", "notes", "value", "new_record"];

const isoDate = z.string().describe("YYYY-MM-DD");

export const Draft = z.object({
  subject: z.string(),
  body: z.string(),
});

export const Triage = z.object({
  intent: z.enum(INTENTS),
  secondary_intents: z.array(z.enum(INTENTS)).describe("Other intents in the same email, if any. Empty if none."),
  summary: z.string().describe("One line, max ~20 words, written for the firm owner."),
  urgency: z.enum(URGENCY),
  urgency_reason: z.string().describe("Short, concrete. Cite the deadline or signal."),
  sentiment: z.enum(["angry", "frustrated", "neutral", "positive"]),
  churn_risk: z.boolean(),
  deadline: z.object({
    date: isoDate.nullable().describe("Resolved calendar date, or null if none stated"),
    as_written: z.string().nullable().describe("Exact phrase from the email, e.g. 'by friday', 'EOW', '3pm today'"),
    hard: z.boolean().describe("True if missing it has a real consequence (bank dispute, lender, IRS, a meeting)."),
  }),
  route_to: z.enum(ROLES),
  action_items: z.array(z.object({
    task: z.string().describe("Imperative, specific, e.g. 'Re-send policy docs to bev.nguyen@gmail.com'"),
    owner: z.enum(ROLES),
    due: isoDate.nullable(),
  })),
  client_questions: z.array(z.string()).describe("Every distinct question the sender asked. The reply must answer each."),
  firm_facts_needed: z.array(z.string()).describe("Facts the reply depends on that are NOT in the firm profile or CRM, e.g. 'what amount was agreed for invoice #4471'."),
  crm_updates: z.array(z.object({
    field: z.enum(CRM_FIELDS),
    value: z.string(),
    reason: z.string(),
  })),
  sensitive_data: z.array(z.object({
    kind: z.string().describe("e.g. EIN, SSN, bank account"),
    masked: z.string().describe("Masked form, e.g. 47-***9204"),
  })),
  draft_reply: Draft,
  needs_owner_review: z.boolean().describe("True for money, refunds, disputes, legal/IRS exposure, churn risk, or anything the firm profile says only the owner decides."),
  review_reason: z.string().nullable(),
});
