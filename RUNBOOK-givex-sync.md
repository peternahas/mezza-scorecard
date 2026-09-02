# Givex sales sync — runbook

## What feeds what

```
Givex POS ──HTTPS push per closed bill──▶ Cloudflare Worker (mezza-givex-webhook)
                                              │  writes one row per bill
                                              ▼
                                         Cloudflare D1 (mezza-givex-orders)
                                              │  GET /changes?since=<row id>
                                              ▼
                              GitHub Action "Sync Givex sales data"
                              scripts/sync-givex-to-json.mjs
                                              │  commits
                                              ▼
                                data/givex-sales-data.json  (this repo)
                                              │  raw.githubusercontent.com
                                              ▼
                          sales.mezzascorecard.com  (mezza-dashboards repo)
```

## The extraction is v2

`scripts/sync-givex-to-json.mjs` reads roughly 25 fields v1 ignored: item-level
menu mix, category / category-group / subcategory mix, beverage attach, paid
add-on attach, hourly trade, ticket time, operator, tax and subtotal, and a
marketplace-vs-own-online split. Every v1 field still ships unchanged.

- `scripts/sync-givex-to-json.v1.mjs` — the previous version, kept for rollback.
- `scripts/test-sync-v2.mjs` — 68 tests. They run in CI before the API is touched.
- `scripts/givex-schema-probe.mjs` — confirms which payload fields Givex actually
  sends. Run this before adding a field, and any time Givex says they changed
  the payload. Output: `data/givex-schema-probe.json`.

## Two things that will bite you if you do not know them

**1. D1 holds nothing before 2026-08-26.** The Worker moved from Workers KV to
D1 that afternoon and the KV store was never migrated. Aug 14–26 exists only in
`data/givex-legacy-days.json`, a frozen snapshot the sync seeds on every
rebuild. Delete that file and twelve days of history — about $520k of recorded
sales — disappear from the scorecard. Those days carry sales, orders, channel,
day part and tender, but no item, hour, ticket-time or operator detail, and they
are tagged `Legacy_Sales_Only` so the dashboard says so instead of drawing an
empty chart.

**2. `net_sales` already contains paid add-ons.** Verified by reconciling a full
week: `adj_gross_sales + paid add-ons − discounts ≈ net_sales`, within 0.03%.
So `adj_gross_sales` is the base item value BEFORE add-ons and is *smaller* than
net — which is why it is emitted as `Item_Base_Sales` and not as "gross sales".
Adding add-on money to net would inflate every sales figure by about 5.6%.

## Routine operations

| Situation | Action |
|---|---|
| Feed looks stale | Actions → **Sync Givex sales data** → Run workflow. GitHub's scheduler is best-effort and has skipped ten hours at a stretch. |
| Store mapping changed | Edit `scripts/store-mapping.json`, then run with **full resync** checked. Already-processed orders are never re-evaluated otherwise. |
| A metric reads zero | Check `field_coverage` in the feed, or the Data health tab. `found: 0` means the pipeline is broken; a real zero shows `found` > 0. |
| An unmapped outlet appears | It is in `unmapped_outlets` and its sales are missing entirely. Add it to the mapping, then full resync. |
| Changing which fields are read | Run **Givex payload schema probe** first, then the **v2 verify** workflow, which rebuilds into a scratch file and fails if any measure the business has already seen moved. |

## Rollback

```
cp scripts/sync-givex-to-json.v1.mjs scripts/sync-givex-to-json.mjs
git rm data/givex-sync-state.json      # v1 cannot read a v2 state file
```
Commit, then run the workflow with **full resync** checked. Note that v1 rebuilds
from D1 only, so it will come back with history starting 2026-08-26 — the legacy
seed is a v2 feature.

## Still outstanding, and not on us

- **Repoll for Aug 20–26.** Those bills were rejected at the door by the KV write
  cap and never stored, so they are not recoverable from any file here. Only a
  Givex repoll returns them, and `repollwebhook` is still not enabled for
  production user 1657662 (`["19","Operation not permitted"]`). Draft request:
  `givex-repoll/GIVEX-REQUEST-EMAIL.md` in the project folder.
- **Discounts and voids.** Non-zero but very small — about 0.45% of net sales.
  Either Mezza discounts almost nothing at the till, or some of it is not being
  rung as a discount. Worth one question to operations.
- **Loyalty.** `customer_id`, `customer_name` and `member_number` are present on
  every bill and empty on every bill. No repeat-customer analysis is possible
  until that changes.
