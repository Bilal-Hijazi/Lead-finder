#!/usr/bin/env node
// Lead audit — turns a list of clinic domains into a ranked queue with evidence.
//
// Built for one job: finding Dubai clinics whose web presence is costing them
// bookings, and having the proof in hand before the first email. Every number
// this prints is measured, never estimated. A check that fails records why it
// failed rather than guessing a value — a lead list you cannot trust is worse
// than no list, because you will quote it at someone.
//
// Zero dependencies on purpose: Node builtins plus global fetch. It does not
// belong in the site's package.json and must not drag a supply chain along.
//
//   node audit.mjs leads.json
//   node audit.mjs leads.json --out report.md --no-psi
//
// PageSpeed Insights works without an API key but is rate limited, so requests
// are serialised with a delay. Set PSI_KEY to raise the quota; pass --no-psi to
// skip it entirely when you only want the reachability pass.
//
// Pure helpers are exported and tested; the entry point below only runs when
// this file is executed directly, matching discover.mjs, so importing it for
// a test fires no requests and opens no sockets.

import { promises as dns } from 'node:dns';
import tls from 'node:tls';
import { readFile, writeFile } from 'node:fs/promises';
import { leadValue, demand } from './rank.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TIMEOUT_MS = 15_000;

// PageSpeed gets its own, much longer budget. It is not a request for a
// document — Google loads and instruments the page on its own hardware, and
// that work takes longer the heavier the page is.
//
// This was 60s, and the consequence was measured rather than guessed: across
// two consecutive runs over the same 30 aesthetics sites, 10 and then 11
// requests hit the limit while the transient HTTP 500s cleared on their own.
// The failures were not random. Slow sites take longer to analyse, so the ones
// that ran out of time were disproportionately the slow ones — the tool was
// systematically failing to measure exactly the leads it exists to find, and
// reporting them HEALTHY for want of a number.
//
// 180s costs wall-clock on a run that hits it repeatedly, which is a fair
// trade against silently mis-scoring the best prospects on the list.
const PSI_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------- reachability

// A domain that resolves nowhere is the strongest signal in this whole script:
// the clinic is not merely hard to find, it is absent. Both www and apex are
// tried because plenty of small businesses only ever configured one.
//
// Two resolvers, deliberately. `dns.lookup` goes through the OS resolver and
// works almost everywhere; `dns.resolve4` issues a real DNS query to port 53,
// which corporate networks, VPNs and CI sandboxes routinely refuse. Trusting
// resolve4 alone reports every domain on earth as dead - which is the single
// most damaging wrong answer this tool can produce, because you would email a
// clinic telling them their site is down when it is your own network.
//
// So the two failure modes are kept apart: a name that genuinely does not
// exist (ENOTFOUND / NXDOMAIN) versus a probe we were not allowed to make
// (ECONNREFUSED / EAI_AGAIN). Only the first is ever reported as a dead domain.
const NAME_MISSING = new Set(['ENOTFOUND', 'NXDOMAIN', 'ENODATA']);
// SERVFAIL surfaces as EAI_AGAIN. It means "the zone answered, badly" - which
// is a dead site for every visitor - but it is also what a broken resolver
// returns. The canary below is what separates those two readings.
const ZONE_FAILING = new Set(['EAI_AGAIN', 'ESERVFAIL', 'SERVFAIL']);

// Resolve a domain that certainly exists before trusting any negative result.
// If the canary resolves, the resolver works, so a lead returning SERVFAIL has
// a genuinely broken zone. If the canary fails too, this machine cannot answer
// the question and every negative is reported as UNVERIFIED rather than sold
// to you as a dead domain.
async function canaryOk() {
  for (const probe of ['cloudflare.com', 'google.com']) {
    try { await dns.lookup(probe); return true; } catch {}
  }
  return false;
}

async function resolveName(name) {
  let lookupErr = null;
  let resolveErr = null;
  try {
    const r = await dns.lookup(name);
    return { ok: true, address: r.address, via: 'os-resolver' };
  } catch (e) { lookupErr = e.code || String(e); }
  try {
    const a = await dns.resolve4(name);
    return { ok: true, addresses: a, via: 'dns-query' };
  } catch (e) { resolveErr = e.code || String(e); }
  return { ok: false, lookupErr, resolveErr };
}

async function resolveDns(host, resolverTrusted) {
  const apex = await resolveName(host);
  const www = await resolveName(`www.${host}`);
  const ok = apex.ok || www.ok;

  const codes = [apex.lookupErr, www.lookupErr].filter(Boolean);
  const allMissing = codes.length > 0 && codes.every((c) => NAME_MISSING.has(c));
  const allFailing = codes.length > 0 && codes.every((c) => NAME_MISSING.has(c) || ZONE_FAILING.has(c));

  // `missing` is the only flag the scorer may act on, and it requires a
  // resolver we have proven works. Without the canary, every negative is
  // treated as unverified.
  const missing = !ok && (allMissing || (resolverTrusted && allFailing));
  const zoneFailing = !ok && missing && !allMissing;
  const probeBlocked = !ok && !missing;

  return { ok, apex, www, missing, zoneFailing, probeBlocked, codes, resolverTrusted };
}

// Whether to spend a fetch + TLS probe on this lead at all, given only its
// DNS read. Unconditionally yes: `missing` covers both a genuinely
// nonexistent name and a SERVFAIL zone, and SERVFAIL surfaces identically to
// a resolver hiccup as EAI_AGAIN. `resolverTrusted` was measured once at
// startup by the canary, not at the moment THIS lead is checked, so a
// "missing" verdict can still be a transient blip minutes later — the old
// `dns.ok || dns.probeBlocked` guard trusted that startup reading and skipped
// exactly the case where a fetch was needed to catch the mistake. A page that
// loads is the only evidence that can overrule a blocked or misleading DNS
// probe, so the probe always runs to have a chance of gathering it. A host
// that truly does not exist fails the fetch fast (no TCP handshake to wait
// out), so this costs real latency only on the leads it exists to save from
// a false "NO SITE" verdict. Kept as its own function, rather than inlined
// into the main loop, so a wrong answer here is a small, direct test failure
// instead of a silent skip discovered only by noticing a live clinic printed
// NO SITE.
export function shouldProbeSite(_dnsResult) {
  return true;
}

