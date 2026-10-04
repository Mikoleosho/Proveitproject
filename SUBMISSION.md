# Inbox Desk: Xylo Prove-It submission

**Candidate:** Michael Koleosho · **Vertical:** A, independent accounting and bookkeeping firms
**Workflow:** morning inbox triage, reply drafting and CRM reconciliation

> **Before sending:** add the Loom link and the Claude Code session link (both marked `TODO`).

---

## 1. A working AI tool

**What it is.** Inbox Desk turns a folder of messy client emails plus a messy CRM export into something the owner can work through one email at a time. Each email gets:

- a draft reply where anything the AI couldn't know is a yellow fill-in spot
- a **Send** button that opens the owner's email app pre-addressed, then moves on to the next email
- at the end, one step that downloads the CRM with the changes the emails mentioned

**Run it** (Node 20+, about 2 minutes):

```bash
git clone https://github.com/Mikoleosho/Proveitproject && cd Proveitproject
# (or: unzip inbox-desk.zip && cd inbox-desk)
npm install
cp .env.example .env     # add ANTHROPIC_API_KEY (optional)
npm start                # http://localhost:3000
```

Other ways to run it:
- `npm run triage` runs the same pipeline from the terminal. It prints the ranked list and the run cost, and writes `out/brief.md`, `out/drafts.md` and `out/crm_proposed_changes.csv`.
- With no API key, it runs on an offline rules engine (same output shape, template drafts) and says so in the ⋯ menu, so it runs on any machine.
- To use your own data: `npm run triage -- --emails DIR --crm FILE`.

