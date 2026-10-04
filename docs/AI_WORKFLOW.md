# How this was built with AI

**Tooling:** Claude Code (Claude Opus 5.5) in VS Code, driving the whole build from an empty folder: reading the brief and data, writing code, running tests, the CLI, the evals and headless-browser screenshots, then fixing what those turned up. The app itself calls Claude Haiku 4.5.

> Session link: _add your Claude Code session share link here_

## The prompts that mattered

**1. The kickoff.** I pasted the full Xylo brief, the sample-data README, the CRM CSV and all 14 emails into one message with no extra instructions. Giving it the whole brief (scoring rubric, "assume no paid budget", "build for the mess") meant the agent planned for those constraints from the start: cheap model, an offline mode, an eval.

**2. Before writing any Claude API code, the agent loaded Anthropic's API reference skill** and read the TypeScript structured-outputs and prompt-caching docs. That turned up details that were easy to get wrong from memory:
- Structured outputs use `client.messages.parse()` with `output_config.format` and `zodOutputFormat` (the older `output_format` parameter is deprecated).
- The SDK helper imports `zod/v4`.
- Haiku 4.5's minimum cacheable prefix is **4,096 tokens**. That decided the next point.

**3. The system prompt** (`src/llm.js`) is written as an operating manual for a junior staffer, not a list of capabilities. The rules that changed output most:
- *"NEVER invent a fact. If the reply needs something the firm profile and CRM record don't tell you, write a placeholder in double square brackets… Placeholders are expected and good. Guessing is not."* Without permission to leave blanks, drafts fill gaps with plausible fiction ("I've re-sent your documents").
- *"A referral email is about the referred person, not the sender."*
- *"Resolve relative dates against TODAY… EOW means that Friday. A month with no day means the standard deadline in that month (business extension deadline: Oct 15)."*
- The user message says the CRM match was decided deterministically: *"trust it for who this is."*

## Where AI sped things up

- Scaffolding the whole pipeline (parser, CSV reader, six-format date normalizer, matcher, schema, server, dashboard) took minutes of wall time, so the hours went into judgment calls.
- **Headless screenshots in the loop.** The agent started the server, drove it with Playwright at 1440px and 390px wide, read the screenshots, and checked for console errors and horizontal scroll on mobile. That's how the UI got checked, not by asking me.
- Unit tests for the guardrails passed 13/13 on the first run, partly because the guardrails were written as small pure functions so they could be tested at all.

## Where it led me astray, and how I corrected

| What happened | How it was caught | Fix |
|---|---|---|
| The API skill's default is the top Opus model, "never downgrade for cost". The brief says assume no budget. | Read the brief against the default | Haiku 4.5 is the default. Swap with `TRIAGE_MODEL`. The write-up says where spend would pay off (Sonnet for drafts the owner edits heavily, an A/B on the eval) |
| I first assumed prompt caching would cut cost across the batch | The caching doc: Haiku's minimum prefix is 4,096 tokens, and the system prompt is about 1,100 | Left `cache_control` on (no cost below the minimum, pays off as the playbook grows), and didn't claim savings that don't happen |
| **The offline rules scored 100%.** Looked great, meant nothing: they were written while reading those 14 emails | Wrote 8 held-out emails and labels *before* running anything on them | Holdout: 50% intent, 50% urgency, 0% owner review. Didn't tune on the holdout. Reported both numbers |
| Offline rules read Sandra's "Thanks!!" as anger, so a friendly referral ranked critical with churn risk | Read the CLI queue output; a referral at #1 looked wrong | Narrowed the anger signals |
| CRM rows with no name showed up as **"null"** in the brief and queue | First end-to-end run of the CLI | `displayName()` fallback: name, then company, then email |
| The template produced "I know you need this **by by** friday" | Screenshot of the draft | Only prepend "by" when the phrase doesn't already start with it |
| Agent tried to look for an API key in other projects' `.env` files | Claude Code's permission check blocked it as credential exploration | Correct call. The tool reads only its own `.env`, and the offline mode means it runs without one |