// Read the certificate directly rather than inferring validity from a failed
// fetch. An expired cert produces a full-page browser interstitial - the
// visitor never sees the site at all - and it is the most demonstrable defect
// you can put in front of an owner, so it is worth reporting precisely.
// `connect` defaults to the real tls.connect but is swappable — tls.connect
// cannot be stubbed from outside an ESM import, so a test that needs to drive
// an expired cert, an untrusted one, a socket error or a timeout has to hand
// this a fake socket instead. Behaviour and return shape are unchanged; this
// is only a seam for the default to be substituted through.
export function checkTls(host, connect = tls.connect) {
  return new Promise((resolve) => {
    const done = (v) => { try { socket.destroy(); } catch {} resolve(v); };
    const socket = connect(
      { host, port: 443, servername: host, timeout: TIMEOUT_MS, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate();
        if (!cert || !cert.valid_to) return done({ ok: false, error: 'no certificate presented' });
        const validTo = new Date(cert.valid_to);
        const daysLeft = Math.floor((validTo - Date.now()) / 86_400_000);
        done({
          ok: socket.authorized && daysLeft > 0,
          authorized: socket.authorized,
          authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
          issuer: cert.issuer?.O || null,
          validTo: validTo.toISOString().slice(0, 10),
          daysLeft,
        });
      },
    );
    socket.on('error', (e) => done({ ok: false, error: e.code || String(e) }));
    socket.on('timeout', () => done({ ok: false, error: 'TLS timeout' }));
  });
}

async function fetchPage(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; lead-audit/1.0)' },
    });
    const html = await res.text();
    return { ok: res.ok, status: res.status, finalUrl: res.url, ms: Date.now() - started, html };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'timeout' : String(e.message || e), ms: Date.now() - started };
  }
}

// ------------------------------------------------------------------ page facts

