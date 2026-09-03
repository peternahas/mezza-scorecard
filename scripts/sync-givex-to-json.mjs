#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════
 * GIVEX SALES SYNC — v2, "deep extraction"
 * ═══════════════════════════════════════════════════════════════════
 *
 * Reads Givex Order Details webhook payloads from the Cloudflare
 * Worker's D1 database (via /changes) and produces the feed the Mezza
 * executive scorecard reads: data/givex-sales-data.json
 *
 * ── WHY v2 EXISTS ────────────────────────────────────────────────
 *
 * v1 read three fields per payload — BusinessDate, department_name,
 * net_sales — later joined by order_type, opening_time and the
 * payments array. Everything else Givex pushes was stored and never
 * looked at.
 *
 * A schema probe against real production payloads
 * (scripts/givex-schema-probe.mjs, output in data/givex-schema-probe.json)
 * showed what was actually sitting there. Confirmed present on 100% of
 * production line items:
 *
 *   item_name, item_sku_code, units, price_per_unit, adj_gross_sales
 *   category_name, category_group_name, subcat_name, category_id
 *   operator_name, time (HH:MM:SS), section_name, seat_num, table_num
 *   total_amt, total_tax, type
 *
 * and on every order/bill:
 *
 *   opening_time, closing_time, opening_date, closing_date
 *   bills[].order_subtotal, bill_tax, bill_amount, bill_status,
 *   bills[].num_seats, bills[].bill_online_order_id
 *   bills[].payments[]: payment_method, payment_method_amount,
 *                       total_payment, total_tip, operator_name,
 *                       operator_login, cash_out_id
 *
 * That is the difference between "how much did we sell" and "what did
 * we sell, when, through which channel, rung by whom, at what tax and
 * tip, with what attached" — between a sales report and something you
 * can run the business off.
 *
 * ── WHAT IS AND IS NOT ACTUALLY POPULATED ────────────────────────
 *
 * Recorded here so nobody builds a metric on an empty field and then
 * reads the resulting zero as a business fact.
 *
 * Genuinely absent:
 *   customer_id / customer_name / member_number — present on every
 *     bill, EMPTY on every bill. No loyalty, repeat-rate or cohort
 *     analysis is possible from this feed today.
 *   discounts[] / coupons[] / returns[] / modifiers[] — present on
 *     every line item, empty on every one.
 *   coupon_pretax — present, zero everywhere seen.
 *   service_charge_amt / service_charge_tax — always zero.
 *   num_seats — always 1, and table_num is populated on 100% of
 *     orders, so it is an order/queue number rather than a dine-in
 *     table. Neither supports a guest-count or table-turn metric.
 *
 * Present after all, contrary to a first small sample:
 *   discount_pretax — non-zero. Roughly 0.45% of net sales over the
 *     first full week measured. Small, but real and worth watching.
 *   line `type` — production carries "sale" AND "refund". Refunds are
 *     therefore measurable, which is what NonSale_Lines/NonSale_Sales
 *     report.
 *
 * ── HOW THE MONEY FIELDS ACTUALLY RELATE ─────────────────────────
 *
 * This was established by reconciling a full week of real data, not
 * from documentation, and it matters because getting it wrong would
 * mean double-counting revenue:
 *
 *   adj_gross_sales  +  paid add-ons  -  discounts  ≈  net_sales
 *      $355,539          $21,062        $1,667        $374,080
 *      (residual +$854, of which -$757 is refund lines: 0.03%)
 *
 * So `net_sales` ALREADY CONTAINS the add-on money, and
 * `adj_gross_sales` is the BASE ITEM VALUE BEFORE add-ons — it is
 * smaller than net, not larger. Calling it "gross sales" would be
 * actively misleading, so it is emitted as Item_Base_Sales.
 *
 * Paid add-ons are therefore reported as a COMPONENT of net sales,
 * never added to it. Adding them would have inflated every sales
 * figure on the scorecard by about 5.6%.
 *
 * ── BACKWARD COMPATIBILITY IS ABSOLUTE ───────────────────────────
 *
 * Every field v1 emitted is still emitted, same name, same shape,
 * same value. v2 only adds. In particular Total_Sales stays exactly
 * "sum of line-item net_sales" — paid add-ons are counted and
 * reported separately and deliberately NOT folded into net sales,
 * because it is not established whether Givex already includes them
 * in the parent line. Adding them would have silently inflated every
 * historical comparison on the scorecard.
 *
 * ── THE STATE FILE IS NOW BOUNDED ────────────────────────────────
 *
 * v1 kept one snapshot per order forever: 16.7 MB at 34k orders,
 * on track for hundreds of MB within a year, rewritten into a git
 * commit on every sync run.
 *
 * Those snapshots exist for one reason — idempotency. Givex
 * re-delivers closed bills, and a snapshot lets a re-delivery replace
 * its earlier contribution instead of stacking on top of it. That
 * protection only matters while a re-delivery is still plausible.
 *
 * So v2 keeps snapshots for a rolling RETAIN_ORDER_DAYS window and
 * FREEZES older days: the day's finished aggregates are kept, the
 * individual snapshots are dropped. The file reaches a steady size
 * and stays there. D1 remains the only source of truth — FULL_RESYNC
 * rebuilds everything from it at any time.
 *
 * ── FIELD COVERAGE IS PUBLISHED WITH THE DATA ────────────────────
 *
 * A wrong field name here fails silently. So the output carries a
 * `field_coverage` block counting how often each field was actually
 * found. A zero there means the pipeline is broken, not that the
 * business number is zero. Check it before believing a metric.
 *
 * Environment (GitHub Actions repo secrets):
 *   GIVEX_WEBHOOK_URL    https://givex-webhook.mezzascorecard.com
 *   GIVEX_SHARED_SECRET  the secret the Worker checks
 * Optional:
 *   FULL_RESYNC=true     ignore saved state, rebuild from D1
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { GIVEX_WEBHOOK_URL, GIVEX_SHARED_SECRET, FULL_RESYNC, VERIFY_ONLY } = process.env;

// VERIFY_ONLY rebuilds everything from D1 and writes to a SEPARATE
// file, touching neither the live feed nor the saved state. It exists
// so a change to this pipeline can be checked against the numbers
// currently on the scorecard BEFORE it replaces them. A field-name
// mistake here does not raise an error, it produces a plausible wrong
// number — so the only safe way to ship a change is to diff it against
// what the business has already seen.
const verifyOnly = VERIFY_ONLY === "true";