**Demo path (2 minutes)**
1. `npm start`. The most urgent email (a double charge, threatening a bank dispute by Friday) is already open, marked **Your call**, and the draft doesn't promise a refund.
2. Click **Tina**: she needs Q2 numbers for a 3pm call today. The cursor is already in the first yellow spot. Type what you'll send, press Enter, click **Today**, then **Send reply**. Her email is done and the next one is open.
3. **Ray Delgado** (invoice #4471, $2,400 vs $2,850): the draft won't say which amount is right. It's a blank only the owner can fill.
4. **Priya Kapoor:** her EIN is in the email. It's masked in the reply and kept out of CRM notes.
5. **Tom Becker:** the email came from Sandra Liu, the referrer. It was matched to Tom's record by the phone number in the body, and his missing email (written as "tom.becker at beckerroofing dot com") shows up in the CRM step.
6. **Add an email:** paste any raw email and get a triaged draft back.

**Real-shaped, messy input.** It runs on the provided sample data:

- 14 emails with missing subjects, forwarded threads, an obfuscated email address and an anonymous sender
- a CRM with 6 date formats, blank names, "churned?" as a status, and phone numbers in three styles

It also runs on 8 more held-out emails I wrote to be harder: a colleague writing from a shared company domain, a client on a new address, a QuickBooks system notification, and a reply that moves a deadline.

---

## 2. AI-native workflow

Full log: [`docs/AI_WORKFLOW.md`](docs/AI_WORKFLOW.md) · Session link: **TODO**

**Tools.** Claude Code (Opus 5.5) in VS Code built the whole thing from an empty folder. It wrote the code, ran the tests, the CLI and the evals, and drove a headless browser (Playwright) to screenshot and click through the UI at desktop and phone sizes. The shipped tool calls Claude Haiku 4.5.

**Prompts that mattered**
- **The kickoff:** the full brief plus all the data, pasted in one message with no extra instructions. The rubric and "assume no paid budget" shaped the plan from the first step: a cheap model, an offline mode, and an eval.
- **"Read the docs before writing API code."** The agent loaded Anthropic's API reference before any Claude code. That caught two things: structured outputs now go through `messages.parse()` with a Zod schema, and Haiku won't cache a prompt under 4,096 tokens. So I don't claim caching savings that wouldn't happen.
- **The line in the system prompt that changed output most:** *"NEVER invent a fact… write a placeholder… Placeholders are expected and good. Guessing is not."* Without permission to leave blanks, drafts fill gaps with plausible fiction.
- **"Make it simpler, it seems like the user experience would be awful."** The most useful prompt of the build: one sentence of honest pushback on the second version.

**Where AI sped me up.** Scaffolding the parser, CSV reader, six-format date normalizer, matcher, schema, server and UI took minutes, so the hours went into judgment calls. Browser screenshots in the loop meant the agent checked its own UI and didn't wait for me to.

**Where AI led me astray, and how I corrected**

| What happened | Correction |
|---|---|
| The offline rules scored **100%** on the sample emails, because they were written while reading those same emails | Wrote 8 held-out emails *first*, then scored on them: **50%**. Reported both numbers and didn't tune on the holdout |
| The API docs' default is the top model, "never downgrade for cost" | The brief says no budget, so Haiku 4.5 is the default and `TRIAGE_MODEL` swaps it |
| The second UI pass optimized for speed and piled on features: 6 stat tiles, tabs, filters, scores, side cards | Stripped back to one email, one reply, one button. **Speed features aren't simplicity**, and an agent will keep adding them unless pushed back |
| Small bugs the browser runs caught: "null" as a client name, "by by friday", animations replaying on every keystroke, re-checking dropping pasted emails, "tomorrow" suggested for a same-day deadline | Each one fixed and re-verified in the browser |
| The agent went looking for an API key in my other projects | Claude Code's permission check blocked it. The tool reads only its own `.env`, and the offline mode means it runs without a key |

---

## 3. One-page write-up

Full page: [`docs/WRITEUP.md`](docs/WRITEUP.md). The short version:

**Workflow and why.** A small bookkeeping firm owner's first hour every day goes to the inbox:

- **ordering:** what can't wait
- **reconciling:** who this is in a messy CRM
- **replying without getting it wrong:** no refund promises, no wrong invoice amounts, no emailing an EIN back

About one in four emails in the sample is urgent with a real consequence: a chargeback, a lender deadline, a 3pm call. It's a daily, high-frequency job that eats billable time, and a mistake costs money or a client.

**What the tool does.** Each layer does only what it's reliable at:

- **Code** decides which client an email is about (sender, then company domain, then a phone or email in the body, then full name) and normalizes the CRM. It also enforces the guardrails: mask EIN/SSN, block refund promises, flag any dollar amount that isn't in a source, and route money disputes to the owner.
- **Claude Haiku 4.5** makes one schema-validated call per email for intent, urgency, the resolved deadline, action items and the draft.
- **`firm.json`** is the only source of firm facts a draft may state.
- **Cost** is estimated under 1¢ per email, and each run prints the actual figure.

**Evidence.**
- 13 unit tests.
- Hand labels for 14 sample emails plus 8 held-out emails.
- The rules baseline drops from 100% to 50% on the holdout. Client matching stays at 100%, which is why it stays in code.
- **How the Claude path was checked without spending on an API key:**
  - The schema compiles to a strict JSON schema.
  - A real request reaches the Anthropic API and fails cleanly on auth (401), without silently falling back.
  - The rewrite flow was tested end to end in a browser with the API mocked.

  With a key, `npm run eval -- --holdout` scores Claude on the same held-out set in one command, for about 5 cents.

**What breaks at real scale.**
- **Ingestion:** real mail is MIME, with HTML, attachments and long threads.
- **Identity:** at thousands of clients, matching needs an index, fuzzy names and contact history.
- **Context:** "did my payment land?" needs QuickBooks/Xero access, not just the CRM row.
- **Compliance:** client financial data needs a vendor agreement, zero retention and an audit log.
- **Evaluation:** 22 labeled emails is a smoke test. The owner's edits to drafts are free labels.

**Next week.**
1. A Gmail connector that writes Gmail *drafts* (never auto-send).
2. Read access to QuickBooks Online, so invoice and payment questions get answered instead of left blank.
3. Learning from the owner's edits.
4. The Batch API (50% cheaper) for the overnight run.
5. After-hours texts for anything critical.

**Where spend would earn its keep.** Sonnet only for the drafts the owner edits most, decided by an A/B on edit distance. Leave triage on Haiku.

---

## 4. Loom (3 to 5 minutes)

Link: **TODO**

Script: [`docs/LOOM_SCRIPT.md`](docs/LOOM_SCRIPT.md).

| Time | What to show |
|---|---|
| 0:00 | The problem in one breath |
| 0:25 | `npm run triage` and the cost line |
| 0:45 | End to end: the double charge (Your call), Tina in four seconds, Ray's invoice blank, Priya's EIN, Tom's referral match, the CRM download, adding an email live |
| 2:30 | How AI built it: the kickoff prompt, reading the docs first, the placeholder rule, the 100% to 50% holdout story, the "make it simpler" rewrite |
| 4:15 | What's next |

---

## How this maps to the rubric

| Dimension | Where to look |
|---|---|
| Shipped and real | `npm install && npm start`. Runs with or without a key, on the provided messy data and on held-out emails |
| AI-native execution | `docs/AI_WORKFLOW.md`: prompts, the docs-first habit, browser checks in the loop, three honest course corrections |
| Technical depth | Code-vs-model split, schema-validated structured output, guardrails enforced in code, deterministic CRM matching with confidence, eval with a held-out set, 13 tests, live progress streaming |
| Problem choice | Daily, high-frequency, money-and-trust risk, directly reclaims billable time |
| Craft and polish | One email at a time, fill-in spots inside the reply, one Send button, Undo everywhere, works on a phone, light and dark |
| Communication | This page, the one-pager, the Loom |
