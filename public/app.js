// Inbox Desk. One email at a time: read it, fill the highlighted spots, send.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (iso, o = { weekday: "short", month: "short", day: "numeric" }) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { ...o, timeZone: "UTC" });
const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const daysFrom = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
const BLANK = /\[\[([^\]]+)\]\]/g;
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

let run, status, selected = null, editing = false, lastDone = null;

// ------------------------------------------------------------ saved progress (this browser only)
const key = () => `inbox-desk:${run.generated_at}`;
let cache = null;
const saved = () => (cache ??= (() => { try { return JSON.parse(localStorage.getItem(key())) || {}; } catch { return {}; } })());
function save(bucket, id, value) {
  const all = saved();
  all[bucket] = { ...(all[bucket] || {}) };
  if (value === null || value === undefined) delete all[bucket][id]; else all[bucket][id] = value;
  try { localStorage.setItem(key(), JSON.stringify(all)); } catch { /* private window: works for this tab */ }
}
const get = (bucket, id) => (saved()[bucket] || {})[id];

// ------------------------------------------------------------ email helpers
const item = (id) => run.items.find((i) => i.id === id);
const nameOf = (it) => it.match.client?.name || it.email.from_name || it.email.from_email;
const isDone = (it) => Boolean(get("done", it.id));
const draft = (it) => get("drafts", it.id) || it.triage.draft_reply;
const fills = (it) => get("fills", it.id) || {};

/** Split a draft into text and blanks. Blank i is the i-th [[...]] in the text. */
function parts(body) {
  const out = [];
  let last = 0, i = 0;
  for (const m of body.matchAll(BLANK)) {
    if (m.index > last) out.push({ text: body.slice(last, m.index) });
    out.push({ blank: m[1], i: i++ });
    last = m.index + m[0].length;
  }
  if (last < body.length) out.push({ text: body.slice(last) });
  return out;
}
/** The reply as it will be sent: filled blanks dropped in, unfilled ones left as [[...]]. */
function finalText(it) {
  const f = fills(it);
  return parts(draft(it).body).map((p) => (p.text ?? (f[p.i]?.trim() ? f[p.i].trim() : `[[${p.blank}]]`))).join("");
}
const openSpots = (it) => parts(draft(it).body).filter((p) => p.blank && !fills(it)[p.i]?.trim()).length;
const promptOf = (b) => b.replace(/^[A-Z]+:\s*/, "").replace(/,?\s*e\.g\..*$/i, "").trim();

function when(it) {
  const d = it.triage.deadline.date;
  if (d) {
    const n = daysFrom(run.as_of, d);
    if (n < 0) return { text: "Overdue", soon: true };
    if (n === 0) return { text: "Today", soon: true };
    if (n === 1) return { text: "Tomorrow", soon: true };
    return { text: n < 7 ? fmt(d, { weekday: "long" }) : fmt(d, { month: "short", day: "numeric" }), soon: false };
  }
  return it.triage.urgency === "critical" ? { text: "Urgent", soon: true } : null;
}