const OUTPUT_PATH = verifyOnly ? "data/givex-sales-data.verify.json" : "data/givex-sales-data.json";
const STATE_PATH = "data/givex-sync-state.json";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_MAPPING_PATH = path.join(__dirname, "store-mapping.json");

// Pre-D1 history. The Worker moved from Workers KV to D1 on
// 2026-08-26; D1 holds nothing before that afternoon, because the KV
// store was never migrated. The v1 sync only still had 2026-08-14 to
// 2026-08-26 because its own state file had accumulated those days
// while KV was live -- so rebuilding from D1 alone silently drops
// twelve days and roughly $520k of recorded sales. This file is that
// history, frozen once, and seeded in on any rebuild.
const LEGACY_PATH = "data/givex-legacy-days.json";

// How long an order stays individually re-writable before its day is
// frozen. Givex repolls target recent business days; three weeks is a
// generous margin. Raising this raises state file size ~linearly.
const RETAIN_ORDER_DAYS = 21;

// Network-wide item mix keeps a longer history than the order window
// because it freezes into compact per-day rows. The per-location item
// mix and the operator rollup come from live snapshots only, so their
// window IS RETAIN_ORDER_DAYS — deliberately not given their own
// constant, which would imply history the state does not hold.
const ITEM_DAY_WINDOW = 90;

// Real production department names, from a production GetDepartmentList
// call and confirmed against live payloads:
//   in-store   Eat - In, Take - Out, Drive Through, Catering
//   online     Givex Online, Delivery, Uber Eats, Skip The Dishes,
//              Door Dash - Delivery, Door Dash - Pickup
// "Catering" is genuinely ambiguous and defaults to in-store — same
// open-question category as the net-vs-gross basis. Flagged, not guessed.
const ONLINE_DEPARTMENTS = new Set([
  "Givex Online",
  "Delivery",
  "Uber Eats",
  "Skip The Dishes",
  "Door Dash - Delivery",
  "Door Dash - Pickup",
]);

// Third-party marketplaces, as distinct from Mezza's own online
// ordering. Commission economics are completely different, so the CFO
// view needs these separated rather than lumped into "online".
const MARKETPLACE_DEPARTMENTS = new Set([
  "Uber Eats",
  "Skip The Dishes",
  "Door Dash - Delivery",
  "Door Dash - Pickup",
]);

// category_group_name is "Food" or "Beverages" in production. Beverage
// attachment is one of the few genuine margin levers a QSR has, so it
// gets its own measure rather than living inside a category map.
const BEVERAGE_GROUP = "Beverages";

/* ─────────────────────────────────────────────────────────────────
   FIELD ACCESS
   Every read goes through pick(), which records whether the field was
   found. That is what populates field_coverage in the output.
   ───────────────────────────────────────────────────────────────── */

const coverage = {};

function pick(obj, names, field) {
  if (obj) {
    for (const n of names) {
      const v = obj[n];
      if (v !== undefined && v !== null && v !== "") {
        if (field) mark(field, true);
        return v;
      }
    }
  }
  if (field) mark(field, false);
  return undefined;
}

function mark(field, hit) {
  const c = coverage[field] || (coverage[field] = { found: 0, missing: 0 });
  if (hit) c.found++; else c.missing++;
}

function num(v) {
  const x = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(x) ? x : 0;
}

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function authedGet(pathAndQuery) {
  const url = `${GIVEX_WEBHOOK_URL.replace(/\/$/, "")}${pathAndQuery}`;
  const res = await fetch(url, { headers: { Authorization: GIVEX_SHARED_SECRET } });
  if (!res.ok) throw new Error(`Request failed: ${url} -> ${res.status} ${await res.text()}`);
  return res;
}

// /changes takes the highest D1 row id already folded in and returns
// only what is above it, payloads inline. /list + /get had to go: it
// read table-size x runs-per-day rows, which crosses D1's free
// 5M rows/day cap. See worker.d1.js.
async function fetchChanges(since) {
  const rows = [];
  let cursor = since;
  for (;;) {
    const qs = new URLSearchParams({ since: String(cursor), limit: "100" });
    const data = await (await authedGet(`/changes?${qs}`)).json();
    rows.push(...data.rows);
    cursor = data.nextSince;
    if (!data.hasMore) break;
  }
  return { rows, nextSince: cursor };
}

/* ── dates and times ────────────────────────────────────────────── */

function isoWeekInfo(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const weekNumber =
    1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  const monday = new Date(dateStr + "T00:00:00Z");
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return { year: d.getUTCFullYear(), weekNumber, weekStart: monday.toISOString().slice(0, 10) };
}

function daysBetween(from, to) {
  return Math.round((new Date(to + "T00:00:00Z") - new Date(from + "T00:00:00Z")) / 86400000);
}

function hourOf(timeStr) {
  if (!timeStr || typeof timeStr !== "string") return null;
  const h = parseInt(timeStr.split(":")[0], 10);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : null;
}

// Unchanged from v1 deliberately. Moving the bucket edges would move
// every historical day-part number and make the trend lie. Hour_Sales
// ships alongside so any consumer can re-bucket freely — and once
// Mezza's real configured day parts are pulled from the production
// GetDayPartList, this can be replaced without touching history.
function dayPartFromTime(timeStr) {
  const hour = hourOf(timeStr);
  if (hour === null) return "Unknown";
  if (hour >= 6 && hour < 11) return "Breakfast";
  if (hour >= 11 && hour < 14) return "Lunch";
  if (hour >= 14 && hour < 17) return "Afternoon";
  if (hour >= 17 && hour < 21) return "Dinner";
  return "Late Night";
}

function toMinutes(t) {
  if (!t || typeof t !== "string") return null;
  const p = t.split(":");
  const h = parseInt(p[0], 10), m = parseInt(p[1] || "0", 10);
  return Number.isInteger(h) && Number.isInteger(m) ? h * 60 + m : null;
}

// Open to close, in minutes. A negative result means the bill closed
// after midnight, so wrap. Anything over four hours is a POS artefact
// (a tab left open, a terminal not cashed out), not a real ticket
// time, so it is discarded rather than allowed to poison the average.
function serviceMinutes(open, close) {
  const a = toMinutes(open), b = toMinutes(close);
  if (a === null || b === null) return null;
  let d = b - a;
  if (d < 0) d += 1440;
  return d >= 0 && d <= 240 ? d : null;
}

/* ── store mapping ──────────────────────────────────────────────── */

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