// Everything here is read from the delivered HTML. No judgement calls: either
// the tag is present or it is not, so the evidence survives an argument with
// whoever built the site.
export function analysePage(html = '') {
  const has = (re) => re.test(html);
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return {
    title: titleMatch ? titleMatch[1].trim().replace(/\s+/g, ' ').slice(0, 120) : null,
    // No viewport meta means the phone renders a desktop layout zoomed out.
    // Most of a Dubai clinic's traffic is a phone, so this is a revenue defect.
    mobileViewport: has(/<meta[^>]+name=["']viewport["']/i),
    whatsapp: has(/wa\.me\/|api\.whatsapp\.com\/send/i),
    telLink: has(/href=["']tel:/i),
    bookingIntent: has(/\b(book|appointment|احجز|موعد)\b/i),
    structuredData: has(/application\/ld\+json/i),
    // Registrar and host parking pages resolve and serve 200, so a naive
    // "is it up" check calls them healthy. They are not a website.
    parked: has(/domain (is )?for sale|buy this domain|parked (free )?courtesy|godaddy\.com\/domain|sedoparking/i),
    bytes: html.length,
  };
}

// Turn a fetched page into page facts — but only when the response actually
// IS the site. fetchPage() returns `ok:false` bodies too (a 404, a 500 with
// an HTML error page), and analysing those scores the SERVER'S error page —
// "no mobile viewport", "no WhatsApp link" — and attributes it to the
// clinic. Gated on `page.ok`, matching the standard the PSI call downstream
// already applies; a non-2xx is itself a finding, reported separately by the
// Fetch line in fmt(), not silently folded into page facts that imply a
// homepage was actually read.
export function analyseIfSite(page) {
  return page?.ok && page.html ? analysePage(page.html) : null;
}

// --------------------------------------------------------------------- speed

// Given PSI's own parsed response body, decide whether it actually measured
// anything. An HTTP 200 is not proof of that: Lighthouse can run and still
// carry `lighthouseResult.runtimeError` (NO_FCP when the page never painted,
// among others), and when it does, `categories.performance.score` is absent
// while individual audits often still hold a bare numericValue of 0 rather
// than being missing outright. The old code's `?? null` let those zeros
// through as if measured, and because no `error` key was ever set, fmt() took
// the "measured" branch and printed "LCP 0.0s ... TBT 0ms" — numbers nothing
// measured. A numeric performance score is now the only thing this treats as
// proof of a real measurement, the same standard a non-2xx response already
// gets; anything else is an error, and PSI's own runtimeError code is
// surfaced when it gave one rather than a generic "no score" message.
export function interpretPsi(data) {
  const audits = data?.lighthouseResult?.audits || {};
  const score = data?.lighthouseResult?.categories?.performance?.score;
  if (typeof score !== 'number') {
    const code = data?.lighthouseResult?.runtimeError?.code;
    return {
      error: code
        ? `PSI ran but could not measure this page — ${code}`
        : 'PSI ran but returned no performance score',
    };
  }
  return {
    score: Math.round(score * 100),
    lcpMs: audits['largest-contentful-paint']?.numericValue ?? null,
    cls: audits['cumulative-layout-shift']?.numericValue ?? null,
    tbtMs: audits['total-blocking-time']?.numericValue ?? null,
  };
}

async function pagespeed(url) {
  const endpoint = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  endpoint.searchParams.set('url', url);
  endpoint.searchParams.set('strategy', 'mobile');
  endpoint.searchParams.set('category', 'performance');
  if (process.env.PSI_KEY) endpoint.searchParams.set('key', process.env.PSI_KEY);

  // One retry on 429. Google's keyless quota is now small enough that it is
  // effectively unusable for a list of any size, so the retry is a courtesy -
  // the real answer is PSI_KEY, and the error text says so rather than leaving
  // a blank column that reads like "this site was fine".
  //
  // PSI_KEY, when set, is IP-restricted on Google's side to the owner's IPv4
  // address. Node's fetch prefers IPv6 under Happy Eyeballs whenever a route
  // exists, so this specific call leaves over IPv6 and Google rejects it with
  // a 403 IP-restriction error even though the IPv4 address is allowlisted —
  // that is a fact about Google's key restriction on THIS call, not about the
  // clinic domain audit.mjs exists to measure.
  //
  // So the IPv4 preference is scoped to this fetch alone, not set for the
  // whole process the way discover.mjs sets it for Places (see that file's
  // comment on `dns.setDefaultResultOrder` — the reasoning below matches it
  // and does not weaken it). audit.mjs's whole job is measuring how a
  // clinic's own domain resolves and connects for a real visitor; forcing
  // IPv4 process-wide here would quietly change the resolver order its own
  // DNS, TLS and page-fetch checks take, which is exactly the measurement
  // this script exists to report honestly.
  //
  // Restored in `finally` rather than only after a normal return, so a thrown
  // exception or the AbortSignal timeout below can never leave the process
  // stuck on ipv4first for every request that follows this one. Mutating a
  // process-wide setting around a single call is only safe because main()
  // processes leads strictly sequentially, `await`ing each one in turn — no
  // other DNS/TLS/fetch call is ever in flight while this is set. If the lead
  // loop is ever parallelised, this becomes a race between leads and must be
  // revisited then.
  const previousResultOrder = dns.getDefaultResultOrder();
  dns.setDefaultResultOrder('ipv4first');
  let res;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await fetch(endpoint, { signal: AbortSignal.timeout(PSI_TIMEOUT_MS) }).catch((e) => ({ ok: false, status: 0, err: e }));
      if (res.ok || res.status !== 429) break;
      await sleep(4000);
    }
  } finally {
    dns.setDefaultResultOrder(previousResultOrder);
  }

  try {
    if (!res.ok) {
      return {
        error: res.status === 429
          ? 'rate limited by Google (keyless quota). Set PSI_KEY to measure speed — see the README'
          : `PSI HTTP ${res.status || res.err?.message || 'request failed'}`,
      };
    }
    const data = await res.json();
    return interpretPsi(data);
  } catch (e) {
    return { error: e.name === 'TimeoutError' ? 'PSI timeout' : String(e.message || e) };
  }
}

// -------------------------------------------------------------------- scoring

// Opportunity, not quality: a high score means "this clinic is losing business
// in a way you can prove", which is the only thing that makes a cold email
// land. Each signal names itself in `reasons` so the report shows its working
// and you can quote the specific defect back to the owner.
export function score(lead) {
  const reasons = [];
  let points = 0;
  const add = (n, why) => { points += n; reasons.push(`${why} (+${n})`); };

  // Named once and read by both the points chain below and the verdict chain
  // further down, so they cannot disagree again. I1: a plain HTTP 500 was
  // scored 45 points as "unreachable" here, but the verdict chain checked
  // only `lead.page?.error` — which a 500 never sets — so the same lead
  // printed verdict HEALTHY, defined in the legend as "nothing measurable to
  // sell against", directly above a 45-point "Site unreachable" bullet.
  const unreachable = Boolean(lead.page?.error) || Boolean(lead.page && lead.page.status >= 500);

  // Only a name that genuinely does not exist scores. A probe we were not
  // allowed to make scores nothing and is surfaced as UNVERIFIED instead - an
  // unchecked lead is recoverable, a false "your site is down" email is not.
  if (lead.dns.missing) {
    add(50, lead.dns.zoneFailing
      ? `DNS zone is failing (SERVFAIL) — the domain is registered but answers nothing, so no visitor reaches the site`
      : `Domain does not resolve — no DNS record (${[...new Set(lead.dns.codes)].join(', ')})`);
  } else if (!lead.dns.ok && lead.dns.probeBlocked) {
    reasons.push('DNS probe blocked by this network and the site did not load — verify by hand before acting (0)');
  } else if (unreachable) {
    add(45, `Site unreachable (${lead.page.error || 'HTTP ' + lead.page.status})`);
  } else if (lead.tls && !lead.tls.ok) {
    const why = lead.tls.daysLeft <= 0 ? `certificate expired ${Math.abs(lead.tls.daysLeft)} days ago`
      : lead.tls.authorizationError || lead.tls.error || 'certificate not trusted';
    add(40, `HTTPS broken - ${why}. Visitors get a full-page browser warning`);
  } else if (lead.analysis?.parked) {
    add(45, 'Domain resolves to a parking page, not a website');
  }

  if (lead.tls?.ok && lead.tls.daysLeft > 0 && lead.tls.daysLeft < 21) {
    add(10, `Certificate expires in ${lead.tls.daysLeft} days`);
  }

  const psi = lead.psi;
  if (psi && typeof psi.score === 'number') {
    if (psi.score < 30) add(25, `PageSpeed mobile ${psi.score}/100`);
    else if (psi.score < 50) add(18, `PageSpeed mobile ${psi.score}/100`);
    else if (psi.score < 70) add(10, `PageSpeed mobile ${psi.score}/100`);
    if (psi.lcpMs && psi.lcpMs > 4000) add(12, `Largest Contentful Paint ${(psi.lcpMs / 1000).toFixed(1)}s (Google's "poor" threshold is 4s)`);
    if (psi.cls && psi.cls > 0.25) add(6, `Layout shift ${psi.cls.toFixed(2)} - content jumps while loading`);
  }

  const a = lead.analysis;
  if (a && !a.parked) {
    if (!a.mobileViewport) add(20, 'No mobile viewport tag - phones render the desktop layout zoomed out');
    if (!a.whatsapp) add(8, 'No WhatsApp link - the channel UAE patients actually use');
    if (!a.telLink) add(6, 'No tap-to-call link');
    if (!a.structuredData) add(5, 'No structured data - invisible to rich results');
  }

  let verdict = 'HEALTHY';
  if (lead.dns.missing) verdict = 'NO SITE';
  else if (!lead.dns.ok) verdict = 'UNVERIFIED';
  else if (lead.analysis?.parked) verdict = 'PARKED';
  else if (unreachable || (lead.tls && !lead.tls.ok)) verdict = 'BROKEN';
  else if (psi && typeof psi.score === 'number' && psi.score < 50) verdict = 'SLOW';
  else if (a && (!a.mobileViewport || !a.whatsapp)) verdict = 'WEAK CONVERSION';

  return { points: Math.min(points, 100), reasons, verdict };
}

// A clinic with no website cannot be measured, so nothing here is measured —
// it is scored directly and no request of any kind is made.
//
// 55 sits above a dead domain's 50 deliberately. A lapsed domain is an asset
// whose owner may already know it is broken; never having had a site means
// every search for their own name lands on a directory that takes a commission
// on the booking.
function scoreNoWebsite() {
  return {
    points: 55,
    verdict: 'NO WEBSITE',
    reasons: [
      'No website on their Google Business Profile — every search for their own name lands on a directory that takes a commission on the booking (+55)',
      'Nothing here was measured: with no domain there is no DNS, TLS, page or PageSpeed request to make (0)',
    ],
  };
}

// SERP position cannot be checked honestly without a paid SERP API - scraping
// Google is against its terms and returns different results per datacentre
// anyway. So this emits the exact queries to run by hand. Directory dominance
// is the single most persuasive piece of evidence you can show a clinic owner,
// and it is worth the two minutes it costs.
function serpQueries(lead) {
  const q = [`"${lead.name}"`, `${lead.name} ${lead.area || 'Dubai'}`, `dentist ${lead.area || 'Dubai'}`];
  return q.map((s) => ({ query: s, url: `https://www.google.com/search?q=${encodeURIComponent(s)}` }));
}

// ------------------------------------------------------------- lead intake

// Before the host is computed, because String(null) is "null", which
// resolves nowhere and would be reported as "Domain does not resolve — no
// DNS record". That is a fabricated measurement about a real clinic, in a
// tool whose entire premise is that every number it prints was measured.
//
// I2: `!= null` alone is not enough — String(true) is "true" and
// String(12345) is "12345", both non-null and non-empty, so a hand-written
// `"domain": true` in leads.json used to pass this guard, get resolved as
// the literal hostname "true", and print a fabricated "Domain does not
// resolve — no DNS record (ENOTFOUND)" about a real clinic: the exact
// mistake this guard exists to prevent, one type away. A `domain` that is
// not a string at all is malformed input, not a domain, but it is treated
// as NO WEBSITE rather than thrown — one bad hand-edited row should not
// abort a run of hundreds of leads.
export function hasUsableDomain(lead) {
  return typeof lead.domain === 'string' && lead.domain.trim() !== '';
}

// Valid JSON that is not an array used to reach `leads.length` /
// `leads.entries()` unchecked: an object has no `.length`, printing
// "auditing undefined lead(s)" before `TypeError: leads.entries is not a
// function"; a string DOES have a `.length` — its character count — so it
// printed a plausible "auditing 13 lead(s)" before the identical crash.
// Naming what was actually found, not just "invalid", is what lets someone
// trace a leads.json produced by, say, `JSON.stringify` of the wrong
// variable back to its cause.
export function validateLeads(parsed) {
  if (!Array.isArray(parsed)) {
    const found = parsed === null ? 'null' : typeof parsed;
    throw new Error(`expected a JSON array of leads, got ${found}`);
  }
  return parsed;
}

// An entry that survives the array check above but is not itself an object —
// a stray string, number or `null` left by a bad hand-edit — would still
// reach `hasUsableDomain`/`buildRow` and throw a raw TypeError reading
// `.domain` off a primitive: the same class of crash the array check exists
// to remove, one level down. Skipped by the caller rather than thrown,
// matching I2's own reasoning a few lines up — one bad row must not abort a
// run of hundreds of good ones.
//
// Deliberately NOT checking for a `name` field: name is arbitrary display
// text, never a measurement, so an entry missing it is not malformed — it
// just prints "undefined" in that lead's line, which is ugly but not
// dishonest. Rejecting it here would abort a run over a cosmetic gap.
export function isLeadEntry(entry) {
  return typeof entry === 'object' && entry !== null && !Array.isArray(entry);
}

// Keys the main loop only ever sets from a measurement it actually took this
// run. Named once and stripped below rather than whitelisted, so arbitrary
// input fields (the README tells you to put provenance in `note`, and
// anything else you add is carried through to report.json) still pass
// through untouched — only the specific keys a probe would have produced are
// ever removed.
const MEASUREMENT_KEYS = ['dns', 'tls', 'page', 'analysis', 'psi', 'httpOnly'];

// The row this lead's measurements accumulate onto, seeded from the input.
//
// C4: `{ ...lead, host }` alone lets any of MEASUREMENT_KEYS ride straight
// through from the input. That input is routinely last run's report.json —
// the README advertises it as raw data to filter or re-sort — so a lead
// re-run after its domain was blanked out (or one that this run's DNS marks
// missing and therefore never re-probes) can still carry last week's
// "DNS: resolves" / "PageSpeed: 99/100" verbatim, with zero requests made
// this run. Stripped here, once, so every path that builds a row — probed or
// not — starts from a lead that cannot be mistaken for having been measured
// until this run's code sets those keys itself.
export function buildRow(lead, host) {
  const row = { ...lead, host };
  for (const key of MEASUREMENT_KEYS) delete row[key];
  return row;
}

// host is derived, and null exactly when there is no domain to derive it
// from — buildRow above still has to set it (see C4's own row.host === null
// assertion, taken right after buildRow returns), so the strip happens one
// step later, at the point a row is finalised for output. The spec is that
// an absent fact is omitted, never printed as a measured `null` — `domain`
// is the sole named exception — and `host` was the one place that rule
// wasn't applied.
export function finalizeHost(row) {
  if (row.host !== null) return row;
  const { host, ...rest } = row;
  return rest;
}

// Labelled explicitly, not switched to local time. toISOString() is always
// UTC but the rendered header used to name no timezone at all, so a report
// read in Dubai (UTC+4) prints a time four hours behind the wall clock with
// nothing to say why — read as a stale file, not a fresh run. The README's
// roadmap is a weekly diff comparing runs across machines and DST, which
// needs an absolute timezone to mean anything, so UTC stays; only the label
// was missing.
export function formatRunTimestamp(date = new Date()) {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// Markdown reads `|` as a column separator. Every cell built from data is run
// through this before it reaches a row, not just the name column, so a
// future column added to the table is covered by construction instead of by
// someone remembering — the domain comes from a URL host (never contains
// one), but the verdict string and the name are both arbitrary text and the
// name is real: 5 of 75 clinic names in the live list carry a literal `|`
// (Google Business listings routinely fold a tagline into the name field).
// An unescaped one shifts every column after it — see FIX2 in the test file
// for a genuine 9-cells-against-8-header row this produced. Only the
// rendered table cell is escaped; the stored name itself is untouched; it is
// still used raw in the per-lead heading and the SERP query links, where a
// literal `|` is correct.
function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|');
}

// ---------------------------------------------------------------------- report

// Anything under 512 bytes rounds to "0KB" under plain toFixed(0), which
// reads as a measured empty page — the exact false "nothing here" this
// tool's whole premise refuses to print — rather than a small one. Below 1KB
// this renders the raw byte count instead, so the smallest real page still
// shows a number that cannot be mistaken for zero; a genuinely empty page
// (0 bytes) renders as "0B", which is an exact reading, not a rounded one.
export function formatPageSize(bytes) {
  return bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(0)}KB`;
}

export function fmt(lead, hasDemand) {
  const l = [];
  l.push(`### ${lead.name} — ${lead.assessment.verdict} (${lead.assessment.points}/100)`);
  l.push('');
  l.push(lead.host
    ? `- **Domain:** \`${lead.host}\`${lead.area ? ` · ${lead.area}` : ''}`
    : `- **Domain:** none listed on Google${lead.area ? ` · ${lead.area}` : ''}`);
  // Every lead in the table's Lead column gets a line here accounting for it
  // — but only in runs that actually rank on lead value (`hasDemand`); a run
  // that declined to rank on it and printed '—' for every row must not then
  // quote a lead value per lead anyway.
  //
  // Disclosure is per component, not per lead: the assumed 0.5 rating prior
  // applies whenever the rating itself is missing, whatever the review count
  // says, and an absent review count is never printed as a measured
  // "0 reviews" — Google not listing a number is not the same fact as Google
  // listing zero.
  if (hasDemand) {
    const ratingKnown = typeof lead.rating === 'number';
    const reviewsKnown = typeof lead.reviews === 'number';
    const ratingText = ratingKnown
      ? `${lead.rating}★`
      : '—★ (no rating on Google — demand uses the assumed unrated prior 0.5)';
    const reviewsText = reviewsKnown
      ? `${lead.reviews} reviews`
      : 'no review count listed (counted as 0)';
    // lead.displayLeadValue and lead.demandStr were computed once, alongside
    // lead.leadValue, when results were assembled — the table reads the same
    // two fields, so this line can never disagree with the table row for the
    // same lead.
    l.push(`- **Demand:** ${ratingText} · ${reviewsText}`
      + ` · lead value **${lead.displayLeadValue}**`
      + ` = opportunity ${lead.assessment.points} × demand ${lead.demandStr}`);
  }
  if (lead.phone) l.push(`- **Phone:** ${lead.phone}`);
  if (lead.note) l.push(`- **Note:** ${lead.note}`);
  if (!lead.dns) {
    // No domain, so nothing was probed. Saying so explicitly keeps an absent
    // measurement from reading as a clean bill of health.
    l.push('- **Checks:** none run — there is no domain to check');
  } else if (lead.dns.missing) {
    l.push(lead.dns.zoneFailing
      ? `- **DNS:** zone failing (SERVFAIL) on apex and www — registered but resolving nothing`
      : `- **DNS:** no record on apex or www — \`${[...new Set(lead.dns.codes)].join(', ')}\``);
  } else if (!lead.dns.ok) {
    l.push(`- **DNS:** could not be checked from this network (\`${[...new Set(lead.dns.codes)].join(', ')}\`) and the site did not load. **Verify by hand — this is not evidence the domain is dead.**`);
  } else {
    l.push(`- **DNS:** resolves${lead.dns.provenByFetch ? ' (confirmed by a successful page load; the DNS probe itself was blocked)' : ''}${lead.httpOnly ? ' · **HTTP only, no working HTTPS**' : ''}`);
    if (lead.tls) {
      l.push(lead.tls.ok
        ? `- **TLS:** valid, expires ${lead.tls.validTo} (${lead.tls.daysLeft} days)${lead.tls.issuer ? ` · ${lead.tls.issuer}` : ''}`
        : `- **TLS:** BROKEN — ${lead.tls.authorizationError || lead.tls.error || 'untrusted'}${lead.tls.validTo ? ` · expired ${lead.tls.validTo}` : ''}`);
    }
    if (lead.page?.error) l.push(`- **Fetch:** failed — ${lead.page.error}`);
    else if (lead.page) l.push(`- **Fetch:** HTTP ${lead.page.status} in ${lead.page.ms}ms → ${lead.page.finalUrl}`);
    if (lead.analysis) {
      const a = lead.analysis;
      l.push(`- **Page:** ${a.parked ? '**parking page, not a site**' : formatPageSize(a.bytes)}`
        + ` · viewport ${a.mobileViewport ? 'yes' : '**no**'}`
        + ` · WhatsApp ${a.whatsapp ? 'yes' : '**no**'}`
        + ` · tel: ${a.telLink ? 'yes' : '**no**'}`
        + ` · schema ${a.structuredData ? 'yes' : 'no'}`);
      if (a.title) l.push(`- **Title:** ${a.title}`);
    }
    if (lead.psi) {
      l.push(lead.psi.error
        ? `- **PageSpeed:** not measured — ${lead.psi.error}`
        : `- **PageSpeed (mobile):** ${lead.psi.score}/100 · LCP ${(lead.psi.lcpMs / 1000).toFixed(1)}s · CLS ${lead.psi.cls?.toFixed(2)} · TBT ${Math.round(lead.psi.tbtMs)}ms`);
    }
  }
  l.push('');
  l.push('**Why this is a lead:**');
  for (const r of lead.assessment.reasons) l.push(`- ${r}`);
  if (!lead.assessment.reasons.length) l.push('- Nothing measurable wrong. Deprioritise.');
  l.push('');
  l.push('**Check by hand (2 min) — does the clinic outrank the directories for its own name?**');
  for (const s of lead.serp) l.push(`- [\`${s.query}\`](${s.url})`);
  l.push('');
  return l.join('\n');
}

// I7: discover.mjs's off-category flag (Example Aesthetics DXB, 2,823 reviews, no
// website — typed skin_care_clinic, not dental) only ever landed inside
// `note`, a field README.md never tells the reader to look at — the ranked
// table is. A flag nobody reading top-down will see is not a flag.
//
// Read from `note`, not `primaryType`, though both ride along on the lead:
// classifyCategory() (discover.mjs) also consults `types` to reach its
// verdict — see the Saray polyclinic case in discover.test.mjs, primaryType
// `doctor` but NOT flagged because a dental entry sits in `types` — and
// `types` itself is never carried onto the lead at all (toLead() only ever
// sets `primaryType`). Re-deriving the flag from primaryType alone here would
// therefore sometimes disagree with the note printed one line below it for
// the very same lead. `note` already carries classifyCategory's actual
// verdict, computed once, so reading it is the only way this table can't
// contradict itself the way I1/I3/C4 already show this codebase cannot
// afford.
//
// Matched on the two stable reason-codes classifyCategory() emits
// ("NOT TYPED AS <CATEGORY> — ...", "CATEGORY MISSING — ...") rather than the
// full sentence, so a wording tweak to the explanatory clause after the dash
// doesn't silently stop the marker from firing.
//
// The category name is deliberately NOT part of the match. discover.mjs gained
// a --category flag, so the label varies by vertical — matching the literal
// "NOT TYPED AS DENTAL" would have kept working on dental runs and silently
// stopped flagging anything on every other one, which is the exact
// fails-quietly-on-the-new-path defect this file has been bitten by before.
const OFF_CATEGORY_MARKERS = ['NOT TYPED AS ', 'CATEGORY MISSING'];

export function isOffCategoryFlagged(lead) {
  return typeof lead.note === 'string' && OFF_CATEGORY_MARKERS.some((m) => lead.note.includes(m));
}

// The ranked table's one row for a lead. Reads exactly the fields the table
// header promises — ★ and Reviews included — so it can never disagree with
// what rank.mjs's `demand()` actually consumed to produce the same row's
// lead-value figure.
//
// I3: `r.rating ?? '—'` printed whatever was there, unfiltered — a string
// "4.5" from a hand-edited leads.json rendered as if Google had reported it,
// while demand() (rank.mjs) discards non-numbers and this same lead's own
// "Why this is a lead" section correctly read "—★ ... no review count
// listed". The table disagreeing with the arithmetic it sits above is the
// exact defect two earlier commits set out to eliminate, so both columns are
// gated on `typeof === 'number'` — the same standard fmt()'s ratingKnown /
// reviewsKnown already use.
export function tableRow(r, hasDemand) {
  const flag = isOffCategoryFlagged(r) ? ' †' : '';
  const cells = [
    hasDemand ? r.displayLeadValue : '—',
    r.assessment.points,
    `${r.name}${flag}`,
    r.assessment.verdict,
    typeof r.rating === 'number' ? r.rating : '—',
    typeof r.reviews === 'number' ? r.reviews : '—',
    r.psi?.score ?? '—',
    r.host || '—',
  ];
  return `| ${cells.map(escapeCell).join(' | ')} |`;
}

// ---------------------------------------------------------------------- main

// A bare `outPath.replace(/\.md$/, '.json')` is a no-op unless outPath
// already ends in .md, so `--out clash-report` sent both the markdown and
// JSON writes to the identical path and the JSON — written second — silently
// clobbered the report. Stripping whatever extension is actually present
// (if any) before adding .json fixes the common case; the equality check
// below covers the one remaining collision, an --out that was already
// *.json, by suffixing rather than reusing the input path outright — so this
// function's two outputs can never be proven to collide, whatever is passed.
// Groups the PageSpeed failures by their error text, commonest first, so the
// banner can name what actually went wrong instead of quoting whichever lead
// happened to be first in the array.
export function psiFailures(attempted) {
  const tally = new Map();
  for (const r of attempted) {
    if (typeof r.psi?.score === 'number') continue;
    const reason = r.psi?.error || 'no score and no error reported';
    tally.set(reason, (tally.get(reason) || 0) + 1);
  }
  return [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count }));
}