/** Likely answers for a blank, from the email, the client's deadline and the firm profile. */
function suggestions(b, it) {
  const out = [];
  const add = (label, value = label) => { if (value && !out.some((o) => o.value === value)) out.push({ label, value }); };
  const eg = b.match(/e\.g\.\s*["“]?([^"”]+)["”]?\s*$/i);
  if (eg) add(eg[1].length > 40 ? `${eg[1].slice(0, 38)}…` : eg[1], eg[1].trim());
  if (/^DATE|date|when|\bday\b/i.test(b)) {
    const dl = it.triage.deadline.date;
    if (dl && dl <= run.as_of) add("Today", "end of day today");
    else if (dl) add(`${fmt(dl)} (their deadline)`, fmt(dl, { weekday: "long", month: "long", day: "numeric" }));
    for (let d = run.as_of, n = 0; n < 2;) {
      d = addDays(d, 1);
      if ([0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) continue;
      n++;
      if (d === dl) continue; // already offered as their deadline
      add(n === 1 ? `Tomorrow` : fmt(d), n === 1 ? `tomorrow (${fmt(d, { weekday: "long", month: "long", day: "numeric" })})` : fmt(d, { weekday: "long", month: "long", day: "numeric" }));
    }
  }
  if (/^AMOUNT|amount|total|\$|invoice/i.test(b)) {
    for (const m of it.email.body.matchAll(/\$?\b\d{1,3}(?:,\d{3})+\b/g)) add(m[0].startsWith("$") ? m[0] : `$${m[0]}`);
  }
  if (/pay/i.test(b)) add(status.firm.payment_methods.join(", "));
  if (/call|meeting|time|book/i.test(b)) add("Your booking link", status.firm.booking_link);
  return out.slice(0, 4);
}

// ------------------------------------------------------------ toast
function toast(text, action) {
  $("#toast-text").textContent = text;
  const b = $("#toast-btn");
  b.hidden = !action;
  if (action) { b.textContent = action.label; b.onclick = () => { $("#toast").classList.remove("show"); action.run(); }; }
  $("#toast").classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $("#toast").classList.remove("show"), action ? 6000 : 3000);
}

async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
}

// ------------------------------------------------------------ header
function renderTop() {
  const left = run.items.filter((i) => !isDone(i));
  const urgent = left.filter((i) => ["critical", "high"].includes(i.triage.urgency)).length;
  const hour = new Date().getHours();
  const hi = `Good ${hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening"}, ${esc(status.firm.owner_name)}.`;
  $("#greeting").innerHTML = left.length
    ? `${hi} <span>${left.length} email${left.length > 1 ? "s" : ""} to go${urgent ? `, <em>${urgent} today</em>` : ""}.</span>`
    : `${hi} <span>You're all done.</span>`;
  const done = run.items.length - left.length;
  $("#progress").hidden = false;
  $("#bar").style.width = `${(100 * done) / run.items.length}%`;
  $("#progress-text").textContent = `${done} of ${run.items.length} done`;
  $("#engine-note").textContent = run.engine === "claude"
    ? `Drafts by Claude (${run.model}) · $${run.stats.cost_usd.toFixed(3)} today`
    : "Offline mode. Add an Anthropic API key to .env for smarter drafts.";
}

// ------------------------------------------------------------ list
function renderList() {
  const open = run.items.filter((i) => !isDone(i));
  const today = open.filter((i) => ["critical", "high"].includes(i.triage.urgency));
  const later = open.filter((i) => !today.includes(i));
  const done = run.items.filter(isDone);
  const row = (it) => {
    const w = when(it);
    return `<button class="item ${it.id === selected ? "on" : ""} ${isDone(it) ? "done" : ""}" data-id="${esc(it.id)}" aria-current="${it.id === selected}">
      <span class="item-top"><span class="name">${esc(nameOf(it))}</span>${w && !isDone(it) ? `<span class="when ${w.soon ? "soon" : ""}">${w.text}</span>` : ""}${isDone(it) ? `<span class="when">${get("done", it.id) === "sent" ? "Sent" : "Done"}</span>` : ""}</span>
      <span class="what">${esc(it.triage.summary)}</span>
    </button>`;
  };
  $("#list").innerHTML = `
    ${today.length ? `<h2>Today</h2>${today.map(row).join("")}` : ""}
    ${later.length ? `<h2>Can wait</h2>${later.map(row).join("")}` : ""}
    ${done.length ? `<details class="done-list" ${open.length ? "" : "open"}><summary>Done (${done.length})</summary>${done.map(row).join("")}</details>` : ""}`;
}