/* ═════════════════════════════════════════════════════════════════
   ORDER EXTRACTION
   One raw Givex order plus its line items becomes one compact
   snapshot. Compact matters — this is what gets persisted, one per
   order, so the keys are abbreviated on purpose.
   ═════════════════════════════════════════════════════════════════ */

function extractOrder(o, lines, mapping, locationName, businessDate) {
  let net = 0, base = 0, tax = 0;
  let inStore = 0, online = 0, marketplace = 0;
  let units = 0;
  let bevSales = 0, foodSales = 0, hasBeverage = false;
  let paidAddonCount = 0, paidAddonSales = 0, freeAddonCount = 0;
  let nonSaleLines = 0, nonSaleSales = 0;
  const dept = {}, cat = {}, catGroup = {}, subcat = {}, items = {}, lineTypes = {};
  let operator = null;
  let earliestLineTime = null;

  for (const li of lines) {
    // `type` is "sale" on every production line seen. Anything else is
    // counted separately rather than being silently summed into sales
    // — this is the only channel through which a void or return would
    // become visible, since the returns[] array is always empty.
    const lineType = pick(li, ["type"], "line.type") || "(none)";
    lineTypes[lineType] = (lineTypes[lineType] || 0) + 1;

    const deptName = pick(li, ["department_name"], "line.department_name") || "(none)";
    const amt = num(pick(li, ["net_sales"], "line.net_sales"));
    const baseAmt = num(pick(li, ["adj_gross_sales"], "line.adj_gross_sales"));
    const qty = num(pick(li, ["units"], "line.units")) || 1;
    tax += num(pick(li, ["total_tax"], "line.total_tax"));

    if (lineType !== "sale") {
      nonSaleLines += 1;
      nonSaleSales += amt;
      // Still counted into the totals: whatever Givex puts in net_sales
      // is the truth of the day's takings. The flag is for visibility,
      // not for re-deciding the arithmetic.
    }

    net += amt;
    base += baseAmt || amt;
    units += qty;

    if (ONLINE_DEPARTMENTS.has(deptName)) online += amt; else inStore += amt;
    if (MARKETPLACE_DEPARTMENTS.has(deptName)) marketplace += amt;
    dept[deptName] = (dept[deptName] || 0) + amt;

    const catName = pick(li, ["category_name"], "line.category_name");
    if (catName) cat[catName] = (cat[catName] || 0) + amt;

    const grpName = pick(li, ["category_group_name"], "line.category_group_name");
    if (grpName) {
      catGroup[grpName] = (catGroup[grpName] || 0) + amt;
      if (grpName === BEVERAGE_GROUP) { bevSales += amt; hasBeverage = true; }
      else foodSales += amt;
    }

    const subName = pick(li, ["subcat_name"], "line.subcat_name");
    if (subName) subcat[subName] = (subcat[subName] || 0) + amt;

    const itemName = pick(li, ["item_name"], "line.item_name");
    if (itemName) {
      const rec = items[itemName] || (items[itemName] = { u: 0, s: 0, c: catName || "" });
      rec.u += qty;
      rec.s += amt;
    }

    // Add-ons. Most carry adj_gross_sales of 0 — free customisations —
    // while a minority are genuinely paid upsells. Only the paid ones
    // are a revenue lever, so they are counted separately.
    //
    // Their money is deliberately NOT added to net, because
    // reconciling a full week of real data showed net_sales already
    // contains it: adj_gross_sales + paid add-ons - discounts lands
    // within 0.03% of net_sales. Adding them again would have
    // inflated every sales figure on the scorecard by about 5.6%.
    // They are a COMPONENT of net sales, reported alongside it.
    const addons = pick(li, ["addons"], "line.addons");
    if (Array.isArray(addons)) {
      for (const a of addons) {
        const aAmt = num(a && a.adj_gross_sales);
        if (aAmt > 0) { paidAddonCount += 1; paidAddonSales += aAmt; }
        else freeAddonCount += 1;
      }
    }

    // operator_name is on the LINE ITEM in production (not the bill,
    // as originally assumed) and also appears on each payment. Whoever
    // rang the first line is treated as the order's operator.
    operator = operator || pick(li, ["operator_name"], "line.operator_name") || null;

    const t = pick(li, ["time"], "line.time");
    if (t && (!earliestLineTime || t < earliestLineTime)) earliestLineTime = t;
  }

  // ---- order level ----
  const orderType = pick(o, ["order_type"], "order.order_type") || "(unknown)";
  const openingTime = pick(o, ["opening_time"], "order.opening_time") || earliestLineTime || null;
  const closingTime = pick(o, ["closing_time"], "order.closing_time") || null;

  // ---- bill level ----
  const payments = {};
  let tips = 0, tendered = 0, subtotal = 0, billTax = 0;
  let guests = 0, discount = 0, coupon = 0;
  let onlineOrderId = false;

  for (const bill of o.bills || []) {
    subtotal += num(pick(bill, ["order_subtotal"], "bill.order_subtotal"));
    billTax += num(pick(bill, ["bill_tax"], "bill.bill_tax"));
    guests += num(pick(bill, ["num_seats"], "bill.num_seats"));
    discount += Math.abs(num(pick(bill, ["discount_pretax"], "bill.discount_pretax")));
    coupon += Math.abs(num(pick(bill, ["coupon_pretax"], "bill.coupon_pretax")));
    // A non-null bill_online_order_id is a direct, unambiguous online
    // flag straight from Givex — independent of the department-name
    // classification, so the two can be cross-checked.
    if (bill.bill_online_order_id != null) onlineOrderId = true;

    for (const pmt of bill.payments || []) {
      const method = pick(pmt, ["payment_method"], "payment.payment_method") || "(unknown)";
      const amt = num(pick(pmt, ["payment_method_amount"], "payment.payment_method_amount"));
      payments[method] = (payments[method] || 0) + amt;
      tendered += amt;
      tips += num(pick(pmt, ["total_tip"], "payment.total_tip"));
      operator = operator || pick(pmt, ["operator_name"], "payment.operator_name") || null;
    }
  }

  // table_num is deliberately not extracted. It is populated on 100%
  // of production orders, so in this format it is an order/queue
  // number rather than a dine-in table, and a metric that is always
  // 100% only invites a wrong reading.

  return {
    l: locationName,
    lt: resolveLocationType(mapping, locationName),
    d: businessDate,
    ot: orderType,
    op: openingTime,
    cl: closingTime,
    dp: dayPartFromTime(openingTime),
    hr: hourOf(openingTime),
    sm: serviceMinutes(openingTime, closingTime),
    n: net,
    b: base,
    tx: billTax || tax,
    st: subtotal,
    is: inStore,
    on: online,
    mk: marketplace,
    u: units,
    bv: bevSales,
    fd: foodSales,
    hb: hasBeverage ? 1 : 0,
    pa: paidAddonCount,
    pas: paidAddonSales,
    fa: freeAddonCount,
    nsl: nonSaleLines,
    nss: nonSaleSales,
    gs: guests,
    dsc: discount,
    cpn: coupon,
    tp: tips,
    td: tendered,
    dep: dept,
    cat: cat,
    cg: catGroup,
    sc: subcat,
    it: items,
    lty: lineTypes,
    pm: payments,
    o: operator,
    ooid: onlineOrderId ? 1 : 0,
  };
}

