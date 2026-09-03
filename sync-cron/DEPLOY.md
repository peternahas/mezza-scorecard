# Deploying the sync watchdog

Ten minutes in the Cloudflare dashboard. No CLI, same route the Givex webhook
Worker was deployed by.

## What you are deploying, and what it replaces

Nothing about the sync itself changes. The GitHub Action that reads D1 and commits
the feed stays exactly as it is, tests and all. What changes is **who asks it to
run**.

Today that is GitHub's own scheduler, which is best-effort on free runners: the
nominal 15-minute cron really fires every 30–95 minutes, and on the night of
2026-08-26 it stopped for about ten hours with every prior run green. Cloudflare
Cron Triggers are not best-effort.

The Worker is also a **watchdog rather than a blind cron**. Each tick it reads the
published feed's own `generated_at` and only dispatches if the data is actually
stale. So a healthy pipeline costs one cheap API read every 15 minutes instead of
96 workflow runs a day, and — the part that matters — the Worker now has an
opinion about whether the pipeline is alive. Nothing in the chain had one before,
which is precisely how nine weeks of staleness went unnoticed.

Thresholds are in `worker.js`: dispatch the Givex sync at 45 minutes stale, raise
an alert at 180.

## Leave the GitHub schedule alone

Do **not** delete the `schedule:` block from the workflow. Two triggers is
strictly more reliable than one, and a double fire is harmless — the workflow's
`concurrency` group queues the second run, which then finds the cursor unchanged
and processes zero payloads. Belt and braces, at no cost.

## Step 1 — the GitHub token

This is the only credential the Worker holds, so keep it narrow.

github.com → Settings → Developer settings → **Fine-grained tokens** → Generate new

- **Repository access:** Only select repositories → `peternahas/mezza-scorecard`
- **Permissions:** `Actions` = Read and write, `Contents` = Read-only. Nothing else.
- **Expiration:** this one wants to be long-lived — it is machinery, not a
  session. Whatever you pick, put a calendar reminder a week before it lapses.
  When it expires the watchdog's own `/` endpoint starts returning 503 with
  `feed read failed: 401`, which is the good failure mode: it tells you.

## Step 2 — create the Worker

Cloudflare dashboard → **Workers & Pages** → Create → **Create Worker**

- Name: `mezza-sync-cron`
- Deploy the placeholder, then **Edit code**
- Select all in the editor and replace it with the contents of `worker.js`
- Deploy

> The dashboard editor is a cross-origin iframe that rejects synthetic typing but
> accepts a real ⌘V. If a paste half-lands, the buffer is broken but *undeployed* —
> navigating away discards it. Check the status bar reads 0 errors before Deploy.

## Step 3 — the two secrets

Worker → **Settings** → **Variables and Secrets** → Add, and click **Encrypt** on
both:

| Name | Value |
|---|---|
| `GITHUB_TOKEN` | the token from Step 1 |
| `CRON_SHARED_SECRET` | any long random string — this only guards the on-demand endpoint so nobody else can make it fire dispatches |

Deploy again after adding them.

## Step 4 — the cron trigger

Worker → **Settings** → **Trigger Events** → Add → **Cron Trigger**

```
*/15 * * * *
```

## Step 5 — prove it works

Two checks, in order.

**a) The health endpoint is up.** Open the Worker's URL with `/health` on the end.
It should say `ok`. No auth needed — that is deliberate, so an uptime monitor can
watch it.

**b) It can actually see the feed and dispatch.** From Terminal:

```bash
curl -s -H "Authorization: YOUR_CRON_SHARED_SECRET" https://mezza-sync-cron.<your-subdomain>.workers.dev/ | python3 -m json.tool
```

A healthy answer looks like:

```json
{
  "checked_at": "2026-09-03T...",
  "jobs": [
    { "name": "Givex sales", "ageMin": 12, "action": "ok (12 min old)" },
    { "name": "Excel scorecard", "ageMin": 41, "action": "ok (41 min old)" }
  ],
  "healthy": true
}
```

If `jobs[].error` says `feed read failed: 401`, the token is wrong or missing the
Contents permission. If a dispatch reports 403, it is missing Actions write.

Then watch the Actions tab for an hour. Runs should appear at genuine 15-minute
boundaries, most of them showing `0 new or updated payload(s)` — which is the
watchdog doing its job cheaply.

## Rolling it back

Delete the cron trigger. That is the whole rollback — the GitHub schedule is still
in place and takes over immediately, at its old unreliable cadence.

## What this does not fix

The watchdog notices a stale feed and asks for a run. It cannot fix a run that is
*failing*, and it cannot make Givex push orders it is not pushing. What it does is
turn a silent stall into a loud one, which is the difference between finding out in
fifteen minutes and finding out in nine weeks.
