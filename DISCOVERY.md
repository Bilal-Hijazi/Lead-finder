# Discovery tool — `discover.mjs`

**Built.** This is the agreed shape it was built from. Four things here turned
out to be wrong or missing once the API was actually called — the result caps,
social and `business.site` "websites", where `leads.json` is gitignored, and
category flagging, which was decided and shipped after this page was written
and is not described here at all. All four are corrected or covered in
`docs/superpowers/specs/2026-08-24-lead-discovery-design.md`, which is the
accurate document wherever the two disagree — read this page as the design
snapshot from before the API was ever called, not as current documentation of
what shipped.

## What it does

Turns a place into a list of dental clinics with their websites attached, so
the audit has something to run against without anyone typing domains by hand.
This is built for dental outreach specifically, not a general-purpose place
search — see "Category flagging" below.

```
"dentists within 5km of Jumeirah"  →  leads.json  →  audit.mjs  →  report.md
```

Today `leads.json` is hand-built from Google Maps, which caps the whole
pipeline at however many clinics you can be bothered to look up. This removes
that ceiling — one command produces the full addressable market for an area.

It also finds a lead type the audit **structurally cannot see**: a clinic with
no website at all. The audit starts from a domain, so a clinic that has never
had one can't enter it. Those are the strongest leads on the list and they are
currently invisible.

## How it does it

Google's **Places API**, which is the legitimate front door for exactly this.
Two calls were planned; one shipped:

1. **Search** — `places:searchText` (a phrase like `"dental clinic Jumeirah
   Dubai"`). Returns up to 20 results per page with a `nextPageToken` for
   more. `places:searchNearby` (a coordinate and a radius, no phrase) was the
   other option considered here; it never shipped, because ranking on a
   phrase like "dental clinic" is the whole point — proximity alone can't
   express dental versus any other business nearby.
2. **Details** — never called. This page said a second call "usually" isn't
   needed if the search field mask already returns everything; in practice it
   never is. The search field mask below already returns `websiteUri` and
   everything else the audit needs in one round trip.

Field masks (`X-Goog-FieldMask`) are how you control cost — you're billed by
which fields you ask for. What shipped requests these:

```
places.id
places.displayName
places.websiteUri
places.nationalPhoneNumber
places.rating
places.userRatingCount
places.businessStatus
places.formattedAddress
places.primaryType
places.types
nextPageToken
```

The first eight are what this page originally proposed. `primaryType` and
`types` were added later for category flagging — see
`docs/superpowers/specs/2026-08-24-lead-discovery-design.md` for that
decision in full. `nextPageToken` was simply missing from the original list
above: the search step already described here returns one, and it has to be
named in the mask to get it back.

Then: dedupe by place id, strip `websiteUri` down to a bare host, drop anything
whose `businessStatus` isn't operational, and write the file.

## Category flagging

Not part of the shape this page describes — decided and shipped afterward,
during implementation. `searchText` matches on relevance, not category, so
the result list is not automatically all-dental; the tool now requests
`primaryType`/`types` and flags (never drops) any lead Google doesn't
categorise as `dental_clinic` or `dentist`. See
`docs/superpowers/specs/2026-08-24-lead-discovery-design.md` for why it flags
rather than filters and the live data that shaped it.

**Not scraping.** Scraping Google Search results breaks its terms, gets
CAPTCHA'd, and returns different results per datacentre — a domain list built
that way is one you couldn't defend if a clinic asked where you got it. The
Places API returns the same data through the door Google opened for it.

## Tools it uses

| | |
|---|---|
| Google Places API (New) | Discovery and the `websiteUri` field |
| `PLACES_KEY` env var | Never committed; same pattern as `PSI_KEY` |
| Node builtins + `fetch` | Zero dependencies, matching `audit.mjs` |

Free-tier alternatives if you'd rather not enable billing: **OpenStreetMap /
Overpass** (no key, many businesses carry a `website` tag, but patchier
coverage in Dubai) and **Brave Search API** (free tier, permits automated
queries). Neither returns ratings, which is the part actually worth having.

## Input

Command line, or a small config file for repeatable runs:

```bash
PLACES_KEY=... node discover.mjs \
  --query "dental clinic" \
  --near "25.2388,55.2711" \
  --radius 5000 \
  --area "Jumeirah" \
  --out leads.json
```