/* ═════════════════════════════════════════════════════════════════
   DAY BUCKETS
   ═════════════════════════════════════════════════════════════════ */

function newDayBucket(loc, type, date) {
  return {
    Location_Name: loc, Location_Type: type, Business_Date: date,
    Total_Sales: 0, InStore_Sales: 0, Online_Sales: 0, Orders: 0,
    Order_Type_Sales: {}, Day_Part_Sales: {}, Payment_Mix: {}, Tips_Total: 0,
    Item_Base_Sales: 0, Tax_Total: 0, Subtotal_Total: 0,
    Marketplace_Sales: 0, Marketplace_Orders: 0, Online_Orders: 0,
    Units: 0, Guests: 0,
    Beverage_Sales: 0, Food_Sales: 0, Beverage_Orders: 0,
    Paid_Addon_Count: 0, Paid_Addon_Sales: 0, Free_Addon_Count: 0,
    NonSale_Lines: 0, NonSale_Sales: 0,
    Discount_Total: 0, Coupon_Total: 0, Tendered_Total: 0,
    Hour_Sales: {}, Hour_Orders: {},
    Category_Sales: {}, Category_Group_Sales: {}, Subcategory_Sales: {},
    Department_Sales: {}, Line_Types: {},
    _svcSum: 0, _svcN: 0, _ops: {}, _opnExtra: 0, _legacy: false,
  };
}

function addMap(target, src) {
  if (!src) return;
  for (const k in src) target[k] = (target[k] || 0) + src[k];
}

function foldOrderIntoDay(b, ord) {
  b.Total_Sales += ord.n;
  b.Item_Base_Sales += ord.b;
  b.Tax_Total += ord.tx;
  b.Subtotal_Total += ord.st;
  b.InStore_Sales += ord.is;
  b.Online_Sales += ord.on;
  b.Marketplace_Sales += ord.mk;
  b.Orders += 1;
  if (ord.on > 0 || ord.ooid) b.Online_Orders += 1;
  if (ord.mk > 0) b.Marketplace_Orders += 1;
  b.Units += ord.u;
  b.Guests += ord.gs;
  b.Beverage_Sales += ord.bv;
  b.Food_Sales += ord.fd;
  if (ord.hb) b.Beverage_Orders += 1;
  b.Paid_Addon_Count += ord.pa;
  b.Paid_Addon_Sales += ord.pas;
  b.Free_Addon_Count += ord.fa;
  b.NonSale_Lines += ord.nsl;
  b.NonSale_Sales += ord.nss;
  b.Discount_Total += ord.dsc;
  b.Coupon_Total += ord.cpn;
  b.Tips_Total += ord.tp;
  b.Tendered_Total += ord.td;
  b.Order_Type_Sales[ord.ot] = (b.Order_Type_Sales[ord.ot] || 0) + ord.n;
  b.Day_Part_Sales[ord.dp] = (b.Day_Part_Sales[ord.dp] || 0) + ord.n;
  if (ord.hr !== null && ord.hr !== undefined) {
    b.Hour_Sales[ord.hr] = (b.Hour_Sales[ord.hr] || 0) + ord.n;
    b.Hour_Orders[ord.hr] = (b.Hour_Orders[ord.hr] || 0) + 1;
  }
  addMap(b.Payment_Mix, ord.pm);
  addMap(b.Category_Sales, ord.cat);
  addMap(b.Category_Group_Sales, ord.cg);
  addMap(b.Subcategory_Sales, ord.sc);
  addMap(b.Department_Sales, ord.dep);
  addMap(b.Line_Types, ord.lty);
  if (ord.sm !== null && ord.sm !== undefined) { b._svcSum += ord.sm; b._svcN += 1; }
  if (ord.o) {
    const op = b._ops[ord.o] || (b._ops[ord.o] = { orders: 0, sales: 0, tips: 0 });
    op.orders += 1; op.sales += ord.n; op.tips += ord.tp;
  }
}