// The banner above the table.
//
// This used to fire only when EVERY PageSpeed request failed. Partial failure
// — by far the commoner case — was silent, and a real aesthetics run made the
// cost concrete: 18 of 30 requests failed (10 timeouts, 8 HTTP 500s) and the
// report still stated that every PageSpeed figure below was measured directly.
// One clinic, the highest review count in the set at 714, printed HEALTHY
// with its speed never measured, which reads as "nothing to sell them" about
// a clinic that might be the best lead on the list.
//
// An all-or-nothing warning is the same defect as a blank column: it is the
// middle of the range, where most runs land, that misleads. So any failure is
// disclosed, with the count, and the unmeasured leads are named as unknown
// rather than left to read as healthy.
export function buildPsiNote({ skipPsi, attempted, measured, failures = [] }) {
  if (skipPsi) {
    return '\n> **Speed was not measured** (`--no-psi`). No lead in this run can be classified `SLOW`.\n';
  }
  if (!attempted || !failures.length) return '';

  const why = failures.map((f) => `${f.count}× ${f.reason}`).join(', ');
  if (!measured) {
    return `\n> **Speed was not measured on any lead** — every PageSpeed request failed (${why}). No lead in this run can be classified \`SLOW\`, so treat the absence of that verdict as unknown rather than good.\n`;
  }
  // Timeouts are called out separately because they are not random, and the
  // difference decides what to do about them. Two consecutive runs over the
  // same 30 sites cleared 5 of 8 HTTP 500s and 0 of 10 timeouts — a re-run
  // fixes the transient errors and does nothing for the timeouts, because
  // nothing about those sites got faster between runs.
  //
  // Worse, the bias runs the wrong way: PageSpeed takes longer to analyse
  // heavy, slow-loading pages, so the sites that exhaust the timeout are
  // disproportionately the slow ones. The leads this tool exists to find are
  // the ones it is most likely to fail to measure, which makes an unmeasured
  // HEALTHY actively more suspicious than an average one.
  const timeouts = failures.filter((f) => /timeout|aborted/i.test(f.reason)).reduce((n, f) => n + f.count, 0);
  const advice = timeouts
    ? ` ${timeouts} of those were timeouts, which a re-run will not fix — PageSpeed takes longer on heavy pages, so the sites that time out skew slow. Treat an unmeasured \`HEALTHY\` as more suspicious than a measured one, not less.`
    : ' These are usually transient; re-running clears most of them.';
  return `\n> **Speed was measured on ${measured} of ${attempted} leads.** ${attempted - measured} PageSpeed request(s) failed (${why}). Those leads cannot be classified \`SLOW\` however slow they are, so a \`HEALTHY\` or \`WEAK CONVERSION\` verdict on one of them means speed is **unknown**, not good. Each lead's own section says whether its speed was measured.${advice}\n`;
}

