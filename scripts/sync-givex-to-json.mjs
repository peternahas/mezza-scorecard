#!/usr/bin/env node
/**
 * Pulls Givex Order Details webhook payloads out of the Cloudflare
 * KV-backed Worker (givex-webhook), splits sales into InStore_Sales /
 * Online_Sales, rolls it up per store per week, and writes the result
 * to data/givex-sales-data.json in this repo.
 *
 * This is a SEPARATE output file from data/scorecard-data.json (the
 * Excel-sync pipeline's output) on purpose — the two pipelines run on
 * independent schedules and shouldn't race to overwrite the same file.
 * Whoever wires the scorecard's index.html to read live JSON should
 * merge these two sources client-side or in a later build step.
 *
 * INCREMENTAL SYNC (added 2026-08-17) — why this exists:
 *   The original version of this script re-listed AND re-fetched every
 *   single stored order on every run, on a 15-minute cron, forever.
 *   Checked against the real Cloudflare KV metrics on 2026-08-17: only
 *   ~2,990 keys / 11.9 MB stored, but 546,510 reads in the prior month
 *   against only 7,480 writes and 750 lists — a ~73x read amplification
 *   for a dataset this small. That's the most likely cause of both the
 *   13-20 minute run times seen historically and a meaningful chunk of
 *   the Cloudflare request-volume incident (a separate, not fully ruled
 *   out possibility is a genuine Givex-side retry loop; see
 *   `project_givex_integration` notes / the email thread with Adam).
 *
 *   Fix: persist a state file (STATE_PATH below) between runs that
 *   remembers which keys have already been read and folded into the
 *   totals. Every run still does a full `/list` (cheap: ~750/month
 *   total, not the bottleneck) but only calls `/get` on keys it hasn't
 *   seen before. This means read volume now scales with NEW orders
 *   since the last run (typically zero to a few dozen), not with the
 *   entire order history.
 *
 *   Trade-off worth knowing: because already-processed orders are
 *   never re-fetched, a later fix to store-mapping.json's classification
 *   (a store that was previously excluded/unmapped, or a department
 *   reclassified from in-store to online) will NOT retroactively
 *   change historical totals already folded into the state file. Set
 *   the FULL_RESYNC environment variable (or the workflow's
 *   `full_resync` manual-run input) to `true` to force a from-scratch
 *   rebuild — ignores the state file, re-reads everything, and
 *   rewrites it. Do this after any store-mapping.json or
 *   ONLINE_DEPARTMENTS change that should apply to historical data.
 *
 * How channel (in-store vs. online) is determined:
 *   Verified against real webhook payloads (not just the API docs) --
 *   each order line item carries a `department_name` field, and that's
 *   the reliable signal for channel. `order_type` (Dine-In/Take-Out/
 *   Delivery) describes fulfillment, NOT channel -- a real sample showed
 *   a "Take-Out" order_type filed under the "Online Orders" department,
 *   meaning it was placed online for pickup, not ordered at the counter.
 *   `OnlineOrderID` (top-level field) was empty on every one of the
 *   first 164 real orders received, so it is NOT a usable signal here --
 *   don't be tempted to switch to it without re-checking real data first.
 *
 * ONLINE_DEPARTMENTS below is therefore the actual classification rule.
 * Updated 2026-08-17 against REAL production department names (pulled
 * via a production GetDepartmentList call) -- these replace the
 * certification-sandbox placeholder names, which don't match:
 *   In-store:  Eat - In, Take - Out, Drive Through
 *   Online:    Givex Online, Delivery, Uber Eats, Skip The Dishes,
 *              Door Dash - Delivery, Door Dash - Pickup
 * "Catering" is NOT classified as online or in-store automatically --
 * it's genuinely ambiguous (phoned-in/booked event orders, not a
 * counter order but not a delivery-app/online-storefront order
 * either) and defaults to in-store until Peter/Ashley confirm which
 * bucket it belongs in (same open question as the net vs. gross
 * Total_Sales basis -- see SETUP.md).
 *
 * Required environment variables (set as GitHub Actions repo secrets):
 *   GIVEX_WEBHOOK_URL    - e.g. https://givex-webhook.mezzascorecard.com
 *   GIVEX_SHARED_SECRET  - the same secret the Worker checks on /list and /get
 *                           (already exists from setting up the webhook --
 *                           no new Cloudflare credential needed)
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

// "Catering" is deliberately NOT in ONLINE_DEPARTMENTS above -- it falls
// through to in-store by default until Peter/Ashley confirm the right
// bucket (see comment block up top). Its dollar amount is still fully
// visible in department_breakdown below, so nothing is hidden -- just
// bucketed with a placeholder assumption for now.

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

function resolveLocationName(mapping, outletId, storeName) {
  const excludeReason = mapping.excludeOutletIds?.[String(outletId)];
  if (excludeReason) return { locationName: null, matchedBy: "excluded", excludeReason };
  const byId = mapping.byOutletId[String(outletId)];
  if (byId) return { locationName: byId, matchedBy: "outlet_id" };
  const byName = mapping.byStoreName[storeName];
  if (byName) return { locationName: byName, matchedBy: "store_name" };
  return { locationName: null, matchedBy: "unmapped" };
}

// ---- State persistence -----------------------------------------------
// Converts the in-memory Map/Set-based accumulators to/from a plain
// JSON-serializable shape so they can be committed to the repo and
// picked back up by the next run.

function emptyState() {
  return {
    processedKeys: [],
    buckets: {}, // bucketKey -> { Location_Name, Year, Week_Number, Week_Start, Total_Sales, InStore_Sales, Online_Sales, orderIds: [] }
    deptBreakdown: {}, // deptName -> { netSales, lineItems, orderTypes: { [type]: count } }
    unmappedOutlets: {}, // key -> count
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
      buckets: parsed.buckets || {},
      deptBreakdown: parsed.deptBreakdown || {},
      unmappedOutlets: parsed.unmappedOutlets || {},
      excludedOutlets: parsed.excludedOutlets || {},
      payloadsProcessedTotal: parsed.payloadsProcessedTotal || 0,
      payloadsSkippedTotal: parsed.payloadsSkippedTotal || 0,
    };
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log("No existing state file found — this will be a full backfill (expected on first incremental run).");
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
      processedKeySet.add(key); // still mark as seen so we don't keep retrying an empty payload forever
      continue;
    }

    const orderTypeByVxlId = new Map();
    const outletByVxlId = new Map();
    const storeNameByVxlId = new Map();
    for (const o of orders) {
      orderTypeByVxlId.set(o.vxl_order_id, o.order_type);
      outletByVxlId.set(o.vxl_order_id, o.outlet_id ?? payload.OutletID);
      storeNameByVxlId.set(o.vxl_order_id, o.store_name);
    }

    const businessDate = payload.BusinessDate;
    if (!businessDate) {
      skippedThisRun++;
      processedKeySet.add(key);
      continue;
    }
    const { year, weekNumber, weekStart } = isoWeekInfo(businessDate);

    for (const li of lineItems) {
      const outletId = outletByVxlId.get(li.vxl_order_id) ?? payload.OutletID;
      const storeName = storeNameByVxlId.get(li.vxl_order_id);
      const { locationName, matchedBy, excludeReason } = resolveLocationName(mapping, outletId, storeName);
      const deptName = li.department_name || "(none)";
      const isOnline = ONLINE_DEPARTMENTS.has(deptName);
      const netSales = li.net_sales || 0;
      const vxlOrderId = li.vxl_order_id;

      if (matchedBy === "excluded") {
        const excludeKey = `outlet_id=${outletId} store_name=${storeName}`;
        const existing = state.excludedOutlets[excludeKey] || { count: 0, reason: excludeReason };
        existing.count += 1;
        state.excludedOutlets[excludeKey] = existing;
        continue; // known non-store outlet (test/internal) -- deliberately dropped, not a data gap
      }

      if (matchedBy === "unmapped") {
        const unmappedKey = `outlet_id=${outletId} store_name=${storeName}`;
        state.unmappedOutlets[unmappedKey] = (state.unmappedOutlets[unmappedKey] || 0) + 1;
        continue; // don't silently attribute sales to a guessed location
      }

      const bucketKey = `${locationName}|${year}-W${String(weekNumber).padStart(2, "0")}`;
      if (!state.buckets[bucketKey]) {
        state.buckets[bucketKey] = {
          Location_Name: locationName,
          Year: year,
          Week_Number: weekNumber,
          Week_Start: weekStart,
          Total_Sales: 0,
          InStore_Sales: 0,
          Online_Sales: 0,
          orderIds: [],
        };
      }
      const bucket = state.buckets[bucketKey];
      bucket.Total_Sales += netSales;
      if (isOnline) bucket.Online_Sales += netSales;
      else bucket.InStore_Sales += netSales;
      if (!bucket.orderIds.includes(vxlOrderId)) bucket.orderIds.push(vxlOrderId);

      if (!state.deptBreakdown[deptName]) {
        state.deptBreakdown[deptName] = { netSales: 0, lineItems: 0, orderTypes: {} };
      }
      const db = state.deptBreakdown[deptName];
      db.netSales += netSales;
      db.lineItems += 1;
      const ot = orderTypeByVxlId.get(vxlOrderId) || "(unknown)";
      db.orderTypes[ot] = (db.orderTypes[ot] || 0) + 1;
    }

    processedKeySet.add(key);
    processedThisRun++;
  }

  state.processedKeys = [...processedKeySet];
  state.payloadsProcessedTotal += processedThisRun;
  state.payloadsSkippedTotal += skippedThisRun;

  const weeks = Object.values(state.buckets)
    .map((b) => {
      const orders = b.orderIds.length;
      return {
        Location_Name: b.Location_Name,
        Year: b.Year,
        Week_Number: b.Week_Number,
        Week_Start: b.Week_Start,
        Total_Sales: round2(b.Total_Sales),
        InStore_Sales: round2(b.InStore_Sales),
        Online_Sales: round2(b.Online_Sales),
        Orders: orders,
        Avg_Ticket: orders ? round2(b.Total_Sales / orders) : 0,
      };
    })
    .sort((a, b) => a.Location_Name.localeCompare(b.Location_Name) || a.Week_Start.localeCompare(b.Week_Start));

  const departments = Object.entries(state.deptBreakdown).map(([name, d]) => ({
    department_name: name,
    classified_as: ONLINE_DEPARTMENTS.has(name) ? "online" : "in-store",
    net_sales: round2(d.netSales),
    line_items: d.lineItems,
    order_types_seen: d.orderTypes,
  }));

  const output = {
    generated_at: new Date().toISOString(),
    source: "givex-webhook-kv",
    full_resync: FULL_RESYNC === "true",
    payloads_processed_this_run: processedThisRun,
    payloads_skipped_this_run: skippedThisRun,
    payloads_processed_total: state.payloadsProcessedTotal,
    payloads_skipped_total: state.payloadsSkippedTotal,
    weeks,
    department_breakdown: departments,
    unmapped_outlets: state.unmappedOutlets,
    excluded_outlets: state.excludedOutlets,
  };

  await mkdir("data", { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
  console.log(
    `Wrote ${OUTPUT_PATH} (${weeks.length} store-weeks; ${processedThisRun} new payloads this run, ` +
      `${state.payloadsProcessedTotal} total processed all-time, ${skippedThisRun} skipped this run)`
  );
  console.log(`Updated ${STATE_PATH} with ${state.processedKeys.length} known keys.`);
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

function round2(n) {
  return Math.round(n * 100) / 100;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
