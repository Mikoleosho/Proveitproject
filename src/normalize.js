// Small, boring normalizers. The CRM export mixes six date formats, phone styles and status casing.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export function clean(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
};

/** 2024-04-02, 4/29/2024, 05/01/24, Apr 10 2024, 2024/04/22, 4-25-2024 -> ISO YYYY-MM-DD (or null). */
export function normalizeDate(v) {
  const s = clean(v);
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/))) return iso(+m[1], +m[2], +m[3]);
  // US order. A bookkeeping CRM in Minnesota is not writing DD/MM.
  if ((m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2}|\d{4})$/))) return iso(+m[3], +m[1], +m[2]);
  if ((m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/))) {
    const mon = MONTHS[m[1].toLowerCase()];
    return mon ? iso(+m[3], mon, +m[2]) : null;
  }
  return null;
}

/** Any 10-digit US number -> (XXX) XXX-XXXX. Tolerates spaces, dots, parens. */
export function normalizePhone(v) {
  const digits = (clean(v) || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (digits.length !== 10) return null;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export function findPhones(text) {
  const out = new Set();
  for (const m of text.matchAll(/\(?\b(\d{3})\)?[\s.-]*(\d{3})[\s.-]*(\d{4})\b/g)) {
    out.add(normalizePhone(m[1] + m[2] + m[3]));
  }
  return [...out].filter(Boolean);
}

/** Finds real addresses and the "name at domain dot com" style people type to dodge spam filters. */
export function findEmails(text) {
  const out = new Set();
  for (const m of text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) out.add(m[0].toLowerCase());
  for (const m of text.matchAll(/([\w.+-]+)\s+(?:at|\[at\]|\(at\))\s+([\w-]+)\s+(?:dot|\[dot\]|\(dot\))\s+(com|net|org|co|biz|io|us)\b/gi)) {
    out.add(`${m[1]}@${m[2]}.${m[3]}`.toLowerCase());
  }
  return [...out];
}

const STATUS = {
  active: "active", prospect: "prospect", lead: "lead", new: "new", negotiating: "negotiating",
  onboarding: "onboarding", inactive: "inactive", churned: "churned",
};

export function normalizeStatus(v) {
  const s = (clean(v) || "").toLowerCase();
  const uncertain = /\?/.test(s);
  const key = s.replace(/[^a-z]/g, "");
  return { value: STATUS[key] || (key || "unknown"), uncertain };
}

/** Day-of-week name for an ISO date (UTC, so tests are timezone-proof). */
export function weekday(isoDate) {
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
}

export function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Best human label for a CRM record that may be missing its name. */
export function displayName(client, fallback = null) {
  if (!client) return fallback;
  return client.name || client.company || client.email || fallback || `#${client.client_id}`;
}