## Second pass: UX ("make the tasks easier, not harder")

The prompt for this pass was one line: *"using all the skills you have, improve on it. Make the user experience elite. The whole point is to make the tasks easier, not harder."* The agent loaded the frontend-design and UI/UX skills. Before changing anything, it listed where the owner spends effort on each email:

| Friction | Before | After |
|---|---|---|
| Filling blanks | Find `[[...]]` inside a textarea and overwrite it by hand | One field per blank with context suggestions (dates from the client's deadline, amounts from the email, firm payment methods). Enter fills it and jumps to the next |
| Sending | Copy, switch apps, paste, address it, come back, mark sent | **Send in Mail** (⌘↵) opens a pre-addressed email, marks it sent, moves to the next email, and offers Undo |
| Rewording | Edit by hand | Type an instruction ("say Monday"), Claude rewrites, the same guardrails re-run, one-click Undo |
| Finding the next thing | One flat list sorted by score | Groups (Do first / Today / This week), filters (Needs you, Ready to send, Done), progress bar, inbox-zero screen |
| CRM | Accept rows one at a time, no output | Accept all, then download the CRM with the changes applied |
| Waiting on a re-run | Spinner | Live per-email progress over server-sent events |

Things the browser tests caught in this pass:
- **Animations replayed on every keystroke**, because a re-render restarted the entrance animation, so the totals flickered while typing. Entrance animations now run on first paint only.
- **Date suggestions offered "tomorrow" for a same-day deadline** (Tina's 3pm call). Suggestions now start from the client's own deadline.
- **Re-triage silently dropped pasted emails**, because it only re-read the folder. Pasted emails now carry over.
- **The offline deadline quote showed a broken fragment** ("rs pulled together for my 3pm call today") from a fixed-width slice. It's now a proper phrase match ("my 3pm call today").
- **"Yes"/"No" suggestions read badly once dropped into a sentence.** They were replaced with the template's own "e.g." example, and Claude's prompt now writes blanks in that labeled `KIND: prompt, e.g. answer` format so the form can parse them.
- **A garbled "Undo" for Accept all** that I wrote and caught on review, before testing.

The Claude-only paths (rewrite, cost readout) were tested by mocking the API inside Playwright, since no key was available.

## Third pass: simpler

The feedback on the second pass was blunt: *"Make it simpler, it seems like the user experience would be awful."* Fair. The second pass had added features to make each step faster, but a first-time user faced:

- 6 stat tiles, 3 tabs, 4 filters, 4 header buttons
- a score and chips on every row
- a separate form for blanks above the reply
- 6 side cards

Faster for a power user, overwhelming for a bookkeeper on day one. The lesson: **speed features are not simplicity**, and an AI agent will happily keep adding them unless someone pushes back.

What changed:
- **The reply is the form.** Blanks are now yellow fields typed straight into the reply text, with suggestions under the reply. There's no separate blanks panel and no highlighted textarea.
- **One button.** Send. "No reply needed" and "Copy instead" are quiet text links.
- **The list is just name, what they want, and when.** Two groups: Today and Can wait. Done emails fold away.
- **Removed from view:** stat tiles, tabs, filters, scores, chips, side cards, the "why it's ranked" panel and the shortcut dialog. CRM review is a single step at the end, with every change pre-ticked. Rarely used actions live in one ⋯ menu.
- **Plain words:** "Your call. This one is about money…" instead of "Owner sign-off: churn risk". The offline one-line summaries now pick the sentence that carries the actual ask ("I was charged twice.") instead of echoing the subject line.

None of the engine, guardrails or evals changed. The detail is all still in the data and the exports. It just isn't on screen by default.

## What I'd do differently with more time

Run the Claude eval on both sets, then A/B Haiku against Sonnet 5.5 on draft quality with the owner's edit distance as the metric. Today the eval scores fields, not prose. The draft is the part a client sees, so it deserves a rubric-graded eval of its own (answers every question, no invented facts, under 7 sentences, tone).
