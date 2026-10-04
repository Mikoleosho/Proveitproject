# Loom script (about 4.5 min)

Have ready: the dashboard open on a fresh Claude run (`npm run triage` then `npm start`), a terminal, and `docs/AI_WORKFLOW.md` in the editor.

**0:00 to 0:25 · The problem.**
"This is a small bookkeeping firm's inbox: 14 messy emails and a CRM export with six date formats and half the names missing. Every morning the owner has to work out what can't wait, who each person is, and how to reply without promising something they shouldn't. Inbox Desk does that first pass."

**0:25 to 0:45 · Run it.** In the terminal, `npm run triage`. Point at the progress lines, the ranked queue, and the last line: tokens and **actual cost**.

**0:45 to 2:30 · Dashboard, end to end.**
- The screen: a greeting, a progress bar, the list (Today / Can wait), and one email. That's all of it.
- **Top item: the double charge.** Owner sign-off banner, deadline "by friday" resolved to Fri May 3, "why it's #1" score breakdown. The draft acknowledges the problem and gives a date, with no refund promise. "That isn't just the prompt. `guardrails.js` blocks it in code."
- **Tina (due today).** The cursor is already in the first yellow spot inside the reply. Type "the Q2 P&L and balance sheet", press Enter, then click "Today" (suggestions start from her own deadline). Press ⌘↵: your mail app opens addressed and filled in, the email is marked sent, and you're on the next one. "That's one email in about four seconds."
- **Ray Delgado, invoice #4471.** Marked *Needs you*. The draft won't say which amount is right, and Send stays disabled until it's filled. With a key: type "tell him we're checking against the signed proposal" and show the rewrite.
- **Priya.** EIN masked in the draft and the sensitive-data card.
- **Tom Becker.** "This email came from Sandra, the referrer, but it was matched to Tom's record by the phone number in the body, and his email was pulled out of 'tom.becker at beckerroofing dot com'." At the end, **Update my CRM**: the changes are pre-ticked, and you download your CRM with them applied.
- **Paste an email** live: write a new one with a relative deadline ("before my bank meeting tuesday") and show it land in the queue in the right spot.

**2:30 to 4:15 · How I built it with AI.**
- "I built this in Claude Code from an empty folder. I pasted the whole brief plus the data, so the rubric and the no-budget rule shaped the plan from the start."
- "Before any API code, it read Anthropic's current docs. That caught the structured-outputs API shape, and that Haiku won't cache prompts under 4K tokens, so I don't claim caching savings."
- The prompt line that mattered most: "placeholders are expected and good, guessing is not."
- **Where it went wrong:** "The rules engine scored 100%, because I wrote the rules while looking at those emails. So I wrote 8 held-out emails first and ran it on them: 50%. That's the honest reason the model is in there." Run `npm run eval -- --holdout`.
- "Code owns identity and safety, the model owns judgment, and every layer is testable."

**4:15 to 4:45 · Next.** Gmail connector that writes Gmail *drafts* (never auto-send), read access to QuickBooks so invoice and payment questions get answered and not blanked, and learning from the owner's edits.