| Flag | Meaning |
|---|---|
| `--query` | Search phrase, e.g. `"dental clinic"`. Wording only — every result is still judged against the fixed dental_clinic/dentist category test regardless of phrasing. |
| `--near` | `lat,lng` centre of the area you want. Not the city centre: `25.2048,55.2708` is the generic Dubai centroid, 3.8km south of Jumeirah 1, and a 5km circle there covers more of Business Bay than of Jumeirah. |
| `--radius` | Metres, max 50000. Enforced exactly — a place measured beyond it is dropped and counted, not merely ranked lower. |
| `--area` | District filter, e.g. `"Jumeirah"`. **Repeatable** — a place matching any term is kept. A place in another district is **dropped** and counted, because `--radius` draws a circle and a circle is not a district. Matches the area and its numbered sub-districts (`Jumeirah 1`, `Jumeira Third`) but not places that merely share the name (`Jumeirah Lake Towers`, `Jumeirah Village Circle`). Omit to filter on `--radius` alone. |
| `--min-reviews` | Skip places below a review count |
| `--out` | Defaults to `leads.json` |

### How the geographic filter works

Google's `searchText` takes two location fields and only one of them filters:

- `locationBias` — a **ranking hint**. Google's own wording: *"results around given location might be returned."* Passing a radius here constrains nothing, which is how a `--radius 5000` run once shipped clinics in Deira and Al Garhoud, both ~9km out.
- `locationRestriction` — a **hard filter**, and for `searchText` it accepts a **rectangle only**, never a circle.

So the radius is enforced in two layers, and neither is redundant: the request sends the circle's bounding rectangle as a `locationRestriction`, then every returned place's `places.location` is measured against the true circle with a haversine distance. The rectangle's corners reach `radius × √2`, so without the second layer the corners leak.

`--area` is the third layer, and it exists because a circle is a poor model of a district: a 5km circle centred on Jumeirah 1 still reaches Business Bay, Satwa and Al Wasl.

#### Why `--area` is repeatable

Google returns each district in whatever language it is stored in, and
`languageCode` does **not** change that — measured against the live API, the
same place ids come back byte-identical with `languageCode: 'en'`, without it,
and with `regionCode: 'AE'` added. Many Dubai clinics are stored as `الكرامة`,
not `Al Karama`.

So a Latin `--area "Jumeirah"` cannot be compared against an Arabic district at
all. Comparing them and reporting "no match" would turn *we could not check*
into *we checked and it is elsewhere* — and it did exactly that on a live run,
dropping a clinic whose district is `جميرا ١`, which is Jumeirah 1.

The filter therefore returns **three** verdicts, not two:

| Verdict | Meaning | Reported as |
|---|---|---|
| `match` | Confirmed in the target area | written to `leads.json` |
| `other` | Compared in the same script, genuinely a different district | `dropped as another district` |
| `unverifiable` | Different script — neither confirmed nor ruled out | `COULD NOT VERIFY`, listed by spelling |

`unverifiable` places are still not written, because a Jumeirah prospect list
must not quietly fill with Karama. But they are named, and naming them is the
recovery path: pass the spelling as an extra `--area` and any real lead among
them comes back.

```bash
--area "Jumeirah" --area "جميرا"
```

That run wrote 45 leads, 6 of which are `جميرا ١` / `جميرا الثانية` — leads that
were being discarded before the alias existed.

## Output

`leads.json`, in the shape `audit.mjs` already accepts — the two chain with no
adapter:

```json
[
  {
    "name": "Example Dental Clinic",
    "domain": "exampledental.ae",
    "area": "Jumeirah 1",
    "phone": "+971 4 000 0000",
    "rating": 4.6,
    "reviews": 94,
    "placeId": "ChIJ...",
    "distanceM": 812,
    "note": "discovered 2026-08-24 · dental clinic within 5km of 25.2388,55.2711 · in Jumeirah"
  },
  {
    "name": "Clinic With No Website",
    "domain": null,
    "area": "Jumeirah 2",
    "rating": 4.8,
    "reviews": 210,
    "placeId": "ChIJ...",
    "distanceM": 2140,
    "note": "NO WEBSITE LISTED — highest-value lead type"
  }
]
```

`area` is the district Google returned for that specific place, **never** the
`--area` you asked for. It used to be the latter — stamped onto every lead
unconditionally — which meant a contaminated run still reported every lead as
`"Jumeirah"` and hid the fact that the radius was not being enforced. `distanceM`
is the measured distance from `--near`, so the radius claim in `note` is
checkable against the lead itself rather than taken on trust.

