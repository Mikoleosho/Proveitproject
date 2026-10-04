# Inbox Desk: one-page write-up

## The workflow, and why this one

At a 2 to 10 person bookkeeping firm, the owner's first hour every day goes to the inbox. In the sample data that's 14 emails, and about one in four is urgent: a double-charge threatening a chargeback by Friday, Q2 numbers needed for a 3pm call, a loan package due end of week. Those sit next to a payment notice, a meeting reschedule and a new lead. Each email also means looking up the client in a CRM where the dates come in six formats, half the names are incomplete, and one status reads "churned?".

The pain isn't writing replies. It's three jobs done by hand every morning:

1. **Ordering:** which of these can't wait.
2. **Reconciling:** who this is, and what the CRM says about them.
3. **Replying without getting it wrong:** no promising a refund, confirming the wrong invoice amount, or emailing an EIN back.

A miss on the first costs a client; a miss on the third costs money or trust. That's why I picked inbox triage plus CRM reconciliation over pure extraction. It's the job the owner actually does every day, and an hour saved here is an hour of billable time.

## What the tool does

`npm run triage` or the dashboard (`npm start`) turns raw `.txt` emails plus a CRM CSV into a ranked queue. Each email gets a client match with a confidence score, intent, urgency, a resolved deadline ("by friday" becomes Fri May 3), action items, the questions the client asked, proposed CRM updates and a reply draft. In the dashboard the owner works one email at a time. Anything the draft can't know (the agreed invoice amount, whether docs were re-sent) is a yellow fill-in spot inside the reply, with suggestions. **Send** stays disabled until every spot is filled, then opens their email app pre-addressed and moves on to the next email. At the end, one step downloads the CRM with the changes the emails mentioned. There's also a markdown morning summary and an export of all drafts.

**Design choice:** each layer does only what it's reliable at.

- **Code decides:** which client an email is about (exact sender, then company domain, then a phone or email in the body, then full name), date and phone normalization, the priority score, and the guardrails (mask EIN/SSN, block refund promises, flag any dollar amount not found in the email, CRM or firm profile, force owner review on billing disputes).
- **Claude Haiku 4.5 handles the parts that need judgment:** one structured-output call per email, validated against a Zod schema.
- **The firm profile** (`firm.json`) is the only source of firm facts the draft is allowed to state.

## Evidence it works

- **13 unit tests** cover the deterministic layer.
- **Hand labels** for all 14 sample emails, plus **8 held-out emails** I wrote and labeled before running anything on them (shared company domain, client on a new address, a system notification, a CPA letter the firm can't write).
- The keyword-rules baseline scores 100% on the sample and **50% on the holdout**. It was tuned on the sample, and that gap is the honest case for the model. Client matching held at 100% on the holdout, which is why it stays in code.
- **Cost** is estimated under 1 cent per email on Haiku. Each run prints actual tokens and dollars.
- **The Claude path** was built and wired without spending on an API key:
  - the schema compiles to a strict JSON schema
  - a live request reaches the API and fails cleanly on auth
  - the rewrite flow passes a mocked browser test

  Scoring Claude on the held-out set is one command once a key is in `.env`.

## What breaks at real scale

- **Ingestion.** Real mail is MIME: HTML, attachments (Carlos's returns, Renee's statements), threads where only the newest message matters. It needs a Gmail/Outlook connector, quote stripping and attachment handling (PDF text plus OCR).
- **Identity.** Matching is O(emails × CRM) and only sees the export. At 2,000 clients it needs an index, fuzzy name matching and contact history ("Renee always writes for Stella Roofing").
- **Context.** Drafts know the CRM row, not the ledger. "Did my payment land?" or "where's my paperwork?" need read access to QuickBooks/Xero and the document portal. Without it those answers stay as `[[blanks]]`.
- **Trust and compliance.** Client financial data going to an API needs a vendor agreement, zero-retention settings and an audit log of who sent what. The browser-only edit state needs to become a real store with users.
- **Evaluation.** 22 labeled emails is a smoke test. Each owner edit to a draft is a free label; log them.

## Next week

1. **Gmail connector:** pull unread messages, write replies back as Gmail drafts (never auto-send), label by urgency.
2. **QuickBooks Online read access**, so invoice, payment and report questions get answered from the books and not left as blanks.
3. **Learning from edits:** diff each sent reply against the draft, feed recurring corrections into `firm.json`, and grow the eval set from real traffic.
4. **Batch API and prompt caching** for the overnight run: about 50% cheaper, and caching starts paying off once the firm playbook grows past Haiku's 4K-token cache minimum.
5. **Escalation:** text the owner for anything critical after hours.
