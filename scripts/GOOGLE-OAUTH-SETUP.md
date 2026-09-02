# Google Reviews + Business Profile — one-time setup

Reviews and Business Profile metrics were both built and working once, in Apps
Script, against the Google Sheet that has since stopped being the scorecard's
source. Nothing about them is lost — they just need re-pointing at a pipeline
that still runs. This is the only manual step in doing that.

Everything except the refresh token already exists. Total time: about 15 minutes,
once.

---

## What the pipeline gets you that the old one did not

The old Reviews integration used the public **Places API** with a bare key: a
star rating and a review count, nothing more. Mezza already has OAuth approval
for the **Business Profile** suite (granted 2026-07-03, 300 QPM), which reads
Mezza's own data and returns every review with its text and — the part that
matters — **whether it has been replied to**.

A star rating is a lagging number nobody can act on this week. *"Eleven reviews
unanswered, four of them one-star, oldest nineteen days"* is a task list.

---

## Step 1 — Confirm the four APIs are enabled

Google split this across four services, and each has to be enabled individually
even though the access approval covers the suite. In
[console.cloud.google.com](https://console.cloud.google.com) → **APIs & Services
→ Library**, confirm all four are **Enabled** on the same project that holds the
OAuth client:

- My Business Account Management API
- My Business Business Information API
- **Google My Business API** ← the legacy one; reviews are only available here
- Business Profile Performance API

If a call later fails with `403 SERVICE_DISABLED`, the error names which one.

---

## Step 2 — Add the redirect URI

**APIs & Services → Credentials →** your existing OAuth 2.0 Client ID → under
**Authorised redirect URIs** add exactly:

```
http://localhost:8910/
```

Save. This is only used for the one-time consent below; it can be removed
afterwards.

---

## Step 3 — Get the refresh token

Open this URL in a browser signed in as the Google account that **owns the Mezza
Business Profile locations**, with `YOUR_CLIENT_ID` replaced:

```
https://accounts.google.com/o/oauth2/v2/auth
  ?client_id=YOUR_CLIENT_ID
  &redirect_uri=http://localhost:8910/
  &response_type=code
  &scope=https://www.googleapis.com/auth/business.manage
  &access_type=offline
  &prompt=consent
```

(Put it on one line — the line breaks above are only for reading.)

Approve the consent screen. The browser will fail to load a page — that is
expected, nothing is listening on port 8910. The part that matters is in the
address bar:

```
http://localhost:8910/?code=4/0AeanS0...&scope=...
```

Copy the value between `code=` and the following `&`.

Then exchange it for a refresh token. In Terminal, with the three values filled
in:

```bash
curl -s -X POST https://oauth2.googleapis.com/token \
  -d client_id=YOUR_CLIENT_ID \
  -d client_secret=YOUR_CLIENT_SECRET \
  -d code=THE_CODE_YOU_COPIED \
  -d redirect_uri=http://localhost:8910/ \
  -d grant_type=authorization_code
```

The response contains `"refresh_token": "1//0g..."`. That is the value you need.

**The code is single-use and expires in a few minutes.** If the exchange returns
`invalid_grant`, go back to Step 3 and get a fresh one — the code was used or it
timed out. `prompt=consent` is in the URL deliberately: without it Google will
often return no refresh token at all on a repeat authorisation.

---

## Step 4 — Add three repo secrets

`github.com/peternahas/mezza-scorecard` → **Settings → Secrets and variables →
Actions → New repository secret**:

| Secret | Where it comes from |
|---|---|
| `GOOGLE_CLIENT_ID` | Apps Script → Project Settings → Script Properties (`GBP_CLIENT_ID`) |
| `GOOGLE_CLIENT_SECRET` | same place (`GBP_CLIENT_SECRET`) |
| `GOOGLE_REFRESH_TOKEN` | Step 3 |

The refresh token is long-lived. It only needs redoing if it is revoked, if the
Google password changes in a way that invalidates grants, or if the OAuth client
is deleted.

---

## Step 5 — First run, then the mapping

Actions → **Sync Google reviews and Business Profile** → **Run workflow**.

The first run will report every location as **unmapped**, and print a
ready-to-paste block. That is by design: Google's own location titles do not
match the names the sales feed uses — Google may call a store *"7001 Mumford"*
where the scorecard calls it *"Halifax Shopping Centre"* — and guessing is
exactly how one store's reviews end up filed against another. So it never
guesses.

Take the printed block into `scripts/google-location-mapping.json`, fill in the
Mezza `Location_Name` for each (spelled exactly as it appears on the scorecard),
commit, and run the workflow again. From then on it runs daily on its own.

---

## What it produces

`data/google-data.json`, committed to this repo and read by
sales.mezzascorecard.com:

- **locations** — rating, review count, reviews in the last 7 and 30 days,
  rating over the last 30 days (the leading indicator; the all-time average
  barely moves), unanswered count, unanswered negatives, and the age of the
  oldest unanswered review
- **reviews** — every review read, with stars, text, reply status and reply lag
- **performance** — profile views, searches, calls, direction requests, website
  clicks, menu clicks and food orders, per location per day, 120 days

Reviewer display names are kept, because a reply has to address someone. Profile
photos and every other reviewer detail are dropped.
