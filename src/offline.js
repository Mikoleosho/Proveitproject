// Keyword-rules engine with the same output shape as the Claude path.
// Exists so the tool runs with no API key (and as a baseline the eval compares Claude against).
// It is deliberately simple. Its drafts are templates full of [[blanks]].

import { daysBetween, displayName } from "./normalize.js";

const RULES = [
  ["billing_dispute", /charged twice|double charge|refund|invoice.*(off|wrong)|total looks off|overcharg|dispute/i],
  ["payment_notice", /sent (the )?payment|paid via|zelle|venmo|check is in the mail|lmk when it lands/i],
  ["deliverable_request", /need (the )?(q\d|numbers|reports?|statements?|p&l|financials)|pulled together|loss run/i],
  ["document_followup", /where (is )?my paperwork|did .* (come|go) through|still waiting|haven'?t (got|received)|documents ever/i],
  ["client_sending_docs", /attaching|attached|see below|this is everything|forwarded message/i],
  ["scheduling", /meeting|reschedul|cancel|mon(day)?|tues(day)?|call (on|at)/i],
  ["onboarding_issue", /onboarding|form .*(submit|invalid)|wouldn'?t let me submit/i],
  ["contract_change", /proposal|push the start|start date|scope/i],
  ["referral", /referr(ing|al)/i],
  ["new_client_inquiry", /do you (guys )?(work|handle)|is that something you handle|what would .* cost|saw your site|need someone to take over/i],
];

const ROUTE = {
  billing_dispute: "owner", payment_notice: "billing", deliverable_request: "bookkeeper", document_followup: "bookkeeper",
  client_sending_docs: "bookkeeper", scheduling: "admin", onboarding_issue: "bookkeeper", contract_change: "owner",
  referral: "sales", new_client_inquiry: "sales", out_of_scope: "bookkeeper", other: "admin",
};

const DOW = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
function nextDow(asOf, dow) {
  const today = new Date(`${asOf}T12:00:00Z`).getUTCDay();
  return addDays(asOf, ((dow - today + 7) % 7) || 0);
}

export function resolveDeadline(body, asOf) {
  const year = asOf.slice(0, 4);
  let m;
  if (/\btoday\b/i.test(body)) {
    m = body.match(/(?:(?:my|the|our)\s+)?(?:\d{1,2}(?::\d{2})?\s?(?:am|pm)\s+\w+\s+)?today\b/i);
    return { date: asOf, as_written: m ? m[0] : "today", hard: true };
  }
  if ((m = body.match(/\bby (mon|tues|wednes|thurs|fri|satur|sun)day\b/i)))
    return { date: nextDow(asOf, DOW.findIndex((d) => d.startsWith(m[1].toLowerCase()))), as_written: m[0], hard: true };
  if ((m = body.match(/\b(by )?(eow|end of (the )?week)\b/i))) return { date: nextDow(asOf, 5), as_written: m[0], hard: true };
  if ((m = body.match(/\bthis week\b/i))) return { date: nextDow(asOf, 5), as_written: m[0], hard: false };
  if ((m = body.match(/\bextension\s+deadline\s+in\s+oct\w*/i))) return { date: `${year}-10-15`, as_written: m[0], hard: true };
  return { date: null, as_written: null, hard: false };
}

// Templates per intent. Blanks are labeled KIND: what-to-write so the dashboard can render them as
// a short form with the right suggestions (dates, amounts, yes/no).
const TEMPLATES = {
  billing_dispute: () => `Thanks for flagging this, and I'm sorry for the hassle. I'm going through the charges now and will get back to you by [[DATE: when you'll have an answer]] with what happened and how we'll make it right.`,
  payment_notice: ({ asksReports, firm }) => `Thanks for sending that. [[CONFIRM: has the payment landed? e.g. "It came through this morning, you're all set."]]${asksReports ? ` ${firm.monthly_reports_schedule}` : ""}`,
  deliverable_request: () => `On it. I'll get [[INSERT: what you'll send, e.g. the Q2 P&L and balance sheet]] over to you by [[DATE: when you'll send it]].`,
  document_followup: () => `I'm sorry this has dragged on. [[CONFIRM: where their documents stand]] I'll make sure it's wrapped up by [[DATE: follow-up date]].`,
  client_sending_docs: ({ deadline }) => `Got it, thank you. [[CONFIRM: anything still missing?]] I'll have everything ready by [[DATE: when it'll be ready]]${deadline.date ? " so you're set for the deadline" : ""}.`,
  scheduling: () => `No problem at all. Would [[INSERT: new day and time]] work?`,
  onboarding_issue: () => `Thanks for letting me know, and sorry about the form. [[WRITE: the fix or a workaround]] Nothing else needed from you for now. I'll reach out if that changes.`,
  contract_change: () => `Thanks for the note. [[CONFIRM: can you accommodate the change?]] I'll send an updated proposal by [[DATE: when]].`,
  referral: () => `Thank you for the referral, I really appreciate it. I'll reach out by [[DATE: when you'll contact them]].`,
  new_client_inquiry: ({ firm }) => `Thanks for reaching out. Yes, this is right in our wheelhouse. Every situation is a bit different, so rather than guess at a price over email, let's do a free 20-minute call and I'll give you a fixed quote after that: ${firm.booking_link}`,
  out_of_scope: () => `[[WRITE: who can help with this instead]] Happy to help with anything on the books side.`,
  other: () => `Thanks for reaching out. [[WRITE: your reply]]`,
};

const TASKS = {
  billing_dispute: "Pull the charges, find what went wrong, decide on the fix",
  payment_notice: "Confirm the payment landed and apply it",
  deliverable_request: "Prepare and send what they asked for",
  document_followup: "Find where their documents stand and send an update",
  client_sending_docs: "Review what they sent and list anything missing",
  scheduling: "Reschedule the meeting",
  onboarding_issue: "Fix the onboarding blocker",
  contract_change: "Decide on the change and update the proposal",
  referral: "Contact the referred client",
  new_client_inquiry: "Reply with a discovery-call link",
  out_of_scope: "Point them to who can help",
  other: "Read and reply",
};

/** The sentence that carries the ask, tidied up. Claude writes a real summary; this is the fallback. */
function summarize(body) {
  const flat = body.replace(/\s*\n\s*/g, " ").replace(/-{3,}.*?-{3,}/g, "");
  const sentences = flat.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 12);
  // Rank sentences: concrete asks beat pleasantries ("let me know if you need anything else").
  const TIERS = [
    /\b(referr\w*|charged|cancel|push the start|sent the payment|where my paperwork|asking for|wouldn'?t let me|needs? (?:the|someone|p&l|\w+ statements?))\b/i,
    /\b(can you|could you|do you|did|when|where|want)\b|\?/i,
  ];
  const usable = sentences.filter((x) => !/\b(let me know|lmk|thanks|thank you)\b/i.test(x));
  const pick = TIERS.map((re) => usable.find((x) => re.test(x))).find(Boolean) || usable[0] || sentences[0] || flat;
  let s = pick.replace(/^(hi|hey|hello)[^,]*,\s*/i, "").replace(/^(ok|so|also|quick one)\s*[-,]?\s*/i, "");
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return s.length > 110 ? `${s.slice(0, 107).replace(/\s+\S*$/, "")}…` : s;
}

export function triageOffline({ email, match, firm, asOf }) {
  const text = `${email.subject}\n${email.body}`;
  const hits = RULES.filter(([, re]) => re.test(text)).map(([k]) => k);
  if (/loss run/i.test(text)) hits.unshift("out_of_scope");
  const intent = hits[0] || "other";
  const deadline = resolveDeadline(email.body, asOf);
  const daysLeft = deadline.date ? daysBetween(asOf, deadline.date) : null;

  const angry = /ridiculous|TWICE|disput(e|ing) the charge|unacceptable/.test(email.body);
  const frustrated = /frustrat|again|second time|exhausting|still waiting/i.test(email.body);
  const sentiment = angry ? "angry" : frustrated ? "frustrated" : /thanks so much|hope you|:\)|looks good/i.test(email.body) ? "positive" : "neutral";
  const churn = angry || /disput(e|ing) the charge|cancel (my|our) (service|account)/i.test(email.body);

  let urgency = "normal";
  if ((daysLeft !== null && daysLeft <= 2 && deadline.hard) || angry) urgency = "critical";
  else if (frustrated || intent === "billing_dispute" || (daysLeft !== null && daysLeft <= 7)) urgency = "high";
  else if (intent === "payment_notice") urgency = "low";

  const first = (match.role === "sender" ? (match.client?.name || email.from_name || "") : email.from_name || "").split(/[\s,]+/)[0];
  const hi = first && first.length > 1 ? `Hi ${first[0].toUpperCase()}${first.slice(1)},` : "Hi there,";
  const questions = email.body.split(/(?<=[?])/).filter((s) => s.trim().endsWith("?")).map((s) => s.trim().split(/[.!]\s/).pop());

  return {
    triage: {
      intent,
      secondary_intents: [...new Set(hits.slice(1))].filter((i) => i !== intent).slice(0, 2),
      summary: summarize(email.body),
      urgency,
      urgency_reason: deadline.date ? `Deadline "${deadline.as_written}" (${deadline.date}).` : angry ? "Angry tone." : frustrated ? "Repeat follow-up / frustrated." : "No deadline stated.",
      sentiment,
      churn_risk: churn,
      deadline,
      route_to: ROUTE[intent],
      action_items: [{ task: TASKS[intent], owner: ROUTE[intent], due: deadline.date }],
      client_questions: questions,
      firm_facts_needed: [],
      crm_updates: match.enrichment.map((e) => ({ field: e.field, value: e.to, reason: `Found in ${e.source}` })),
      sensitive_data: [],
      draft_reply: {
        subject: `Re: ${email.subject.replace(/^((re|fwd?):\s*)+/i, "") || "your note"}`,
        body: `${hi}\n\n${TEMPLATES[intent]({ firm, deadline, asksReports: /reports?/i.test(email.body) })}${
          intent !== "payment_notice" && /\b(ach|cards?|zelle|payment methods?|how (do|can) (i|we) pay)\b/i.test(email.body)
            ? `\n\nOn payment: we take ${firm.payment_methods.join(", ")}.` : ""
        }\n\n${firm.owner_name}`,
      },
      needs_owner_review: intent === "billing_dispute" || churn,
      review_reason: intent === "billing_dispute" || churn ? "This one is about money and the client is unhappy, so you decide how to handle it." : null,
    },
    meta: { engine: "offline-rules", model: null, ms: 0, usage: null, cost_usd: 0 },
  };
}