export function sidecarPath(outPath) {
  const base = outPath.replace(/\.[^./\\]+$/, '');
  const sidecar = `${base}.json`;
  return sidecar === outPath ? `${outPath}.json` : sidecar;
}

// Every fetched page's full HTML used to ride straight into the JSON
// sidecar under page.html. Measured on the run that prompted this: 24.3MB
// total, 23.2MB of it raw HTML across 62 leads — and nobody reads it, because
// the facts anyone acts on are already pulled out separately into `analysis`
// (page.bytes covers the size the HTML column of a byte count would have
// shown anyway). It also breaks the README's roadmap: a weekly diff of a
// handful of fields per clinic should not cost ~100MB a month because the
// bulk of every file is a page body nobody re-reads. Dropped only here, at
// the point results become the JSON written to disk — analysePage() still
// needs the live html in memory during the run, so this must not run before
// that, and the markdown report is built from `results` directly and never
// sees this function at all. A pure map so it can be tested without a run.
export function toSerializable(results) {
  return results.map((r) => {
    if (!r.page || !('html' in r.page)) return r;
    const { html, ...page } = r.page;
    return { ...r, page };
  });
}

// The old parser — `args.find((a) => !a.startsWith('--'))` — takes the first
// non-flag token with no idea that `--out` already consumed the token right
// after it, so `audit.mjs --out report.md leads.json` read "report.md"
// itself as the lead list. Walking argv with an index and explicitly
// skipping `--out`'s value slot is the only way that can't happen; unknown
// `--flags` are still skipped rather than treated as the positional arg,
// matching the previous parser's leniency.
export function parseAuditArgs(argv) {
  let inputPath = null;
  let outPath = 'lead-report.md';
  let skipPsi = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-psi') { skipPsi = true; continue; }
    if (a === '--out') { outPath = argv[++i]; continue; }
    if (a.startsWith('--out=')) { outPath = a.slice('--out='.length); continue; }
    if (a.startsWith('--')) continue;
    if (inputPath === null) inputPath = a;
  }
  return { inputPath, outPath, skipPsi };
}