// ------------------------------------------------------------ the email
function renderEmail() {
  const el = $("#email");
  const it = item(selected);
  if (!it) return (el.innerHTML = allDone());
  const t = it.triage;
  const w = when(it);
  const d = draft(it);
  const warnings = it.flags.filter((f) => f.level === "block" || f.level === "warn");

  el.innerHTML = `
    <button class="back" data-action="back">← All emails</button>
    <header class="email-head">
      <h2>${esc(nameOf(it))}${it.match.client?.company ? ` <span>${esc(it.match.client.company)}</span>` : ""}</h2>
      <p class="want">${esc(t.summary)}</p>
      ${w && t.deadline.date ? `<p class="due ${w.soon ? "soon" : ""}">Due ${w.text.toLowerCase() === "overdue" ? "already" : w.text.toLowerCase()} · they said “${esc(t.deadline.as_written)}”</p>` : ""}
    </header>
    ${t.needs_owner_review ? `<p class="yourcall"><b>Your call.</b> ${esc(t.review_reason || "This one is about money, so you decide how to handle it.")}</p>` : ""}
    ${warnings.map((f) => `<p class="warn">${esc(f.text)}</p>`).join("")}

    <section class="theirs">
      <h3>They wrote</h3>
      <blockquote>${emailHtml(it.email.body)}</blockquote>
    </section>

    <section class="reply">
      <h3>Your reply <button type="button" class="link" data-action="${editing ? "stop-edit" : "edit"}">${editing ? "Done editing" : "Edit the whole reply"}</button></h3>
      ${editing
        ? `<label class="sr" for="subject">Subject</label><input id="subject" class="subject-input" value="${esc(d.subject)}" />
           <label class="sr" for="body">Reply</label><textarea id="body" class="body-input">${esc(finalText(it))}</textarea>`
        : `<div class="paper" id="paper">${paper(it)}</div><div class="suggest" id="suggest" aria-live="polite"></div>`}
      ${status.has_key && !editing ? `<form class="ask" id="ask"><label class="sr" for="ask-input">Ask Claude to change the reply</label><input id="ask-input" placeholder="Want it different? Tell Claude, e.g. “make it shorter”" autocomplete="off" /><button class="btn ghost small" id="ask-go">Change it</button></form>` : ""}
      <div class="actions">
        <button class="btn send" id="send"></button>
        <button type="button" class="link" data-action="skip">No reply needed</button>
        <button type="button" class="link" data-action="copy">Copy instead</button>
      </div>
    </section>`;
  updateSend();
  if (!editing) focusFirstBlank(false);
}

/** The reply as a letter, with each blank as a highlighted field right where it goes. */
function paper(it) {
  const f = fills(it);
  return parts(draft(it).body).map((p) => {
    if (p.text !== undefined) return esc(p.text);
    const ph = promptOf(p.blank);
    return `<input class="spot" data-i="${p.i}" value="${esc(f[p.i] || "")}" placeholder="${esc(ph)}" aria-label="${esc(ph)}" size="${Math.max(ph.length, (f[p.i] || "").length, 8)}" autocomplete="off" />`;
  }).join("");
}

function emailHtml(body) {
  // Emails arrive hard-wrapped at ~80 chars. Re-flow them so they read like sentences.
  const lines = body.split("\n");
  const text = lines.reduce((acc, line, i) => (i === 0 ? line : acc + (lines[i - 1].trim().length > 55 && line.trim() && !/[-=]{4,}/.test(lines[i - 1] + line) ? " " : "\n") + line), "");
  return esc(text)
    .replace(/\(?\b(\d{3})\)?[\s.-]*(\d{3})[\s.-]*(\d{4})\b/g, (m, a, b, c) => `<a href="tel:+1${a}${b}${c}">${m}</a>`)
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, (m) => `<a href="mailto:${m}">${m}</a>`);
}

function updateSend() {
  const it = item(selected);
  const btn = $("#send");
  if (!it || !btn) return;
  const n = editing ? [...$("#body").value.matchAll(BLANK)].length : openSpots(it);
  btn.disabled = n > 0;
  btn.innerHTML = n ? `Fill in ${n === 1 ? "the highlighted spot" : `the ${n} highlighted spots`}` : `Send reply <kbd>${MOD}↵</kbd>`;
  $$('[data-action="copy"]').forEach((b) => (b.hidden = n > 0));
}

