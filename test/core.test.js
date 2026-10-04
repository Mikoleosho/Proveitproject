import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDate, normalizePhone, findEmails, normalizeStatus } from "../src/normalize.js";
import { parseEmail, parseCsv, normalizeCrmRow } from "../src/ingest.js";
import { matchEmail } from "../src/match.js";
import { review, maskSensitive } from "../src/guardrails.js";
import { resolveDeadline } from "../src/offline.js";

test("every date format in the CRM export normalizes", () => {
  for (const [raw, want] of [
    ["2024-04-02", "2024-04-02"], ["4/29/2024", "2024-04-29"], ["05/01/24", "2024-05-01"],
    ["Apr 10 2024", "2024-04-10"], ["2024/04/22", "2024-04-22"], ["4-25-2024", "2024-04-25"],
    ["", null], ["sometime", null],
  ]) assert.equal(normalizeDate(raw), want, raw);
});

test("phones and obfuscated emails", () => {
  assert.equal(normalizePhone("612 555 0193"), "(612) 555-0193");
  assert.equal(normalizePhone("(952) 555-0177"), "(952) 555-0177");
  assert.equal(normalizePhone("555-0177"), null);
  assert.deepEqual(findEmails("tom.becker at beckerroofing dot com, phone"), ["tom.becker@beckerroofing.com"]);
  assert.deepEqual(normalizeStatus("churned?"), { value: "churned", uncertain: true });
});

test("From header variants", () => {
  const e = parseEmail('From: "Delgado, Ray" <r.delgado@delgadohvac.net>\nSubject: Re: Re: x\n\nbody');
  assert.equal(e.from_name, "Ray Delgado");
  assert.equal(e.from_email, "r.delgado@delgadohvac.net");
  assert.equal(e.reply_depth, 2);
  const bare = parseEmail("From: newlead2024@yahoo.com\nSubject:\n\nhi");
  assert.equal(bare.from_email, "newlead2024@yahoo.com");
  assert.equal(bare.subject, "");
});

test("CSV with quoted commas", () => {
  const rows = parseCsv('a,b,c\n1,"x, y",z\n');
  assert.equal(rows[0].b, "x, y");
});

const crm = parseCsv(`client_id,name,company,email,phone,status,last_contact,value,notes
1005,Tom Becker,Becker Roofing,,612-555-0193,new,,,
1009,Dwight S,Stella Roofing,dwight.s@stellaroofing.com,,active,,,
1011,Mike,Twin Cities Flooring,mike@twincitiesflooring.com,,active,2024-04-30,1800,
`).map(normalizeCrmRow);

test("referral is matched to the referred client by phone, and fills the missing email", () => {
  const e = parseEmail("From: Sandra Liu <sliu@meridianadvisors.co>\nSubject: referral\n\nTom Becker, tom.becker at beckerroofing dot com, phone 612 555 0193");
  const m = matchEmail(e, crm);
  assert.equal(m.client.client_id, "1005");
  assert.equal(m.role, "mentioned");
  assert.deepEqual(m.enrichment.map((x) => [x.field, x.to]), [["email", "tom.becker@beckerroofing.com"]]);
});

test("colleague at the same company domain matches the account", () => {
  const e = parseEmail("From: Renee <accounts@stellaroofing.com>\nSubject: x\n\nDwight asked me to send these");
  assert.equal(matchEmail(e, crm).client.client_id, "1009");
});

test("unknown sender is unmatched, not guessed", () => {
  const e = parseEmail("From: x@gmail.com\nSubject: x\n\nhello there mike");
  assert.equal(matchEmail(e, crm).client, null);
});

test("EIN is masked, SSN is masked, phone numbers are left alone", () => {
  assert.equal(maskSensitive("EIN 47-1839204").text, "EIN 47-***9204");
  assert.equal(maskSensitive("SSN 123-45-6789").text, "SSN ***-**-6789");
  assert.equal(maskSensitive("call 651-555-0148").hits, 0);
});

const baseTriage = (body, extra = {}) => ({
  intent: "other", secondary_intents: [], summary: "", urgency: "normal", urgency_reason: "", sentiment: "neutral",
  churn_risk: false, deadline: { date: null, as_written: null, hard: false }, route_to: "admin", action_items: [],
  client_questions: [], firm_facts_needed: [], crm_updates: [], sensitive_data: [],
  draft_reply: { subject: "Re", body }, needs_owner_review: false, review_reason: null, ...extra,
});
const ctx = (body = "the invoice says 2,850 but we agreed 2,400") => ({
  email: parseEmail(`From: a@b.com\nSubject: s\n\n${body}`), match: { client: crm[2], confidence: 0.99, method: "sender email", role: "sender" },
  firm: { owner_name: "Alex" }, asOf: "2024-05-02",
});

test("guardrails: refund promise is blocked and forced to owner review", () => {
  const r = review(baseTriage("Sorry! We'll refund the duplicate charge today."), ctx());
  assert.ok(r.flags.some((f) => f.code === "money_promise"));
  assert.equal(r.triage.needs_owner_review, true);
});

test("guardrails: amounts must exist in a source", () => {
  assert.ok(!review(baseTriage("You're right that we agreed on 2,400."), ctx()).flags.some((f) => f.code === "unverified_amount"));
  const r = review(baseTriage("The corrected total is $2,650."), ctx());
  assert.ok(r.flags.some((f) => f.code === "unverified_amount"));
  // An amount inside a placeholder is the owner's to fill, not a claim.
  assert.ok(!review(baseTriage("Total is [[CONFIRM: $2,650?]]"), ctx()).flags.some((f) => f.code === "unverified_amount"));
});

test("guardrails: EIN in draft gets masked, billing disputes route to owner", () => {
  const r = review(baseTriage("Got your EIN 47-1839204, thanks.", { intent: "billing_dispute" }), ctx());
  assert.ok(!r.triage.draft_reply.body.includes("1839204"));
  assert.equal(r.triage.route_to, "owner");
  assert.equal(r.triage.needs_owner_review, true);
});

test("priority: due today outranks due next week", () => {
  const today = review(baseTriage("x", { urgency: "high", deadline: { date: "2024-05-02", as_written: "today", hard: true } }), ctx("x"));
  const later = review(baseTriage("x", { urgency: "high", deadline: { date: "2024-05-08", as_written: "wed", hard: true } }), ctx("x"));
  assert.ok(today.priority.score > later.priority.score);
});

test("offline deadline resolution against a Thursday", () => {
  assert.equal(resolveDeadline("if i dont hear back by friday", "2024-05-02").date, "2024-05-03");
  assert.equal(resolveDeadline("needs it by EOW", "2024-05-02").date, "2024-05-03");
  assert.equal(resolveDeadline("my 3pm call today", "2024-05-02").date, "2024-05-02");
});