async function main() {
  const { inputPath, outPath, skipPsi } = parseAuditArgs(process.argv.slice(2));

  if (!inputPath) {
    console.error('usage: node audit.mjs <leads.json> [--out report.md] [--no-psi]');
    process.exit(1);
  }

  // Fails on the file's own terms — "expected an array, got X" — rather than
  // the raw TypeError leads.entries() would otherwise throw partway through
  // the run, after this lead count was already printed as if it were real.
  let leads;
  try {
    leads = validateLeads(JSON.parse(await readFile(inputPath, 'utf8')));
  } catch (e) {
    console.error(`${inputPath}: ${e.message}`);
    process.exit(1);
  }
  const resolverTrusted = await canaryOk();
  console.log(`auditing ${leads.length} lead(s)${skipPsi ? ' (PageSpeed skipped)' : ''}`);
  console.log(resolverTrusted
    ? 'DNS resolver verified against a known-good domain — negative results are trustworthy\n'
    : 'WARNING: this machine could not resolve a known-good domain. Every DNS failure below is reported as UNVERIFIED, not as a dead site.\n');

  const results = [];
  for (const [i, lead] of leads.entries()) {
    // A stray primitive in the array (a bad hand-edit, not a lead object at
    // all) would otherwise reach hasUsableDomain/buildRow and throw a raw
    // TypeError reading `.domain` off it. Skipped and named by index instead
    // — one bad row must not abort a run of hundreds of good ones.
    if (!isLeadEntry(lead)) {
      console.log(`[${i + 1}/${leads.length}] skipped — entry ${i} is not a lead object (${JSON.stringify(lead)})`);
      continue;
    }

    const hasDomain = hasUsableDomain(lead);
    const host = hasDomain
      ? String(lead.domain).replace(/^https?:\/\//, '').replace(/\/.*$/, '')
      : null;
    process.stdout.write(`[${i + 1}/${leads.length}] ${lead.name} (${host || 'no website'}) ... `);

    const row = buildRow(lead, host);

    if (!hasDomain) {
      row.assessment = scoreNoWebsite();
      row.serp = serpQueries(lead);
      results.push(finalizeHost(row));
      console.log(`${row.assessment.verdict} (${row.assessment.points})`);
      continue;
    }

    row.dns = await resolveDns(host, resolverTrusted);

    // Always attempt the fetch, even when DNS looked dead. A page that loads is
    // proof the domain resolves, and it is the only evidence that can overrule a
    // blocked or misleading DNS probe.
    if (shouldProbeSite(row.dns)) {
      row.tls = await checkTls(host);
      row.page = await fetchPage(`https://${host}`);
      // A dead HTTPS endpoint does not mean a dead business - plenty of old
      // builds are http-only, and that is itself a finding worth reporting.
      if (row.page.error) {
        const httpTry = await fetchPage(`http://${host}`);
        if (!httpTry.error) { row.page = httpTry; row.httpOnly = true; }
      }
      row.analysis = analyseIfSite(row.page);
      // A successful fetch settles it: the domain resolves, whatever the probe said.
      if (row.page.ok) row.dns = { ...row.dns, ok: true, missing: false, provenByFetch: !row.dns.ok };
      if (!skipPsi && row.page.ok && !row.analysis?.parked) {
        row.psi = await pagespeed(row.page.finalUrl || `https://${host}`);
        await sleep(1200); // stay under the keyless PSI rate limit
      }
    }

    row.assessment = score(row);
    row.serp = serpQueries(lead);
    results.push(finalizeHost(row));
    console.log(`${row.assessment.verdict} (${row.assessment.points})`);
  }

  // Whether a lead carries anything to compute demand from. Used once, below,
  // to decide whether *any* lead in the run has a demand signal at all — which
  // picks the ranking mode and whether the table's Lead column and each lead's
  // Demand line appear. It stays an OR on purpose: one component is enough for
  // the run to rank on lead value. Which component a *given* lead is missing
  // is a separate, per-component question — fmt() answers that on its own, so
  // a lead can pass this test on reviews alone and still have its rating
  // disclosed as assumed.
  const leadHasDemand = (lead) => typeof lead.rating === 'number' || typeof lead.reviews === 'number';

  // Discovery supplies rating and reviews. Without them there is no demand
  // signal at all, and ranking on opportunity alone is the correct fallback
  // rather than a degraded guess.
  const hasDemand = results.some(leadHasDemand);
  for (const r of results) {
    r.demand = demand(r.reviews, r.rating);
    // Unrounded, for sorting only - never printed.
    r.leadValue = leadValue(r.assessment.points, r.reviews, r.rating);
    // The *displayed* lead value, computed once here and read by the table,
    // this lead's own Demand line, and the "top lead" console summary, so the
    // three can never print three different numbers for the same lead. It is
    // derived from the demand string the report actually prints (3dp), not
    // from the unrounded product: rounding the full-precision product directly
    // and rounding from the printed 3dp demand text can cross a .5 boundary
    // differently for the same lead, which is what let the table and the
    // section disagree before. Deriving from the printed figure keeps the
    // equation a reader checks by hand landing on the number beside it.
    r.demandStr = r.demand.toFixed(3);
    r.displayLeadValue = Math.round(r.assessment.points * Number(r.demandStr));
  }
  // Sorted on displayLeadValue, the ROUNDED figure the table and each lead's
  // own Demand line actually print — not on the precise leadValue used to
  // compute it. Math.round(points * Number(demand.toFixed(3))) truncates by up
  // to points × 0.0005, so two leads within about 0.05 of each other on the
  // precise leadValue can sit on opposite sides of a rounding boundary: sorting
  // on leadValue can then print a SMALLER displayed number above a LARGER one,
  // which reads as a broken table even though nothing printed is false. The
  // next reader will be tempted to "fix" this back to leadValue because it
  // looks more precise — resist that, precision is exactly what causes the
  // inversion. leadValue only breaks ties where displayLeadValue matches, so
  // two leads that print the same figure still order deterministically.
  results.sort((a, b) => (hasDemand
    ? (b.displayLeadValue - a.displayLeadValue) || (b.leadValue - a.leadValue)
    : b.assessment.points - a.assessment.points));

  const table = results.map((r) => tableRow(r, hasDemand)).join('\n');

  // If speed was not measured, say so at the top. A blank PageSpeed column
  // otherwise reads as "nothing wrong here", and SLOW becomes a verdict this run
  // was structurally incapable of reaching.
  const psiAttempted = results.filter((r) => r.psi);
  const psiMeasured = psiAttempted.filter((r) => typeof r.psi.score === 'number');
  // Whether the "every figure was measured" line below may name PageSpeed
  // among them. On a run where PSI was skipped, or attempted but never once
  // returned a score, that sentence naming PageSpeed is vacuously true rather
  // than false — there are zero PageSpeed figures printed to be honest about —
  // but the banner right above it already says speed was not measured, so the
  // sentence should not separately claim it was.
  const speedWasMeasured = psiMeasured.length > 0;
  const psiNote = buildPsiNote({ skipPsi, attempted: psiAttempted.length, measured: psiMeasured.length, failures: psiFailures(psiAttempted) });

  const report = `# Lead audit

Run ${formatRunTimestamp()} · ${results.length} lead(s)${skipPsi ? ' · PageSpeed skipped' : ''}
${psiNote}

${hasDemand
    ? `Ranked by **lead value** — opportunity × demand. A broken website only costs
someone money if people are looking for them, so a busy practice with a merely
slow site outranks a struggling one with a dead site. Opportunity is measured
here; demand comes from the Google rating and review count discovery supplied.`
    : `Ranked by **opportunity** alone: no lead in this run carries a rating or
review count, so there is no demand signal to rank on. Run \`discover.mjs\` to
supply one.`}

${speedWasMeasured
    ? 'Every opportunity, DNS, TLS and PageSpeed figure below was measured directly —\nnothing there is inferred.'
    : 'Every opportunity, DNS and TLS figure below was measured directly — nothing\nthere is inferred.'} Lead value is opportunity (measured) × demand:
demand comes from the Google rating and review count discovery supplied, and
the rating half of it is assumed at the unrated prior of 0.5 for any lead
with **no rating**, whatever its review count — each lead's own section says
which parts, if any, were assumed.

| Lead | Opp | Clinic | Verdict | ★ | Reviews | PSI | Domain |
|---:|---:|---|---|---:|---:|---:|---|
${table}

**Verdicts.** \`NO WEBSITE\` no domain was ever listed, so nothing was checked ·
\`NO SITE\` a domain was checked and does not resolve · \`PARKED\` resolves to a
holding page · \`BROKEN\` unreachable or HTTPS failing · \`SLOW\` PageSpeed
mobile under 50 · \`WEAK CONVERSION\` loads fine but missing mobile viewport or
WhatsApp · \`HEALTHY\` nothing measurable to sell against. A **†** beside a
name means Google does not type that place as \`dental_clinic\` or \`dentist\`
— check it by hand before treating it as a dental lead; nothing was dropped.

**One thing this cannot do.** Search position is not checked. Scraping Google
is against its terms and returns different results per datacentre, so a rank
this script printed would be a number you could not defend. The per-lead
queries below take two minutes each and give you a screenshot instead — and a
clinic sitting below Okadoc and Doctify for its own name is the most persuasive
evidence in this entire report.

---

${results.map((r) => fmt(r, hasDemand)).join('\n---\n\n')}`;

  // Computed once, so the two writes below and the console line reporting
  // them can never name three different paths for the same run.
  const sidecar = sidecarPath(outPath);
  await writeFile(outPath, report, 'utf8');
  await writeFile(sidecar, JSON.stringify(toSerializable(results), null, 2), 'utf8');

  console.log(`\nwrote ${outPath} and ${sidecar}`);
  // Report whichever figure the run actually ranked on. Printing
  // assessment.points here when leads were sorted by lead value would report
  // the ordering's input rather than its key — a lead can be top by lead value
  // without having the highest opportunity in the list. Reads displayLeadValue,
  // the same field the table and this lead's own Demand line read, so the
  // console summary can never be the one place that quotes a third number.
  const topFigure = hasDemand && results[0]
    ? `lead value ${results[0].displayLeadValue}`
    : `${results[0]?.assessment.points}/100`;
  console.log(`top lead: ${results[0]?.name} — ${results[0]?.assessment.verdict} (${topFigure})`);
}

if (import.meta.main) await main();
