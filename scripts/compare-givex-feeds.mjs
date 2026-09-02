#!/usr/bin/env node
/**
 * Diffs the v2 verify output against the feed the scorecard is
 * currently serving, store-day by store-day.
 *
 * The point is narrow and important: v2 adds ~25 measures, but it must
 * not have moved a single number the business has already seen. If
 * Total_Sales, Orders, InStore_Sales or Online_Sales differ anywhere,
 * something in the rewrite changed the meaning of the existing feed
 * and it must not ship until that is explained.
 *
 * Writes data/givex-feed-comparison.json and exits non-zero if any
 * existing measure moved by more than a rounding cent.
 */
import { readFile, writeFile } from "node:fs/promises";

const CENT = 0.011; // one cent, plus room for float noise

const live = JSON.parse(await readFile("data/givex-sales-data.json", "utf8"));
const next = JSON.parse(await readFile("data/givex-sales-data.verify.json", "utf8"));

const key = (d) => `${d.Location_Name}|${d.Business_Date}`;
const liveByKey = new Map(live.days.map((d) => [key(d), d]));
const nextByKey = new Map(next.days.map((d) => [key(d), d]));

const CARRIED_OVER = ["Total_Sales", "InStore_Sales", "Online_Sales", "Orders", "Tips_Total"];

// The newest business day is still trading, and the two feeds were
// generated at different times, so it legitimately differs. Comparing
// it would report a few thousand dollars of "drift" on every run and
// train everyone to ignore this check -- which is worse than not
// having it. It is reported separately instead.
const liveLatest = live.days.map((d) => d.Business_Date).sort().pop();
const v2Latest = next.days.map((d) => d.Business_Date).sort().pop();
const stillTrading = [liveLatest, v2Latest].sort().pop();

const drift = [];
const onlyInLive = [];
const onlyInNext = [];

const inFlight = [];
for (const [k, a] of liveByKey) {
  const b = nextByKey.get(k);
  if (!b) { onlyInLive.push(k); continue; }
  if (k.endsWith("|" + stillTrading)) { inFlight.push(k); continue; }
  for (const f of CARRIED_OVER) {
    const av = a[f] ?? 0, bv = b[f] ?? 0;
    if (Math.abs(av - bv) > CENT) drift.push({ store_day: k, field: f, live: av, v2: bv, delta: Math.round((bv - av) * 100) / 100 });
  }
}
for (const k of nextByKey.keys()) if (!liveByKey.has(k)) onlyInNext.push(k);

const sum = (rows, f) => Math.round(rows.reduce((s, r) => s + (r[f] || 0), 0) * 100) / 100;

const report = {
  compared_at: new Date().toISOString(),
  live_generated_at: live.generated_at,
  v2_generated_at: next.generated_at,
  live_store_days: live.days.length,
  v2_store_days: next.days.length,
  live_total_sales: sum(live.days, "Total_Sales"),
  v2_total_sales: sum(next.days, "Total_Sales"),
  live_orders: live.days.reduce((s, d) => s + d.Orders, 0),
  v2_orders: next.days.reduce((s, d) => s + d.Orders, 0),
  // Store-days present in one feed and not the other. Some asymmetry
  // is expected and benign: the live feed is a point-in-time commit
  // and v2 rebuilds from D1 as it stands right now, so the newest
  // business day can legitimately appear in one and not the other.
  still_trading_date_excluded: stillTrading,
  store_days_excluded_as_in_flight: inFlight.length,
  only_in_live: onlyInLive,
  only_in_v2: onlyInNext,
  drift_count: drift.length,
  drift: drift.slice(0, 200),
  new_measures_present: Object.keys(next.days[0] || {}).filter(
    (k) => !(k in (live.days[0] || {}))
  ),
  field_coverage: next.field_coverage,
  fields_never_found: Object.entries(next.field_coverage || {})
    .filter(([, c]) => c.found === 0)
    .map(([f]) => f),
};

await writeFile("data/givex-feed-comparison.json", JSON.stringify(report, null, 2) + "\n", "utf8");

console.log(`Live: ${report.live_store_days} store-days, $${report.live_total_sales}, ${report.live_orders} orders`);
console.log(`  v2: ${report.v2_store_days} store-days, $${report.v2_total_sales}, ${report.v2_orders} orders`);
console.log(`New measures added: ${report.new_measures_present.length}`);
console.log(`Excluded ${inFlight.length} store-day(s) on ${stillTrading} — still trading, so the two feeds cannot agree.`);
if (onlyInLive.length) console.log(`MISSING FROM v2: ${onlyInLive.length} store-day(s) the live feed has and v2 does not.`);
if (onlyInNext.length) console.log(`New in v2: ${onlyInNext.length} store-day(s).`);
if (report.fields_never_found.length) {
  console.log(`Fields never found (metric will read zero): ${report.fields_never_found.join(", ")}`);
}
if (onlyInLive.length) {
  console.error(`\nFAIL: v2 is missing ${onlyInLive.length} store-day(s) that the live feed has.`);
  console.error(`  e.g. ${onlyInLive.slice(0, 6).join(", ")}`);
  console.error("  Losing history is a worse failure than a value moving, so this gates too.");
  process.exit(1);
}
if (drift.length) {
  // Report is already written above -- exiting non-zero here is a
  // signal to the workflow, not a reason to withhold the evidence.
  console.error(`\nFAIL: ${drift.length} existing measure(s) changed value. First few:`);
  for (const d of drift.slice(0, 10)) {
    console.error(`  ${d.store_day} ${d.field}: live ${d.live} -> v2 ${d.v2} (${d.delta > 0 ? "+" : ""}${d.delta})`);
  }
  process.exit(1);
}
console.log("\nOK: no existing measure changed value.");