// v1 keys first and unchanged; v2 measures appended.
function sealDay(b) {
  const orders = b.Orders;
  return {
    Location_Name: b.Location_Name,
    Location_Type: b.Location_Type,
    Business_Date: b.Business_Date,
    Total_Sales: r2(b.Total_Sales),
    InStore_Sales: r2(b.InStore_Sales),
    Online_Sales: r2(b.Online_Sales),
    Orders: orders,
    Avg_Ticket: orders ? r2(b.Total_Sales / orders) : 0,
    Order_Type_Sales: rMap(b.Order_Type_Sales),
    Day_Part_Sales: rMap(b.Day_Part_Sales),
    Payment_Mix: rMap(b.Payment_Mix),
    Tips_Total: r2(b.Tips_Total),
    // ── v2 ──
    // NOT "gross sales" -- this is the base item value BEFORE paid
    // add-ons and before discount, so it is SMALLER than net sales.
    // adj_gross_sales + add-ons - discounts = net_sales.
    Item_Base_Sales: r2(b.Item_Base_Sales),
    Tax_Total: r2(b.Tax_Total),
    Subtotal_Total: r2(b.Subtotal_Total),
    Marketplace_Sales: r2(b.Marketplace_Sales),
    Marketplace_Orders: b.Marketplace_Orders,
    Online_Orders: b.Online_Orders,
    Online_Order_Pct: orders ? r2((b.Online_Orders / orders) * 100) : 0,
    Units: r2(b.Units),
    Units_Per_Order: orders ? r2(b.Units / orders) : 0,
    Beverage_Sales: r2(b.Beverage_Sales),
    Food_Sales: r2(b.Food_Sales),
    Beverage_Attach_Pct: orders ? r2((b.Beverage_Orders / orders) * 100) : 0,
    Paid_Addon_Count: b.Paid_Addon_Count,
    Paid_Addon_Sales: r2(b.Paid_Addon_Sales),
    Paid_Addon_Attach_Pct: orders ? r2((b.Paid_Addon_Count / orders) * 100) : 0,
    Free_Addon_Count: b.Free_Addon_Count,
    NonSale_Lines: b.NonSale_Lines,
    NonSale_Sales: r2(b.NonSale_Sales),
    Discount_Total: r2(b.Discount_Total),
    Coupon_Total: r2(b.Coupon_Total),
    Discount_Pct: b.Total_Sales ? r2(((b.Discount_Total + b.Coupon_Total) / b.Total_Sales) * 100) : 0,
    Tendered_Total: r2(b.Tendered_Total),
    Tip_Pct: b.Tendered_Total ? r2((b.Tips_Total / b.Tendered_Total) * 100) : 0,
    Guests: r2(b.Guests),
    Avg_Service_Minutes: b._svcN ? r2(b._svcSum / b._svcN) : null,
    Hour_Sales: rMap(b.Hour_Sales),
    Hour_Orders: b.Hour_Orders,
    Category_Sales: rMap(b.Category_Sales),
    Category_Group_Sales: rMap(b.Category_Group_Sales),
    Subcategory_Sales: rMap(b.Subcategory_Sales),
    Department_Sales: rMap(b.Department_Sales),
    Line_Types: b.Line_Types,
    Operator_Count: Object.keys(b._ops).length + (b._opnExtra || 0),
    // True where the day predates D1 and therefore has sales, orders,
    // channel, day part and tender but none of the item, hour,
    // ticket-time or operator detail.
    Legacy_Sales_Only: b._legacy ? true : undefined,
  };
}

function r2(n) { return Math.round((n || 0) * 100) / 100; }
function rMap(o) { const out = {}; for (const k in o) out[k] = r2(o[k]); return out; }

/* ═════════════════════════════════════════════════════════════════
   STATE
   ═════════════════════════════════════════════════════════════════ */

function emptyState() {
  return {
    version: 2,
    cursor: 0,
    orders: {},          // live, individually re-writable snapshots
    frozenDays: {},      // "Loc|Date" -> sealed day (snapshots discarded)
    frozenItemDays: {},  // "Date|Item" -> { u, s, o, c }
    frozenThrough: null,
    unmappedOutlets: {},
    excludedOutlets: {},
    payloadsProcessedTotal: 0,
    payloadsSkippedTotal: 0,
  };
}

async function loadState() {
  if (FULL_RESYNC === "true" || verifyOnly) {
    console.log(
      verifyOnly
        ? "VERIFY_ONLY=true — rebuilding from D1 into a scratch file; live feed and saved state untouched."
        : "FULL_RESYNC=true — ignoring saved state, rebuilding every order from D1."
    );
    return emptyState();
  }
  try {
    const parsed = JSON.parse(await readFile(STATE_PATH, "utf8"));
    if (parsed.version !== 2) {
      // A v1 state file holds snapshots in the old verbose shape with
      // none of the v2 fields, and no frozen buckets. Rather than
      // write migration code that can only ever run once, start
      // clean: D1 holds every payload, so one full rebuild is both
      // correct and cheap.
      console.log("Saved state is pre-v2 — discarding and rebuilding from D1 (one-time).");
      return emptyState();
    }
    return Object.assign(emptyState(), parsed, {
      orders: parsed.orders || {},
      frozenDays: parsed.frozenDays || {},
      frozenItemDays: parsed.frozenItemDays || {},
    });
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log("No saved state — full backfill from D1 (expected on first run).");
      return emptyState();
    }
    throw err;
  }
}

/* ── pre-D1 history ─────────────────────────────────────────────
   Seeded into frozenDays, which is exactly what frozenDays is for: a
   finished day whose individual orders are no longer available. These
   rows carry only the measures v1 extracted, and are tagged so the
   dashboard can say the newer dimensions do not exist for them rather
   than drawing an empty chart and letting someone read it as zero. */

