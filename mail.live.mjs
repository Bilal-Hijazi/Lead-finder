#!/usr/bin/env node
// Live confirmation that the fixtures in mail.test.mjs still match reality.
// Deliberately not part of `node --test`: these are domains we do not control,
// and a suite that goes red when a clinic changes host is one people stop
// reading.
//
//   node mail.live.mjs
//
// Every expectation below was observed on 2026-09-02. If one fails, check
// whether the domain moved before changing any code — a changed answer here is
// usually news about the clinic, not a bug.

import { mxCanaryOk, resolveMail, MAIL_CAPABLE, NO_MAIL, IMPLICIT_MX } from './mail.mjs';

const CASES = [
  ['google.com', MAIL_CAPABLE, 'smtp.google.com', 'Google Workspace'],
  // Microsoft 365, and a legitimate preference-0 MX — which is worth a case of
  // its own, because it is the input a careless Null MX check false-positives
  // on. Replaced a clinic domain (Etisalat) on 2026-09-02: that zone began returning
  // SERVFAIL for every record type, MX, A, NS and SOA alike, a few hours after
  // it was first probed. This script caught it, which is what it is for. The
  // tool reported the clinic UNVERIFIED rather than NO-MAIL, which is correct —
  // a zone that answers nothing is not a domain that refuses mail.
  ['github.com', MAIL_CAPABLE, 'github-com.mail.protection.outlook.com', 'Microsoft 365, preference 0'],
  ['example.com', NO_MAIL, null, 'Null MX, returned by Node as an empty exchange'],
  ['nonexistent-domain-xyz.invalid', NO_MAIL, null, 'a domain that does not exist (ENOTFOUND)'],
  ['web.dev', IMPLICIT_MX, null, 'no MX via an ENODATA rejection'],
  ['www.google.com', IMPLICIT_MX, null, 'no MX, only a web server address record'],
];

const trusted = await mxCanaryOk();
if (!trusted) {
  console.error('MX canary failed — this network cannot resolve MX. Nothing below would mean anything.');
  process.exit(2);
}

let failed = 0;
for (const [domain, expected, primary, why] of CASES) {
  const got = await resolveMail(domain, true);
  const ok = got.verdict === expected && (primary === null || got.primary === primary);
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${domain.padEnd(24)} ${got.verdict.padEnd(13)}`
    + `${(got.primary || '').padEnd(26)} ${why}`);
  if (!ok) console.log(`     expected ${expected}${primary ? ` · ${primary}` : ''} · codes ${JSON.stringify(got.codes)}`);
}

console.log(failed
  ? `\n${failed} case(s) no longer match — verify by hand before changing code.`
  : '\nAll live cases match.');
process.exit(failed ? 1 : 0);
