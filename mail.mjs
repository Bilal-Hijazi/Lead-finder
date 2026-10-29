// Mail deliverability — can the domain behind an address actually receive email?
//
// contacts.mjs already refuses to synthesise an address from a pattern, on the
// grounds that a plausible wrong address is worse than a visible blank. This
// applies the same standard to the addresses it *does* find, because reading an
// address off a clinic's own page turns out not to prove it works.
//
// The unit of the check is a mail domain, not a clinic. Those come apart more
// often than you would guess: of the 20 addresses on the current list, 9 sit on
// a domain other than the clinic's website. One clinic publishes
// info@sampldent.com on sampledentdubai.com — note the missing "e" — and that
// domain does not exist, so the address hard-bounces while the website's own
// domain routes mail through Google Workspace quite happily. Checking the
// website domain would have cleared that address to send.

import { promises as dns } from 'node:dns';

export const MAIL_CAPABLE = 'MAIL-CAPABLE';
export const NO_MAIL = 'NO-MAIL';
export const IMPLICIT_MX = 'IMPLICIT-MX';
export const UNVERIFIED = 'UNVERIFIED';

// Codes that constitute an answer ("there are no MX records here") as opposed
// to a failure to ask. Anything not listed is a failed probe, and a failed
// probe is never allowed to become a claim about the clinic.
const ANSWERED = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

// RFC 7505: one MX, preference 0, exchange "." means the domain accepts no
// mail. Node strips the root label, so it arrives as an empty string — a check
// written against the RFC's spelling alone silently matches nothing.
export function isNullMx(records) {
  return records.length === 1
    && records[0].priority === 0
    && (records[0].exchange === '' || records[0].exchange === '.');
}

// Pure: takes what DNS returned and names the state. No network, no clock.
export function classifyMail({ mxRecords, mxCode, addrOk, addrCode } = {}) {
  const codes = [mxCode, addrCode].filter(Boolean);

  if (mxCode && !ANSWERED.has(mxCode)) {
    return { verdict: UNVERIFIED, records: [], primary: null, codes };
  }

  const records = [...(mxRecords || [])].sort((a, b) => a.priority - b.priority);

  if (records.length) {
    if (isNullMx(records)) {
      return { verdict: NO_MAIL, records, primary: null, codes, reason: 'null-mx' };
    }
    return { verdict: MAIL_CAPABLE, records, primary: records[0].exchange, codes };
  }

  // No MX. RFC 5321 section 5.1 falls back to the address record — but that
  // host is a web server, and web servers rarely answer on port 25. Neither
  // MAIL-CAPABLE nor NO-MAIL is honest, so it gets its own state.
  if (addrOk) return { verdict: IMPLICIT_MX, records: [], primary: null, codes };
  if (addrCode && !ANSWERED.has(addrCode)) {
    return { verdict: UNVERIFIED, records: [], primary: null, codes };
  }
  return { verdict: NO_MAIL, records: [], primary: null, codes, reason: 'no-records' };
}

// audit.mjs guards its DNS negatives with a canary built on dns.lookup, which
// goes through the OS resolver and answers on networks that permit no outbound
// DNS at all. resolveMx has no such path — it queries a nameserver on port 53
// directly, which VPNs and CI sandboxes routinely refuse. A passing dns.lookup
// is therefore not evidence that resolveMx works, so this needs its own canary.
// Without it, running on a VPN reports the entire Dubai dental market as unable
// to receive email.
export async function mxCanaryOk(resolver = dns) {
  for (const probe of ['google.com', 'cloudflare.com']) {
    try {
      const records = await resolver.resolveMx(probe);
      if (records.length) return true;
    } catch {}
  }
  return false;
}