async function loadLegacy(state) {
  let file;
  try {
    file = JSON.parse(await readFile(LEGACY_PATH, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log("No pre-D1 legacy snapshot found — history will start wherever D1 starts.");
      return { through: null, count: 0 };
    }
    throw err;
  }
  const through = file.authoritative_through || null;
  const days = file.days || [];

  // Only seed when the state is fresh. On an incremental run these
  // days are already sitting in frozenDays from the rebuild that
  // seeded them, and re-adding would double them.
  const alreadySeeded = Object.keys(state.frozenDays).length > 0;
  if (!alreadySeeded) {
    for (const d of days) {
      state.frozenDays[`${d.Location_Name}|${d.Business_Date}`] = Object.assign({}, d, {
        Legacy_Sales_Only: true,
      });
    }
    if (days.length) {
      console.log(`Seeded ${days.length} pre-D1 store-day(s) through ${through} from ${LEGACY_PATH}.`);
    }
  }

  /* ── WHICH DATES THE SNAPSHOT OWNS, DATE BY DATE ──────────────────
     This used to be a single `authoritative_through` scalar: skip any
     D1 order dated on or before it. That works while the snapshot is
     one contiguous block, and breaks the moment part of it is
     recovered.

     Concretely, on 2026-09-03 Givex re-pushed 2026-08-20 and it landed
     in D1. To use it, the cutover had to move from Aug 26 back to
     Aug 19 -- which would also have un-skipped Aug 21-26, where D1
     holds nothing, so those six days would have vanished from the
     scorecard entirely. And Aug 26, where D1 DOES hold a partial day
     alongside a fuller legacy row, would have been counted twice.

     So the rule is now per date: a D1 order is skipped if the snapshot
     still holds that business date. Recovering a day is then one edit
     -- archive that date's rows out of the snapshot file -- and it
     switches to D1 on the next run, with no scalar to get wrong and
     no double count. `authoritative_through` is kept for reporting
     only; it is no longer what decides anything. */
  const ownedDates = new Set(days.map((d) => d.Business_Date));
  return { through, count: days.length, ownedDates };
}

/* ═════════════════════════════════════════════════════════════════
   MAIN
   ═════════════════════════════════════════════════════════════════ */

async function main() {
  requireEnv("GIVEX_WEBHOOK_URL", GIVEX_WEBHOOK_URL);
  requireEnv("GIVEX_SHARED_SECRET", GIVEX_SHARED_SECRET);

  const mapping = JSON.parse(await readFile(STORE_MAPPING_PATH, "utf8"));
  const state = await loadState();
  const legacy = await loadLegacy(state);

  console.log(`Fetching payloads changed since D1 row id ${state.cursor}...`);
  const { rows, nextSince } = await fetchChanges(state.cursor);
  console.log(`${rows.length} new or updated payload(s).`);

  let processedThisRun = 0, skippedThisRun = 0, legacySkipped = 0;

  for (const row of rows) {
    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch (err) {
      console.warn(`  [!] Unparseable payload at D1 row ${row.id}: ${err.message}`);
      skippedThisRun++;
      continue;
    }

    const orders = payload.payload?.[0] || [];
    const lineItems = payload.payload?.[1] || [];
    const businessDate = payload.BusinessDate;
    if (!orders.length || !lineItems.length || !businessDate) { skippedThisRun++; continue; }

    // Business days the legacy snapshot already owns are skipped
    // entirely. The v1 feed those rows came from was itself reading
    // the D1-backed Worker after the cutover, so its cutover-day
    // total already includes that afternoon's D1 orders -- counting
    // them again here would double them.
    // Per business date, not a cutover scalar -- see loadLegacy().
    if (legacy.ownedDates && legacy.ownedDates.has(businessDate)) { legacySkipped++; continue; }

    // Index line items by order once per payload. v1 filtered the
    // whole line-item array per order, which is O(n^2) on a payload
    // carrying many orders.
    const byOrder = new Map();
    for (const li of lineItems) {
      const id = li.vxl_order_id;
      let arr = byOrder.get(id);
      if (!arr) byOrder.set(id, (arr = []));
      arr.push(li);
    }

    for (const o of orders) {
      const outletId = o.outlet_id ?? payload.OutletID;
      const { locationName, matchedBy, excludeReason } =
        resolveLocationName(mapping, outletId, o.store_name);
      const tag = `outlet_id=${outletId} store_name=${o.store_name}`;

      if (matchedBy === "excluded") {
        const e = state.excludedOutlets[tag] || { count: 0, reason: excludeReason };
        e.count += 1;
        state.excludedOutlets[tag] = e;
        continue;
      }
      if (matchedBy === "unmapped") {
        state.unmappedOutlets[tag] = (state.unmappedOutlets[tag] || 0) + 1;
        continue;
      }

      // Overwrite, never add. A Givex re-delivery of the same closed
      // bill must REPLACE its earlier contribution, not stack on it.
      state.orders[o.vxl_order_id] =
        extractOrder(o, byOrder.get(o.vxl_order_id) || [], mapping, locationName, businessDate);
    }

    processedThisRun++;
  }

  // The watermark advances only after the whole batch is folded in. If
  // the process dies mid-loop the cursor is unsaved and the batch is
  // re-read next run — harmless, since orders are upserted by id.
  // Skipping would silently lose sales. Fail toward re-reading.
  state.cursor = nextSince;
  state.payloadsProcessedTotal += processedThisRun;
  state.payloadsSkippedTotal += skippedThisRun;

  /* ── Freeze days that have fallen out of the retention window ── */

  const liveDates = new Set();
  for (const id in state.orders) liveDates.add(state.orders[id].d);
  const newest = [...liveDates].sort().pop() || null;
  let frozenNow = 0;

  if (newest) {
    const freezing = {};
    for (const id in state.orders) {
      const ord = state.orders[id];
      if (daysBetween(ord.d, newest) <= RETAIN_ORDER_DAYS) continue;
      const dk = `${ord.l}|${ord.d}`;
      const b = freezing[dk] || (freezing[dk] = newDayBucket(ord.l, ord.lt, ord.d));
      foldOrderIntoDay(b, ord);
      for (const [itemName, rec] of Object.entries(ord.it)) {
        const ik = `${ord.d}|${itemName}`;
        const f = state.frozenItemDays[ik] || (state.frozenItemDays[ik] = { u: 0, s: 0, o: 0, c: rec.c });
        f.u += rec.u; f.s += rec.s; f.o += 1;
      }
      delete state.orders[id];
      frozenNow++;
    }
    for (const [dk, b] of Object.entries(freezing)) {
      // A day may already be partly frozen if an earlier run froze
      // some of it, so merge rather than replace.
      const existing = state.frozenDays[dk];
      state.frozenDays[dk] = existing ? sealDay(mergeWorking(reviveFrozen(existing), b)) : sealDay(b);
    }
    if (frozenNow) {
      state.frozenThrough = newest;
      console.log(`Froze ${frozenNow} order snapshot(s) older than ${RETAIN_ORDER_DAYS} days.`);
    }
  }

  /* ── Derive every output bucket fresh ─────────────────────────
     Frozen days arrive pre-aggregated; live days are re-derived from
     their order snapshots. Deriving rather than accumulating is what
     makes a re-delivered order harmless.                          */

  const working = {};
  for (const [dk, sealed] of Object.entries(state.frozenDays)) working[dk] = reviveFrozen(sealed);

  const itemDays = {};
  const itemLoc = {};
  const operators = {};

  for (const [ik, f] of Object.entries(state.frozenItemDays)) {
    itemDays[ik] = { u: f.u, s: f.s, o: f.o, c: f.c };
  }

  for (const id in state.orders) {
    const ord = state.orders[id];
    const dk = `${ord.l}|${ord.d}`;
    const b = working[dk] || (working[dk] = newDayBucket(ord.l, ord.lt, ord.d));
    foldOrderIntoDay(b, ord);

    for (const [itemName, rec] of Object.entries(ord.it)) {
      const ik = `${ord.d}|${itemName}`;
      const f = itemDays[ik] || (itemDays[ik] = { u: 0, s: 0, o: 0, c: rec.c });
      f.u += rec.u; f.s += rec.s; f.o += 1;
      const lk = `${ord.l}|${itemName}`;
      const g = itemLoc[lk] || (itemLoc[lk] = { u: 0, s: 0, o: 0, c: rec.c });
      g.u += rec.u; g.s += rec.s; g.o += 1;
    }
    if (ord.o) {
      const ok = `${ord.l}|${ord.o}`;
      const op = operators[ok] || (operators[ok] = { orders: 0, sales: 0, tips: 0, days: {} });
      op.orders += 1; op.sales += ord.n; op.tips += ord.tp; op.days[ord.d] = 1;
    }
  }

  const days = Object.values(working)
    .map(sealDay)
    .sort((a, b) =>
      a.Location_Name.localeCompare(b.Location_Name) || a.Business_Date.localeCompare(b.Business_Date));

  const latestDate = days.length
    ? days.map((d) => d.Business_Date).sort().pop()
    : null;
  const withinWindow = (date, n) => !latestDate || daysBetween(date, latestDate) <= n;

  /* ── Weekly rollup — v1 shape preserved, v2 measures appended ── */

  const weekAccum = {};
  for (const d of days) {
    const { year, weekNumber, weekStart } = isoWeekInfo(d.Business_Date);
    const wk = `${d.Location_Name}|${year}-W${String(weekNumber).padStart(2, "0")}`;
    const w = weekAccum[wk] || (weekAccum[wk] = {
      Location_Name: d.Location_Name, Location_Type: d.Location_Type,
      Year: year, Week_Number: weekNumber, Week_Start: weekStart,
      Total_Sales: 0, InStore_Sales: 0, Online_Sales: 0, Orders: 0,
      Item_Base_Sales: 0, Tax_Total: 0, Marketplace_Sales: 0, Marketplace_Orders: 0,
      Online_Orders: 0, Units: 0, Beverage_Sales: 0, Food_Sales: 0,
      Paid_Addon_Sales: 0, Tips_Total: 0, Tendered_Total: 0, Days_Reporting: 0,
    });
    w.Total_Sales += d.Total_Sales; w.InStore_Sales += d.InStore_Sales;
    w.Online_Sales += d.Online_Sales; w.Orders += d.Orders;
    w.Item_Base_Sales += d.Item_Base_Sales; w.Tax_Total += d.Tax_Total;
    w.Marketplace_Sales += d.Marketplace_Sales; w.Marketplace_Orders += d.Marketplace_Orders;
    w.Online_Orders += d.Online_Orders; w.Units += d.Units;
    w.Beverage_Sales += d.Beverage_Sales; w.Food_Sales += d.Food_Sales;
    w.Paid_Addon_Sales += d.Paid_Addon_Sales;
    w.Tips_Total += d.Tips_Total; w.Tendered_Total += d.Tendered_Total;
    w.Days_Reporting += 1;
  }
  const weeks = Object.values(weekAccum).map((w) => ({
    Location_Name: w.Location_Name,
    Year: w.Year,
    Week_Number: w.Week_Number,
    Week_Start: w.Week_Start,
    Total_Sales: r2(w.Total_Sales),
    InStore_Sales: r2(w.InStore_Sales),
    Online_Sales: r2(w.Online_Sales),
    Orders: w.Orders,
    Avg_Ticket: w.Orders ? r2(w.Total_Sales / w.Orders) : 0,
    // v2
    Location_Type: w.Location_Type,
    Item_Base_Sales: r2(w.Item_Base_Sales),
    Tax_Total: r2(w.Tax_Total),
    Marketplace_Sales: r2(w.Marketplace_Sales),
    Marketplace_Orders: w.Marketplace_Orders,
    Online_Orders: w.Online_Orders,
    Units: r2(w.Units),
    Beverage_Sales: r2(w.Beverage_Sales),
    Food_Sales: r2(w.Food_Sales),
    Paid_Addon_Sales: r2(w.Paid_Addon_Sales),
    Tips_Total: r2(w.Tips_Total),
    Tendered_Total: r2(w.Tendered_Total),
    Days_Reporting: w.Days_Reporting,
  })).sort((a, b) =>
    a.Location_Name.localeCompare(b.Location_Name) || a.Week_Start.localeCompare(b.Week_Start));

  /* ── Item mix ───────────────────────────────────────────────── */

  const items = Object.entries(itemDays)
    .filter(([k]) => withinWindow(k.slice(0, 10), ITEM_DAY_WINDOW))
    .map(([k, v]) => ({
      Business_Date: k.slice(0, k.indexOf("|")),
      Item_Name: k.slice(k.indexOf("|") + 1),
      Category_Name: v.c || "",
      Units: r2(v.u),
      Net_Sales: r2(v.s),
      Orders: v.o,
    }))
    .sort((a, b) => a.Business_Date.localeCompare(b.Business_Date) || b.Net_Sales - a.Net_Sales);

  const itemsByLocation = Object.entries(itemLoc).map(([k, v]) => ({
    Location_Name: k.slice(0, k.indexOf("|")),
    Item_Name: k.slice(k.indexOf("|") + 1),
    Category_Name: v.c || "",
    Units: r2(v.u),
    Net_Sales: r2(v.s),
    Orders: v.o,
  })).sort((a, b) => a.Location_Name.localeCompare(b.Location_Name) || b.Net_Sales - a.Net_Sales);

  const operatorRows = Object.entries(operators).map(([k, v]) => {
    const shifts = Object.keys(v.days).length;
    return {
      Location_Name: k.slice(0, k.indexOf("|")),
      Operator: k.slice(k.indexOf("|") + 1),
      Orders: v.orders,
      Net_Sales: r2(v.sales),
      Tips: r2(v.tips),
      Avg_Ticket: v.orders ? r2(v.sales / v.orders) : 0,
      Days_Worked: shifts,
      Sales_Per_Day: shifts ? r2(v.sales / shifts) : 0,
      Orders_Per_Day: shifts ? r2(v.orders / shifts) : 0,
    };
  }).sort((a, b) => a.Location_Name.localeCompare(b.Location_Name) || b.Net_Sales - a.Net_Sales);

  /* ── Network rollups ───────────────────────────────────────────── */

  const deptTotals = {}, catTotals = {}, subTotals = {}, groupTotals = {};
  for (const d of days) {
    addMap(deptTotals, d.Department_Sales);
    addMap(catTotals, d.Category_Sales);
    addMap(subTotals, d.Subcategory_Sales);
    addMap(groupTotals, d.Category_Group_Sales);
  }
  const departments = Object.entries(deptTotals).map(([name, netSales]) => ({
    department_name: name,
    classified_as: ONLINE_DEPARTMENTS.has(name) ? "online" : "in-store",
    marketplace: MARKETPLACE_DEPARTMENTS.has(name),
    net_sales: r2(netSales),
  })).sort((a, b) => b.net_sales - a.net_sales);

  const output = {
    generated_at: new Date().toISOString(),
    source: "givex-webhook-d1",
    schema_version: 2,
    full_resync: FULL_RESYNC === "true" || verifyOnly,
    verify_only: verifyOnly,
    payloads_processed_this_run: processedThisRun,
    payloads_skipped_this_run: skippedThisRun,
    payloads_processed_total: state.payloadsProcessedTotal,
    payloads_skipped_total: state.payloadsSkippedTotal,
    orders_total: Object.keys(state.orders).length,
    orders_live_window_days: RETAIN_ORDER_DAYS,
    frozen_through: state.frozenThrough,
    // Dates on or before this came from the pre-D1 snapshot and carry
    // only the v1 measures. Anything the dashboard shows from the v2
    // dimensions -- item mix, hours, ticket time, operator -- starts
    // the day after. Saying so in the feed is cheaper than letting
    // someone read an empty item chart as a business fact.
    legacy_authoritative_through: legacy.through,
    // The business dates the pre-D1 snapshot still owns. A D1 order on
    // one of these is skipped. Remove a date from the snapshot file and
    // it switches to D1 -- this list is how to see which days are still
    // on the old record.
    legacy_owned_dates: legacy.ownedDates ? [...legacy.ownedDates].sort() : [],
    legacy_store_days: legacy.count,
    legacy_payloads_skipped_this_run: legacySkipped,
    latest_business_date: latestDate,
    days,
    weeks,
    items,
    items_by_location: itemsByLocation,
    item_location_window_days: RETAIN_ORDER_DAYS,
    operators: operatorRows,
    operator_window_days: RETAIN_ORDER_DAYS,
    department_breakdown: departments,
    category_totals: rMap(catTotals),
    subcategory_totals: rMap(subTotals),
    category_group_totals: rMap(groupTotals),
    // Which payload fields were actually found. A found:0 here means
    // the pipeline is broken or Givex changed the payload — it does
    // NOT mean the business number is zero. Check before believing a
    // metric that reads zero.
    field_coverage: Object.fromEntries(
      Object.entries(coverage).sort(([a], [b]) => a.localeCompare(b))
    ),
    unmapped_outlets: state.unmappedOutlets,
    excluded_outlets: state.excludedOutlets,
  };

  await mkdir("data", { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output) + "\n", "utf8");
  if (!verifyOnly) {
    await writeFile(STATE_PATH, JSON.stringify(state) + "\n", "utf8");
  } else {
    console.log("VERIFY_ONLY — state file deliberately not written.");
  }

  console.log(
    `Wrote ${OUTPUT_PATH}: ${days.length} store-days, ${weeks.length} store-weeks, ` +
    `${items.length} item-days, ${operatorRows.length} operator rows. ` +
    `${processedThisRun} payloads this run; ${output.orders_total} live snapshots.` +
    (legacySkipped ? ` ${legacySkipped} payload(s) skipped as already covered by the pre-D1 snapshot.` : "")
  );
  for (const [f, c] of Object.entries(output.field_coverage)) {
    if (c.found === 0) console.warn(`  [!] FIELD NEVER FOUND: ${f} (missing on ${c.missing} reads)`);
  }
  if (Object.keys(state.unmappedOutlets).length) {
    console.warn(
      `WARNING: ${Object.keys(state.unmappedOutlets).length} unmapped outlet(s) — see unmapped_outlets. ` +
      `Add them to scripts/store-mapping.json, then run with FULL_RESYNC=true to reclassify history.`
    );
  }
}

/* ── freeze helpers ──────────────────────────────────────────────── */

// Rebuild a working bucket from a sealed day, so live orders for that
// same date (a late repoll landing after a freeze) can still add on.
// Operator identities are not recoverable from a sealed day — only the
// count is — which is the deliberate trade for a bounded state file.
function reviveFrozen(s) {
  const b = newDayBucket(s.Location_Name, s.Location_Type, s.Business_Date);
  const scalars = [
    "Total_Sales","InStore_Sales","Online_Sales","Orders","Tips_Total","Item_Base_Sales",
    "Tax_Total","Subtotal_Total","Marketplace_Sales","Marketplace_Orders","Online_Orders",
    "Units","Guests","Beverage_Sales","Food_Sales","Paid_Addon_Count","Paid_Addon_Sales",
    "Free_Addon_Count","NonSale_Lines","NonSale_Sales","Discount_Total","Coupon_Total",
    "Tendered_Total",
  ];
  for (const k of scalars) b[k] = s[k] || 0;
  const maps = [
    "Order_Type_Sales","Day_Part_Sales","Payment_Mix","Hour_Sales","Hour_Orders",
    "Category_Sales","Category_Group_Sales","Subcategory_Sales","Department_Sales","Line_Types",
  ];
  for (const k of maps) b[k] = { ...(s[k] || {}) };
  // Beverage_Orders is derivable back from the attach percentage.
  b.Beverage_Orders = Math.round(((s.Beverage_Attach_Pct || 0) / 100) * (s.Orders || 0));
  b._opnExtra = s.Operator_Count || 0;
  b._legacy = !!s.Legacy_Sales_Only;
  if (s.Avg_Service_Minutes != null && s.Orders) {
    b._svcSum = s.Avg_Service_Minutes * s.Orders;
    b._svcN = s.Orders;
  }
  return b;
}

function mergeWorking(a, b) {
  const scalars = [
    "Total_Sales","InStore_Sales","Online_Sales","Orders","Tips_Total","Item_Base_Sales",
    "Tax_Total","Subtotal_Total","Marketplace_Sales","Marketplace_Orders","Online_Orders",
    "Units","Guests","Beverage_Sales","Food_Sales","Beverage_Orders","Paid_Addon_Count",
    "Paid_Addon_Sales","Free_Addon_Count","NonSale_Lines","NonSale_Sales","Discount_Total",
    "Coupon_Total","Tendered_Total","_svcSum","_svcN","_opnExtra",
  ];
  for (const k of scalars) a[k] = (a[k] || 0) + (b[k] || 0);
  a._legacy = a._legacy || b._legacy;
  const maps = [
    "Order_Type_Sales","Day_Part_Sales","Payment_Mix","Hour_Sales","Hour_Orders",
    "Category_Sales","Category_Group_Sales","Subcategory_Sales","Department_Sales","Line_Types",
  ];
  for (const k of maps) addMap(a[k], b[k]);
  for (const [name, v] of Object.entries(b._ops || {})) {
    const t = a._ops[name] || (a._ops[name] = { orders: 0, sales: 0, tips: 0 });
    t.orders += v.orders; t.sales += v.sales; t.tips += v.tips;
  }
  return a;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