function focusFirstBlank(force = true) {
  const empty = $$(".spot").find((s) => !s.value.trim());
  if (empty && (force || window.innerWidth >= 900)) empty.focus({ preventScroll: !force });
}

function showSuggestions(input) {
  const it = item(selected);
  const p = parts(draft(it).body).find((x) => x.i === Number(input.dataset.i));
  const list = p ? suggestions(p.blank, it) : [];
  $("#suggest").innerHTML = list.length
    ? `<span>Suggestions:</span>${list.map((s) => `<button type="button" class="chip" data-i="${input.dataset.i}" data-value="${esc(s.value)}">${esc(s.label)}</button>`).join("")}`
    : "";
}

function setFill(i, value, { next = false } = {}) {
  const it = item(selected);
  save("fills", it.id, { ...fills(it), [i]: value });
  const input = $(`.spot[data-i="${i}"]`);
  if (input && input.value !== value) input.value = value;
  if (input) input.size = Math.max(input.placeholder.length, value.length, 8);
  updateSend();
  if (next) {
    const after = $$(".spot").find((s) => Number(s.dataset.i) > Number(i) && !s.value.trim()) || $$(".spot").find((s) => !s.value.trim());
    if (after) after.focus(); else { $("#suggest").innerHTML = ""; $("#send").focus(); }
  }
  renderList();
}

function allDone() {
  const updates = run.clients.reduce((n, c) => n + c.crm_updates.length, 0);
  const sent = Object.values(saved().done || {}).filter((v) => v === "sent").length;
  return `<div class="all-done">
    <h2>All done.</h2>
    <p class="want">${sent ? `${sent} repl${sent === 1 ? "y" : "ies"} sent.` : "Every email is handled."}${updates ? ` Your emails also mentioned ${updates} thing${updates > 1 ? "s" : ""} to update in your CRM.` : ""}</p>
    <div class="actions">
      ${updates ? `<button class="btn" data-action="crm">Update my CRM</button>` : ""}
      <a class="btn ghost" href="/out/brief.md" download>Download today's summary</a>
    </div>
  </div>`;
}

// ------------------------------------------------------------ actions
function select(id) {
  selected = id;
  editing = false;
  renderList();
  renderEmail();
  document.body.classList.add("reading");
  if (window.innerWidth < 900) window.scrollTo({ top: 0 });
}

function reply() {
  const it = item(selected);
  const d = draft(it);
  return editing ? { subject: $("#subject").value, body: $("#body").value } : { subject: d.subject, body: finalText(it) };
}

function finish(it, how, message) {
  save("done", it.id, how);
  lastDone = it.id;
  const order = [...run.items.filter((i) => ["critical", "high"].includes(i.triage.urgency)), ...run.items.filter((i) => !["critical", "high"].includes(i.triage.urgency))];
  const idx = order.indexOf(it);
  const next = [...order.slice(idx + 1), ...order.slice(0, idx)].find((i) => !isDone(i));
  selected = next?.id ?? null;
  editing = false;
  renderTop(); renderList(); renderEmail();
  toast(next ? `${message} Next up: ${nameOf(next)}.` : `${message} That was the last one.`, { label: "Undo", run: undo });
}

function undo() {
  if (!lastDone) return;
  save("done", lastDone, null);
  selected = lastDone;
  lastDone = null;
  renderTop(); renderList(); renderEmail();
}

