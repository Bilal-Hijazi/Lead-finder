# Lead audit

Turns a list of clinic domains into a ranked queue with the evidence attached,
so a cold approach opens with a measured fact rather than an opinion.

```bash
node audit.mjs leads.json --out report.md
```

Writes `report.md` (read this) and `report.json` (the raw data, if you want to
filter or re-sort it).

`discover.mjs` builds that list for you — Places API in, `leads.json` out:

```bash
PLACES_KEY=... node discover.mjs \
  --query "dental clinic" --query "dentist" \
  --near "25.2388,55.2711" --radius 5000 --area "Jumeirah"
```

`--near` is the centre of the area you want, not the city centre, and `--area`
is a filter, not a caption. Both matter — see
[the geographic filter](DISCOVERY.md#how-the-geographic-filter-works) for why a
run that got either wrong returned a list where 67 of 75 leads were not in
Jumeirah at all.

Counts drift between runs. Google's relevance ordering is not deterministic, so
re-running the identical command is not guaranteed to return the identical
total. That is Google's ordering changing, not the tool malfunctioning — but a
count that drops sharply after a `--near` or `--area` change is the filters
doing their job, which is a different thing, and the run names every drop so
the two are never confused. The shape of that output (numbers will differ):

```
N results · N unique after dedupe · N dropped (outside 5000m) · N dropped (address not in "Jumeirah") · N written
dropped as outside "Jumeirah", by district: Business Bay (11), Al Wasl (11), Trade Center First (6), ...
```

The district breakdown is not decoration: it is how you catch the filter
rejecting something it should have kept. Replaying the previous 75-lead
`leads.json` through the `--area` filter keeps 8 and drops 67, and those 67
are exactly the Business Bay, Al Wasl, Trade Centre, Deira, Karama and Garhoud
addresses that should never have been on a Jumeirah list.

`--query` is repeatable and each phrase runs as its own search, because Google
caps a single text search at 60 results. If a query comes back saturated the
run says so: the area is not fully enumerated and the list is a floor, not a
census.

It also finds the lead type this script structurally cannot: **a clinic with no
website at all.** The audit starts from a domain, so a clinic that never had one
could not enter it — and that includes clinics whose only listed "website" is a
Facebook page or a dead `business.site` address. Those score `NO WEBSITE` with
nothing probed, because there is nothing to probe.

It also flags, but never filters, category. Google's text search matches on
relevance, not on category, so the result list is not automatically all-dental.
In the run above, the *top-ranked* lead by lead value — 2,823 reviews, no
website — was `Example Aesthetics DXB`, which Google types as `skin_care_clinic`: a real
clinic, but an aesthetics one, not a dental one. `discover.mjs` requests
`primaryType` and `types` and flags any lead Google does not categorise as
`dental_clinic` or `dentist`, so that shows up in the lead's note instead of
quietly passing as a dental lead. The flag is deliberately not a filter: a
genuine dental practice can be typed oddly too — one in the same run,
`Sample Dental Medical Center`, carries no dental type data at all — and silently
dropping it would be worse than showing it with a caveat.

`PLACES_KEY` needs **Places API (New)** enabled — that is a separate console
entry from the legacy "Places API", and only the new one serves these endpoints.

## Input

```json
[
  { "name": "Example Dental Centre", "domain": "exampledental.ae", "area": "Jumeirah 1" }
]
```

`name` is required. `domain` is a bare host like `exampledental.ae` — or `null`,
which is not a missing field but the highest-value lead type discovery
produces: it means Google lists no website of the clinic's own, so nothing is
probed and the lead scores `NO WEBSITE` directly. `area` sharpens the search
queries and is worth filling in. Anything else you add is carried through to
the report, so `note` is a good place for where the lead came from.

## What it measures

| Check | How |
|---|---|
| Domain resolves | OS resolver, then a raw DNS query, then a page load |
| HTTPS valid | Reads the certificate directly — issuer, expiry, trust |
| Site loads | Follows redirects, records status and time |
| Parked page | Detects registrar/host holding pages, which return 200 and look alive |
| Mobile viewport | Missing means phones get the desktop layout zoomed out |
| WhatsApp / tap-to-call | The channels UAE patients actually use |
| Structured data | Whether it can appear in rich results at all |
| Speed | PageSpeed Insights, mobile — score, LCP, CLS, TBT |
| Address can receive mail | MX records for every address found and for the site domain, with A/AAAA fallback per RFC 5321 |

## Verdicts

`NO WEBSITE` · `NO SITE` · `PARKED` · `BROKEN` · `SLOW` · `WEAK CONVERSION` ·
`HEALTHY` · `UNVERIFIED`

`NO WEBSITE` and `NO SITE` are different findings and the distinction matters
on a call: `NO WEBSITE` means no domain was ever listed, so nothing was checked.
`NO SITE` means a domain was checked and does not resolve.

Ranked by **lead value** — opportunity × demand — once discovery has supplied
ratings and review counts, and by opportunity alone before that. The report
header always names which, so the table is never ambiguous about what ordered it.

A lead with no rating on Google is still ranked: demand assumes the unrated
prior of 0.5 for it, and that lead's own section in the report says plainly
that the figure was assumed rather than measured — the tool never prints a
number it did not measure without labelling it as such.

The top of a live Jumeirah run, ranked by lead value:

```
| Lead | Opp | Clinic | Verdict | ★ | Reviews | PSI | Domain |
| 171 | 55 | Example Aesthetics DXB | NO WEBSITE | 4.4 | 2823 | — | — |
| 171 | 55 | Sample Smile Dental Clinic LLC | NO WEBSITE | 4.9 | 1250 | — | — |
| 158 | 45 | Northgate Clinic Emirates Towers Sheikh Zayed Road | BROKEN | 4.9 | 3254 | — | northgate.example |
| 151 | 54 | Harbour Dental Center Satwa Dubai | BROKEN | 4.9 | 606 | — | harbourdental.example |
| 116 | 55 | Example Dental Centre | NO WEBSITE | 4.7 | 120 | — | — |
```

Real patient demand with no way to capture it sits above clinics whose sites
are merely broken — that ordering is the entire reason to rank on lead value
instead of opportunity alone.

## Three honest limits

**Search position is not checked.** Scraping Google is against its terms and
returns different results per datacentre, so any rank this printed would be a
number you could not defend to a clinic owner. Instead each lead gets three
ready-to-run queries. Two minutes and a screenshot beats a fabricated metric —
and a clinic sitting below Okadoc or Doctify for its own name is the single
most persuasive thing in the report.

**`UNVERIFIED` means the tool could not answer, not that the site is fine.**
Before trusting any negative result, it resolves a known-good domain. If that
canary fails, this machine's DNS is unreliable and every failure is reported as
`UNVERIFIED` rather than sold to you as a dead domain — because emailing a
clinic to say their site is down when it is your network is not a recoverable
mistake.

**A `MAIL-CAPABLE` domain is not a working mailbox.** The check proves DNS will
route mail to the domain. It cannot tell you anyone reads `info@`, and it never
will: answering that needs an SMTP `RCPT TO` probe, and catch-all servers accept
every address, Google and Microsoft answer misleadingly on purpose, and repeated
probes from a residential IP earn a blocklist entry on the address you send real
mail from. Prefer an address you saw on the clinic's own page.

What it does remove is the bounce you cannot see coming. It checks **the domain
of each address**, not the clinic's website — those differ for 9 of the 20
addresses on the current list. One clinic publishes `info@sampldent.com` on
`sampledentdubai.com`; the address domain does not exist and will hard-bounce,
while the website's domain runs Google Workspace quite happily. Checking the
website would have cleared that address to send.

`IMPLICIT-MX` is the verdict to read carefully. The domain has no MX record, so
RFC 5321 says deliver to its address record — which is a web server, and web
servers rarely accept mail. Six site domains on the current list are in this
state. Treat it as "verify before sending", not as a failure.

`--no-mx` skips the check for a fast offline pass. The report says so at the
top, so a skipped run is never mistaken for a clean one.

## PageSpeed needs a key

Google's keyless quota now returns `429` almost immediately, so in practice
speed is only measured with a key. It is free:

1. Google Cloud Console → APIs & Services → enable **PageSpeed Insights API**
2. Credentials → Create credentials → API key
3. `PSI_KEY=your-key node audit.mjs leads.json`

Without it, run `--no-psi` for a fast reachability-only pass. Either way the
report states at the top that speed was not measured, so a blank column is
never mistaken for a fast site.

## Discovery needs a key

Same pattern as `PSI_KEY`, and also free:

1. Google Cloud Console → APIs & Services → enable **Places API (New)**
   (`places.googleapis.com`) — a separate console entry from the legacy
   "Places API". Only the new one serves the endpoints `discover.mjs` calls;
   enabling the legacy API does nothing for this tool.
2. Credentials → Create credentials → API key
3. `PLACES_KEY=your-key node discover.mjs --query "dental clinic" --near "25.2388,55.2711" --radius 5000 --area "Jumeirah"`

If the key is IP-restricted, note that Node's `fetch` prefers IPv6 wherever a
route exists. `discover.mjs` pins IPv4 before its first request for exactly
this reason — without it, a call can leave over IPv6 and Google rejects it
with `API_KEY_IP_ADDRESS_BLOCKED` even against a correct IPv4 allowlist entry.

## Where this is going

Discovery is built. The remaining piece is the one with the real leverage:

**Run it weekly against every clinic in Dubai and diff against last week.**

A clinic whose certificate expired *last Tuesday* is a far better lead than one
that has been broken for two years — it is urgent, nobody else has contacted
them about it, and **they may not know yet**, so you are doing them a favour
rather than criticising their website. "Your certificate expired on Tuesday and
visitors are seeing a security warning", sent Wednesday, is a different email
from "your site looks outdated".

That turns a static list into an event stream. The weekly output becomes
"3 clinics broke this week, 1 got notably slower, 1 recovered" instead of 200
rows you have already read.

Shape: a scheduled job (GitHub Actions is free for private repos), the existing
`audit.mjs`, and a `diff.mjs` comparing this run's JSON against the last. The
audit already writes JSON, so the diff is perhaps 60 lines.

**Stop short of automating the emails.** Cold email at volume from
your main domain damages its's sending reputation — the same domain
that delivers your contact-form notifications — and recovering that takes
months. There is a correctness problem too: the pitch works *because* it is
specifically true about them, and a templated blast is only as accurate as its
worst false positive. The day you tell a clinic their site is down when it is
not, you have lost that clinic and anyone they talk to. Automate the finding;
write the emails yourself.

## Reading the output

Work top down. The first section is a ranked table; below it, one block per
lead with the measurements and a `Why this is a lead` list where every line
names its own evidence. Those lines are written to be quotable more or less
verbatim in a first email — they are facts about the clinic's site, not claims
about your service.

Leads scoring 0 with verdict `HEALTHY` have nothing measurable to sell against.
Deprioritise them; a site that already works is the hardest sale there is.