export async function resolveMail(domain, mxCanaryTrusted, resolver = dns) {
  if (!mxCanaryTrusted) {
    return { domain, verdict: UNVERIFIED, records: [], primary: null, codes: ['mx-canary-failed'] };
  }

  let mxRecords = null;
  let mxCode = null;
  try { mxRecords = await resolver.resolveMx(domain); } catch (e) { mxCode = e.code || String(e); }

  // The address record is consulted only when there is no MX to consult — an
  // MX-bearing domain's A record says nothing about where its mail goes.
  let addrOk = false;
  let addrCode = null;
  if (!mxRecords || !mxRecords.length) {
    let addr4 = null;
    try {
      addr4 = await resolver.resolve4(domain);
    } catch (e) {
      addrCode = e.code || String(e);
    }

    // Node signals "no records" as a thrown error or as a resolved empty
    // array — an IPv6-only domain answers resolve4 with [], not a throw, so
    // both shapes must fall back to resolve6 the same way.
    if (addr4 && addr4.length) {
      addrOk = true;
    } else {
      try {
        if ((await resolver.resolve6(domain)).length > 0) { addrOk = true; addrCode = null; }
      } catch (e) {
        if (!addrCode) addrCode = e.code || String(e);
      }
    }
  }

  return { domain, ...classifyMail({ mxRecords, mxCode, addrOk, addrCode }) };
}

// Split on the last @: the local part may legally contain a quoted one.
export function emailDomain(address) {
  const at = String(address).lastIndexOf('@');
  if (at === -1) return null;
  return String(address).slice(at + 1).trim().toLowerCase() || null;
}

// "Can I email this clinic today?" One reachable address is enough to say yes;
// the dead ones keep their own entries, because you need to know which to use.
// With nothing found there is no address to send to, so the answer can never
// be yes: a MAIL-CAPABLE site domain is downgraded to UNVERIFIED here rather
// than asserting emailability for a clinic with zero known addresses — the
// site domain accepting mail says a future address there is worth trying, not
// that this lead can be emailed today. Anything short of MAIL-CAPABLE
// (NO-MAIL, IMPLICIT-MX, UNVERIFIED) is passed through unchanged: none of
// those claim emailability, so none of them need downgrading.
export function rollupMail(site, addresses) {
  if (!addresses.length) return site.verdict === MAIL_CAPABLE ? UNVERIFIED : site.verdict;
  if (addresses.some((a) => a.verdict === MAIL_CAPABLE)) return MAIL_CAPABLE;
  for (const worst of [NO_MAIL, IMPLICIT_MX]) {
    if (addresses.some((a) => a.verdict === worst)) return worst;
  }
  return UNVERIFIED;
}

export async function checkLeadMail(lead, mxCanaryTrusted, cache = new Map(), resolver = dns) {
  // Cache the promise, not the result. main() fans out six workers at a time,
  // and a result-keyed cache is checked and filled on separate ticks — so two
  // workers reaching gmail.com together would both miss and both query.
  const lookup = (domain) => {
    if (!cache.has(domain)) cache.set(domain, resolveMail(domain, mxCanaryTrusted, resolver));
    return cache.get(domain);
  };

  // Normalise the same way emailDomain does, so a lead whose domain differs
  // only in case from an address domain shares one cache entry, not two.
  const leadDomain = lead.domain ? String(lead.domain).trim().toLowerCase() || null : null;
  // `codes` otherwise holds only DNS error codes (ENOTFOUND and the like);
  // there was no DNS query here to produce one, so it stays empty and the
  // reason — there being no domain to query — goes in `reason`, matching how
  // classifyMail already uses that field for 'null-mx' and 'no-records'.
  const site = leadDomain
    ? await lookup(leadDomain)
    : { domain: null, verdict: UNVERIFIED, records: [], primary: null, codes: [], reason: 'no-domain' };

  const addresses = await Promise.all((lead.emails || []).map(async (email) => {
    const domain = emailDomain(email);
    if (!domain) return null;
    return { email, ...(await lookup(domain)) };
  }));
  const found = addresses.filter(Boolean);

  return { canaryTrusted: mxCanaryTrusted, site, addresses: found, rollup: rollupMail(site, found) };
}

export function describeMail(entry) {
  const codes = [...new Set(entry.codes || [])].join(', ');
  switch (entry.verdict) {
    case MAIL_CAPABLE:
      return `MAIL-CAPABLE · ${entry.primary}`;
    case NO_MAIL:
      return entry.reason === 'null-mx'
        ? 'NO-MAIL — publishes a Null MX record (RFC 7505); it accepts no email'
        : `NO-MAIL — no MX and no address record (${codes || 'nothing resolved'}). Mail to it will bounce.`;
    case IMPLICIT_MX:
      return 'IMPLICIT-MX — no MX record; RFC 5321 would deliver to the web server, which is unlikely to accept it. Verify before sending.';
    default:
      return 'UNVERIFIED — MX could not be resolved from this network. Not evidence the domain rejects mail.';
  }
}
