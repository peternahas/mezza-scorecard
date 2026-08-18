#!/usr/bin/env node
/**
 * Pulls Givex Order Details webhook payloads out of the Cloudflare
 * KV-backed Worker (givex-webhook), and rolls them up into DAILY
 * per-store buckets (with a weekly rollup kept for backward
 * compatibility with index.html's existing "Live POS Sales" panel),
 * writing the result to data/givex-sales-data.json in this repo.
 *
 * This is a SEPARATE output file from data/scorecard-data.json (the
 * Excel-sync pipeline's output) on purpose — the two pipelines run on
 * independent schedules and shouldn't race to overwrite the same file.
 *
 * ARCHITECTURE CHANGE 2026-08-18 — snapshot-per-order, not additive:
 *   The original version of this script accumulated Total_Sales
 *   additively as it scanned every line item in every webhook payload.
 *   Inspecting real KV data directly (Cloudflare dashboard, KV Pairs
 *   view) showed the SAME vxl_order_id can appear in multiple distinct
 *   webhook keys with byte-identical content (e.g. order 115700 pushed
 *   at both .../1785860708-... and .../1785860827-...) — almost
 *   certainly a Givex repoll/retry re-delivering the same closed bill.
 *   Under the old additive design, every re-delivery would double-count
 *   that order's sales. Fixed by keeping ONE snapshot per vxl_order_id
 *   in state.orders, overwritten (not added to) on every sighting, and
 *   deriving all daily/weekly/department buckets fresh from that
 *   snapshot map on every run. This makes the pipeline naturally
 *   idempotent against repeated deliveries of the same order, at the
 *   cost of re-deriving buckets each run — cheap in JS even at tens of
 *   thousands of orders, so not a performance concern.
 *
 * INCREMENTAL SYNC (added 2026-08-17, still in effect) — why this exists:
 *   The original version of this script re-listed AND re-fetched every
 *   single stored order on every run, on a 15-minute cron, forever.
 *   Checked against real Cloudflare KV metrics: only ~2,990 keys /
 *   11.9 MB stored, but 546,510 reads in one month against only 7,480
 *   writes — a ~73x read amplification for a dataset this small.
 *   Fix: persist a state file (STATE_PATH below) between runs that
 *   remembers which webhook KEYS have already been fetched. Every run
 *   still does a full `/list` (cheap) but only calls `/get` on keys it
 *   hasn't seen before. New key → decode → upsert into state.orders.
 *
 *   Set FULL_RESYNC=true (or the workflow's `full_resync` manual-run
 *   input) to ignore the state file and rebuild everything from
 *   scratch — required after any store-mapping.json, ONLINE_DEPARTMENTS,
 *   or corpLocations change that should apply to historical data,
 *   since already-processed keys are never retroactively re-read.
 *
 * How channel (in-store vs. online) is determined:
 *   Verified against real webhook payloads — each order line item
 *   carries a `department_name` field, and that's the reliable signal
 *   for channel. `order_type` (Dine-In/Take-Out/Delivery/Drive Through)
 *   describes fulfillment, NOT channel — a real sample showed a
 *   "Take-Out" order_type filed under an online department, meaning it
 *   was placed online for pickup, not ordered at the counter. Both
 *   signals are kept in the output now: department_name still drives
 *   InStore_Sales/Online_Sales (unchanged, trusted); order_type is
 *   surfaced separately as Order_Type_Sales for ops slicing (e.g.
 *   "how much of today was dine-in vs. take-out").
 *
 * ONLINE_DEPARTMENTS — real production department names (pulled via a
 * production GetDepartmentList call, 2026-08-17):
 *   In-store:  Eat - In, Take - Out, Drive Through
 *   Online:    Givex Online, Delivery, Uber Eats, Skip The Dishes,
 *              Door Dash - Delivery, Door Dash - Pickup
 * "Catering" is NOT classified as online or in-store automatically —
 * genuinely ambiguous, defaults to in-store until Peter/Ashley confirm
 * (same open-question category as the net vs. gross Total_Sales basis).
 *
 * Corp vs. Franchisee (added 2026-08-18):
 *   Sourced from store-mapping.json's new `corpLocations` array (a
 *   plain list of Location_Names). Anything not listed defaults to
 *   "Franchisee". This classification does not exist anywhere in the
 *   Givex API itself — it's a Mezza-side business fact, hand-maintained
 *   here the same way outlet-id mapping is.
 *
 * Day-part (added 2026-08-18):
 *   Real order objects carry `opening_time` (HH:MM, confirmed present
 *   on every real order inspected) — bucketed into Breakfast (6-11),
 *   Lunch (11-14), Afternoon (14-17), Dinner (17-21), Late Night
 *   (21-6). This is a NEW capability — previously assumed unavailable
 *   because the old script never read any time-of-day field, only the
 *   date-only BusinessDate.
 *
 * Payment mix (added 2026-08-18):
 *   Real order objects carry a `bills[].payments[]` array with
 *   `payment_method` (CASH/VISA/Smoothpay/GIFTCARD/etc.),
 *   `payment_method_amount`, and `total_tip` — also previously assumed
 *   unconfirmed. Note Payment_Mix totals will not exactly equal
 *   Total_Sales (payments include tax/tip, net_sales does not) — this
 *   is normal and expected, not a reconciliation bug.
 *
 * Required environment variables (set as GitHub Actions repo secrets):
 *   GIVEX_WEBHOOK_URL    - e.g. https://givex-webhook.mezzascorecard.com
 *   GIVEX_SHARED_SECRET  - the same secret the Worker checks on /list and /get
 * Optional:
 *   FULL_RESYNC          - set to "true" to ignore the persisted state
 *                           file and rebuild everything from scratch.
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { GIVEX_WEBHOOK_URL, GIVEX_SHARED_SECRET, FULL_RESYNC } = process.env;

const OUTPUT_PATH = "data/givex-sales-data.json";
const STATE_PATH = "data/givex-sync-state.json";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_MAPPING_PATH = path.join(__dirname, "store-mapping.json");

const ONLINE_DEPARTMENTS = new Set([
  "Givex Online",
  "Delivery",
  "Uber Eats",
  "Skip The Dishes",
  "Door Dash - Delivery",
  "Door Dash - Pickup",
]);

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function authedGet(pathAndQuery) {
  const url = `${GIVEX_WEBHOOK_URL.replace(/\/$/, "")}${pathAndQuery}`;
  const res = await fetch(url, { headers: { Authorization: GIVEX_SHARED_SECRET } });
  if (!res.ok) {
    throw new Error(`Request failed: ${url} -> ${res.status} ${await res.text()}`);
  }
  return res;
}

async function listAllKeys() {
  const keys = [];
  let cursor = null;
  do {
    const qs = new URLSearchParams({ prefix: "orders/" });
    if (cursor) qs.set("cursor", cursor);
    const res = await authedGet(`/list?${qs.toString()}`);
    const data = await res.json();
    keys.push(...data.keys);
    cursor = data.cursor || null;
  } while (cursor);
  return keys;
}

async function getPayload(key) {
  const res = await authedGet(`/get?key=${encodeURIComponent(key)}`);
  return res.json();
}

// ISO 8601 week number + the Monday date that starts that week.
function isoWeekInfo(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const weekNumber =
    1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  const monday = new Date(dateStr + "T00:00:00Z");
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return { year: d.getUTCFullYear(), weekNumber, weekStart: monday.toISOString().slice(0, 10) };
}

function dayPartFromTime(timeStr) {
  if (!timeStr || typeof timeStr !== "string") return "Unknown";
  const hour = parseInt(timeStr.split(":")[0], 10);
  if (Number.isNaN(hour)) return "Unknown";
  if (hour >= 6 && hour < 11) return "Breakfast";
  if (hour >= 11 && hour < 14) return "Lunch";
  if (hour >= 14 && hour < 17) return "Afternoon";
  if (hour >= 17 && hour < 21) return "Dinner";
  return "Late Night"; // 21:00-05:59
}

function resolveLocationName(mapping, outletId, storeName) {
  const excludeReason = mapping.excludeOutletIds?.[String(outletId)];
  if (excludeReason) return { locationName: null, matchedBy: "excluded", excludeReason };
  const byId = mapping.byOutletId[String(outletId)];
  if (byId) return { locationName: byId, matchedBy: "outlet_id" };
  const byName = mapping.byStoreName[storeName];
  if (byName) return { locationName: byName, matchedBy: "store_name" };
  return { locationName: null, matchedBy: "unmapped" };
}

function resolveLocationType(mapping, locationName) {
  const corpSet = mapping.__corpSet || (mapping.__corpSet = new Set(mapping.corpLocations || []));
  return corpSet.has(locationName) ? "Corp" : "Franchisee";
}

// ---- State persistence -----------------------------------------------

function emptyState() {
  return {
    processedKeys: [],
    // One snapshot per real Givex order (vxl_order_id) — deliberately
    // OVERWRITTEN (never added to) on every sighting, so a repoll/
    // repush of the same order can never double-count sales. All
    // daily/weekly/department buckets below are DERIVED from this map
    // fresh on every run.
    orders: {},
    unmappedOutlets: {}, // key -> count (diagnostic only, not dollar totals)
    excludedOutlets: {}, // key -> { count, reason }
    payloadsProcessedTotal: 0,
    payloadsSkippedTotal: 0,
  };
}

async function loadState() {
  if (FULL_RESYNC === "true") {
    console.log("FULL_RESYNC=true — ignoring any existing state file, rebuilding from scratch.");
    return emptyState();
  }
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      processedKeys: parsed.processedKeys || [],
      orders: parsed.orders || {},
      unmappedOutlets: parsed.unmappedOutlets || {},
      excludedOutlets: parsed.excludedOutlets || {},
      payloadsProcessedTotal: parsed.payloadsProcessedTotal || 0,
      payloadsSkippedTotal: parsed.payloadsSkippedTotal || 0,
    };
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log("No existing state file found — this will be a full backfill (expected on first run).");
      return emptyState();
    }
    throw err;
  }
}

async function main() {
  requireEnv("GIVEX_WEBHOOK_URL", GIVEX_WEBHOOK_URL);
  requireEnv("GIVEX_SHARED_SECRET", GIVEX_SHARED_SECRET);

  const mapping = JSON.parse(await readFile(STORE_MAPPING_PATH, "utf8"));
  const state = await loadState();
  const processedKeySet = new Set(state.processedKeys);

  console.log("Listing stored order keys...");
  const allKeys = await listAllKeys();
  console.log(`Found ${allKeys.length} total stored payloads (list is cheap; this is not the bottleneck).`);

  const newKeys = allKeys.filter((k) => !processedKeySet.has(k));
  console.log(`${newKeys.length} of those are new since the last run — only these will be fetched.`);

  let processedThisRun = 0;
  let skippedThisRun = 0;

  for (const key of newKeys) {
    let payload;
    try {
      payload = await getPayload(key);
    } catch (err) {
      console.warn(`  [!] Failed to read ${key}: ${err.message}`);
      skippedThisRun++;
      continue;
    }

    const orders = payload.payload?.[0] || [];
    const lineItems = payload.payload?.[1] || [];
    if (orders.length === 0 || lineItems.length === 0) {
      skippedThisRun++;
      processedKeySet.add(key);
      continue;
    }

    const businessDate = payload.BusinessDate;
    if (!businessDate) {
      skippedThisRun++;
      processedKeySet.add(key);
      continue;
    }

    for (const o of orders) {
      const outletId = o.outlet_id ?? payload.OutletID;
      const storeName = o.store_name;
      const { locationName, matchedBy, excludeReason } = resolveLocationName(mapping, outletId, storeName);

      if (matchedBy === "excluded") {
        const excludeKey = `outlet_id=${outletId} store_name=${storeName}`;
        const existing = state.excludedOutlets[excludeKey] || { count: 0, reason: excludeReason };
        existing.count += 1;
        state.excludedOutlets[excludeKey] = existing;
        continue;
      }
      if (matchedBy === "unmapped") {
        const unmappedKey = `outlet_id=${outletId} store_name=${storeName}`;
        state.unmappedOutlets[unmappedKey] = (state.unmappedOutlets[unmappedKey] || 0) + 1;
        continue;
      }

      const vxlOrderId = o.vxl_order_id;
      const myLineItems = lineItems.filter((li) => li.vxl_order_id === vxlOrderId);

      let netSales = 0;
      let inStoreSales = 0;
      let onlineSales = 0;
      const deptSales = {};
      for (const li of myLineItems) {
        const deptName = li.department_name || "(none)";
        const amt = li.net_sales || 0;
        netSales += amt;
        if (ONLINE_DEPARTMENTS.has(deptName)) onlineSales += amt;
        else inStoreSales += amt;
        deptSales[deptName] = (deptSales[deptName] || 0) + amt;
      }

      const paymentAmounts = {};
      let tips = 0;
      for (const bill of o.bills || []) {
        for (const pmt of bill.payments || []) {
          const method = pmt.payment_method || "(unknown)";
          paymentAmounts[method] = (paymentAmounts[method] || 0) + (pmt.payment_method_amount || 0);
          tips += pmt.total_tip || 0;
        }
      }

      // Overwrite, never add — see architecture note at top of file.
      state.orders[vxlOrderId] = {
        locationName,
        locationType: resolveLocationType(mapping, locationName),
        businessDate,
        orderType: o.order_type || "(unknown)",
        openingTime: o.opening_time || null,
        dayPart: dayPartFromTime(o.opening_time),
        netSales,
        inStoreSales,
        onlineSales,
        deptSales,
        paymentAmounts,
        tips,
      };
    }

    processedKeySet.add(key);
    processedThisRun++;
  }

  state.processedKeys = [...processedKeySet];
  state.payloadsProcessedTotal += processedThisRun;
  state.payloadsSkippedTotal += skippedThisRun;

  // ---- Derive all output buckets fresh from state.orders ----
  const dayBuckets = {}; // "Location|BusinessDate" -> accumulator
  const deptTotals = {}; // deptName -> { netSales, orderIds:Set }

  for (const [vxlOrderId, ord] of Object.entries(state.orders)) {
    const dayKey = `${ord.locationName}|${ord.businessDate}`;
    if (!dayBuckets[dayKey]) {
      dayBuckets[dayKey] = {
        Location_Name: ord.locationName,
        Location_Type: ord.locationType,
        Business_Date: ord.businessDate,
        Total_Sales: 0,
        InStore_Sales: 0,
        Online_Sales: 0,
        orderIds: new Set(),
        Order_Type_Sales: {},
        Day_Part_Sales: {},
        Payment_Mix: {},
        Tips_Total: 0,
      };
    }
    const b = dayBuckets[dayKey];
    b.Total_Sales += ord.netSales;
    b.InStore_Sales += ord.inStoreSales;
    b.Online_Sales += ord.onlineSales;
    b.orderIds.add(vxlOrderId);
    b.Order_Type_Sales[ord.orderType] = (b.Order_Type_Sales[ord.orderType] || 0) + ord.netSales;
    b.Day_Part_Sales[ord.dayPart] = (b.Day_Part_Sales[ord.dayPart] || 0) + ord.netSales;
    b.Tips_Total += ord.tips;
    for (const [method, amt] of Object.entries(ord.paymentAmounts)) {
      b.Payment_Mix[method] = (b.Payment_Mix[method] || 0) + amt;
    }

    for (const [deptName, amt] of Object.entries(ord.deptSales)) {
      if (!deptTotals[deptName]) deptTotals[deptName] = { netSales: 0, orderIds: new Set() };
      deptTotals[deptName].netSales += amt;
      deptTotals[deptName].orderIds.add(vxlOrderId);
    }
  }

  const days = Object.values(dayBuckets)
    .map((b) => roundBucket(b, "Business_Date"))
    .sort((a, b) => a.Location_Name.localeCompare(b.Location_Name) || a.Business_Date.localeCompare(b.Business_Date));

  // Weekly rollup, derived from the daily buckets — kept for backward
  // compatibility with index.html's existing weekly Givex panel. Field
  // names/shape match the pre-2026-08-18 output exactly on purpose.
  const weekAccum = {};
  for (const b of Object.values(dayBuckets)) {
    const { year, weekNumber, weekStart } = isoWeekInfo(b.Business_Date);
    const weekKey = `${b.Location_Name}|${year}-W${String(weekNumber).padStart(2, "0")}`;
    if (!weekAccum[weekKey]) {
      weekAccum[weekKey] = {
        Location_Name: b.Location_Name,
        Year: year,
        Week_Number: weekNumber,
        Week_Start: weekStart,
        Total_Sales: 0,
        InStore_Sales: 0,
        Online_Sales: 0,
        orderCount: 0,
      };
    }
    const w = weekAccum[weekKey];
    w.Total_Sales += b.Total_Sales;
    w.InStore_Sales += b.InStore_Sales;
    w.Online_Sales += b.Online_Sales;
    w.orderCount += b.orderIds.size;
  }
  const weeks = Object.values(weekAccum)
    .map((w) => ({
      Location_Name: w.Location_Name,
      Year: w.Year,
      Week_Number: w.Week_Number,
      Week_Start: w.Week_Start,
      Total_Sales: round2(w.Total_Sales),
      InStore_Sales: round2(w.InStore_Sales),
      Online_Sales: round2(w.Online_Sales),
      Orders: w.orderCount,
      Avg_Ticket: w.orderCount ? round2(w.Total_Sales / w.orderCount) : 0,
    }))
    .sort((a, b) => a.Location_Name.localeCompare(b.Location_Name) || a.Week_Start.localeCompare(b.Week_Start));

  const departments = Object.entries(deptTotals).map(([name, d]) => ({
    department_name: name,
    classified_as: ONLINE_DEPARTMENTS.has(name) ? "online" : "in-store",
    net_sales: round2(d.netSales),
    orders: d.orderIds.size,
  }));

  const output = {
    generated_at: new Date().toISOString(),
    source: "givex-webhook-kv",
    full_resync: FULL_RESYNC === "true",
    payloads_processed_this_run: processedThisRun,
    payloads_skipped_this_run: skippedThisRun,
    payloads_processed_total: state.payloadsProcessedTotal,
    payloads_skipped_total: state.payloadsSkippedTotal,
    orders_total: Object.keys(state.orders).length,
    days,
    weeks,
    department_breakdown: departments,
    unmapped_outlets: state.unmappedOutlets,
    excluded_outlets: state.excludedOutlets,
  };

  await mkdir("data", { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
  console.log(
    `Wrote ${OUTPUT_PATH} (${days.length} store-days, ${weeks.length} store-weeks; ${processedThisRun} new payloads this run, ` +
      `${state.payloadsProcessedTotal} total processed all-time, ${skippedThisRun} skipped this run, ${output.orders_total} distinct orders total)`
  );
  console.log(`Updated ${STATE_PATH} with ${state.processedKeys.length} known keys and ${output.orders_total} order snapshots.`);
  if (Object.keys(state.unmappedOutlets).length > 0) {
    console.warn(
      `WARNING: ${Object.keys(state.unmappedOutlets).length} distinct unmapped outlet/store combos seen so far -- see "unmapped_outlets" in the output file. Add them to scripts/store-mapping.json, then run with FULL_RESYNC=true to reclassify historical data.`
    );
  }
  if (Object.keys(state.excludedOutlets).length > 0) {
    console.log(
      `Note: ${Object.keys(state.excludedOutlets).length} distinct known non-store outlet(s) excluded on purpose -- see "excluded_outlets" in the output file.`
    );
  }
}

function roundBucket(b) {
  const orders = b.orderIds.size;
  return {
    Location_Name: b.Location_Name,
    Location_Type: b.Location_Type,
    Business_Date: b.Business_Date,
    Total_Sales: round2(b.Total_Sales),
    InStore_Sales: round2(b.InStore_Sales),
    Online_Sales: round2(b.Online_Sales),
    Orders: orders,
    Avg_Ticket: orders ? round2(b.Total_Sales / orders) : 0,
    Order_Type_Sales: roundMap(b.Order_Type_Sales),
    Day_Part_Sales: roundMap(b.Day_Part_Sales),
    Payment_Mix: roundMap(b.Payment_Mix),
    Tips_Total: round2(b.Tips_Total),
  };
}

function roundMap(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = round2(v);
  return out;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