`name` and `domain` are what the audit requires; everything else rides along.
A `null` domain means Places has no website for them at all — the audit should
score that as `NO WEBSITE` without attempting any network check.

## Why rating and reviews matter

They're the reason to prefer Places over a plain domain list. A **4.6★ clinic
with 94 reviews and a dead website** is a completely different opportunity from
a **3.1★ clinic with 8 reviews and a dead website**. The first has proven
demand and no way to capture it — that is the entire pitch. The second has a
problem you can't fix.

The audit can't currently tell those apart; it only sees the broken site. Once
discovery supplies these fields, the ranked table should sort on *demand with
a broken web presence* rather than broken web presence alone.

## Ranking: how to combine the two

Neither tool ranks by lead quality today. Discovery collects in Google's
relevance order; the audit ranks by how broken a site is. Those come apart
badly — as written, the audit puts a dead site with 8 reviews above a slow site
with 400, when the second is plainly the better business.

**A broken website only costs someone money if people are looking for them.**
So lead value is the product of the two, not either alone:

```
leadValue = opportunity × demand

demand = log10(reviews + 10) × ratingFactor
```

`opportunity` is the audit's existing 0–100. `demand` is the part discovery
supplies.

**Why log-scale the reviews.** 400 reviews is not twice the opportunity of
200 — both are clinics with established demand. The log keeps the ordering
while stopping one very popular practice from burying everything else. The
`+ 10` matters too: with `+ 1`, a clinic with zero reviews scores exactly zero
and can never be contacted, which is too strong a claim about a practice that
may simply be new.

**Why discount low ratings.**

| Rating | Factor |
|---|---|
| ≥ 4.5 | 1.0 |
| ≥ 4.0 | 0.9 |
| ≥ 3.5 | 0.6 |
| ≥ 3.0 | 0.3 |
| < 3.0 | 0.15 |
| unrated | 0.5 |

A 3.1★ clinic's problem is not its website, and a new one will not fix it.
They are also the least likely to have budget. This is not snobbery — it is
avoiding a sale you would regret. Unrated sits at 0.5 because unknown is not
the same as bad, and a genuinely new clinic is a reasonable prospect.

**Worked, using real profiles:**

| Clinic | Opportunity | Reviews | Rating | Lead value |
|---|---:|---:|---:|---:|
| No website at all | 55 | 210 | 4.8 | **129** |
| Dead site (a dead-site profile) | 50 | 94 | 4.6 | **101** |
| Slow site, no WhatsApp | 31 | 400 | 4.7 | **81** |
| Dead site, struggling practice | 50 | 8 | 3.1 | **19** |
| Healthy site | 0 | 300 | 4.7 | **0** |

That ordering is the point. The top of the list becomes *real patient demand
with no way to capture it* — which is the email that gets answered — and the
struggling practice with a dead site drops below the busy practice with a
merely slow one.

Report it as a ranking number, not a percentage: it is unbounded and turning
it into a score out of 100 would invent a precision it does not have. Print
the three components beside it so the reason is visible, the same way the
audit already shows its working.

**Where it lives.** In `audit.mjs`, not here — discovery's job ends at
supplying `rating` and `reviews`. Until it does, the audit has no demand
signal and correctly falls back to ranking on opportunity alone.

## Integration notes for whoever builds it

- The audit already carries unknown input fields through to its JSON output,
  so `rating`/`reviews` survive end to end without changes. Surfacing them in
  the **markdown table** needs two lines in `audit.mjs`'s `fmt()` and its
  header row.
- `domain: null` needs handling in the audit's main loop — skip DNS/TLS/fetch
  and score it directly, otherwise it will try to resolve `"null"`.
- Places pagination has a short delay before `nextPageToken` becomes valid.
  Sleep ~2s between pages or the second request returns empty.
- Keep the run date in `note`. A lead list goes stale within weeks — clinics
  fix sites, close, and rebrand — and you want to know how old the file is.
- `leads.json` is already gitignored. Keep it that way.

## Cost

A few hundred calls for the whole Dubai dental market. Google gives a
recurring monthly free allowance per API, so this is likely free and at worst a
few dollars. Verify current pricing before a large run — Google restructured
Places billing recently and anything written here about price will go stale
faster than the rest of this document.