function send() {
  const it = item(selected);
  if (!it || $("#send").disabled) return;
  const { subject, body } = reply();
  window.location.href = `mailto:${encodeURIComponent(it.email.from_email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  finish(it, "sent", "Opened in your email app.");
}

function stopEditing() {
  const it = item(selected);
  save("drafts", it.id, { subject: $("#subject").value, body: $("#body").value });
  save("fills", it.id, null);
  editing = false;
  renderEmail();
}

async function ask(instruction) {
  const it = item(selected);
  if (!instruction.trim()) return;
  const before = { draft: get("drafts", it.id), fills: get("fills", it.id) };
  const go = $("#ask-go");
  go.disabled = true; go.textContent = "Changing…";
  $("#paper")?.classList.add("busy");
  try {
    const r = await api("/api/redraft", { id: it.id, instruction, ...reply() });
    save("drafts", it.id, r.draft);
    save("fills", it.id, null);
    renderEmail();
    const problem = r.flags.find((f) => f.level === "block");
    toast(problem ? problem.text : "Reply updated.", { label: "Undo", run: () => { save("drafts", it.id, before.draft); save("fills", it.id, before.fills); renderEmail(); } });
  } catch (err) {
    toast(err.message);
    renderEmail();
  }
}

// ------------------------------------------------------------ CRM step
function crmRows() {
  return run.clients.flatMap((c) => c.crm_updates.map((u, i) => ({ ...u, client: c, key: `${c.client_id || c.name}:${u.from}:${i}` })));
}

function openCrm() {
  $(".menu")?.removeAttribute("open");
  const rows = crmRows();
  $("#crm-form").innerHTML = `
    <h2>Update your CRM</h2>
    <p class="muted">Today's emails mentioned these changes. Untick anything that's wrong, then download your updated CRM file and import it.</p>
    ${rows.length ? `<ul class="crm-list">${rows.map((r) => `<li><label>
        <input type="checkbox" data-key="${esc(r.key)}" ${get("crm", r.key) === "skip" ? "" : "checked"} />
        <span><b>${esc(r.client.name)}</b>: ${r.field === "new_record" ? "add as a new client" : `${esc(r.field)} → <span class="new">${esc(r.value)}</span>`}<small>${esc(r.reason)}</small></span>
      </label></li>`).join("")}</ul>` : `<p>Nothing to update today.</p>`}
    <div class="dialog-actions">
      <button class="btn ghost" value="cancel">Close</button>
      ${rows.length ? `<button class="btn" value="download" id="crm-download">Download updated CRM</button>` : ""}
    </div>`;
  $("#crm-dialog").showModal();
}

function downloadCrm() {
  const picked = crmRows().filter((r) => get("crm", r.key) !== "skip");
  if (!picked.length) return toast("Nothing ticked, so there's nothing to download.");
  const recs = structuredClone(run.crm || []);
  for (const r of picked) {
    const rec = recs.find((x) => x.client_id && x.client_id === r.client.client_id);
    if (r.field === "new_record" || !rec) { recs.push({ client_id: "", name: r.client.name, status: "new", last_contact: run.as_of, notes: r.value }); continue; }
    rec[r.field] = r.field === "notes" && rec.notes ? `${rec.notes}; ${r.value}` : r.value;
    rec.last_contact = run.as_of;
  }
  const cols = ["client_id", "name", "company", "email", "phone", "status", "last_contact", "value", "notes"];
  const cell = (v) => { const s = v ?? ""; return /[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s); };
  const csv = [cols.join(","), ...recs.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: `crm_updated_${run.as_of}.csv` });
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`Downloaded your CRM with ${picked.length} change${picked.length > 1 ? "s" : ""}.`);
}

// ------------------------------------------------------------ events
document.addEventListener("click", (e) => {
  const t = e.target;
  const row = t.closest(".item");
  if (row) return select(row.dataset.id);
  const chip = t.closest(".chip[data-value]");
  if (chip) return setFill(chip.dataset.i, chip.dataset.value, { next: true });
  const a = t.closest("[data-action]")?.dataset.action;
  if (a === "back") { document.body.classList.remove("reading"); return; }
  if (a === "skip") return finish(item(selected), "done", "Marked done, no reply.");
  if (a === "copy") {
    const it = item(selected);
    return navigator.clipboard.writeText(reply().body).then(
      () => toast("Reply copied. Paste it into your email.", { label: "Mark as sent", run: () => finish(it, "sent", "Marked as sent.") }),
      () => toast("Couldn't copy. Select the text and copy it yourself."),
    );
  }
  if (a === "edit") { editing = true; renderEmail(); return $("#body").focus(); }
  if (a === "stop-edit") return stopEditing();
  if (a === "crm") return openCrm();
  if (a === "rerun") return rerun();
  if (t.closest("#send")) return send();
  if (!t.closest(".menu")) $(".menu")?.removeAttribute("open");
});

document.addEventListener("focusin", (e) => { if (e.target.classList?.contains("spot")) showSuggestions(e.target); });

document.addEventListener("input", (e) => {
  if (e.target.classList.contains("spot")) setFill(e.target.dataset.i, e.target.value);
  if (e.target.id === "body") updateSend();
});

document.addEventListener("change", (e) => {
  if (e.target.dataset.key) save("crm", e.target.dataset.key, e.target.checked ? null : "skip");
});

document.addEventListener("submit", (e) => {
  if (e.target.id === "ask") { e.preventDefault(); ask($("#ask-input").value); }
  if (e.target.id === "crm-form" && e.submitter?.value === "download") downloadCrm();
});

document.addEventListener("keydown", (e) => {
  const t = e.target;
  if (t.classList?.contains("spot") && (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey))) {
    if (e.key === "Enter" || t.value.trim()) { e.preventDefault(); setFill(t.dataset.i, t.value, { next: true }); }
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    if ($("#add-dialog").open) { e.preventDefault(); return $("#add-form").requestSubmit($("#add-submit")); }
    if (selected) { e.preventDefault(); return send(); }
  }
  if (e.key === "Escape" && t.matches("input, textarea") && !$("dialog[open]")) return t.blur();
  if (t.matches("input, textarea") || $("dialog[open]") || e.metaKey || e.ctrlKey) return;
  if (e.key === "j" || e.key === "k") {
    const ids = $$(".list > .item").map((b) => b.dataset.id);
    const next = ids[ids.indexOf(selected) + (e.key === "j" ? 1 : -1)];
    if (next) { select(next); $(`.item[data-id="${CSS.escape(next)}"]`)?.focus(); }
  }
});

// ------------------------------------------------------------ add an email / re-check
$("#btn-add").addEventListener("click", () => { $("#add-error").textContent = ""; $("#add-dialog").showModal(); $("#add-text").focus(); });
$("#add-form").addEventListener("submit", async (e) => {
  if (e.submitter?.value === "cancel") return;
  e.preventDefault();
  const btn = $("#add-submit");
  btn.disabled = true; btn.textContent = "Reading it…";
  try {
    const r = await api("/api/triage", { raw: $("#add-text").value });
    run = r.run; cache = null;
    $("#add-dialog").close();
    $("#add-text").value = "";
    renderTop();
    select(r.item.id);
    toast("Added. Here's a draft reply.");
  } catch (err) {
    $("#add-error").textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = "Add";
  }
});

function rerun() {
  $(".menu")?.removeAttribute("open");
  if (Object.keys(saved().done || {}).length && !confirm("Re-checking starts today's list over. Your progress on this list won't carry over. Continue?")) return;
  const es = new EventSource("/api/run/stream");
  $("#progress-text").textContent = "Checking your emails…";
  es.addEventListener("progress", (ev) => {
    const p = JSON.parse(ev.data);
    $("#bar").style.width = `${(100 * p.n) / p.total}%`;
    $("#progress-text").textContent = `Reading email ${p.n} of ${p.total}…`;
  });
  es.addEventListener("done", async () => { es.close(); await load(); toast("All emails re-checked."); });
  es.addEventListener("failed", (ev) => { es.close(); renderTop(); toast(JSON.parse(ev.data).error); });
}

async function load() {
  [status, run] = await Promise.all([api("/api/status"), api("/api/run")]);
  cache = null;
  const first = [...run.items.filter((i) => ["critical", "high"].includes(i.triage.urgency)), ...run.items].find((i) => !isDone(i));
  selected = first?.id ?? null;
  renderTop(); renderList(); renderEmail();
}

load().catch((err) => { $("#greeting").textContent = "Couldn't load your inbox."; $("#email").innerHTML = `<p class="want">${esc(err.message)}</p>`; });
