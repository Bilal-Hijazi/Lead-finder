#!/usr/bin/env node
// Contact discovery — leads.json in, an email per lead out where one is
// published. Outreach needs an address, and neither of the other two tools
// produces one: the Places API has no email field at all, and audit.mjs fetches
// each homepage but throws the HTML away after reading page facts from it.
//
//   leads.json  ->  contacts.mjs  ->  contacts.json + contacts.md
//
// The only source is the clinic's own website. Nothing is guessed, and in
// particular no address is ever synthesised from a pattern — an invented
// info@ that happens to bounce is worse than a blank, because a blank is
// visibly missing and a plausible wrong address is not. Every address written
// here was read from a page, and the page it came from is recorded next to it.
//
// Zero dependencies, matching audit.mjs and discover.mjs: Node builtins plus
// global fetch. Pure helpers are exported and tested; the entry point only
// runs when this file is executed directly, so importing it fires no requests.
//
//   node contacts.mjs leads.json --out contacts.md

import { readFile, writeFile } from 'node:fs/promises';
import {
  checkLeadMail, mxCanaryOk, describeMail,
  MAIL_CAPABLE, NO_MAIL, IMPLICIT_MX, UNVERIFIED as MAIL_UNVERIFIED,
} from './mail.mjs';

const TIMEOUT_MS = 15_000;
const UA = 'Mozilla/5.0 (compatible; lead-audit/1.0)';

// ------------------------------------------------------------------ extraction

// Deliberately conservative on the local part. A permissive RFC-shaped pattern
// matches half of every minified bundle on the page — "@media", version strings,
// CSS selectors — and the cost of a junk address is a bounced cold email sent to
// a stranger, so the bar is "looks like something a human published".
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,24}/g;

// An asset filename with an @ in it — logo@2x.png, sprite@3x.svg — is the most
// common false positive by a wide margin, because retina asset naming puts an @
// in front of a dotted extension and the pattern above cannot tell it apart.
const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|woff2?|ttf|eot|mp4|webm|pdf)$/i;

// Vendor telemetry, boilerplate and documentation addresses. These are real,
// well-formed and never the clinic.
const JUNK_DOMAINS = new Set([
  'sentry.io', 'sentry-next.wixpress.com', 'wixpress.com', 'wix.com',
  'example.com', 'example.org', 'example.net', 'domain.com', 'yourdomain.com',
  'yoursite.com', 'email.com', 'company.com', 'test.com', 'localhost',
  'schema.org', 'w3.org', 'sentry.wixpress.com', 'godaddy.com',
  'squarespace.com', 'wordpress.com', 'wpengine.com', 'elementor.com',
]);

// Placeholder local parts that ship inside themes and are never filled in.
const JUNK_LOCALS = new Set([
  'youremail', 'your-email', 'yourname', 'email', 'user', 'username',
  'name', 'someone', 'test', 'example', 'sample', 'abc', 'xyz', 'jane', 'john',
  'firstname', 'lastname', 'address',
]);

export function isJunkEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return true;
  const lower = email.toLowerCase();
  if (ASSET_EXT.test(lower)) return true;
  const at = lower.lastIndexOf('@');
  const local = lower.slice(0, at);
  const domain = lower.slice(at + 1);
  if (!local || !domain || !domain.includes('.')) return true;
  if (JUNK_DOMAINS.has(domain)) return true;
  if (JUNK_LOCALS.has(local)) return true;
  // A live run produced info@example.com.com — a theme placeholder whose domain
  // was never replaced, and which the exact-match set above misses because it is
  // not literally "example.com". Any label of "example" is a placeholder.
  if (/(^|\.)example(\.|$)/.test(domain)) return true;
  // A % surviving into the local part is percent-encoding residue, not an
  // address: %20info@clinic.ae came from a mailto with a leading encoded space.
  // Real local parts effectively never contain one.
  if (local.includes('%')) return true;
  // A trailing all-numeric label is a version string, not a TLD (foo@bar.1.2).
  if (/\.\d+$/.test(domain)) return true;
  // Hex blobs are hashed asset names, not addresses someone typed.
  if (/^[0-9a-f]{16,}$/.test(local)) return true;
  if (local.length > 64 || domain.length > 255) return true;
  return false;
}

