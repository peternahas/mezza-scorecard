#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════
 * HAND A BUSINESS DATE FROM THE PRE-D1 SNAPSHOT OVER TO D1
 * ═══════════════════════════════════════════════════════════════════
 *
 * Between 2026-08-20 and 2026-08-26 the webhook was hitting a storage
 * cap each afternoon and rejecting orders, so those days sit at roughly
 * half their real volume. Givex has re-pushed them; as each day lands
 * in D1, the snapshot should stop owning it.
 *
 * The sync decides that per business date: a D1 order is skipped if
 * data/givex-legacy-days.json still holds that date. So recovery is
 * "move this date's rows out of the snapshot" -- and that is all this
 * script does.
 *
 * ── WHY A SCRIPT AND NOT A HAND EDIT ─────────────────────────────
 * givex-legacy-days.json plus its archive are the ONLY record of the
 * pre-D1 period. There is no re-fetching it: D1 holds nothing from
 * before the cutover and Givex's own repoll is what we are relying on
 * here. A mistyped date or a bad JSON write loses real history, and a
 * test suite already deleted this file once by accident. So:
 *
 *   - rows are MOVED to data/givex-legacy-days.archived.json, never
 *     deleted, with the totals they were carrying and the reason;
 *   - --check refuses to touch anything and just reports;
 *   - a date that is not in the snapshot is a no-op, not an error, so
 *     re-running is safe;
 *   - the file is rewritten only after the new content parses.
 *
 * Usage:
 *   node scripts/recover-legacy-day.mjs --check
 *   node scripts/recover-legacy-day.mjs 2026-08-21 2026-08-22
 *   node scripts/recover-legacy-day.mjs --all-outage
 *
 * Then run the sync with FULL_RESYNC=true -- the saved state still
 * holds the old seeded rows, and only a rebuild clears them.
 * ═══════════════════════════════════════════════════════════════════
 */
import { readFile, writeFile } from "node:fs/promises";

const SNAPSHOT = "data/givex-legacy-days.json";
const ARCHIVE = "data/givex-legacy-days.archived.json";
const OUTAGE = ["2026-08-20","2026-08-21","2026-08-22","2026-08-23","2026-08-24","2026-08-25","2026-08-26"];

const args = process.argv.slice(2);
const check = args.includes("--check");
let dates = args.filter((a) => !a.startsWith("--"));
if (args.includes("--all-outage")) dates = OUTAGE;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const bad = dates.filter((d) => !DATE_RE.test(d));
if (bad.length) {
  console.error(`Not a YYYY-MM-DD date: ${bad.join(", ")}`);
  process.exit(2);
}

const snap = JSON.parse(await readFile(SNAPSHOT, "utf8"));
const held = [...new Set(snap.days.map((d) => d.Business_Date))].sort();

const summarise = (rows) => ({
  store_days: rows.length,
  orders: rows.reduce((s, r) => s + (r.Orders || 0), 0),
  total_sales: Math.round(rows.reduce((s, r) => s + (r.Total_Sales || 0), 0) * 100) / 100,
});

if (check || !dates.length) {
  console.log(`Snapshot holds ${snap.days.length} store-day(s) across ${held.length} date(s):\n`);
  for (const d of held) {
    const rows = snap.days.filter((r) => r.Business_Date === d);
    const s = summarise(rows);
    const flag = OUTAGE.includes(d) ? "  <- outage window, recover once repushed" : "";
    console.log(`  ${d}  ${String(s.store_days).padStart(3)} stores  ${String(s.orders).padStart(5)} orders  $${s.total_sales.toLocaleString()}${flag}`);
  }
  if (!dates.length && !check) console.log("\nNothing to do. Pass dates, or --all-outage.");
  process.exit(0);
}

const moving = snap.days.filter((r) => dates.includes(r.Business_Date));
const keeping = snap.days.filter((r) => !dates.includes(r.Business_Date));
const notHeld = dates.filter((d) => !held.includes(d));

if (notHeld.length) {
  // Not an error: the point is that re-running is safe.
  console.log(`Already recovered (not in the snapshot): ${notHeld.join(", ")}`);
}
if (!moving.length) {
  console.log("Nothing moved.");
  process.exit(0);
}

let archive;
try {
  archive = JSON.parse(await readFile(ARCHIVE, "utf8"));
} catch (err) {
  if (err.code !== "ENOENT") throw err;
  archive = {
    _comment:
      "Store-days removed from givex-legacy-days.json because Givex re-pushed them through the " +
      "webhook and D1 now holds the real orders. Kept, never deleted: this and the snapshot are " +
      "the only records of the pre-D1 period, and if a recovery turns out to be incomplete these " +
      "rows are what it gets compared against.",
    removed: [],
  };
}

archive.removed.push({
  removed_at: new Date().toISOString().slice(0, 10),
  reason:
    "Repolled through the Givex Order Details webhook after Givex re-pushed the outage window. " +
    "D1 now holds these business dates and is the fuller record.",
  dates: [...new Set(moving.map((r) => r.Business_Date))].sort(),
  snapshot_totals: summarise(moving),
  days: moving,
});

snap.days = keeping;
const remaining = [...new Set(keeping.map((d) => d.Business_Date))].sort();
snap.store_days = keeping.length;
snap.total_orders = summarise(keeping).orders;
snap.total_net_sales = summarise(keeping).total_sales;
snap.date_range = remaining.length ? `${remaining[0]}..${remaining[remaining.length - 1]}` : null;
snap.authoritative_through = remaining.length ? remaining[remaining.length - 1] : null;
snap._authoritative_through_note =
  "REPORTING ONLY. The sync no longer uses this to decide anything -- it skips a D1 order if this " +
  "file still holds that order's business date, date by date. Dates held here now: " +
  (remaining.join(", ") || "none");

// Parse what we are about to write before replacing anything.
const snapText = JSON.stringify(snap, null, 1);
const archText = JSON.stringify(archive, null, 1);
JSON.parse(snapText);
JSON.parse(archText);
await writeFile(ARCHIVE, archText + "\n", "utf8");
await writeFile(SNAPSHOT, snapText + "\n", "utf8");

const s = summarise(moving);
console.log(`Moved ${s.store_days} store-day(s) to the archive: ${[...new Set(moving.map((r) => r.Business_Date))].sort().join(", ")}`);
console.log(`  they were carrying ${s.orders} orders / $${s.total_sales.toLocaleString()}`);
console.log(`Snapshot now holds ${keeping.length} store-day(s) across ${remaining.length} date(s).`);
console.log(`\nNow run the sync with FULL_RESYNC=true -- the saved state still holds the old seeded rows.`);