// A mailto href is the strongest signal on a page: it is unambiguously an
// address someone published for contact, not a string that merely looks like
// one. Percent-encoding is common (info%40clinic.ae) and HTML entities appear
// in hand-written markup, so both are decoded before matching.
export function decodeForEmails(html = '') {
  let s = String(html);
  try {
    // Only touch %40/%2E style escapes; a blanket decodeURIComponent throws on
    // any stray % in the page and would lose the whole document.
    s = s.replace(/%(?:40|2[eE]|5[fF])/g, (m) => decodeURIComponent(m));
  } catch { /* leave as-is */ }
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&commat;|&#64;/gi, '@')
    .replace(/&amp;/gi, '&');
}

// Light de-obfuscation. "info [at] clinic [dot] ae" is a deliberate choice by
// whoever built the site to stay reachable by humans while dodging naive
// scrapers, so reading it is exactly as intended as reading a mailto.
export function deobfuscate(text = '') {
  return String(text)
    .replace(/\s*[[(<{]\s*(?:at|@)\s*[\])>}]\s*/gi, '@')
    .replace(/\s+(?:at)\s+(?=[A-Za-z0-9-]+\s*(?:\.|\[\s*dot\s*\]))/gi, '@')
    .replace(/\s*[[(<{]\s*(?:dot|punkt)\s*[\])>}]\s*/gi, '.');
}

export function extractEmails(html = '') {
  const found = new Set();
  const decoded = decodeForEmails(html);

  // mailto: first and separately, so a page that also mentions a support
  // address in body copy does not outrank the one it actually linked.
  const mailtos = new Set();
  for (const m of decoded.matchAll(/href\s*=\s*["']\s*mailto:([^"'?>]+)/gi)) {
    const addr = m[1].trim().replace(/^%20+/, '');
    if (addr && !isJunkEmail(addr)) mailtos.add(addr.toLowerCase());
  }

  // Body text, with script and style stripped: bundles are where the junk lives.
  const text = deobfuscate(
    decoded
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  );
  for (const m of text.matchAll(EMAIL_RE)) {
    // Leading %20 is an encoded space from a mailto that was written
    // `mailto: info@...`; strip it rather than reject the address it prefixes.
    const addr = m[0].toLowerCase().replace(/^(?:%20)+/, '').replace(/[.,;:]+$/, '');
    if (!isJunkEmail(addr)) found.add(addr);
  }

  return { mailto: [...mailtos], text: [...found] };
}

// An address on the clinic's own domain is the one to write to. A gmail or
// hotmail address published by the clinic is still real and still theirs, so it
// is kept — just ranked below — and a noreply is kept last because it proves an
// address exists while being useless to write to.
export function rankEmails({ mailto = [], text = [] }, domain) {
  const all = [...new Set([...mailto, ...text])];
  const onDomain = (e) => {
    if (!domain) return false;
    const d = e.slice(e.lastIndexOf('@') + 1);
    const base = String(domain).toLowerCase().replace(/^www\./, '');
    return d === base || d.endsWith(`.${base}`) || base.endsWith(`.${d}`);
  };
  const isNoReply = (e) => /^(no-?reply|do-?not-?reply|bounce|postmaster|mailer-daemon)@/i.test(e);
  const wasLinked = (e) => mailto.includes(e);

  return all.sort((a, b) => {
    // Lower sorts first.
    const rank = (e) => (isNoReply(e) ? 3 : 0) + (onDomain(e) ? 0 : 1) + (wasLinked(e) ? 0 : 0.5);
    const d = rank(a) - rank(b);
    return d !== 0 ? d : a.localeCompare(b);
  });
}

// --------------------------------------------------------------------- phones

// UAE numbering: landlines are 0X XXX XXXX (area codes 2,3,4,6,7,9) and mobiles
// are 05X XXX XXXX, so a national number is 9 or 10 digits starting 0. Written
// internationally as +971 with the 0 dropped. Everything is normalised to the
// national form so the same clinic listed both ways dedupes to one number.
export function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  let d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('971')) d = `0${d.slice(3)}`;
  // A bare 9/10-digit string with no country code and no leading 0 is already
  // national minus the trunk prefix.
  if (!d.startsWith('0') && (d.length === 8 || d.length === 9)) d = `0${d}`;
  if (!/^0\d{8,9}$/.test(d)) return null;
  // 0 and 1 are not valid second digits; 8 is toll-free and not a clinic line.
  if (!'234567 9'.includes(d[1])) return null;
  // A mobile is 05X and ten digits; anything else must be a nine-digit landline.
  if (d[1] === '5' ? d.length !== 10 : d.length !== 9) return null;
  return d;
}

// tel: links are the strong signal, exactly as mailto: is for email. Body text
// is matched too, but only in shapes a human would actually type a phone number
// in — a bare run of digits is as likely to be a licence number or a price.
export function extractPhones(html = '') {
  const decoded = decodeForEmails(html);
  const found = new Set();

  for (const m of decoded.matchAll(/href\s*=\s*["']\s*tel:([^"'?>]+)/gi)) {
    const n = normalizePhone(m[1]);
    if (n) found.add(n);
  }

  const text = decoded
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  // Requires either a +971/00971 prefix or a separator-formatted local number,
  // which is what keeps ID numbers and prices out.
  for (const m of text.matchAll(/(?:\+|00)971[\s-]?\d[\d\s-]{7,12}|\b0\d[\s-]?\d{3}[\s-]?\d{4}\b|\b05\d[\s-]?\d{3}[\s-]?\d{4}\b/g)) {
    const n = normalizePhone(m[0]);
    if (n) found.add(n);
  }
  return [...found];
}

// A wa.me link IS a phone number, and for a Dubai clinic it is often the number
// they actually answer. Kept separate from `phones` rather than merged: which
// channel a lead published is itself information.
export function extractWhatsApp(html = '') {
  const decoded = decodeForEmails(html);
  const found = new Set();
  for (const m of decoded.matchAll(/(?:wa\.me|api\.whatsapp\.com\/send\?phone=|web\.whatsapp\.com\/send\?phone=)\/?(\+?\d[\d\s-]{6,17})/gi)) {
    const n = normalizePhone(m[1]);
    if (n) found.add(n);
  }
  return [...found];
}

// -------------------------------------------------------------- contact forms

// A form the clinic can be reached through, for the leads that publish no
// address at all. Requires a real message-shaped field: a search box and a
// newsletter signup are both <form>s and neither reaches a human.
export function hasContactForm(html = '') {
  const forms = String(html).matchAll(/<form\b[\s\S]*?<\/form>/gi);
  for (const [form] of forms) {
    const hasTextarea = /<textarea\b/i.test(form);
    const hasEmailInput = /<input[^>]+type\s*=\s*["']?email/i.test(form)
      || /<input[^>]+(?:name|id)\s*=\s*["'][^"']*(?:email|e-mail)/i.test(form);
    const hasMessageField = /(?:name|id)\s*=\s*["'][^"']*(?:message|enquiry|inquiry|comment|subject)/i.test(form);
    if (hasTextarea && (hasEmailInput || hasMessageField)) return true;
    if (hasEmailInput && hasMessageField) return true;
  }
  return false;
}

// Where to look after the homepage. Kept short and same-host: this is a lead
// list, not a crawler, and every extra path is a request against somebody
// else's server.
// [-\s]? throughout, not just -?: this matches link TEXT as well as hrefs, and
// a human writes "Get in touch" with spaces where a URL slug uses hyphens.
const CONTACT_HINTS = /contact|reach[-\s]?us|get[-\s]?in[-\s]?touch|about|imprint|impressum|book|appointment|اتصل|تواصل/i;

export function contactLinks(html = '', baseUrl, limit = 3) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const m of String(html).matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1].trim();
    const label = m[2].replace(/<[^>]+>/g, ' ');
    if (!CONTACT_HINTS.test(href) && !CONTACT_HINTS.test(label)) continue;
    let u;
    try {
      u = new URL(href, base);
    } catch {
      continue;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
    u.hash = '';
    const key = u.toString();
    if (seen.has(key) || key === base.toString()) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= limit) break;
  }
  return out;
}

// ------------------------------------------------------------------- runtime

async function fetchHtml(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': UA, accept: 'text/html,*/*' },
    });
    if (!res.ok) return { ok: false, status: res.status };
    const ct = res.headers.get('content-type') || '';
    if (ct && !/text\/html|application\/xhtml|text\/plain/i.test(ct)) return { ok: false, status: res.status, error: `not html (${ct.split(';')[0]})` };
    return { ok: true, status: res.status, html: await res.text(), finalUrl: res.url };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'timeout' : String(e.message || e) };
  }
}

// One lead: homepage, then up to two contact-ish pages. It no longer stops at
// the first email — a lead that publishes an address may also publish a phone,
// a WhatsApp number and a form, and the point of this pass is a route to every
// clinic, not one address. It still stops early once it has a usable route,
// so a clinic reachable from its homepage costs one request rather than three.
export async function findContactsFor(lead, fetchImpl = fetchHtml) {
  const empty = { emails: [], phones: [], whatsapp: [], source: null, contactFormUrl: null, contactPageUrl: null };
  if (!lead.domain) {
    return { ...empty, reason: 'no website — Google lists none, so there is no page to read; use the phone number' };
  }

  const home = `https://${lead.domain}/`;
  let page = await fetchImpl(home);
  if (!page.ok) {
    const httpTry = await fetchImpl(`http://${lead.domain}/`);
    if (httpTry.ok) page = httpTry;
  }
  if (!page.ok) {
    return { ...empty, reason: `site not readable — ${page.error || `HTTP ${page.status}`}` };
  }

  const visited = [];
  const emails = new Set();
  const phones = new Set();
  const whatsapp = new Set();
  let source = null;
  let contactFormUrl = null;
  let contactPageUrl = null;

  const absorb = (html, url) => {
    const ranked = rankEmails(extractEmails(html), lead.domain);
    if (ranked.length && !source) source = url;
    for (const e of ranked) emails.add(e);
    for (const p of extractPhones(html)) phones.add(p);
    for (const w of extractWhatsApp(html)) whatsapp.add(w);
    if (!contactFormUrl && hasContactForm(html)) contactFormUrl = url;
  };

  const homeUrl = page.finalUrl || home;
  visited.push(homeUrl);
  absorb(page.html, homeUrl);

  // Follow contact pages when the homepage left a gap. A form URL alone is not
  // enough to stop for: the contact page is usually where the address and phone
  // actually live, and it is the URL worth recording either way.
  if (!emails.size || !phones.size) {
    for (const link of contactLinks(page.html, homeUrl, 2)) {
      if (!contactPageUrl) contactPageUrl = link;
      const sub = await fetchImpl(link);
      visited.push(link);
      if (!sub.ok) continue;
      absorb(sub.html, link);
      if (emails.size && phones.size) break;
    }
  }

  const out = {
    emails: rankEmails({ mailto: [...emails], text: [] }, lead.domain),
    phones: [...phones],
    whatsapp: [...whatsapp],
    source,
    contactFormUrl,
    contactPageUrl,
    visited,
  };
  // "No email" is no longer the same as "no route", so the note has to
  // distinguish them or a lead with a phone and a form reads as a dead end.
  if (!out.emails.length) {
    const alt = [out.phones.length && 'a phone', out.whatsapp.length && 'WhatsApp', contactFormUrl && 'a contact form']
      .filter(Boolean).join(', ');
    out.reason = alt
      ? `no address published, but the site does publish ${alt}`
      : 'no address published on the pages read';
  }
  return out;
}

// Kept so anything already calling it keeps working; the new name says what the
// function now does.
export const findEmailsFor = findContactsFor;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

export function parseContactArgs(argv) {
  const out = { input: 'leads.json', out: 'contacts.md', concurrency: 6, noMx: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') { out.out = argv[++i]; continue; }
    if (a.startsWith('--out=')) { out.out = a.slice(6); continue; }
    if (a === '--concurrency') { out.concurrency = Number(argv[++i]); continue; }
    if (a === '--no-mx') { out.noMx = true; continue; }
    if (!a.startsWith('--')) rest.push(a);
  }
  if (rest.length) out.input = rest[0];
  return out;
}

// The classifier names four states, not two. Lumping NO-MAIL, IMPLICIT-MX and
// UNVERIFIED into one "bad" bucket — and deriving the good count by
// subtracting that bucket from the total — let a failed probe (UNVERIFIED)
// get counted as accepting mail, and buried IMPLICIT-MX's "verify before
// sending" addresses under a heading that calls them guaranteed bounces. Every
// count below reads its own verdict directly; nothing is derived by
// subtraction.
//
// `mail` is always set by the caller (checkLeadMail never returns undefined),
// so unlike the code this replaced, nothing here needs `?.` on it.
export function summarizeMail(results) {
  // One entry per clinic that published an address — kept for the per-clinic
  // listings below, where a shared address must still show up once for every
  // clinic that publishes it.
  const entries = results.flatMap((r) => r.mail.addresses.map((a) => ({ clinic: r.name, site: r.mail.site, ...a })));

  // Distinct addresses for every count: six clinics sharing one mailbox is one
  // thing to check, not six, and a run that counted rows instead of addresses
  // printed "7 checked, 6 will not deliver" about 2 distinct addresses.
  const distinctCount = (list) => new Set(list.map((e) => e.email)).size;
  const byVerdict = (verdict) => entries.filter((e) => e.verdict === verdict);
  const noMailAddresses = byVerdict(NO_MAIL);
  const implicitMxAddresses = byVerdict(IMPLICIT_MX);

  return {
    checkedCount: distinctCount(entries),
    capableCount: distinctCount(byVerdict(MAIL_CAPABLE)),
    noMailCount: distinctCount(noMailAddresses),
    implicitMxCount: distinctCount(implicitMxAddresses),
    unverifiedCount: distinctCount(byVerdict(MAIL_UNVERIFIED)),
    // Not deduped: one row per clinic, for the "will not deliver" / "needs
    // verification" sections, where the point is naming every clinic exposed.
    noMailAddresses,
    implicitMxAddresses,
  };
}

async function main() {
  const opts = parseContactArgs(process.argv.slice(2));
  const leads = JSON.parse(await readFile(opts.input, 'utf8'));
  if (!Array.isArray(leads) || !leads.length) {
    console.error(`${opts.input} holds no leads.`);
    process.exit(1);
  }

  console.log(`reading ${leads.length} lead(s) from ${opts.input}\n`);
  // One canary for the whole run, before the fan-out — not once per lead.
  const mailTrusted = opts.noMx ? false : await mxCanaryOk();
  const mailCache = new Map();
  let done = 0;
  const results = await mapLimit(leads, opts.concurrency, async (lead) => {
    const found = await findContactsFor(lead);
    done += 1;
    const routes = [
      found.emails[0],
      found.phones.length && `tel ${found.phones[0]}`,
      found.whatsapp.length && `wa ${found.whatsapp[0]}`,
      found.contactFormUrl && 'form',
    ].filter(Boolean);
    console.log(`[${String(done).padStart(2)}/${leads.length}] ${lead.name.slice(0, 40).padEnd(40)} ${routes.length ? routes.join(' · ') : `— ${found.reason}`}`);
    const mail = await checkLeadMail(
      { domain: lead.domain, emails: found.emails }, mailTrusted, mailCache,
    );
    return {
      ...lead,
      emails: found.emails,
      emailSource: found.source,
      emailNote: found.reason || null,
      sitePhones: found.phones,
      whatsapp: found.whatsapp,
      contactFormUrl: found.contactFormUrl,
      contactPageUrl: found.contactPageUrl,
      mail,
    };
  });

  const withEmail = results.filter((r) => r.emails.length);
  const noSite = results.filter((r) => !r.domain);
  const siteNoEmail = results.filter((r) => r.domain && !r.emails.length);
  // The number that actually matters now: a lead with no email but a phone,
  // a WhatsApp number or a form is reachable, and counting it as unreachable
  // was the gap this pass was added to close.
  const noRoute = results.filter((r) => !r.emails.length && !r.sitePhones.length
    && !r.whatsapp.length && !r.contactFormUrl && !r.phone);

  await writeFile(`${opts.out.replace(/\.md$/, '')}.json`, `${JSON.stringify(results, null, 2)}\n`, 'utf8');

  // Only addresses, not site domains: this section is about what you would send
  // to. A clinic whose site domain cannot receive mail but that published no
  // address has nothing here to bounce.
  const mailSummary = summarizeMail(results);

  const lines = [
    '# Lead contacts',
    '',
    `Run ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · ${results.length} lead(s) · ${withEmail.length} with a published email`,
    '',
    ...(mailTrusted
      ? [`Every address below was checked for a mail server on its own domain — ${mailSummary.checkedCount} checked: `
        + `${mailSummary.capableCount} accept mail, ${mailSummary.noMailCount} will not deliver, `
        + `${mailSummary.implicitMxCount} need verification before sending, ${mailSummary.unverifiedCount} could not be checked.`, '']
      : [`> **Mail capability was not measured** — ${opts.noMx ? 'disabled with \`--no-mx\`' : 'MX resolution failed against a known-good domain, so this network cannot answer the question'}. Every address reads \`${MAIL_UNVERIFIED}\`; treat that as unknown, not as a domain that rejects mail.`, '']),
    'Every address below was read from the page named in Source. None are guessed:',
    'no address is synthesised from a pattern, because a plausible wrong address',
    'is worse than a visible blank.',
    '',
    '| Clinic | Area | Email | Phone (Google) | Phone (site) | WhatsApp | Contact form | Source |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    // Only failures are marked. Marking the good addresses to flag the bad one
    // would put noise in every row; silence is the right signal for "nothing
    // wrong here", and it matches how the audit omits verdicts it has nothing
    // to say about.
    //
    // Nothing is marked at all on an unmeasured run. Every verdict is
    // UNVERIFIED then, so marking would put a warning on every address while
    // saying nothing that distinguishes them — and the blockquote above the
    // table has already said the check did not happen. A single UNVERIFIED on
    // a measured run is different: that one domain failed to answer while the
    // rest did, which is worth seeing.
    const verdictOf = (e) => (mailTrusted
      ? r.mail.addresses.find((a) => a.email === e)?.verdict
      : null);
    const email = r.emails.length
      ? r.emails.map((e) => {
        const v = verdictOf(e);
        return v && v !== MAIL_CAPABLE ? `\`${e}\` **⚠ ${v}**` : `\`${e}\``;
      }).join('<br>')
      : `— _${r.emailNote}_`;
    const src = r.emailSource ? `[page](${r.emailSource})` : '—';
    const form = r.contactFormUrl ? `[form](${r.contactFormUrl})` : (r.contactPageUrl ? `[contact page](${r.contactPageUrl})` : '—');
    lines.push(`| ${r.name.replace(/\|/g, '\\|')} | ${r.area || '—'} | ${email} | ${r.phone || '—'} | ${r.sitePhones.join('<br>') || '—'} | ${r.whatsapp.join('<br>') || '—'} | ${form} | ${src} |`);
  }
  lines.push('', '## Not reachable by email', '');
  lines.push(`- **${noSite.length}** have no website at all — Google lists none, so there is no page to read. Their phone number is the contact route, and they remain the highest-value leads.`);
  lines.push(`- **${siteNoEmail.length}** have a site that published no address on the pages read (homepage plus up to two contact pages). Most of them publish a phone, a WhatsApp number or a form instead — see the columns above.`);
  lines.push('', `- **${noRoute.length}** have no route at all: no email, no phone from Google or their site, no WhatsApp and no form. These need a human to look.`);
  for (const r of noRoute) lines.push(`  - ${r.name}${r.domain ? ` (${r.domain})` : ''} — ${r.emailNote}`);
  if (mailTrusted && mailSummary.noMailAddresses.length) {
    lines.push('', '## Addresses that will not deliver', '');
    lines.push('Checked by MX record. This proves the domain accepts mail — it cannot');
    lines.push('tell you the mailbox exists, so a clean result is not a guarantee of');
    lines.push('delivery.', '');
    for (const a of mailSummary.noMailAddresses) {
      // State the measured fact and stop. Naming a replacement address would
      // mean synthesising info@ from a pattern, which this file refuses to do
      // three hundred lines up and for the same reason: a plausible wrong
      // address is worse than a visible blank. That the site domain accepts
      // mail is measured; which mailbox to use there is not.
      const fix = a.site.verdict === MAIL_CAPABLE && a.site.domain !== a.domain
        ? ` The clinic's website domain \`${a.site.domain}\` does accept mail (${a.site.primary}).`
        : '';
      lines.push(`- **${a.clinic}** — \`${a.email}\` ${describeMail(a)}${fix}`);
    }
  }
  // IMPLICIT-MX is not a bounce — mail.mjs created this state precisely
  // because neither MAIL-CAPABLE nor NO-MAIL is honest for "no MX record, but
  // RFC 5321 would fall back to the web server". It gets its own section,
  // worded as something to verify, so it never reads as a failure alongside
  // the addresses above that actually will not deliver.
  if (mailTrusted && mailSummary.implicitMxAddresses.length) {
    lines.push('', '## Addresses needing verification before sending', '');
    lines.push('No MX record on the address domain; RFC 5321 falls back to its web server,');
    lines.push('which rarely accepts mail — but this is not a confirmed bounce like the');
    lines.push('section above. Verify before sending.', '');
    for (const a of mailSummary.implicitMxAddresses) {
      lines.push(`- **${a.clinic}** — \`${a.email}\` ${describeMail(a)}`);
    }
  }
  await writeFile(opts.out, `${lines.join('\n')}\n`, 'utf8');

  const reachable = results.length - noRoute.length;
  console.log(`\n${withEmail.length} of ${results.length} have a published email`);
  console.log(`${noSite.length} have no website · ${siteNoEmail.length} have a site but published no address`);
  console.log(`${reachable} of ${results.length} are reachable by SOME route (email, phone, WhatsApp or form)`);
  if (mailTrusted) {
    // Matches the markdown headline exactly: the numerator is a direct count
    // of MAIL-CAPABLE addresses, never a subtraction, so a failed probe
    // (UNVERIFIED) can never land in it.
    console.log(`\n${mailSummary.capableCount} of ${mailSummary.checkedCount} addresses are on a domain that accepts mail`);
    console.log(`  ${mailSummary.noMailCount} will not deliver · ${mailSummary.implicitMxCount} need verification before sending · ${mailSummary.unverifiedCount} could not be checked`);
    for (const a of mailSummary.noMailAddresses) console.log(`  will not deliver: ${a.email} (${a.clinic})`);
    for (const a of mailSummary.implicitMxAddresses) console.log(`  verify before sending: ${a.email} (${a.clinic})`);
  }
  if (noRoute.length) {
    console.log(`\n${noRoute.length} with no route at all — these need a human:`);
    for (const r of noRoute) console.log(`  ${r.name}${r.domain ? ` (${r.domain})` : ''}`);
  }
  console.log(`\nwrote ${opts.out} and ${opts.out.replace(/\.md$/, '')}.json`);
}

if (import.meta.main) await main();
